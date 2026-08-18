/**
 * StudyOS durable record handlers: learning records, decisions, and visual lessons.
 * Mirrors the original `handle_study_learning_record`,
 * `handle_study_decision`, and `handle_study_lesson`, including the byte-exact
 * Markdown serialization of each record type.
 * @module @puji4810/dsh-study/handlers/records
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'

import { err, ok, type StudyEnvelope } from '../errors.ts'
import type { StudyData } from '../types.ts'
import { slugify } from '../util.ts'
import {
  decisionsDir,
  learningRecordsDir,
  lessonsDir,
  readProjectManifest,
  resolveVaultPath,
  validateScheduleId,
} from '../vault.ts'
import type { HandlerEnv } from './dispatch.ts'

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

/** A `- item` bullet list, falling back to a single `- None` line when empty. */
function mdBullets(value: unknown): string[] {
  const values = asList(value)
  return values.length > 0 ? values.map(item => `- ${item}`) : ['- None']
}

/** Today's ISO timestamp (seconds precision) for `created_at`. */
function nowIso(env: HandlerEnv): string {
  return env.now().toISOString()
}

/** A vault-relative slash path. */
function relativeToVault(vault: string, path: string): string {
  return path.slice(vault.length + 1)
}

/** A sorted list of files matching a suffix under a directory. */
function sortedFiles(root: string, suffix: string): string[] {
  return readdirSync(root)
    .filter(name => name.endsWith(suffix))
    .map(name => `${root}/${name}`)
    .sort()
}

/** The base filename without extension. */
function stemOf(path: string): string {
  const base = path.split('/').pop()!
  return base.slice(0, base.lastIndexOf('.'))
}

function errorMessage(error: unknown): string {
  return (error as Error).message
}

/** The first H1 heading text of a body, or null. */
function firstHeading(body: string): string | null {
  const match = /^#\s+(.+?)\s*$/m.exec(body)
  return match ? match[1]!.trim() : null
}

/** Parse YAML frontmatter key/value lines into a record (possibly empty). */
function parseFrontmatter(text: string): Record<string, string> {
  const lines = text.split(/\r?\n/)
  if (lines[0]!.trim() !== '---') return {}
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  const body = end > 0 ? lines.slice(1, end).join('\n') : ''
  const result: Record<string, string> = {}
  for (const line of body.split(/\r?\n/)) {
    const match = /^([^:]+):\s*(.*)$/.exec(line)
    if (match) result[match[1]!.trim()] = match[2]!.trim()
  }
  return result
}

/** The summary view a `list` action returns for one markdown record path. */
function recordSummary(path: string, vault: string, idKey: string) {
  const text = readFileSync(path, 'utf8')
  const frontmatter = parseFrontmatter(text)
  return {
    path: relativeToVault(vault, path),
    [idKey]: frontmatter[idKey] ?? stemOf(path),
    project_id: frontmatter.project_id ?? null,
    status: frontmatter.status ?? null,
    title: firstHeading(text) ?? stemOf(path),
  }
}

/** Build an auto `NNNN-slug` id when none is supplied. */
function autoId(count: number, title: string, fallback: string): string {
  return `${String(count + 1).padStart(4, '0')}-${slugify(title, fallback)}`
}

/** Error-code dispatch for the record handlers, mapping project/validation failures. */
function guard(error: unknown, fallback: string): StudyEnvelope {
  const code = (error as { code?: string }).code
  if (code === 'PROJECT_NOT_FOUND') return err('PROJECT_NOT_FOUND', errorMessage(error))
  if (code === 'VALIDATION_FAILED') return err('VALIDATION_FAILED', errorMessage(error))
  return err(fallback, errorMessage(error))
}

/**
 * Create, list, or read a learning record.
 * @param args - the payload with `action` plus record fields.
 * @param env - the handler environment.
 * @returns the learning-record envelope.
 */
export function handleStudyLearningRecord(args: StudyData, env: HandlerEnv): StudyEnvelope {
  const action = String(args.action || 'list').trim()
  try {
    const vault = resolveVaultPath(args.vault_path, env.vaultPath)
    const project = readProjectManifest(vault, args.project_id)
    const projectId = project.project_id
    if (action === 'list') {
      const records = sortedFiles(learningRecordsDir(vault, projectId), '.md')
        .map(path => recordSummary(path, vault, 'record_id'))
      return ok({ project_id: projectId, records })
    }
    if (action === 'create') {
      const title = String(args.title || '').trim()
      const summary = String(args.summary || '').trim()
      const evidence = String(args.evidence || '').trim()
      if (!title || !summary || !evidence) {
        return err('VALIDATION_FAILED', 'title, summary, and evidence are required')
      }
      const count = sortedFiles(learningRecordsDir(vault, projectId), '.md').length
      const requestedId = String(args.record_id || '').trim()
      const recordId = validateScheduleId(requestedId || autoId(count, title, 'learning-record'))
      const record: Record<string, unknown> = {
        record_id: recordId,
        project_id: projectId,
        title,
        status: String(args.status || 'active').trim(),
        created_at: nowIso(env),
        summary,
        evidence,
        implications: String(args.implications || '').trim(),
        linked_concepts: asList(args.linked_concepts),
        linked_sources: asList(args.linked_sources),
      }
      const path = `${learningRecordsDir(vault, projectId)}/${recordId}.md`
      if (existsSync(path)) return err('LEARNING_RECORD_EXISTS', `LearningRecord already exists: ${recordId}`)
      writeFileSync(path, learningRecordMarkdown(record), 'utf8')
      return ok({ record, path: relativeToVault(vault, path) })
    }
    if (action === 'read') {
      const recordId = validateScheduleId(args.record_id)
      const path = `${learningRecordsDir(vault, projectId)}/${recordId}.md`
      if (!existsSync(path)) return err('LEARNING_RECORD_NOT_FOUND', `LearningRecord not found: ${recordId}`)
      return ok({
        project_id: projectId,
        record_id: recordId,
        path: relativeToVault(vault, path),
        content: readFileSync(path, 'utf8'),
      })
    }
    return err('INVALID_ACTION', `Unsupported study_learning_record action: ${action}`)
  } catch (error) {
    return guard(error, 'STUDY_LEARNING_RECORD_FAILED')
  }
}

/**
 * Create, list, or read a decision.
 * @param args - the payload with `action` plus decision fields.
 * @param env - the handler environment.
 * @returns the decision envelope.
 */
export function handleStudyDecision(args: StudyData, env: HandlerEnv): StudyEnvelope {
  const action = String(args.action || 'list').trim()
  try {
    const vault = resolveVaultPath(args.vault_path, env.vaultPath)
    const project = readProjectManifest(vault, args.project_id)
    const projectId = project.project_id
    if (action === 'list') {
      const decisions = sortedFiles(decisionsDir(vault, projectId), '.md')
        .map(path => recordSummary(path, vault, 'decision_id'))
      return ok({ project_id: projectId, decisions })
    }
    if (action === 'create') {
      const title = String(args.title || '').trim()
      const decisionText = String(args.decision || '').trim()
      if (!title || !decisionText) {
        return err('VALIDATION_FAILED', 'title and decision are required')
      }
      const count = sortedFiles(decisionsDir(vault, projectId), '.md').length
      const requestedId = String(args.decision_id || '').trim()
      const decisionId = validateScheduleId(requestedId || autoId(count, title, 'decision'))
      const record: Record<string, unknown> = {
        decision_id: decisionId,
        project_id: projectId,
        title,
        status: String(args.status || 'accepted').trim(),
        created_at: nowIso(env),
        decision: decisionText,
        context: String(args.context || '').trim(),
        options_considered: asList(args.options_considered),
        consequences: String(args.consequences || '').trim(),
        linked_concepts: asList(args.linked_concepts),
        linked_sources: asList(args.linked_sources),
        linked_sessions: asList(args.linked_sessions),
      }
      const path = `${decisionsDir(vault, projectId)}/${decisionId}.md`
      if (existsSync(path)) return err('DECISION_EXISTS', `LearningDecisionRecord already exists: ${decisionId}`)
      writeFileSync(path, decisionMarkdown(record), 'utf8')
      return ok({ decision: record, path: relativeToVault(vault, path) })
    }
    if (action === 'read') {
      const decisionId = validateScheduleId(args.decision_id)
      const path = `${decisionsDir(vault, projectId)}/${decisionId}.md`
      if (!existsSync(path)) return err('DECISION_NOT_FOUND', `LearningDecisionRecord not found: ${decisionId}`)
      return ok({
        project_id: projectId,
        decision_id: decisionId,
        path: relativeToVault(vault, path),
        content: readFileSync(path, 'utf8'),
      })
    }
    return err('INVALID_ACTION', `Unsupported study_decision action: ${action}`)
  } catch (error) {
    return guard(error, 'STUDY_DECISION_FAILED')
  }
}

/**
 * Create, list, or read a visual lesson.
 * @param args - the payload with `action` plus lesson fields.
 * @param env - the handler environment.
 * @returns the lesson envelope.
 */
export function handleStudyLesson(args: StudyData, env: HandlerEnv): StudyEnvelope {
  const action = String(args.action || 'list').trim()
  try {
    const vault = resolveVaultPath(args.vault_path, env.vaultPath)
    const project = readProjectManifest(vault, args.project_id)
    const projectId = project.project_id
    const dir = lessonsDir(vault, projectId)
    if (action === 'list') {
      const lessons = sortedFiles(dir, '.html').map(path => lessonSummary(path, vault))
      return ok({ project_id: projectId, lessons })
    }
    if (action === 'create') {
      const title = String(args.title || '').trim()
      const html = String(args.html || '').trim()
      const rationale = String(args.rationale || '').trim()
      if (!title || !html || !rationale) {
        return err('VALIDATION_FAILED', 'title, html, and rationale are required')
      }
      const lowered = html.toLowerCase()
      if (!lowered.includes('<html') || !lowered.includes('</html>')) {
        return err('VALIDATION_FAILED', 'html must be a complete HTML document')
      }
      const count = sortedFiles(dir, '.html').length
      const requestedId = String(args.lesson_id || '').trim()
      const lessonId = validateScheduleId(requestedId || autoId(count, title, 'visual-lesson'))
      const path = `${dir}/${lessonId}.html`
      if (existsSync(path)) return err('LESSON_EXISTS', `VisualLesson already exists: ${lessonId}`)
      writeFileSync(path, html, 'utf8')
      const meta: Record<string, unknown> = {
        schema_version: 'visual_lesson.v1',
        lesson_id: lessonId,
        project_id: projectId,
        title,
        rationale,
        created_at: nowIso(env),
        linked_concepts: asList(args.linked_concepts),
        linked_sources: asList(args.linked_sources),
        html_path: relativeToVault(vault, path),
      }
      const metaPath = `${dir}/${lessonId}.json`
      writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
      return ok({
        lesson: meta,
        path: relativeToVault(vault, path),
        metadata_path: relativeToVault(vault, metaPath),
      })
    }
    if (action === 'read') {
      const lessonId = validateScheduleId(args.lesson_id)
      const path = `${dir}/${lessonId}.html`
      if (!existsSync(path)) return err('LESSON_NOT_FOUND', `VisualLesson not found: ${lessonId}`)
      const metaPath = `${dir}/${lessonId}.json`
      const metadata = existsSync(metaPath)
        ? JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>
        : {}
      return ok({
        project_id: projectId,
        lesson_id: lessonId,
        path: relativeToVault(vault, path),
        metadata,
        html: readFileSync(path, 'utf8'),
      })
    }
    return err('INVALID_ACTION', `Unsupported study_lesson action: ${action}`)
  } catch (error) {
    return guard(error, 'STUDY_LESSON_FAILED')
  }
}

/** The Markdown serialization of a learning record. */
function learningRecordMarkdown(record: Record<string, unknown>): string {
  return [
    '---',
    'schema_version: learning_record.v1',
    `record_id: ${record.record_id}`,
    `project_id: ${record.project_id}`,
    `status: ${record.status}`,
    `created_at: ${record.created_at}`,
    '---',
    '',
    `# ${record.title}`,
    '',
    record.summary,
    '',
    '## Evidence',
    '',
    record.evidence,
    '',
    '## Implications',
    '',
    record.implications || 'None',
    '',
    '## Linked Concepts',
    '',
    ...mdBullets(record.linked_concepts),
    '',
    '## Linked Sources',
    '',
    ...mdBullets(record.linked_sources),
    '',
  ].join('\n')
}

/** The Markdown serialization of a decision. */
function decisionMarkdown(record: Record<string, unknown>): string {
  return [
    '---',
    'schema_version: learning_decision_record.v1',
    `decision_id: ${record.decision_id}`,
    `project_id: ${record.project_id}`,
    `status: ${record.status}`,
    `created_at: ${record.created_at}`,
    '---',
    '',
    `# ${record.title}`,
    '',
    '## Decision',
    '',
    record.decision,
    '',
    '## Context',
    '',
    record.context || 'None',
    '',
    '## Options Considered',
    '',
    ...mdBullets(record.options_considered),
    '',
    '## Consequences',
    '',
    record.consequences || 'None',
    '',
    '## Linked Concepts',
    '',
    ...mdBullets(record.linked_concepts),
    '',
    '## Linked Sources',
    '',
    ...mdBullets(record.linked_sources),
    '',
    '## Linked Sessions',
    '',
    ...mdBullets(record.linked_sessions),
    '',
  ].join('\n')
}

/** The summary view for one lesson. */
function lessonSummary(path: string, vault: string): Record<string, unknown> {
  const content = readFileSync(path, 'utf8')
  const titleMatch = /<title>(.*?)<\/title>/is.exec(content)
  const h1Match = /<h1[^>]*>(.*?)<\/h1>/is.exec(content)
  let title = titleMatch ? titleMatch[1]!.trim() : (h1Match ? h1Match[1]!.trim() : stemOf(path))
  title = title.replace(/<[^>]+>/g, '')
  return {
    path: relativeToVault(vault, path),
    lesson_id: stemOf(path),
    title,
    size_bytes: statSync(path).size,
  }
}
