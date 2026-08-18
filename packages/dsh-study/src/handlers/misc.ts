/**
 * StudyOS misc resource handlers: error logging, session logging, and memory sync.
 * Each mirrors a legacy handler rule-for-rule so vaults and model-facing
 * values stay identical to the original plugin.
 * @module @puji4810/dsh-study/handlers/misc
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename } from 'node:path'

import { err, ok, type StudyEnvelope } from '../errors.ts'
import { isDue } from '../reviews.ts'
import type { StudyData } from '../types.ts'
import { stripWikilink } from '../util.ts'
import { appendText, listMarkdownNotes, resolveVaultPath, studyDir, writeText } from '../vault.ts'
import type { HandlerEnv } from './dispatch.ts'

/** The UTC date of the injected clock. */
function todayIso(env: HandlerEnv): string {
  return env.now().toISOString().slice(0, 10)
}

/** Parse `YYYY-MM-DD`, falling back to a default string when absent or malformed. */
function parseDateOr(value: unknown, fallback: string): string {
  if (value === null || value === undefined || value === '') return fallback
  const text = String(value).trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : fallback
}

/** Join non-empty strings into the `[[a]], [[b]]` wikilink list form. */
function mdList(items: string[]): string {
  return items.map(item => `[[${item}]]`).join(', ')
}

/** Render a `- Name: value` record field, falling back to `-` when empty. */
function recordField(name: string, value: unknown): string {
  const rendered = String(value ?? '').trim()
  return `- ${name}: ${rendered || '-'}`
}

/** Normalize an unknown value into a list of trimmed non-empty strings. */
function asList(value: unknown): string[] {
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) return value.map(item => String(item)).filter(item => item.trim() !== '')
  if (typeof value === 'string') {
    const stripped = value.trim()
    return stripped ? [stripped] : []
  }
  return [String(value)]
}

/** Resolve a path to a vault-relative slash path. */
function relativeToVault(vault: string, path: string): string {
  return path.slice(vault.length + 1)
}

/**
 * Append a learning mistake record under `.StudyOS/errors/YYYY-MM.md`.
 * @param args - the payload: title, occurred_on, cause, severity, etc.
 * @param env - the handler environment.
 * @returns the log envelope.
 */
export function handleStudyError(args: StudyData, env: HandlerEnv): StudyEnvelope {
  try {
    const vault = resolveVaultPath(args.vault_path, env.vaultPath)
    const occurred = parseDateOr(args.occurred_on, todayIso(env))
    const title = String(args.title || args.source_note || '学习错误').trim()
    const concepts = asList(args.concepts).map(stripWikilink)
    const patterns = asList(args.patterns).map(stripWikilink)
    const source = String(args.source_note || '').trim()
    const block = [
      `### ${occurred} ${title}`,
      recordField('Source', source),
      recordField('Subject', args.subject),
      recordField('Concepts', mdList(concepts)),
      recordField('Patterns', mdList(patterns)),
      recordField('Cause', args.cause || '未分类'),
      recordField('Severity', args.severity || 'medium'),
      recordField('Next action', args.next_action),
      '',
      String(args.detail || '').trim() || '（未填写细节）',
      '',
    ].join('\n')
    const month = occurred.slice(0, 7)
    const path = `${studyDir(vault)}/errors/${month}.md`
    if (!existsSync(path)) writeText(path, `# Study OS Error Log ${month}\n\n`)
    appendText(path, block)
    return ok({ vault_path: vault, path: relativeToVault(vault, path), title })
  } catch (error) {
    return err('LOG_ERROR_FAILED', errorMessage(error))
  }
}

/**
 * Log a study session to `.StudyOS/sessions/YYYY-MM-DD.md`.
 * @param args - the payload: occurred_on, duration_minutes, topics, etc.
 * @param env - the handler environment.
 * @returns the session log envelope.
 */
export function handleStudyLogSession(args: StudyData, env: HandlerEnv): StudyEnvelope {
  try {
    const vault = resolveVaultPath(args.vault_path, env.vaultPath)
    const occurred = parseDateOr(args.occurred_on, todayIso(env))
    const duration = args.duration_minutes
    const topics = asList(args.topics)
    const notesCreated = asList(args.notes_created)
    const examplesAttempted = asList(args.examples_attempted)
    const examplesPassed = asList(args.examples_passed)
    const examplesFailed = asList(args.examples_failed)
    const noteText = String(args.note || '').trim()

    const lines = [`# Study Session ${occurred}`, '']
    if (duration !== undefined && duration !== null) lines.push(`- Duration: ${duration} min`)
    if (topics.length > 0) lines.push(`- Topics: ${topics.join(', ')}`)
    if (notesCreated.length > 0) lines.push(`- Notes created: ${notesCreated.join(', ')}`)
    if (examplesAttempted.length > 0) {
      lines.push(`- Examples attempted: ${examplesAttempted.length}`)
      lines.push(`  - Attempted: ${examplesAttempted.join(', ')}`)
    }
    if (examplesPassed.length > 0) lines.push(`  - Passed: ${examplesPassed.join(', ')}`)
    if (examplesFailed.length > 0) lines.push(`  - Failed: ${examplesFailed.join(', ')}`)
    if (noteText) lines.push('', noteText, '')
    lines.push('')

    const sesDir = `${studyDir(vault)}/sessions`
    mkdirSync(sesDir, { recursive: true })
    const sesPath = `${sesDir}/${occurred}.md`
    if (existsSync(sesPath)) appendText(sesPath, lines.join('\n'))
    else writeText(sesPath, lines.join('\n'))

    return ok({ vault_path: vault, path: relativeToVault(vault, sesPath), date: occurred })
  } catch (error) {
    return err('LOG_SESSION_FAILED', errorMessage(error))
  }
}

/**
 * Build structured memory entries from current study state. Does not write memory;
 * the caller decides what to persist.
 * @param args - the payload; supports an optional `vault_path`.
 * @param env - the handler environment.
 * @returns the memory-sync envelope.
 */
export function handleStudySyncMemory(args: StudyData, env: HandlerEnv): StudyEnvelope {
  try {
    const vault = resolveVaultPath(args.vault_path, env.vaultPath)
    const today = todayIso(env)
    const { due, total } = countDue(vault, today)
    const weak = recentWeakConcepts(vault, today, 30)

    const entries: Array<Record<string, string>> = []
    if (weak.length > 0) {
      const top5 = weak.slice(0, 5).map(item => `${item.concept}(${item.error_count})`).join(', ')
      entries.push({
        action: 'replace',
        content: `StudyOS Math: 近30天最薄弱的概念（按错误次数）：${top5}。`,
        old_text: 'StudyOS Math: 近30天最薄弱的概念',
      })
    }
    entries.push({
      action: 'replace',
      content: `StudyOS Math: 当前 ${due}/${total} 道例题待复习（艾宾浩斯间隔到期）。`,
      old_text: 'StudyOS Math: 当前',
    })
    if (weak.length > 0) {
      const weakest = weak[0] as { concept: string; error_count: number }
      entries.push({
        action: 'replace',
        content: `StudyOS Math: 最弱概念 [[${weakest.concept}]] （${weakest.error_count} 次错误）。优先复习相关例题。`,
        old_text: 'StudyOS Math: 最弱概念',
      })
    }
    entries.push({
      action: 'replace',
      content: `StudyOS Math: 上次同步 ${today}。`,
      old_text: 'StudyOS Math: 上次同步',
    })

    return ok({
      vault_path: vault,
      due_count: due,
      total_examples: total,
      weak_concepts: weak,
      memory_entries: entries,
      timestamp: today,
    })
  } catch (error) {
    return err('SYNC_MEMORY_FAILED', errorMessage(error))
  }
}

/** Whether a note example is due on a given date, using the shared rule. */
function countDue(vault: string, today: string): { due: number; total: number } {
  let due = 0
  let total = 0
  for (const note of listMarkdownNotes(vault)) {
    if (note.layer !== 'example') continue
    total += 1
    if (isDue(note, today)) due += 1
  }
  return { due, total }
}

/** Concepts with the most errors in a recent window, sorted by count descending. */
function recentWeakConcepts(vault: string, today: string, days: number): Array<{ concept: string; error_count: number }> {
  const start = shiftDate(today, -days)
  const counts = new Map<string, number>()
  for (const record of collectErrorRecords(vault, start, today)) {
    const names = record.concepts!
      .replace(/\[\[/g, '').replace(/\]\]/g, '')
      .split(',').map(item => item.trim()).filter(Boolean)
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([concept, error_count]) => ({ concept, error_count }))
    .sort((a, b) => b.error_count - a.error_count)
    .slice(0, 10)
}

/** Collect error records whose date falls inside `[start, end]`. */
function collectErrorRecords(vault: string, start: string, end: string): Array<Record<string, string>> {
  const records: Array<Record<string, string>> = []
  for (const path of listErrorFiles(`${studyDir(vault)}/errors`)) {
    const text = readFileSync(path, 'utf8')
    let current: Record<string, string> | null = null
    for (const line of text.split(/\r?\n/)) {
      const heading = /^###\s+(\d{4}-\d{2}-\d{2})\s+(.+)$/.exec(line)
      if (heading) {
        if (current) records.push(current)
        current = { date: heading[1]!, title: heading[2]!.trim(), file: basename(path), concepts: '' }
        continue
      }
      if (current && line.startsWith('- ') && line.includes(':')) {
        const key = line.slice(2).split(':', 1)[0]!
        const value = line.slice(2 + key.length + 1).trim()
        current[key.trim().toLowerCase()] = value
      }
    }
    if (current) records.push(current)
  }
  return records.filter(record => dateInRange(record.date!, start, end))
}

/** Sorted `.md` file paths inside a directory, empty when the directory is missing. */
function listErrorFiles(root: string): string[] {
  let names: string[]
  try {
    names = readdirSync(root).filter(name => name.endsWith('.md')).sort()
  } catch {
    return []
  }
  return names
    .map(name => `${root}/${name}`)
    .filter(path => statSync(path).isFile())
}

/** Whether a `YYYY-MM-DD` string falls inside an inclusive date range. */
function dateInRange(value: string, start: string, end: string): boolean {
  return start <= value && value <= end
}

/** Shift a `YYYY-MM-DD` string by a whole number of days. */
function shiftDate(value: string, days: number): string {
  const parsed = new Date(`${value}T00:00:00Z`)
  return new Date(parsed.getTime() + days * 86_400_000).toISOString().slice(0, 10)
}

/** Render an unknown thrown value as a message string. */
function errorMessage(error: unknown): string {
  return (error as Error).message
}
