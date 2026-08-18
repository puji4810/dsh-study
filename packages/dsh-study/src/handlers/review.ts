/**
 * StudyOS review resource handlers: due, record, submit, create_task, stats,
 * weekly_report, export_anki, plus the review-detail projector.
 * Mirrors the original review handlers and
 * `handle_study_review_submission`/`handle_study_review_detail`.
 * @module @puji4810/dsh-study/handlers/review
 */

import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'

import { err, ok, type StudyEnvelope, type StudyOkEnvelope } from '../errors.ts'
import { toIsoSeconds } from '../datetime.ts'
import {
  automaticReviewLevel,
  buildReviewStats,
  calculateNextReview,
  isDue,
  readReviewState,
} from '../reviews.ts'
import type { StudyData, StudyNote } from '../types.ts'
import { stripWikilink } from '../util.ts'
import {
  allAttempts,
  appendText,
  listMarkdownNotes,
  readNoteFile,
  readProjectManifest,
  resolveVaultPath,
  safeRelativePath,
  studyDir,
  upsertFrontmatterField,
  writeText,
} from '../vault.ts'
import { recordAttempt } from './attempt.ts'
import type { HandlerEnv } from './dispatch.ts'

/** The answer-heading delimiter for review detail. */
const ANSWER_HEADING_RE = /^#{1,6}\s*(?:答案|解析|解答|参考答案|solution|answer)\s*$/im

/** Clamp a list limit into `[1, 500]`. */
function limitFrom(value: unknown, def: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : def
  return Math.max(1, Math.min(numeric, 500))
}

/** Today's ISO date from the injected clock. */
function todayIso(env: HandlerEnv): string {
  return env.now().toISOString().slice(0, 10)
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

/** Parse a `YYYY-MM-DD` string, defaulting when absent or malformed. */
function parseDateOr(value: unknown, fallback: string): string {
  if (value === null || value === undefined || value === '') return fallback
  const text = String(value).trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : fallback
}

/** A selector parsed as a casefolded string set, or null to skip validation. */
function filterValues(value: unknown, key: string): Set<string> {
  if (value === null || value === undefined) return new Set()
  const values = typeof value === 'string' ? [value] : value
  if (!Array.isArray(values) || !values.every(item => typeof item === 'string')) {
    throw new Error(`${key} must be a string or an array of strings`)
  }
  return new Set(values.map(item => item.trim().toLowerCase()).filter(Boolean))
}

/** A selector parsed as an integer set in `[0, 5]`. */
function filterInts(value: unknown, key: string): Set<number> {
  if (value === null || value === undefined) return new Set()
  const values = typeof value === 'number' ? [value] : value
  if (!Array.isArray(values) || !values.every(item => typeof item === 'number' && Number.isInteger(item))) {
    throw new Error(`${key} must be an integer or an array of integers`)
  }
  if (values.some(item => item < 0 || item > 5)) {
    throw new Error(`${key} values must be between 0 and 5`)
  }
  return new Set(values)
}

/** Parse an `exclude_paths` selector into normalized relative prefixes. */
function pathPrefixes(value: unknown, key: string): Set<string> {
  const prefixes = new Set<string>()
  for (const raw of filterValues(value, key)) {
    const normalized = raw.replace(/\\/g, '/')
    const prefix = normalized.replace(/^\/+|\/+$/g, '')
    if (!prefix || prefix.includes('..')) {
      throw new Error(`${key} must contain vault-relative path prefixes`)
    }
    prefixes.add(prefix)
  }
  return prefixes
}

/** Whether a note path is excluded by any of the given prefixes. */
function isExcluded(notePath: string, prefixes: Set<string>): boolean {
  const normalized = notePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase()
  return [...prefixes].some(prefix => normalized === prefix || normalized.startsWith(`${prefix}/`))
}

/** The subject folder of a note, when present. */
function noteSubject(note: StudyNote): string | null {
  const parts = note.path.split('/')
  if (parts.length < 2 || parts[0]!.startsWith('.')) return null
  return parts[0]!
}

/** Whether a note matches query/tag/layer filters (no body search, no normalize). */
function matchesNote(
  note: StudyNote,
  query: string | undefined,
  tag: string | undefined,
  layer: string | undefined,
): boolean {
  if (layer && note.layer !== layer) return false
  if (tag) {
    const wanted = tag.trim().replace(/^#/, '')
    const tags = new Set(note.tags.map(item => item.replace(/^#/, '')))
    if (!tags.has(wanted)) return false
  }
  if (query) {
    const queryLower = query.toLowerCase()
    const haystacks = [
      note.path,
      note.title,
      note.excerpt,
      note.aliases.join(' '),
      note.concepts.join(' '),
      note.patterns.join(' '),
      note.wikilinks.join(' '),
    ]
    if (!haystacks.some(item => item.toLowerCase().includes(queryLower))) return false
  }
  return true
}

/**
 * Dispatch a StudyOS review operation.
 * @param args - the payload with `action` and action-specific fields.
 * @param env - the handler environment.
 * @returns the review envelope.
 */
export function handleStudyReview(args: StudyData, env: HandlerEnv): StudyEnvelope {
  const action = String(args.action || 'due').trim()
  if (action === 'due') return dueReviews(args, env)
  if (action === 'record') return recordReview(args, env)
  if (action === 'submit') return submitReview(args, env)
  if (action === 'create_task') return createTask(args, env)
  if (action === 'stats') return reviewStats(args, env)
  if (action === 'weekly_report') return weeklyReport(args, env)
  if (action === 'export_anki') return exportAnki(args, env)
  return err('INVALID_ACTION', `Unsupported study_review action: ${action}`)
}

/**
 * Open one example split into prompt and initially-hidden answer.
 * @param args - the payload with a `note` (or `path`) reference.
 * @param env - the handler environment.
 * @returns the review-detail envelope.
 */
export function handleStudyReviewDetail(args: StudyData, env: HandlerEnv): StudyEnvelope {
  try {
    const vault = resolveVaultPath(args.vault_path, env.vaultPath)
    const noteRef = String(args.note || args.path || '').trim()
    let note: StudyNote
    let warnings: string[]
    try {
      ;({ note, warnings } = readNoteFile(vault, noteRef, { includeBody: true }))
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'NOTE_AMBIGUOUS') {
        const matches = ((error as unknown as { details?: { matches?: string[] } }).details?.matches ?? [])
        return err('NOTE_AMBIGUOUS', `More than one note matched ${JSON.stringify(noteRef)}`, { matches })
      }
      return err('NOTE_NOT_FOUND', `Note not found: ${noteRef}`)
    }
    if (note.layer !== 'example') {
      return err('NOT_REVIEW_ITEM', 'Only example notes can be opened in the review runner')
    }
    const body = String(note.body ?? '')
    const match = ANSWER_HEADING_RE.exec(body)
    const prompt = match ? body.slice(0, match.index).trim() : body.trim()
    const answer = match ? body.slice(match.index).trim() : null
    return ok({
      item: note,
      prompt_markdown: prompt,
      answer_markdown: answer,
      has_answer: answer !== null,
    }, warnings)
  } catch (error) {
    return err('REVIEW_DETAIL_FAILED', errorMessage(error))
  }
}

/** The `due` action, with every original filter and sort option. */
function dueReviews(args: StudyData, env: HandlerEnv): StudyEnvelope {
  try {
    const vault = resolveVaultPath(args.vault_path, env.vaultPath)
    const limit = limitFrom(args.limit, 30)
    const today = todayIso(env)
    const folder = args.folder !== null && args.folder !== undefined ? String(args.folder).trim() || undefined : undefined

    const subjectsFilter = filterValues(args.subjects, 'subjects')
    if (args.subject !== null && args.subject !== undefined) {
      for (const item of filterValues(args.subject, 'subject')) subjectsFilter.add(item)
    }
    const notesFilter = filterValues(args.notes, 'notes')
    for (const item of filterValues(args.paths, 'paths')) notesFilter.add(item)
    const tagsFilter = filterValues(args.tags, 'tags')
    const excludePaths = pathPrefixes(args.exclude_paths, 'exclude_paths')
    const conceptsFilter = filterValues(args.concepts, 'concepts')
    const difficultiesFilter = filterValues(args.difficulties, 'difficulties')
    const reviewLevelsFilter = filterInts(args.review_levels, 'review_levels')

    const matchMode = String(args.match || 'any').trim().toLowerCase()
    if (matchMode !== 'any' && matchMode !== 'all') throw new Error("match must be 'any' or 'all'")
    const reviewState = String(args.review_state || 'due').trim().toLowerCase()
    if (reviewState !== 'due' && reviewState !== 'all' && reviewState !== 'new' && reviewState !== 'reviewed') {
      throw new Error('review_state must be due, all, new, or reviewed')
    }
    const sortBy = String(args.sort || 'priority').trim().toLowerCase()
    if (!['priority', 'oldest', 'newest', 'difficulty_asc', 'difficulty_desc', 'title'].includes(sortBy)) {
      throw new Error('sort must be priority, oldest, newest, difficulty_asc, difficulty_desc, or title')
    }
    const minLevel = integerInRange(args.min_review_level, 'min_review_level')
    const maxLevel = integerInRange(args.max_review_level, 'max_review_level')
    if (minLevel !== null && maxLevel !== null && minLevel > maxLevel) {
      throw new Error('min_review_level cannot exceed max_review_level')
    }

    const due: Array<Record<string, unknown>> = []
    const subjects = new Set<string>()
    for (const note of listMarkdownNotes(vault)) {
      if (isExcluded(note.path, excludePaths)) continue
      const subject = noteSubject(note)
      if (note.layer !== 'example') continue
      if (subject) subjects.add(subject)

      const state = readReviewState(note)
      const frontmatter = note.frontmatter ?? {}
      const reviewLevel = Number.isFinite(Number(frontmatter.review_level)) ? Math.trunc(Number(frontmatter.review_level)) : 0
      const dueFlag = isDue(note, today)
      if (reviewState === 'due' && !dueFlag) continue
      if (reviewState === 'new' && state.review_count !== 0) continue
      if (reviewState === 'reviewed' && state.review_count === 0) continue

      const noteTags = new Set((note.tags ?? []).map(tag => String(tag).replace(/^#/, '').toLowerCase()))
      const noteConcepts = new Set((note.concepts ?? []).map(concept => String(concept).toLowerCase()))

      const subjectMatches = [...subjectsFilter].filter(value =>
        value === (subject ?? '').toLowerCase()
        || noteTags.has(value)
        || [...noteConcepts].some(concept => concept.includes(value)))
      if (subjectsFilter.size > 0) {
        if (matchMode === 'all' ? subjectMatches.length !== subjectsFilter.size : subjectMatches.length === 0) continue
      }
      if (notesFilter.size > 0 && !notesFilter.has(note.path.toLowerCase())) continue
      if (tagsFilter.size > 0) {
        if (matchMode === 'all' ? ![...tagsFilter].every(tag => noteTags.has(tag)) : ![...tagsFilter].some(tag => noteTags.has(tag))) continue
      }
      const conceptMatches = [...conceptsFilter].filter(value => [...noteConcepts].some(concept => concept.includes(value)))
      if (conceptsFilter.size > 0) {
        if (matchMode === 'all' ? conceptMatches.length !== conceptsFilter.size : conceptMatches.length === 0) continue
      }
      const difficulty = String(frontmatter.difficulty ?? '').toLowerCase()
      if (difficultiesFilter.size > 0 && !difficultiesFilter.has(difficulty)) continue
      if (reviewLevelsFilter.size > 0 && !reviewLevelsFilter.has(reviewLevel)) continue
      if (minLevel !== null && reviewLevel < minLevel) continue
      if (maxLevel !== null && reviewLevel > maxLevel) continue

      due.push({
        path: note.path,
        title: note.title,
        review_level: reviewLevel,
        review_count: state.review_count,
        last_reviewed_at: state.last_reviewed_at || null,
        next_review_at: state.next_review_at || null,
        concepts: note.concepts ?? [],
        tags: note.tags ?? [],
        difficulty: frontmatter.difficulty ?? null,
        subject,
      })
    }

    const difficultyRank: Record<string, number> = { easy: 1, medium: 2, hard: 3 }
    if (sortBy === 'priority') {
      due.sort((a, b) => {
        if (a.review_level !== b.review_level) return (a.review_level as number) - (b.review_level as number)
        const al = String(a.last_reviewed_at ?? '0000-00-00')
        const bl = String(b.last_reviewed_at ?? '0000-00-00')
        if (al !== bl) return al < bl ? -1 : 1
        return String(a.path) < String(b.path) ? -1 : String(a.path) > String(b.path) ? 1 : 0
      })
    } else if (sortBy === 'oldest' || sortBy === 'newest') {
      due.sort((a, b) => {
        const al = String(a.last_reviewed_at ?? '0000-00-00')
        const bl = String(b.last_reviewed_at ?? '0000-00-00')
        if (al !== bl) return sortBy === 'newest' ? (al < bl ? 1 : -1) : (al < bl ? -1 : 1)
        return String(a.path) < String(b.path) ? -1 : String(a.path) > String(b.path) ? 1 : 0
      })
    } else if (sortBy === 'difficulty_asc' || sortBy === 'difficulty_desc') {
      const reverse = sortBy === 'difficulty_desc'
      due.sort((a, b) => {
        const ar = difficultyRank[String(a.difficulty).toLowerCase()] ?? 2
        const br = difficultyRank[String(b.difficulty).toLowerCase()] ?? 2
        if (ar !== br) return reverse ? br - ar : ar - br
        return String(a.path) < String(b.path) ? -1 : String(a.path) > String(b.path) ? 1 : 0
      })
    } else {
      due.sort((a, b) => {
        const at = String(a.title).toLowerCase()
        const bt = String(b.title).toLowerCase()
        if (at !== bt) return at < bt ? -1 : 1
        return String(a.path) < String(b.path) ? -1 : String(a.path) > String(b.path) ? 1 : 0
      })
    }

    const selected = due.slice(0, limit)
    const selection: Record<string, unknown> = {
      review_state: reviewState,
      sort: sortBy,
      match: matchMode,
      limit,
    }
    const selEntries: Array<[string, Set<string> | Set<number>]> = [
      ['subjects', subjectsFilter],
      ['notes', notesFilter],
      ['tags', tagsFilter],
      ['exclude_paths', excludePaths],
      ['concepts', conceptsFilter],
      ['difficulties', difficultiesFilter],
      ['review_levels', reviewLevelsFilter],
    ]
    for (const [key, values] of selEntries) {
      if (values.size > 0) selection[key] = [...values].sort()
    }
    if (folder) selection.folder = folder
    if (minLevel !== null) selection.min_review_level = minLevel
    if (maxLevel !== null) selection.max_review_level = maxLevel

    return ok({
      vault_path: vault,
      date: today,
      count: selected.length,
      available_count: due.length,
      subjects: [...subjects].sort(),
      due: selected,
      selection,
    })
  } catch (error) {
    return err('DUE_REVIEWS_FAILED', errorMessage(error))
  }
}

/** Validate an optional integer in `[0, 5]`; returns the value or null. */
function integerInRange(value: unknown, key: string): number | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 5) {
    throw new Error(`${key} must be an integer from 0 to 5`)
  }
  return value
}

/** The `record` action: advance one review and update frontmatter. */
function recordReview(args: StudyData, env: HandlerEnv): StudyEnvelope {
  try {
    const vault = resolveVaultPath(args.vault_path, env.vaultPath)
    const noteRef = String(args.note || '').trim()
    if (!noteRef) return err('MISSING_NOTE', 'note is required')

    let note: StudyNote
    let warnings: string[]
    try {
      ;({ note, warnings } = readNoteFile(vault, noteRef))
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'NOTE_AMBIGUOUS') {
        const matches = ((error as unknown as { details?: { matches?: string[] } }).details?.matches ?? [])
        return err('NOTE_AMBIGUOUS', `More than one note matched ${JSON.stringify(noteRef)}`, { matches })
      }
      return err('NOTE_NOT_FOUND', `Note not found: ${noteRef}`)
    }

    const frontmatter = note.frontmatter ?? {}
    const oldRl = Number.isFinite(Number(frontmatter.review_level)) ? Math.trunc(Number(frontmatter.review_level)) : 0
    const oldCount = Number.isFinite(Number(frontmatter.review_count)) ? Math.trunc(Number(frontmatter.review_count)) : 0
    let result = args.result
    if (result === null || result === undefined) {
      result = Boolean(args.passed ?? true) ? 'correct' : 'incorrect'
    }
    if (result !== 'correct' && result !== 'partial' && result !== 'incorrect') {
      return err('VALIDATION_FAILED', 'result must be correct, partial, or incorrect')
    }
    const passed = result === 'correct'
    const newRl = automaticReviewLevel(oldRl, result)
    const next = calculateNextReview({ reviewCount: oldCount, reviewLevel: newRl, passed, today: todayIso(env) })

    const path = safeRelativePath(vault, note.path)
    upsertFrontmatterField(path, 'last_reviewed_at', todayIso(env))
    upsertFrontmatterField(path, 'next_review_at', next.nextReviewAt)
    upsertFrontmatterField(path, 'review_count', next.reviewCount)
    if (newRl !== oldRl) upsertFrontmatterField(path, 'review_level', newRl)
    invalidateCaches(vault)

    let errorResult: Record<string, unknown> | null = null
    if (!passed && args.log_error) {
      const occurred = parseDateOr(args.occurred_on, todayIso(env))
      const concepts = asList(args.concepts).map(stripWikilink)
      const block = [
        `### ${occurred} ${note.title} (复习错误)`,
        recordField('Source', note.path),
        recordField('Concepts', concepts.map(item => `[[${item}]]`).join(', ')),
        recordField('Cause', String(args.cause || '未分类').trim()),
        recordField('Severity', args.severity || 'medium'),
        recordField('Next action', `明日重做 (Ebbinghaus reset, next=${next.nextReviewAt})`),
        '',
        String(args.detail || '').trim() || '（复习未通过，间隔重置为 1 天）',
        '',
      ].join('\n')
      const month = occurred.slice(0, 7)
      const errPath = `${studyDir(vault)}/errors/${month}.md`
      if (!existsSync(errPath)) writeText(errPath, `# Study OS Error Log ${month}\n\n`)
      appendErrorText(errPath, block)
      errorResult = { path: errPath.startsWith(`${vault}/`) ? errPath.slice(vault.length + 1) : errPath }
    }

    return ok({
      path: note.path,
      title: note.title,
      passed,
      review_level: { old: oldRl, new: newRl },
      review_count: { old: oldCount, new: next.reviewCount },
      last_reviewed_at: todayIso(env),
      next_review_at: next.nextReviewAt,
      error_logged: errorResult,
    }, warnings)
  } catch (error) {
    return err('RECORD_REVIEW_FAILED', errorMessage(error))
  }
}

/** The `submit` action: record an attempt then a review, rolling back on failure. */
function submitReview(args: StudyData, env: HandlerEnv): StudyEnvelope {
  let vault: string | null = null
  let notePath: string | null = null
  let originalNote: string | null = null
  let attemptPath: string | null = null
  let attemptId: string | null = null
  try {
    vault = resolveVaultPath(args.vault_path, env.vaultPath)
    const project = readProjectManifestFor(vault, args.project_id)
    const noteRefs = [args.note, args.path, args.item_id]
      .filter(value => value !== null && value !== undefined && String(value).trim() !== '')
      .map(value => String(value).trim())
    if (Array.isArray(args.notes)) {
      noteRefs.push(...args.notes.map(value => String(value).trim()).filter(Boolean))
    }
    const uniqueRefs = [...new Set(noteRefs)]
    if (uniqueRefs.length === 0) return err('VALIDATION_FAILED', 'review.submit requires data.note')
    if (uniqueRefs.length !== 1) return err('VALIDATION_FAILED', 'review.submit accepts exactly one reviewed note')
    const noteRef = uniqueRefs[0] as string

    let note: StudyNote
    try {
      ;({ note } = readNoteFile(vault, noteRef))
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'NOTE_AMBIGUOUS') return err('NOTE_AMBIGUOUS', `More than one note matched ${JSON.stringify(noteRef)}`)
      return err('NOTE_NOT_FOUND', `Note not found: ${noteRef}`)
    }
    if (note.layer !== 'example') return err('NOT_REVIEW_ITEM', 'Only example notes can be submitted for review')

    const result = String(args.result || '').trim()
    if (result !== 'correct' && result !== 'partial' && result !== 'incorrect') {
      return err('VALIDATION_FAILED', 'result must be correct, partial, or incorrect')
    }
    const duration = args.duration_seconds
    if (typeof duration !== 'number' || !Number.isInteger(duration) || duration < 0) {
      return err('VALIDATION_FAILED', 'duration_seconds must be a non-negative integer')
    }
    const occurredAt = String(args.occurred_at || nowIso(env)).trim()

    notePath = safeRelativePath(vault, note.path)
    originalNote = readFileSync(notePath, 'utf8')

    const attemptArgs: StudyData = {
      vault_path: vault,
      project_id: project.project_id,
      attempt_id: args.attempt_id,
      item_id: note.path,
      occurred_at: occurredAt,
      response: args.response,
      result,
      score: { correct: 1.0, partial: 0.5, incorrect: 0.0 }[result as 'correct' | 'partial' | 'incorrect'],
      duration_seconds: duration,
      hints_used: args.hints_used ?? 0,
      evaluator: args.evaluator,
      assistance: args.assistance,
      transfer_level: args.transfer_level ?? 'execution',
      concepts: note.concepts ?? [],
      patterns: note.patterns ?? [],
      objective_ids: args.objective_ids ?? [],
      diagnoses: args.diagnoses ?? [],
      source_anchors: args.source_anchors,
      artifact_refs: args.artifact_refs,
      activity_kind: args.activity_kind ?? 'review',
      source: note.path,
      session_id: args.session_id,
    }
    const attemptEnvelope = recordAttempt(attemptArgs, env)
    if (!attemptEnvelope.ok) return attemptEnvelope
    const attempt = (attemptEnvelope.data.attempt ?? {}) as Record<string, unknown>
    attemptId = String(attempt.attempt_id)
    attemptPath = String(attemptEnvelope.data.path ?? '')

    // With a valid note reference and result, `recordReview` deterministically
    // succeeds; genuine compound-write failures throw and are rolled back below.
    const reviewEnvelope = recordReview({
      vault_path: vault,
      note: note.path,
      result,
      log_error: false,
      detail: args.detail,
    }, env) as StudyOkEnvelope

    const completedToday = completedReviewsForLocalDate(vault, project.project_id, String(project.timezone), occurredAt)
    return ok({
      attempt,
      review: reviewEnvelope.data,
      completed_today_increment: 1,
      completed_today: completedToday,
    }, reviewEnvelope.warnings)
  } catch (error) {
    if (vault !== null && notePath !== null && originalNote !== null) {
      try {
        writeFileSync(notePath, originalNote, 'utf8')
        if (attemptPath && attemptId) removeAttempt(vault, attemptPath, attemptId)
      } catch {
        // Rollback best-effort; the original error is the one reported.
      }
    }
    return err('REVIEW_SUBMISSION_FAILED', errorMessage(error))
  }
}

/** Count review attempts completed on a local date in the project timezone. */
function completedReviewsForLocalDate(vault: string, projectId: string, timezone: string, occurredAt: string): number {
  const attempts = allAttemptsFor(vault, projectId)
  const targetDate = localDateOf(occurredAt, timezone)
  let completed = 0
  for (const attempt of attempts) {
    if (attempt.activity_kind !== 'review' || typeof attempt.occurred_at !== 'string') continue
    if (localDateOf(attempt.occurred_at, timezone) === targetDate) completed += 1
  }
  return completed
}

/** The local `YYYY-MM-DD` of an ISO datetime in a timezone (best-effort). */
function localDateOf(iso: string, timezone: string): string {
  const date = new Date(iso.replace(/Z$/, '+00:00'))
  if (Number.isNaN(date.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes): string => parts.find(part => part.type === type)?.value ?? '0'
  return `${value('year')}-${value('month')}-${value('day')}`
}

/** The `create_task` action: append a review-task line. */
function createTask(args: StudyData, env: HandlerEnv): StudyEnvelope {
  try {
    const vault = resolveVaultPath(args.vault_path, env.vaultPath)
    const due = parseDateOr(args.due_date, shiftDate(todayIso(env), 1))
    const title = String(args.title || args.source_note || '复习任务').trim()
    const priority = String(args.priority || 'medium').trim()
    const status = String(args.status || 'todo').trim()
    const concepts = asList(args.concepts).map(stripWikilink)
    const patterns = asList(args.patterns).map(stripWikilink)
    const source = String(args.source_note || '').trim()
    const reviewLevel = args.review_level ?? ''
    const reason = String(args.reason || '').trim()
    let line = `- [ ] ${title} due:${due} priority:${priority} status:${status} `
      + `review_level:${reviewLevel === '' ? '-' : reviewLevel} `
      + `source:${source || '-'} `
      + `concepts:${concepts.join(';') || '-'} `
      + `patterns:${patterns.join(';') || '-'}`
    if (reason) line += ` reason:${reason}`
    const path = `${studyDir(vault)}/review_tasks.md`
    if (!existsSync(path)) writeText(path, '# Study OS Review Tasks\n\n')
    appendErrorText(path, `${line}\n`)
    return ok({ vault_path: vault, path: relativePathOf(vault, path), title, due_date: due })
  } catch (error) {
    return err('CREATE_REVIEW_TASK_FAILED', errorMessage(error))
  }
}

/** The `stats` action: spacing-coverage stats with a disk cache. */
function reviewStats(args: StudyData, env: HandlerEnv): StudyEnvelope {
  try {
    const vault = resolveVaultPath(args.vault_path, env.vaultPath)
    const rebuild = Boolean(args.rebuild)
    const cachePath = `${studyDir(vault)}/review_stats.json`
    if (!rebuild && existsSync(cachePath)) {
      try {
        const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, unknown>
        if (cached.semantics === 'spacing_coverage.v1') return ok({ cached: true, ...cached })
      } catch {
        // Fall through to rebuild.
      }
    }
    const notes = listMarkdownNotes(vault)
    const stats = buildReviewStats(notes, { today: todayIso(env), builtAtIso: env.now().toISOString() })
    writeFileSync(cachePath, `${JSON.stringify(stats)}\n`, 'utf8')
    return ok({ cached: false, ...stats })
  } catch (error) {
    return err('REVIEW_STATS_FAILED', errorMessage(error))
  }
}

/** The `weekly_report` action. */
function weeklyReport(args: StudyData, env: HandlerEnv): StudyEnvelope {
  try {
    const vault = resolveVaultPath(args.vault_path, env.vaultPath)
    const today = todayIso(env)
    const defaultStart = shiftDate(today, -weekdayOf(today))
    const start = parseDateOr(args.start_date, defaultStart)
    const end = parseDateOr(args.end_date, shiftDate(start, 6))
    if (end < start) return err('INVALID_DATE_RANGE', 'end_date must be on or after start_date')

    const errors = collectErrorRecords(vault, start, end)
    const tasks = collectReviewTasks(vault, start, end)
    const causes = frequency(errors.map(record => record.cause || '未分类'))
    const severities = frequency(errors.map(record => record.severity || 'medium'))
    const clusters = clusterErrors(errors)

    const week = isoWeekOf(start)
    const weekLabel = `${week.year}-W${String(week.week).padStart(2, '0')}`
    const reportPath = `${studyDir(vault)}/reports/${weekLabel}.md`
    const lines = [
      `# Study OS Weekly Report ${weekLabel}`,
      '',
      `- Range: ${start} to ${end}`,
      `- Errors logged: ${errors.length}`,
      `- Review tasks in range: ${tasks.length}`,
      '',
    ]

    lines.push('## Error Causes', '')
    if (causes.length > 0) lines.push(...causes.map(([cause, count]) => `- ${cause}: ${count}`))
    else lines.push('- No errors logged.')

    lines.push('', '## Error Patterns (cause × concept)', '')
    if (clusters.pairs.length > 0) {
      lines.push('| Cause | Concept | Count |', '|-------|---------|-------|')
      lines.push(...clusters.pairs.slice(0, 20).map(pair => `| ${pair.cause} | [[${pair.concept}]] | ${pair.count} |`))
    } else {
      lines.push('- No clustered errors.')
    }

    if (clusters.repeated.length > 0) {
      lines.push('', '## ⚠️ Repeated Patterns (≥3 occurrences, same cause + concept)', '')
      for (const pair of clusters.repeated) {
        lines.push(
          `- **${pair.cause}** on **[[${pair.concept}]]** — ${pair.count} 次. `
          + `建议：检查 /Box 中 \`[[${pair.concept}]]\` 概念卡是否清晰，`
          + '创建专项复习任务重做相关例题。',
        )
      }
    }

    if (clusters.deepConfusion.length > 0) {
      lines.push('', '## 🔴 Deep Confusion (same concept, multiple causes)', '')
      for (const item of clusters.deepConfusion) {
        lines.push(
          `- **[[${item.concept}]]** 出现 ${item.cause_count} 种不同错因：${item.causes.join(', ')}. `
          + '这可能表明该概念的多个侧面都未掌握，建议从定义层重新梳理。',
        )
      }
    }

    lines.push('', '## Severity', '')
    if (severities.length > 0) lines.push(...severities.map(([severity, count]) => `- ${severity}: ${count}`))
    else lines.push('- No severity data.')

    lines.push('', '## Error Records', '')
    if (errors.length > 0) lines.push(...errors.map(record => `- ${record.date} ${record.title} (${record.cause || '未分类'})`))
    else lines.push('- No error records in this range.')

    lines.push('', '## Review Tasks', '')
    if (tasks.length > 0) lines.push(...tasks)
    else lines.push('- No review tasks in this range.')

    lines.push(
      '', '## Next Focus', '',
      '- 优先处理 Repeated Patterns 中的概念。',
      '- Deep Confusion 的概念建议回到 /Box 重新梳理定义层。',
      '- Overdue 复习任务优先于新任务。',
      '',
    )
    writeTextFile(reportPath, lines.join('\n'))
    return ok({
      vault_path: vault,
      path: relativePathOf(vault, reportPath),
      error_count: errors.length,
      task_count: tasks.length,
      causes: causes,
      clusters,
    })
  } catch (error) {
    return err('GENERATE_WEEKLY_REPORT_FAILED', errorMessage(error))
  }
}

/** The `export_anki` action. */
function exportAnki(args: StudyData, env: HandlerEnv): StudyEnvelope {
  try {
    const vault = resolveVaultPath(args.vault_path, env.vaultPath)
    const limit = limitFrom(args.limit, 30)
    const includeErrors = Boolean(args.include_errors ?? true)
    const candidates: Array<{ front: string; back: string; tags: string }> = []

    const query = typeof args.query === 'string' ? args.query : undefined
    const tag = typeof args.tag === 'string' ? args.tag : undefined
    const layer = typeof args.layer === 'string' ? args.layer : undefined
    for (const note of listMarkdownNotes(vault)) {
      if (!matchesNote(note, query, tag, layer)) continue
      const concepts = (note.concepts ?? []).slice(0, 3).join(', ')
      const front = `${note.title} 的核心辨析点是什么？`
      let back = `候选来源：[[${note.path.replace(/\.md$/, '')}]]`
      if (concepts) back += `\n关联概念：${concepts}`
      candidates.push({ front, back, tags: 'StudyOS Obsidian' })
      if (candidates.length >= limit) break
    }

    if (includeErrors && candidates.length < limit) {
      const start = parseDateOr(args.start_date, shiftDate(todayIso(env), -30))
      const end = parseDateOr(args.end_date, todayIso(env))
      for (const record of collectErrorRecords(vault, start, end)) {
        candidates.push({
          front: `错因复盘：${record.title || '学习错误'} 的错误原因是什么？`,
          back: `错因：${record.cause || '未分类'}\n下一步：${record['next action'] || '-'}`,
          tags: 'StudyOS 错题',
        })
        if (candidates.length >= limit) break
      }
    }

    const exported = todayIso(env)
    const path = `${studyDir(vault)}/anki_candidates/${exported}.md`
    const lines = [
      `# Study OS Anki Candidates ${exported}`,
      '',
      'These are candidates. Review before moving them into source notes or importing with obsidian-to-anki.',
      '',
    ]
    candidates.forEach((card, index) => {
      lines.push(
        `## Candidate ${index + 1}`,
        '',
        'START',
        '问答题',
        `正面: ${card.front}`,
        `背面: ${card.back}`,
        `Tags: ${card.tags}`,
        'END',
        '',
      )
    })
    writeTextFile(path, lines.join('\n'))
    return ok({ vault_path: vault, path: relativePathOf(vault, path), count: candidates.length })
  } catch (error) {
    return err('EXPORT_ANKI_CANDIDATES_FAILED', errorMessage(error))
  }
}

// ---- shared helpers used across review actions ----

function readProjectManifestFor(vault: string, projectId: unknown) {
  return readProjectManifest(vault, projectId)
}

function allAttemptsFor(vault: string, projectId: string) {
  return allAttempts(vault, projectId)
}

function recordField(name: string, value: unknown): string {
  const rendered = String(value ?? '').trim()
  return `- ${name}: ${rendered || '-'}`
}

function invalidateCaches(vault: string): void {
  try { unlinkSync(`${studyDir(vault)}/review_stats.json`) } catch { /* absent */ }
  try { unlinkSync(`${studyDir(vault)}/concept_graph.json`) } catch { /* absent */ }
}

function appendErrorText(path: string, content: string): void {
  appendText(path, content)
}

function writeTextFile(path: string, content: string): void {
  writeText(path, content)
}

function removeAttempt(vault: string, relativePath: string, attemptId: string): void {
  const path = `${vault}/${relativePath}`
  const kept = readFileSync(path, 'utf8').split('\n')
    .filter(line => line.trim() && (JSON.parse(line).attempt_id !== attemptId))
  if (kept.length > 0) writeFileSync(path, `${kept.join('\n')}\n`, 'utf8')
  else unlinkSync(path)
}

function relativePathOf(vault: string, path: string): string {
  return path.slice(vault.length + 1)
}

function nowIso(env: HandlerEnv): string {
  return toIsoSeconds(env.now()).replace(/\.\d{3}Z$/, 'Z')
}

function shiftDate(value: string, days: number): string {
  const parsed = new Date(`${value}T00:00:00Z`)
  return new Date(parsed.getTime() + days * 86_400_000).toISOString().slice(0, 10)
}

function weekdayOf(value: string): number {
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isNaN(parsed.getTime()) ? 0 : (parsed.getUTCDay() + 6) % 7
}

function isoWeekOf(value: string): { year: number; week: number } {
  const date = new Date(`${value}T00:00:00Z`)
  // ISO-8601 week: Thursday is the anchor day; week 1 contains the first Thursday.
  const day = date.getUTCDay() || 7
  const thursday = new Date(date.getTime() + (4 - day) * 86_400_000)
  const year = thursday.getUTCFullYear()
  const firstThursday = new Date(Date.UTC(year, 0, 1))
  const firstThursdayDay = firstThursday.getUTCDay() || 7
  const firstIsoThursday = new Date(firstThursday.getTime() + (4 - firstThursdayDay) * 86_400_000)
  const week = Math.floor((thursday.getTime() - firstIsoThursday.getTime()) / (7 * 86_400_000)) + 1
  return { year, week }
}

function frequency(values: string[]): Array<[string, number]> {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

function clusterErrors(errors: Array<Record<string, string>>): {
  pairs: Array<{ cause: string; concept: string; count: number }>
  repeated: Array<{ cause: string; concept: string; count: number }>
  deepConfusion: Array<{ concept: string; causes: string[]; cause_count: number }>
} {
  const causeConcept = new Map<string, { cause: string; concept: string; count: number }>()
  const conceptCauses = new Map<string, Set<string>>()
  for (const record of errors) {
    const cause = (record.cause || '未分类').trim()
    const names = (record.concepts ?? '')
      .replace(/\[\[/g, '').replace(/\]\]/g, '')
      .split(',').map(item => item.trim()).filter(Boolean)
    for (const name of names) {
      const key = `${cause}\u0000${name}`
      const existing = causeConcept.get(key)
      if (existing) existing.count += 1
      else causeConcept.set(key, { cause, concept: name, count: 1 })
      if (!conceptCauses.has(name)) conceptCauses.set(name, new Set())
      conceptCauses.get(name)!.add(cause)
    }
  }
  const pairs = [...causeConcept.values()].sort((a, b) => b.count - a.count)
  const repeated = pairs.filter(pair => pair.count >= 3)
  const deepConfusion = [...conceptCauses.entries()]
    .filter(([, causes]) => causes.size >= 2)
    .map(([concept, causes]) => ({ concept, causes: [...causes].sort(), cause_count: causes.size }))
  return { pairs, repeated, deepConfusion }
}

function collectReviewTasks(vault: string, start: string, end: string): string[] {
  const path = `${studyDir(vault)}/review_tasks.md`
  if (!existsSync(path)) return []
  const tasks: string[] = []
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.startsWith('- [')) continue
    const dueMatch = /due:(\d{4}-\d{2}-\d{2})/.exec(line)
    if (dueMatch && (dueMatch[1]! < start || dueMatch[1]! > end)) continue
    tasks.push(line)
  }
  return tasks
}

function collectErrorRecords(vault: string, start: string, end: string): Array<Record<string, string>> {
  const records: Array<Record<string, string>> = []
  const root = `${studyDir(vault)}/errors`
  let names: string[]
  try {
    names = readdirSync(root).filter(name => name.endsWith('.md')).sort()
  } catch {
    return []
  }
  for (const name of names) {
    const text = readFileSync(`${root}/${name}`, 'utf8')
    let current: Record<string, string> | null = null
    for (const line of text.split(/\r?\n/)) {
      const heading = /^###\s+(\d{4}-\d{2}-\d{2})\s+(.+)$/.exec(line)
      if (heading) {
        if (current) records.push(current)
        current = { date: heading[1] ?? '', title: (heading[2] ?? '').trim(), file: name }
        continue
      }
      if (current && line.startsWith('- ') && line.includes(':')) {
        const key = (line.slice(2).split(':', 1)[0] ?? '').trim().toLowerCase()
        current[key] = line.slice(2 + key.length + 1).trim()
      }
    }
    if (current) records.push(current)
  }
  return records.filter(record => record.date !== '' && start <= record.date! && record.date! <= end)
}

function errorMessage(error: unknown): string {
  return String((error as Error).message ?? error)
}
