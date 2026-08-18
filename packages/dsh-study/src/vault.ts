/**
 * StudyOS vault path resolution and I/O. Every path helper returns an absolute path string,
 * guards every resolve against escaping the vault, and maps filesystem failures onto the
 * stable {@link StudyOSError} codes the model boundary expects.
 * @module @puji4810/dsh-study/vault
 */

import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { PROJECT_ID_PATTERN, SCHEDULE_ID_PATTERN } from './constants.ts'
import { StudyOSError } from './errors.ts'
import { parseNoteMarkdown, resolveNoteRef } from './notes.ts'
import type { StudyAttempt, StudyData, StudyNote, StudyProject, StudySchedule } from './types.ts'
import { validateStudyProject, validateStudySchedule } from './validate.ts'

const PROJECT_ID_RE = new RegExp(PROJECT_ID_PATTERN)
const SCHEDULE_ID_RE = new RegExp(SCHEDULE_ID_PATTERN)

/** The StudyOS state directory name inside a vault. */
const STUDY_DIR_NAME = '.StudyOS'

/** True for a non-null, non-array object (plain-object check). */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Expand a leading `~` to the current user's home directory. */
function expanduser(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith(`~${sep}`) || value.startsWith('~/')) return `${homedir()}${value.slice(1)}`
  return value
}

/** Whether `candidate` resolves strictly inside `base` (not equal, no ancestor escape). */
function isInside(candidate: string, base: string): boolean {
  const relativePath = relative(base, candidate)
  return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath)
}

/** Whether an error is an ENOENT filesystem error. */
function isEnoent(error: unknown): boolean {
  return isObject(error) && String((error)['code']) === 'ENOENT'
}

/** Create a directory recursively (no-op when it already exists). */
function mkdirRecursive(path: string): string {
  mkdirSync(path, { recursive: true })
  return path
}

/**
 * Resolve the StudyOS vault to an absolute, existing directory path.
 * @param explicit - an explicit path override; a non-empty string wins over the config value.
 * @param defaultVaultPath - the current workspace path or configured fallback.
 * @returns the resolved absolute vault directory path.
 */
export function resolveVaultPath(explicit: unknown, defaultVaultPath?: string): string {
  const value = typeof explicit === 'string' && explicit.trim() !== '' ? explicit : defaultVaultPath
  if (value === undefined || value.trim() === '') {
    throw new StudyOSError(
      'VALIDATION_FAILED',
      'StudyOS needs a dsh workspace, a configured vaultPath fallback, or an explicit vault_path.',
    )
  }
  const path = resolve(expanduser(value))
  let isDirectory = false
  try {
    isDirectory = statSync(path).isDirectory()
  } catch {
    isDirectory = false
  }
  if (!isDirectory) {
    throw new StudyOSError(
      'NOT_FOUND',
      `StudyOS Vault not found: ${path}. Open a dsh workspace, configure studyos.vaultPath, or pass vault_path explicitly.`,
    )
  }
  return path
}

/**
 * The vault-owned StudyOS state directory, created on demand.
 * @param vault - the resolved vault path.
 * @returns the absolute `.StudyOS` directory path.
 */
export function studyDir(vault: string): string {
  const root = resolve(vault, STUDY_DIR_NAME)
  if (!isInside(root, resolve(vault, '.')) || relative(vault, root).startsWith('..')) {
    throw new StudyOSError('VALIDATION_FAILED', 'StudyOS state path escapes Vault')
  }
  return mkdirRecursive(root)
}

/**
 * The projects root directory for a vault.
 * @param vault - the resolved vault path.
 * @returns the absolute projects root path.
 */
export function projectsRoot(vault: string): string {
  return mkdirRecursive(resolve(studyDir(vault), 'projects'))
}

/**
 * The active-project pointer file path.
 * @param vault - the resolved vault path.
 * @returns the absolute active.json path.
 */
export function activeProjectPath(vault: string): string {
  return resolve(projectsRoot(vault), 'active.json')
}

/**
 * A project's directory, created on demand and guarded against escaping the vault.
 * @param vault - the resolved vault path.
 * @param projectId - the project id.
 * @returns the absolute project directory path.
 */
export function projectDir(vault: string, projectId: string): string {
  const id = validateProjectId(projectId)
  const base = resolve(projectsRoot(vault), '.')
  const path = resolve(base, id)
  if (!isInside(path, base)) {
    throw new StudyOSError('VALIDATION_FAILED', `Project path escapes vault: ${projectId}`)
  }
  return mkdirRecursive(path)
}

/**
 * The manifest file for a project.
 * @param vault - the resolved vault path.
 * @param projectId - the project id.
 * @returns the absolute manifest.json path.
 */
export function projectManifestPath(vault: string, projectId: string): string {
  return resolve(projectDir(vault, projectId), 'manifest.json')
}

/**
 * The prompt-summary file for a project.
 * @param vault - the resolved vault path.
 * @param projectId - the project id.
 * @returns the absolute prompt_summary.md path.
 */
export function promptSummaryPath(vault: string, projectId: string): string {
  return resolve(projectDir(vault, projectId), 'prompt_summary.md')
}

/**
 * The schedules directory for a project, created on demand.
 * @param vault - the resolved vault path.
 * @param projectId - the project id.
 * @returns the absolute schedules directory path.
 */
export function scheduleDir(vault: string, projectId: string): string {
  return mkdirRecursive(resolve(projectDir(vault, projectId), 'schedules'))
}

/**
 * The schedule file for a project and schedule id.
 * @param vault - the resolved vault path.
 * @param projectId - the project id.
 * @param scheduleId - the schedule id.
 * @returns the absolute schedule.json path.
 */
export function schedulePath(vault: string, projectId: string, scheduleId: string): string {
  return resolve(scheduleDir(vault, projectId), `${validateScheduleId(scheduleId)}.json`)
}

/**
 * The activity directory for a project, created on demand.
 * @param vault - the resolved vault path.
 * @param projectId - the project id.
 * @returns the absolute activity directory path.
 */
export function activityDir(vault: string, projectId: string): string {
  return mkdirRecursive(resolve(projectDir(vault, projectId), 'activity'))
}

/**
 * The monthly attempt file for a timestamp's `YYYY-MM` month.
 * @param vault - the resolved vault path.
 * @param projectId - the project id.
 * @param occurredAt - an ISO datetime whose first seven characters name the month.
 * @returns the absolute attempts-YYYY-MM.jsonl path.
 */
export function attemptPathFor(vault: string, projectId: string, occurredAt: string): string {
  const month = occurredAt.slice(0, 7)
  return resolve(activityDir(vault, projectId), `attempts-${month}.jsonl`)
}

/**
 * The plan-proposals directory for a project, optionally created.
 * @param vault - the resolved vault path.
 * @param projectId - the project id.
 * @param create - create the directory when true (default).
 * @returns the absolute plan-proposals directory path.
 */
export function planProposalDir(vault: string, projectId: string, create = true): string {
  const path = resolve(projectDir(vault, projectId), 'plan-proposals')
  return create ? mkdirRecursive(path) : path
}

/**
 * The pattern-proposals directory for a project, created on demand.
 * @param vault - the resolved vault path.
 * @param projectId - the project id.
 * @returns the absolute pattern-proposals directory path.
 */
export function patternProposalDir(vault: string, projectId: string): string {
  return mkdirRecursive(resolve(projectDir(vault, projectId), 'pattern-proposals'))
}

/**
 * The sessions directory for a project, created on demand.
 * @param vault - the resolved vault path.
 * @param projectId - the project id.
 * @returns the absolute sessions directory path.
 */
export function sessionsDir(vault: string, projectId: string): string {
  return mkdirRecursive(resolve(projectDir(vault, projectId), 'sessions'))
}

/**
 * The runtime binding index file under the study state directory.
 * @param vault - the resolved vault path.
 * @returns the absolute active-sessions.json path.
 */
export function runtimeIndexPath(vault: string): string {
  return resolve(studyDir(vault), 'runtime', 'active-sessions.json')
}

/**
 * The decisions directory for a project, created on demand.
 * @param vault - the resolved vault path.
 * @param projectId - the project id.
 * @returns the absolute decisions directory path.
 */
export function decisionsDir(vault: string, projectId: string): string {
  return mkdirRecursive(resolve(projectDir(vault, projectId), 'decisions'))
}

/**
 * The learning-records directory for a project, created on demand.
 * @param vault - the resolved vault path.
 * @param projectId - the project id.
 * @returns the absolute learning-records directory path.
 */
export function learningRecordsDir(vault: string, projectId: string): string {
  return mkdirRecursive(resolve(projectDir(vault, projectId), 'learning-records'))
}

/**
 * The lessons directory for a project, created on demand.
 * @param vault - the resolved vault path.
 * @param projectId - the project id.
 * @returns the absolute lessons directory path.
 */
export function lessonsDir(vault: string, projectId: string): string {
  return mkdirRecursive(resolve(projectDir(vault, projectId), 'lessons'))
}

/**
 * Read a text file, mapping a missing file onto `NOT_FOUND`.
 * @param path - the absolute file path.
 * @returns the file contents.
 */
export function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (isEnoent(error)) throw new StudyOSError('NOT_FOUND', String(error))
    throw error
  }
}

/**
 * Write text to a file, creating parent directories.
 * @param path - the absolute file path.
 * @param content - the content to write.
 */
export function writeText(path: string, content: string): void {
  mkdirSync(dirnameOf(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

/**
 * Append text to a file, ensuring a newline separator before the appended content.
 * @param path - the absolute file path.
 * @param content - the content to append.
 */
export function appendText(path: string, content: string): void {
  mkdirSync(dirnameOf(path), { recursive: true })
  let existing = ''
  if (existsSync(path) && statSync(path).size > 0) {
    existing = readFileSync(path, 'utf8')
  }
  if (existing !== '' && !existing.endsWith('\n')) existing += '\n'
  writeFileSync(path, existing + content, 'utf8')
}

/**
 * Read at most `limit` characters from a file without reading the whole file.
 * @param path - the absolute file path.
 * @param limit - the character ceiling.
 * @returns the leading text, empty when the limit is not positive.
 */
export function readTextPrefix(path: string, limit: number): string {
  if (limit <= 0) return ''
  const content = readFileSync(path, 'utf8')
  return content.slice(0, limit)
}

/**
 * Read and parse a JSON file into a typed value with stable error mapping.
 * @param path - the absolute file path.
 * @returns the parsed value.
 */
export function readJsonFile<T = Record<string, unknown>>(path: string): T {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (isEnoent(error)) throw new StudyOSError('NOT_FOUND', String(error))
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new StudyOSError('VALIDATION_FAILED', `Invalid JSON in ${basename(path)}`)
  }
  if (!isObject(parsed)) {
    throw new StudyOSError('VALIDATION_FAILED', `${basename(path)} must contain a JSON object`)
  }
  return parsed as T
}

/**
 * Atomically write a JSON value: same-directory temp file, then rename over the target.
 * @param path - the absolute file path.
 * @param value - the JSON-serializable value.
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirnameOf(path), { recursive: true })
  const temporary = join(dirnameOf(path), `.${basename(path)}.${randomUUID()}.tmp`)
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    renameSync(temporary, path)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The temp file never landed; nothing to clean.
    }
    throw error
  }
}

/**
 * Read a JSONL file into records, validating each non-blank line.
 * @param path - the absolute file path.
 * @returns the parsed records.
 */
export function readJsonl(path: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = []
  if (!existsSync(path)) return records
  const name = basename(path)
  const text = readFileSync(path, 'utf8')
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (!line.trim()) continue
    const lineNumber = index + 1
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new StudyOSError('VALIDATION_FAILED', `Invalid activity JSON at ${name}:${lineNumber}`)
    }
    if (!isObject(value)) {
      throw new StudyOSError('VALIDATION_FAILED', `Activity record at ${name}:${lineNumber} must be an object`)
    }
    records.push(value)
  }
  return records
}

/**
 * Resolve a possibly-relative vault path, guarding against escapes.
 * @param vault - the resolved vault path.
 * @param rel - the relative (or absolute) path; empty resolves to the vault itself.
 * @returns the resolved absolute path.
 */
export function safeRelativePath(vault: string, rel: unknown): string {
  const text = typeof rel === 'string' ? rel.trim() : ''
  if (!text) return vault
  const raw = expanduser(text)
  const candidate = isAbsolute(raw) ? resolve(raw) : resolve(vault, raw)
  if (candidate !== vault && !isInside(candidate, vault)) {
    throw new StudyOSError('VALIDATION_FAILED', `Path escapes vault: ${rel}`)
  }
  return candidate
}

/**
 * Validate a project id against the canonical pattern.
 * @param value - the candidate id.
 * @returns the trimmed id.
 */
export function validateProjectId(value: unknown): string {
  const text = String(value ?? '').trim()
  if (!PROJECT_ID_RE.test(text)) {
    throw new StudyOSError('VALIDATION_FAILED', `project_id must match ${PROJECT_ID_PATTERN}`)
  }
  return text
}

/**
 * Validate a schedule id against the canonical pattern.
 * @param value - the candidate id.
 * @returns the trimmed id.
 */
export function validateScheduleId(value: unknown): string {
  const text = String(value ?? '').trim()
  if (!SCHEDULE_ID_RE.test(text)) {
    throw new StudyOSError('VALIDATION_FAILED', `schedule_id must match ${SCHEDULE_ID_PATTERN}`)
  }
  return text
}

/**
 * Resolve a project id, falling back to the active-project pointer.
 * @param vault - the resolved vault path.
 * @param projectId - an explicit id, or nothing for the active project.
 * @returns the resolved id.
 */
export function resolveProjectId(vault: string, projectId?: unknown): string {
  if (projectId !== undefined && projectId !== null && String(projectId).trim() !== '') {
    return validateProjectId(projectId)
  }
  const activePath = activeProjectPath(vault)
  if (!existsSync(activePath)) {
    throw new StudyOSError('PROJECT_NOT_FOUND', 'No active StudyOS project selected')
  }
  const active = readJsonFile(activePath)
  return validateProjectId(active['project_id'])
}

/**
 * Read and validate a project manifest.
 * @param vault - the resolved vault path.
 * @param projectId - an explicit id, or nothing for the active project.
 * @returns the validated manifest.
 */
export function readProjectManifest(vault: string, projectId?: unknown): StudyProject {
  const id = resolveProjectId(vault, projectId)
  const path = projectManifestPath(vault, id)
  if (!existsSync(path)) {
    throw new StudyOSError('PROJECT_NOT_FOUND', `StudyOS project not found: ${id}`)
  }
  const data = readJsonFile(path)
  const result = validateStudyProject(data)
  if (!result.ok) {
    throw new StudyOSError('VALIDATION_FAILED', result.errors.join('; '))
  }
  if (!isObject(result.value)) {
    throw new StudyOSError('VALIDATION_FAILED', 'Project validator returned invalid data')
  }
  return result.value as unknown as StudyProject
}

/**
 * Write a project manifest, creating its parent directories.
 * @param vault - the resolved vault path.
 * @param manifest - the validated manifest.
 */
export function writeProjectManifest(vault: string, manifest: StudyProject): void {
  writeText(projectManifestPath(vault, manifest.project_id), `${JSON.stringify(manifest, null, 2)}\n`)
}

/**
 * Resolve a project's prompt policy against the shared defaults.
 * @param project - the validated project manifest.
 * @returns the merged prompt policy.
 */
export function promptPolicy(project: StudyProject): StudyData {
  const policy = (project as unknown as Record<string, unknown>)['prompt_policy']
  const defaults: StudyData = {
    base_max_chars: 2000,
    intent_max_chars: 2500,
    domain_max_chars: 2000,
    project_summary_max_chars: 1200,
    total_max_chars: 6000,
    total_max_tokens: 1800,
    updates_apply: 'next_session',
  }
  return { ...defaults, ...(isObject(policy) ? policy : {}) }
}

/**
 * Resolve the shared prompt budgets as `(pool tokens, total max chars)`.
 * @param policy - the merged prompt policy.
 * @returns the token and character pools.
 */
export function promptBudget(policy: StudyData): { poolTokens: number; totalMaxChars: number } {
  return {
    poolTokens: Math.trunc(Number(policy['total_max_tokens'])),
    totalMaxChars: Math.trunc(Number(policy['total_max_chars'])),
  }
}

/**
 * Read every attempt across a project's monthly files, sorted by `(occurred_at, attempt_id)`.
 * @param vault - the resolved vault path.
 * @param projectId - the project id.
 * @returns the sorted attempts.
 */
export function allAttempts(vault: string, projectId: string): StudyAttempt[] {
  const id = validateProjectId(projectId)
  const root = resolve(vault, '.StudyOS', 'projects', id, 'activity')
  if (!isInside(root, vault)) {
    throw new StudyOSError('VALIDATION_FAILED', 'Activity path escapes Vault')
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) return []
  const attempts: StudyAttempt[] = []
  const files = readdirSync(root)
    .filter(name => name.startsWith('attempts-') && name.endsWith('.jsonl'))
    .sort()
  for (const name of files) {
    for (const record of readJsonl(resolve(root, name))) {
      attempts.push(record as unknown as StudyAttempt)
    }
  }
  attempts.sort((a, b) => {
    const aKey = `${String(a.occurred_at ?? '')}\u0000${String(a.attempt_id ?? '')}`
    const bKey = `${String(b.occurred_at ?? '')}\u0000${String(b.attempt_id ?? '')}`
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0
  })
  return attempts
}

/**
 * Append one attempt to its monthly file and return the vault-relative path.
 * @param vault - the resolved vault path.
 * @param projectId - the project id.
 * @param attempt - the validated attempt.
 * @param occurredAt - the attempt's ISO timestamp.
 * @returns the vault-relative attempt file path.
 */
export function appendAttemptFile(
  vault: string,
  projectId: string,
  attempt: StudyAttempt,
  occurredAt: string,
): string {
  const path = attemptPathFor(vault, projectId, occurredAt)
  appendText(path, `${JSON.stringify(attempt)}\n`)
  return relative(vault, path).split(sep).join('/')
}

/**
 * List parsed markdown notes in a vault.
 * @param vault - the resolved vault path.
 * @param options - the optional folder, file glob, and .StudyOS inclusion.
 * @returns the parsed notes.
 */
export function listMarkdownNotes(
  vault: string,
  options?: { folder?: string; fileGlob?: string; includeStudyOs?: boolean },
): StudyNote[] {
  const includeStudyOs = options?.includeStudyOs ?? false
  const root = safeRelativePath(vault, options?.folder)
  if (!existsSync(root)) return []
  const pattern = options?.fileGlob?.trim() || '**/*.md'
  const paths = statSync(root).isDirectory() ? walkMarkdown(root, pattern) : (isMarkdown(root) ? [root] : [])
  const notes: StudyNote[] = []
  for (const path of paths) {
    if (!existsSync(path) || !statSync(path).isFile() || !isMarkdown(path)) continue
    const parts = actualRelative(vault, path).split('/')
    if (parts.some(part => part.startsWith('.')) && !(includeStudyOs && parts[0] === '.StudyOS')) {
      continue
    }
    const size = statSync(path).size
    const modified = new Date(Math.floor(statSync(path).mtimeMs / 1000) * 1000).toISOString().replace(/\.000Z$/, 'Z')
    const raw = readFileSync(path, 'utf8')
    const { note } = parseNoteMarkdown(raw, { path: actualRelative(vault, path), size, modified })
    notes.push(note)
  }
  return notes
}

/** Whether a path has a `.md` suffix (case-insensitive). */
function isMarkdown(path: string): boolean {
  return path.toLowerCase().endsWith('.md')
}

/** The vault-relative slash path of a resolved file. */
function actualRelative(vault: string, path: string): string {
  return relative(vault, path).split(sep).join('/')
}

/**
 * Walk a directory for `.md` files matching a simple glob prefix/suffix pattern.
 * @param root - the root directory.
 * @param pattern - a recursive or single-star glob like `**` + `/` + `*.md`.
 * @returns the sorted matching absolute paths.
 */
function walkMarkdown(root: string, pattern: string): string[] {
  const segments = pattern.split('/').map(segment => segment.trim()).filter(segment => segment && segment !== '')
  const result: string[] = []
  const collect = (directory: string, remaining: string[]): void => {
    if (remaining.length === 0) {
      if (isMarkdown(directory)) result.push(directory)
      return
    }
    const head = remaining[0] ?? ''
    const tail = remaining.slice(1)
    if (head === '**') {
      // `**` matches zero or more directories: try it both as zero (drop the `**`)
      // and as one-or-more (recurse into every child directory keeping the `**`).
      collect(directory, tail)
      for (const entry of listDir(directory)) {
        if (isDirectoryFollowingLinks(entry)) collect(entry, remaining)
      }
      return
    }
    if (head.includes('*')) {
      const prefix = head.split('*', 1)[0] ?? ''
      const suffix = head.split('*').pop() ?? ''
      for (const entry of listDir(directory)) {
        const name = basename(entry)
        if (name.startsWith(prefix) && name.endsWith(suffix)) collect(entry, tail)
      }
      return
    }
    collect(resolve(directory, head), tail)
  }
  collect(root, segments)
  return result.sort()
}

/** List the absolute paths inside a directory, or empty when missing. */
function listDir(directory: string): string[] {
  try {
    return readdirSync(directory).map(name => resolve(directory, name))
  } catch {
    return []
  }
}

/** Whether a path is a directory, following symlinks; a broken link is not a directory. */
function isDirectoryFollowingLinks(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    // Mirrors pathlib `is_dir()`: a dangling symlink is silently not a directory.
    return false
  }
}

/**
 * Resolve a note reference to a single note.
 * @param vault - the resolved vault path.
 * @param ref - the note reference.
 * @param options - whether to include the body.
 * @returns the resolved note and its warnings.
 */
export function readNoteFile(
  vault: string,
  ref: string,
  options?: { includeBody?: boolean },
): { note: StudyNote; warnings: string[] } {
  const notes = listMarkdownNotes(vault)
  const { note, matches } = resolveNoteRef(notes, ref)
  if (note === null && matches.length > 1) {
    throw new StudyOSError(
      'NOTE_AMBIGUOUS',
      `More than one note matched ${JSON.stringify(ref)}`,
      { matches: matches.slice(0, 20).map(match => match.path) },
    )
  }
  if (note === null) {
    throw new StudyOSError('NOTE_NOT_FOUND', `Note not found: ${ref}`)
  }
  const warnings: string[] = []
  if (options?.includeBody) {
    const path = safeRelativePath(vault, note.path)
    note.body = stripFrontmatter(readFileSync(path, 'utf8'))
  }
  return { note, warnings }
}

/** The note body: the raw text after the closing frontmatter fence, or the whole text. */
function stripFrontmatter(raw: string): string {
  const lines = splitLines(raw)
  if (lines.length === 0 || (lines[0] ?? '').trim() !== '---') return raw
  for (let index = 1; index < lines.length; index += 1) {
    if ((lines[index] ?? '').trim() === '---') {
      return lines.slice(index + 1).join('\n')
    }
  }
  return lines.slice(1).join('\n')
}

/**
 * Add or replace one YAML frontmatter field without reformatting the note.
 * @param path - the absolute note path.
 * @param field - the field name.
 * @param value - the value to serialize; booleans and Dates serialize canonically.
 */
export function upsertFrontmatterField(path: string, field: string, value: unknown): void {
  const raw = readFileSync(path, 'utf8')
  const lines = splitLines(raw)
  const serialized = serializeFrontmatterValue(value)
  if (lines.length === 0 || (lines[0] ?? '').trim() !== '---') {
    writeFileSync(path, `---\n${field}: ${serialized}\n---\n\n${raw}`, 'utf8')
    return
  }
  let endIndex: number | null = null
  for (let index = 1; index < lines.length; index += 1) {
    if ((lines[index] ?? '').trim() === '---') {
      endIndex = index
      break
    }
  }
  if (endIndex === null) return
  const fieldPattern = new RegExp(`^${escapeRegex(field)}\\s*:.*$`)
  for (let index = 1; index < endIndex; index += 1) {
    if (fieldPattern.test(lines[index] ?? '')) {
      lines[index] = `${field}: ${serialized}`
      writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
      return
    }
  }
  lines.splice(endIndex, 0, `${field}: ${serialized}`)
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
}

/** Split text into lines without a trailing empty element. */
function splitLines(text: string): string[] {
  const parts = text.split(/\r\n|\r|\n/)
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts
}

/** Serialize one frontmatter value the way the original upsert does. */
function serializeFrontmatterValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value instanceof Date) {
    const year = value.getUTCFullYear()
    const month = String(value.getUTCMonth() + 1).padStart(2, '0')
    const day = String(value.getUTCDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }
  return String(value)
}

/** Escape a literal string for safe use in a RegExp. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The parent directory of a path. */
function dirnameOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '.' : path.slice(0, index) || '/'
}

const SHARED_DISCOVER = 'shared'

/**
 * Discover and validate the schedules of a project.
 * @param vault - the resolved vault path.
 * @param projectId - the project id.
 * @param relationshipValidator - cross-field checks between project and schedule.
 * @returns the catalog of valid and invalid schedules.
 */
export function discoverSchedules(
  vault: string,
  projectId: string,
  relationshipValidator: (project: StudyProject, schedule: StudyData) => string[],
): DiscoverSchedulesResult {
  return discoverSchedulesImpl(vault, projectId, relationshipValidator)
}

/** The catalog a schedule discovery returns. */
interface DiscoverSchedulesResult {
  project_id: string
  schedules: Array<StudySchedule & { path: string }>
  invalid_schedules: Array<{ schedule_id: string; path: string; errors: string[] }>
}

/** Shared implementation behind both `discoverSchedules` and `StudyWorkspace.discoverSchedules`. */
function discoverSchedulesImpl(
  vault: string,
  projectId: string | undefined,
  relationshipValidator: ((project: StudyProject, schedule: StudyData) => string[]) | undefined,
): DiscoverSchedulesResult {
  const workspace = new StudyWorkspace({ vault, source: SHARED_DISCOVER })
  const project = workspace.project(projectId)
  const resolvedId = project.project_id
  const root = resolve(workspace.projectsRoot, resolvedId, 'schedules')
  if (!isInside(root, resolve(workspace.projectsRoot, '.'))) {
    throw new StudyOSError('VALIDATION_FAILED', 'Schedule path escapes StudyOS projects root')
  }
  const schedules: Array<StudySchedule & { path: string }> = []
  const invalidSchedules: Array<{ schedule_id: string; path: string; errors: string[] }> = []
  if (!existsSync(root)) {
    return { project_id: resolvedId, schedules, invalid_schedules: invalidSchedules }
  }
  for (const path of sortedJsonFiles(root)) {
    const scheduleId = basename(path).replace(/\.json$/, '')
    const relativePath = actualRelative(vault, path)
    let errors: string[] = []
    let raw: Record<string, unknown> | null = null
    try {
      raw = readJsonFile(path)
    } catch (error) {
      if (error instanceof StudyOSError && error.code === 'VALIDATION_FAILED') {
        errors = [`Invalid JSON: ${basename(path)}`]
      } else {
        errors = [String(error instanceof Error ? error.message : error)]
      }
    }
    let valid: Record<string, unknown> | null = null
    if (errors.length === 0 && raw !== null) {
      const result = validateStudySchedule(raw)
      if (!result.ok) {
        errors = [...result.errors]
      } else if (!isObject(result.value)) {
        errors = ['Schedule validator returned invalid data']
      } else {
        valid = result.value
      }
    }
    if (errors.length === 0 && valid !== null) {
      const relationshipErrors = relationshipValidator ? relationshipValidator(project, valid) : []
      if (relationshipErrors.length > 0) {
        errors = [...relationshipErrors]
      } else if (valid['schedule_id'] !== scheduleId) {
        errors = ['schedule_id must match its canonical filename']
      }
    }
    if (errors.length > 0) {
      invalidSchedules.push({ schedule_id: scheduleId, path: relativePath, errors })
    } else if (valid !== null) {
      schedules.push(Object.assign(valid, { path: relativePath }) as unknown as StudySchedule & { path: string })
    }
  }
  return { project_id: resolvedId, schedules, invalid_schedules: invalidSchedules }
}

/** Sorted `.json` file paths inside a directory. */
function sortedJsonFiles(root: string): string[] {
  try {
    return readdirSync(root)
      .filter(name => name.endsWith('.json'))
      .map(name => resolve(root, name))
      .sort()
  } catch {
    return []
  }
}

/**
 * A resolved vault with an authoritative active-project pointer.
 */
export class StudyWorkspace {
  /** The resolved absolute vault path. */
  readonly vault: string
  /** Where the vault was resolved from. */
  readonly source: string

  /**
   * @param options.vault - the resolved vault path.
   * @param options.source - the resolution source label.
   */
  constructor(options: { vault: string; source: string }) {
    this.vault = options.vault
    this.source = options.source
  }

  /** @returns the projects root directory. */
  get projectsRoot(): string {
    return projectsRoot(this.vault)
  }

  /** @returns the study state directory. */
  get studyDir(): string {
    return studyDir(this.vault)
  }

  /** @returns the active-project pointer path. */
  get activeProjectPath(): string {
    return activeProjectPath(this.vault)
  }

  /**
   * Read and validate a project manifest.
   * @param projectId - an explicit id, or nothing for the active project.
   * @returns the manifest.
   */
  project(projectId?: string): StudyProject {
    const selected = projectId ?? this.activeProjectId()
    if (selected === null) {
      throw new StudyOSError('PROJECT_NOT_FOUND', 'No active StudyOS project selected')
    }
    const id = validateProjectId(selected)
    const manifestPath = resolve(this.projectsRoot, id, 'manifest.json')
    if (!isInside(manifestPath, resolve(this.projectsRoot, '.'))) {
      throw new StudyOSError('VALIDATION_FAILED', 'Project manifest path escapes Vault')
    }
    if (!existsSync(manifestPath)) {
      throw new StudyOSError('PROJECT_NOT_FOUND', `Project not found: ${id}`)
    }
    const raw = readJsonFile(manifestPath)
    const result = validateStudyProject(raw)
    if (!result.ok) throw new StudyOSError('VALIDATION_FAILED', result.errors.join('; '))
    if (!isObject(result.value)) throw new StudyOSError('VALIDATION_FAILED', 'Project validator returned invalid data')
    return result.value as unknown as StudyProject
  }

  /**
   * List every valid project manifest in the vault.
   * @returns the projects.
   */
  listProjects(): StudyProject[] {
    if (!existsSync(this.projectsRoot)) return []
    const projects: StudyProject[] = []
    const root = this.projectsRoot
    const names = listDir(root)
    for (const child of names) {
      if (!statSync(child).isDirectory()) continue
      const manifestPath = resolve(child, 'manifest.json')
      if (!existsSync(manifestPath)) continue
      const id = basename(child)
      try {
        projects.push(this.project(id))
      } catch {
        // Invalid or unreadable manifests are skipped, not raised.
      }
    }
    return projects
  }

  /**
   * Discover the valid schedules of a project, plus explicit invalid ones.
   * @param projectId - an explicit id, or nothing for the active project.
   * @param relationshipValidator - optional cross-field checks.
   * @returns the catalog.
   */
  discoverSchedules(
    projectId?: string,
    relationshipValidator?: (project: StudyProject, schedule: StudyData) => string[],
  ): DiscoverSchedulesResult {
    return discoverSchedulesImpl(this.vault, projectId, relationshipValidator)
  }

  /**
   * The active project id, or null when unset or unresolvable.
   * @returns the active id or null.
   */
  activeProjectId(): string | null {
    if (!existsSync(this.activeProjectPath)) return null
    let active: Record<string, unknown>
    try {
      active = readJsonFile(this.activeProjectPath)
    } catch {
      return null
    }
    let id: string
    try {
      id = validateProjectId(active['project_id'])
    } catch {
      return null
    }
    if (!existsSync(resolve(this.projectsRoot, id, 'manifest.json'))) return null
    return id
  }

  /**
   * Atomically persist the active-project pointer and return the manifest.
   * @param projectId - the project id to select.
   * @returns the selected manifest.
   */
  selectProject(projectId: string): StudyProject {
    const project = this.project(projectId)
    const payload = `${JSON.stringify({ project_id: project.project_id }, null, 2)}\n`
    return writeJsonAtomicTemp(this.projectsRoot, this.activeProjectPath, payload, project)
  }
}

/** Write a payload atomically then return a value. */
function writeJsonAtomicTemp(
  projectsRootValue: string,
  target: string,
  payload: string,
  result: StudyProject,
): StudyProject {
  mkdirSync(projectsRootValue, { recursive: true })
  const temporary = join(projectsRootValue, `.active-${randomUUID().replace(/-/g, '')}.json`)
  writeFileSync(temporary, payload, 'utf8')
  try {
    renameSync(temporary, target)
    return result
  } finally {
    try {
      unlinkSync(temporary)
    } catch {
      // The temp file already moved away; nothing to clean.
    }
  }
}
