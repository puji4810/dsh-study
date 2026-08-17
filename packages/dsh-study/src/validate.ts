/**
 * Hand-rolled structural and semantic validators for every durable StudyOS record.
 * Error strings reproduce the Python plugin's normalized messages because they cross the
 * model boundary inside tool envelopes; codes stay the stable identifiers.
 * @module @puji4810/dsh-study/validate
 */

import {
  ASSISTANCE_LEVELS,
  ATTEMPT_RESULTS,
  ATTEMPT_SCHEMA_VERSION,
  DEADLINE_BANDS,
  EVALUATOR_KINDS,
  EVIDENCE_AGE_BANDS,
  EVIDENCE_DIMENSIONS,
  INTERVENTION_KINDS,
  INTERVENTION_POLICY_VERSION,
  LEARNING_CONTRACT_SCHEMA_VERSION,
  LEARNING_MODES,
  PATTERN_PROPOSAL_CHANGE_TYPES,
  PATTERN_PROPOSAL_SCHEMA_VERSION,
  PATTERN_PROPOSAL_STATUSES,
  PLAN_PROPOSAL_SCHEMA_VERSION,
  PLAN_PROPOSAL_STATUSES,
  PROJECT_ID_PATTERN,
  PROJECT_SCHEMA_VERSION_V1,
  PROJECT_SCHEMA_VERSION_V2,
  SCHEDULE_ID_PATTERN,
  SCHEDULE_SCHEMA_VERSION,
  SOURCE_ANCHOR_KINDS,
  VERIFICATION_STATUSES,
  DAY_PLAN_SCHEMA_VERSION,
} from './constants.ts'
import { parseDate, parseOffsetDateTime } from './datetime.ts'
import type { StudyData } from './types.ts'

/** Validation outcome: the validated record, or the list of normalized errors. */
export type ValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; errors: string[] }

const PROJECT_ID_RE = new RegExp(PROJECT_ID_PATTERN)
const SCHEDULE_ID_RE = new RegExp(SCHEDULE_ID_PATTERN)
const DATETIME_WITH_OFFSET_RE = new RegExp('^(?:\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2})(?:[+-]\\d{2}:\\d{2}|Z)$')

function typeName(value: unknown): string {
  if (value === null) return 'NoneType'
  if (Array.isArray(value)) return 'list'
  return typeof value
}

function asRecord(value: unknown): StudyData | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as StudyData
    : null
}

/** Emit `{path} must be a string` plus optional non-empty check; returns the string or null. */
function needString(
  errors: string[],
  data: StudyData,
  key: string,
  path: string,
  options: { nonEmpty?: boolean } = {},
): string | null {
  const value = data[key]
  if (typeof value !== 'string') {
    errors.push(`${path} must be a string`)
    return null
  }
  if (options.nonEmpty !== false && !value.trim()) {
    errors.push(`${path} must not be empty`)
    return null
  }
  return value
}

/** Emit a datetime-with-offset error for a field; returns the instant or null. */
function needOffsetDatetime(errors: string[], value: unknown, path: string): Date | null {
  if (typeof value !== 'string') {
    errors.push(`${path} must be a string`)
    return null
  }
  const trimmed = value.trim()
  if (!DATETIME_WITH_OFFSET_RE.test(trimmed)) {
    errors.push(`${path} must include timezone offset`)
    return null
  }
  const instant = new Date(trimmed.replace(/Z$/, '+00:00'))
  if (Number.isNaN(instant.getTime())) {
    errors.push(`${path} must be a valid ISO datetime`)
    return null
  }
  return instant
}

/** Validate a string array field; emits `{path} must be a{qualifier} string array`. */
function needStringArray(
  errors: string[],
  value: unknown,
  path: string,
  options: { nonEmpty?: boolean } = {},
): string[] | null {
  if (
    !Array.isArray(value)
    || (options.nonEmpty === true && value.length === 0)
    || value.some(item => typeof item !== 'string' || !item.trim())
  ) {
    const qualifier = options.nonEmpty === true ? 'non-empty ' : ''
    errors.push(`${path} must be a ${qualifier}string array`)
    return null
  }
  return value as string[]
}

/** Validate the source_anchors field against the shared anchor rules. */
function needSourceAnchors(errors: string[], value: unknown, path: string): void {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`)
    return
  }
  value.forEach((anchor, index) => {
    const itemPath = `${path}[${index}]`
    const record = asRecord(anchor)
    if (record === null) {
      errors.push(`${itemPath} must be an object`)
      return
    }
    if (typeof record.kind !== 'string' || !(SOURCE_ANCHOR_KINDS as readonly string[]).includes(record.kind)) {
      errors.push(`${itemPath}.kind must be one of: ${[...SOURCE_ANCHOR_KINDS].sort().join(', ')}`)
    }
    if (typeof record.ref !== 'string' || !record.ref.trim()) {
      errors.push(`${itemPath}.ref must be a non-empty string`)
    }
    for (const key of ['version', 'locator']) {
      const present = record[key]
      if (present !== undefined && present !== null && (typeof present !== 'string' || !present.trim())) {
        errors.push(`${itemPath}.${key} must be a non-empty string when provided`)
      }
    }
  })
}

const enumList = (values: readonly string[]): string => [...values].sort().join(', ')

function needEnum(errors: string[], value: unknown, path: string, allowed: readonly string[]): string | null {
  if (typeof value === 'string' && (allowed).includes(value)) return value
  errors.push(`${path} must be one of: ${enumList(allowed)}`)
  return null
}

/** A positive (>= 1) integer, Python strict-style: booleans do not count. */
function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

/** A non-negative integer, Python strict-style. */
function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** A finite number that is not a boolean. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && !Number.isNaN(value) && Number.isFinite(value)
}

function requireObject(errors: string[], value: unknown, path: string): StudyData | null {
  const record = asRecord(value)
  if (record === null) errors.push(`${path} must be an object`)
  return record
}

function requireArray(errors: string[], value: unknown, path: string): unknown[] | null {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`)
    return null
  }
  return value as unknown[]
}

// ---- project ----

function validateSubject(errors: string[], value: unknown, path: string): void {
  const record = requireObject(errors, value, path)
  if (record === null) return
  needString(errors, record, 'id', `${path}.id`)
  needString(errors, record, 'label', `${path}.label`)
  const score = record.target_score
  if (score !== undefined && score !== null && !isFiniteNumber(score)) {
    errors.push(`${path}.target_score must be a number when provided`)
  }
}

function validateObjective(errors: string[], value: unknown, path: string): void {
  const record = requireObject(errors, value, path)
  if (record === null) return
  const id = needString(errors, record, 'objective_id', `${path}.objective_id`)
  if (id !== null && !SCHEDULE_ID_RE.test(id)) {
    errors.push(`${path}.objective_id must match ${SCHEDULE_ID_PATTERN}`)
  }
  needString(errors, record, 'capability', `${path}.capability`)
  needStringArray(errors, record.success_criteria, `${path}.success_criteria`, { nonEmpty: true })
  const targets = needStringArray(errors, record.evidence_targets, `${path}.evidence_targets`, { nonEmpty: true })
  if (targets !== null) {
    const unknown = [...new Set(targets.filter(target => !(EVIDENCE_DIMENSIONS as readonly string[]).includes(target)))].sort()
    if (unknown.length > 0) errors.push(`${path}.evidence_targets contains unsupported evidence dimensions: ${unknown.join(', ')}`)
  }
  if (record.source_anchors !== undefined && record.source_anchors !== null) {
    needSourceAnchors(errors, record.source_anchors, `${path}.source_anchors`)
  }
  if (record.activates_on !== undefined && record.activates_on !== null) {
    if (typeof record.activates_on !== 'string' || parseDate(record.activates_on) === null) {
      errors.push(`${path}.activates_on must be ISO date YYYY-MM-DD`)
    }
  }
}

function validatePromptPolicy(errors: string[], value: unknown, path: string): void {
  const record = requireObject(errors, value, path)
  if (record === null) return
  for (const key of ['base_max_chars', 'intent_max_chars', 'domain_max_chars', 'project_summary_max_chars', 'total_max_chars']) {
    if (!isPositiveInt(record[key])) errors.push(`${path}.${key} must be a positive integer`)
  }
  needEnum(errors, record.updates_apply, `${path}.updates_apply`, ['next_session'])
  for (const key of ['total_max_tokens', 'base_reserve_tokens', 'intent_reserve_tokens', 'domain_reserve_tokens', 'project_summary_reserve_tokens']) {
    const present = record[key]
    if (present !== undefined && present !== null && !isPositiveInt(present)) {
      errors.push(`${path}.${key} must be a positive integer when provided`)
    }
  }
}

function duplicateErrors(values: unknown, collection: string, key: string): string[] {
  const errors: string[] = []
  if (!Array.isArray(values)) return errors
  const seen = new Set<string>()
  values.forEach((item, index) => {
    const record = asRecord(item)
    const value = record?.[key]
    if (typeof value !== 'string') return
    if (seen.has(value)) errors.push(`${collection}[${index}].${key} must be unique`)
    seen.add(value)
  })
  return errors
}

/**
 * Validate a project manifest against the study_project.v1 or .v2 contract.
 * @param data - the candidate manifest.
 * @returns the validated record or normalized errors.
 */
export function validateStudyProject(data: unknown): ValidationResult {
  const record = asRecord(data)
  if (record === null) return { ok: false, errors: [`project must be an object, got ${typeName(data)}`] }
  const errors: string[] = []
  const version = record.schema_version
  if (version !== PROJECT_SCHEMA_VERSION_V1 && version !== PROJECT_SCHEMA_VERSION_V2) {
    return { ok: false, errors: [`schema_version must be ${PROJECT_SCHEMA_VERSION_V1} or ${PROJECT_SCHEMA_VERSION_V2}`] }
  }

  const projectId = needString(errors, record, 'project_id', 'project_id')
  if (projectId !== null && !PROJECT_ID_RE.test(projectId)) {
    errors.push(`project_id must match ${PROJECT_ID_PATTERN}`)
  }
  needString(errors, record, 'title', 'title')
  needString(errors, record, 'domain', 'domain')
  needString(errors, record, 'timezone', 'timezone')
  needString(errors, record, 'phase', 'phase')
  needString(errors, record, 'domain_pack', 'domain_pack')
  needOffsetDatetime(errors, record.created_at, 'created_at')
  needOffsetDatetime(errors, record.updated_at, 'updated_at')
  validatePromptPolicy(errors, record.prompt_policy, 'prompt_policy')

  if (version === PROJECT_SCHEMA_VERSION_V1) {
    needString(errors, record, 'exam_type', 'exam_type')
    if (typeof record.exam_date !== 'string' || parseDate(record.exam_date) === null) {
      errors.push('exam_date must be ISO date YYYY-MM-DD')
    }
    const subjects = requireArray(errors, record.subjects, 'subjects')
    if (subjects !== null && subjects.length === 0) errors.push('subjects must be a non-empty array')
    subjects?.forEach((subject, index) => { validateSubject(errors, subject, `subjects[${index}]`) })
    errors.push(...duplicateErrors(record.subjects, 'subjects', 'id'))
  } else {
    if (record.deadline !== undefined && record.deadline !== null) {
      if (typeof record.deadline !== 'string' || parseDate(record.deadline) === null) {
        errors.push('deadline must be ISO date YYYY-MM-DD')
      }
    }
    for (const key of ['workspace_type', 'artifact_policy']) {
      needString(errors, record, key, key)
    }
    const tracks = requireArray(errors, record.tracks, 'tracks')
    if (tracks !== null && tracks.length === 0) errors.push('tracks must be a non-empty array')
    tracks?.forEach((track, index) => { validateSubject(errors, track, `tracks[${index}]`) })
    errors.push(...duplicateErrors(record.tracks, 'tracks', 'id'))
    const objectives = requireArray(errors, record.objectives, 'objectives')
    if (objectives !== null && objectives.length === 0) errors.push('objectives must be a non-empty array')
    objectives?.forEach((objective, index) => { validateObjective(errors, objective, `objectives[${index}]`) })
    errors.push(...duplicateErrors(record.objectives, 'objectives', 'objective_id'))
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: record }
}

// ---- schedule ----

function validateSchedulePhase(errors: string[], value: unknown, path: string): void {
  const record = requireObject(errors, value, path)
  if (record === null) return
  for (const key of ['id', 'title', 'goal']) needString(errors, record, key, `${path}.${key}`)
  for (const key of ['start', 'end']) {
    if (typeof record[key] !== 'string' || parseDate(record[key]) === null) {
      errors.push(`${path}.${key} must be ISO date YYYY-MM-DD`)
    }
  }
  if (record.effort_minutes !== undefined && record.effort_minutes !== null && !isPositiveInt(record.effort_minutes)) {
    errors.push(`${path}.effort_minutes must be a positive integer`)
  }
  if (record.goals !== undefined && record.goals !== null) {
    needStringArray(errors, record.goals, `${path}.goals`)
  }
  if (record.source_curricula !== undefined && record.source_curricula !== null) {
    needStringArray(errors, record.source_curricula, `${path}.source_curricula`)
  }
  if (record.status !== undefined && record.status !== null) {
    needString(errors, record, 'status', `${path}.status`)
  }
}

function validateScheduleEvent(errors: string[], value: unknown, path: string): void {
  const record = requireObject(errors, value, path)
  if (record === null) return
  for (const key of ['id', 'title', 'subject_id', 'type', 'status']) {
    needString(errors, record, key, `${path}.${key}`)
  }
  needOffsetDatetime(errors, record.start, `${path}.start`)
  needOffsetDatetime(errors, record.end, `${path}.end`)
  const duration = record.duration_minutes
  if (!isPositiveInt(duration) || duration > 720) {
    errors.push(`${path}.duration_minutes must be an integer from 1 to 720`)
  }
  needStringArray(errors, record.goals, `${path}.goals`)
  if (record.source_curriculum !== undefined && record.source_curriculum !== null) {
    needString(errors, record, 'source_curriculum', `${path}.source_curriculum`)
  }
}

/**
 * Validate a schedule against the study_schedule.v1 contract, including the semantic
 * range/duration invariants.
 * @param data - the candidate schedule.
 * @returns the validated record or normalized errors.
 */
export function validateStudySchedule(data: unknown): ValidationResult {
  const record = asRecord(data)
  if (record === null) return { ok: false, errors: [`schedule must be an object, got ${typeName(data)}`] }
  const errors: string[] = []
  if (record.schema_version !== SCHEDULE_SCHEMA_VERSION) {
    return { ok: false, errors: [`schema_version must be ${SCHEDULE_SCHEMA_VERSION}`] }
  }
  const scheduleId = needString(errors, record, 'schedule_id', 'schedule_id')
  if (scheduleId !== null && !SCHEDULE_ID_RE.test(scheduleId)) {
    errors.push(`schedule_id must match ${SCHEDULE_ID_PATTERN}`)
  }
  const projectId = needString(errors, record, 'project_id', 'project_id')
  if (projectId !== null && !PROJECT_ID_RE.test(projectId)) {
    errors.push(`project_id must match ${PROJECT_ID_PATTERN}`)
  }
  needString(errors, record, 'title', 'title')
  needString(errors, record, 'timezone', 'timezone')

  const range = requireObject(errors, record.range, 'range')
  if (range !== null) {
    for (const key of ['start', 'end']) {
      if (typeof range[key] !== 'string' || parseDate(range[key]) === null) {
        errors.push(`range.${key} must be ISO date YYYY-MM-DD`)
      }
    }
  }
  const phases = requireArray(errors, record.phases, 'phases')
  phases?.forEach((phase, index) => { validateSchedulePhase(errors, phase, `phases[${index}]`) })
  const events = requireArray(errors, record.events, 'events')
  events?.forEach((event, index) => { validateScheduleEvent(errors, event, `events[${index}]`) })

  // Semantic invariants (only computed when structural fields parsed).
  if (range !== null && typeof range.start === 'string' && typeof range.end === 'string') {
    const start = parseDate(range.start)
    const end = parseDate(range.end)
    if (start !== null && end !== null && end < start) errors.push('range.end must be on or after range.start')
  }
  phases?.forEach((phase, index) => {
    const item = asRecord(phase)
    if (item === null) return
    const start = typeof item.start === 'string' ? parseDate(item.start) : null
    const end = typeof item.end === 'string' ? parseDate(item.end) : null
    if (start !== null && end !== null && end < start) errors.push(`phases[${index}].end must be on or after start`)
  })
  errors.push(...duplicateErrors(record.events, 'events', 'id'))
  events?.forEach((event, index) => {
    const path = `events[${index}]`
    const item = asRecord(event)
    if (item === null) return
    const start = typeof item.start === 'string' ? parseOffsetDateTime(item.start) : null
    const end = typeof item.end === 'string' ? parseOffsetDateTime(item.end) : null
    if (start === null || end === null) return
    if (end <= start) {
      errors.push(`${path}.end must be after start`)
      return
    }
    const actualMinutes = Math.floor((end.getTime() - start.getTime()) / 60_000)
    if (actualMinutes > 720) {
      errors.push(`${path} spans more than 720 minutes; use phases for long-term ranges and events only for concrete study sessions`)
    } else if (actualMinutes !== item.duration_minutes) {
      errors.push(`${path}.duration_minutes does not match start/end`)
    }
    if (range !== null && typeof range.start === 'string' && typeof range.end === 'string') {
      const rangeStart = parseDate(range.start)
      const rangeEnd = parseDate(range.end)
      if (
        rangeStart !== null && rangeEnd !== null
        && !(rangeStart <= start && start <= rangeEnd && rangeStart <= end && end <= rangeEnd)
      ) {
        errors.push(`${path} must fall inside range`)
      }
    }
  })
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: record }
}

/**
 * Cross-aggregate checks between a validated project and schedule: the schedule must
 * belong to the project and every event subject must exist in its tracks or subjects.
 * @param project - the validated project.
 * @param schedule - the validated schedule.
 * @returns relationship errors, empty when the pair is consistent.
 */
export function validateScheduleRelationships(project: StudyData, schedule: StudyData): string[] {
  const errors: string[] = []
  if (schedule.project_id !== project.project_id) {
    errors.push('schedule.project_id must match project manifest')
  }
  const subjectIds = new Set<string>()
  if (project.schema_version === PROJECT_SCHEMA_VERSION_V2) {
    for (const track of Array.isArray(project.tracks) ? project.tracks : []) {
      const item = asRecord(track)
      if (item !== null && typeof item.id === 'string') subjectIds.add(item.id)
    }
  } else {
    for (const subject of Array.isArray(project.subjects) ? project.subjects : []) {
      const item = asRecord(subject)
      if (item !== null && typeof item.id === 'string') subjectIds.add(item.id)
    }
  }
  for (const event of Array.isArray(schedule.events) ? schedule.events : []) {
    const item = asRecord(event)
    if (item === null) continue
    if (typeof item.subject_id === 'string' && !subjectIds.has(item.subject_id)) {
      errors.push(`events subject_id must exist in project subjects: ${item.subject_id}`)
    }
  }
  return errors
}

// ---- attempt ----

/**
 * Validate one immutable attempt against study_attempt.v1.
 * @param data - the candidate attempt.
 * @returns the validated record or normalized errors.
 */
export function validateStudyAttempt(data: unknown): ValidationResult {
  const record = asRecord(data)
  if (record === null) return { ok: false, errors: [`attempt must be an object, got ${typeName(data)}`] }
  const errors: string[] = []
  if (record.schema_version !== ATTEMPT_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${ATTEMPT_SCHEMA_VERSION}`)
  }
  for (const key of ['attempt_id', 'project_id', 'item_id', 'response', 'result']) {
    needString(errors, record, key, key)
  }
  if (typeof record.project_id === 'string' && !PROJECT_ID_RE.test(record.project_id)) {
    errors.push(`project_id must match ${PROJECT_ID_PATTERN}`)
  }
  needOffsetDatetime(errors, record.occurred_at, 'occurred_at')

  needEnum(errors, record.result, 'result', ATTEMPT_RESULTS)
  const score = record.score
  if (typeof score !== 'number' || !isFiniteNumber(score) || score < 0 || score > 1) {
    errors.push('score must be a number from 0 to 1')
  }
  if (record.duration_seconds !== undefined && record.duration_seconds !== null && !isNonNegativeInt(record.duration_seconds)) {
    errors.push('duration_seconds must be a non-negative integer')
  }
  if (record.hints_used !== undefined && record.hints_used !== null && !isNonNegativeInt(record.hints_used)) {
    errors.push('hints_used must be a non-negative integer')
  }
  if (
    record.self_confidence !== undefined && record.self_confidence !== null
    && (!isNonNegativeInt(record.self_confidence) || record.self_confidence < 1 || record.self_confidence > 5)
  ) {
    errors.push('self_confidence must be an integer from 1 to 5')
  }
  if (
    record.evaluator_confidence !== undefined && record.evaluator_confidence !== null
    && (typeof record.evaluator_confidence !== 'number' || !isFiniteNumber(record.evaluator_confidence) || record.evaluator_confidence < 0 || record.evaluator_confidence > 1)
  ) {
    errors.push('evaluator_confidence must be a number from 0 to 1')
  }
  if (record.transfer_level !== undefined && record.transfer_level !== null) {
    needEnum(errors, record.transfer_level, 'transfer_level', EVIDENCE_DIMENSIONS)
  }
  if (record.intervention_kind !== undefined && record.intervention_kind !== null) {
    needEnum(errors, record.intervention_kind, 'intervention_kind', INTERVENTION_KINDS)
  }
  for (const key of ['source_plan_proposal_id', 'source_intervention_id']) {
    if (record[key] !== undefined && record[key] !== null) {
      const value = needString(errors, record, key, key)
      if (value !== null && !SCHEDULE_ID_RE.test(value)) {
        errors.push(`${key} must match ${SCHEDULE_ID_PATTERN}`)
      }
    }
  }
  const attemptProvenanceFields = ['intervention_kind', 'source_plan_proposal_id', 'source_intervention_id']
  const attemptProvenanceCount = attemptProvenanceFields
    .filter(key => record[key] !== undefined && record[key] !== null).length
  if (attemptProvenanceCount !== 0 && attemptProvenanceCount !== attemptProvenanceFields.length) {
    errors.push('intervention_kind, source_plan_proposal_id, and source_intervention_id must be provided together')
  }
  for (const key of ['concepts', 'patterns', 'objective_ids']) {
    if (record[key] !== undefined && record[key] !== null) {
      needStringArray(errors, record[key], key)
    }
  }
  if (record.evaluator !== undefined && record.evaluator !== null) {
    const evaluator = requireObject(errors, record.evaluator, 'evaluator')
    if (evaluator !== null) {
      needEnum(errors, evaluator.kind, 'evaluator.kind', EVALUATOR_KINDS)
      if (evaluator.confidence !== undefined && evaluator.confidence !== null) {
        if (typeof evaluator.confidence !== 'number' || !isFiniteNumber(evaluator.confidence) || evaluator.confidence < 0 || evaluator.confidence > 1) {
          errors.push('evaluator.confidence must be a number from 0 to 1')
        }
      }
      if (evaluator.id !== undefined && evaluator.id !== null && (typeof evaluator.id !== 'string' || !evaluator.id.trim())) {
        errors.push('evaluator.id must be a non-empty string when provided')
      }
    }
  }
  if (record.assistance !== undefined && record.assistance !== null) {
    const assistance = requireObject(errors, record.assistance, 'assistance')
    if (assistance !== null) {
      needEnum(errors, assistance.level, 'assistance.level', ASSISTANCE_LEVELS)
      if (assistance.hints_used !== undefined && assistance.hints_used !== null && !isNonNegativeInt(assistance.hints_used)) {
        errors.push('assistance.hints_used must be a non-negative integer')
      }
    }
  }
  if (record.source_anchors !== undefined && record.source_anchors !== null) {
    needSourceAnchors(errors, record.source_anchors, 'source_anchors')
  }
  if (record.artifact_refs !== undefined && record.artifact_refs !== null) {
    needStringArray(errors, record.artifact_refs, 'artifact_refs')
  }
  if (record.diagnoses !== undefined && record.diagnoses !== null) {
    const diagnoses = requireArray(errors, record.diagnoses, 'diagnoses')
    diagnoses?.forEach((diagnosis, index) => {
      const path = `diagnoses[${index}]`
      const item = asRecord(diagnosis)
      if (item === null) {
        errors.push(`${path} must be an object with non-empty string fields "kind" and "evidence"; example: {"kind":"condition_missed","evidence":"The required condition was not checked."}`)
        return
      }
      for (const key of ['kind', 'evidence']) {
        if (typeof item[key] !== 'string' || !item[key].trim()) {
          errors.push(`${path}.${key} must be a non-empty string`)
        }
      }
    })
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: record }
}

// ---- learning contract ----

/**
 * Validate a learning contract against learning_contract.v1, optionally against its
 * owning project manifest.
 * @param data - the candidate contract.
 * @param project - optional validated project for cross-field checks.
 * @returns the validated record or normalized errors.
 */
export function validateLearningContract(data: unknown, project?: StudyData): ValidationResult {
  const record = asRecord(data)
  if (record === null) return { ok: false, errors: [`contract must be an object, got ${typeName(data)}`] }
  const errors: string[] = []
  if (record.schema_version !== LEARNING_CONTRACT_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${LEARNING_CONTRACT_SCHEMA_VERSION}`)
  }
  for (const key of ['contract_id', 'project_id', 'objective']) {
    needString(errors, record, key, key)
  }
  if (typeof record.contract_id === 'string' && !SCHEDULE_ID_RE.test(record.contract_id)) {
    errors.push(`contract_id must match ${SCHEDULE_ID_PATTERN}`)
  }
  if (typeof record.project_id === 'string' && !PROJECT_ID_RE.test(record.project_id)) {
    errors.push(`project_id must match ${PROJECT_ID_PATTERN}`)
  }
  if (project !== undefined && record.project_id !== project.project_id) {
    errors.push('project_id must match project manifest')
  }
  needEnum(errors, record.mode, 'mode', LEARNING_MODES)
  needEnum(errors, record.assistance_level, 'assistance_level', ASSISTANCE_LEVELS)
  const budget = record.time_budget_minutes
  if (!isPositiveInt(budget) || budget > 720) {
    errors.push('time_budget_minutes must be an integer from 1 to 720')
  }
  const objectiveIds = needStringArray(errors, record.objective_ids, 'objective_ids')
  const evidenceTargets = needStringArray(errors, record.evidence_targets, 'evidence_targets', { nonEmpty: true })
  if (evidenceTargets !== null) {
    const unknown = [...new Set(evidenceTargets.filter(target => !(EVIDENCE_DIMENSIONS as readonly string[]).includes(target)))].sort()
    if (unknown.length > 0) errors.push(`evidence_targets contains unsupported evidence dimensions: ${unknown.join(', ')}`)
  }
  if (project !== undefined && project.schema_version === PROJECT_SCHEMA_VERSION_V2) {
    const objectives = new Map<string, StudyData>()
    for (const item of Array.isArray(project.objectives) ? project.objectives : []) {
      const objective = asRecord(item)
      if (objective !== null && typeof objective.objective_id === 'string') objectives.set(objective.objective_id, objective)
    }
    if (objectiveIds !== null) {
      const unknownIds = [...new Set(objectiveIds.filter(id => !objectives.has(id)))].sort()
      if (unknownIds.length > 0) errors.push(`objective_ids must exist in project objectives: ${unknownIds.join(', ')}`)
      if (unknownIds.length === 0 && objectiveIds.length > 0) {
        const supportedTargets = new Set(
          objectiveIds.flatMap((id) => {
            const targets = objectives.get(id)?.evidence_targets
            return Array.isArray(targets) ? (targets as string[]) : []
          }),
        )
        if (evidenceTargets !== null) {
          const unsupported = [...new Set(evidenceTargets.filter(target => !supportedTargets.has(target)))].sort()
          if (unsupported.length > 0) {
            errors.push(`evidence_targets must be declared by the referenced objectives: ${unsupported.join(', ')}`)
          }
        }
      }
    }
  }
  const provenanceFields = ['intervention_kind', 'source_plan_proposal_id', 'source_intervention_id']
  const provenanceCount = provenanceFields.filter(key => record[key] !== undefined && record[key] !== null).length
  if (provenanceCount !== 0 && provenanceCount !== provenanceFields.length) {
    errors.push('intervention_kind, source_plan_proposal_id, and source_intervention_id must be provided together')
  }
  if (record.intervention_kind !== undefined && record.intervention_kind !== null) {
    needEnum(errors, record.intervention_kind, 'intervention_kind', INTERVENTION_KINDS)
  }
  for (const key of ['source_plan_proposal_id', 'source_intervention_id']) {
    if (record[key] !== undefined && record[key] !== null) {
      const value = needString(errors, record, key, key)
      if (value !== null && !SCHEDULE_ID_RE.test(value)) {
        errors.push(`${key} must match ${SCHEDULE_ID_PATTERN}`)
      }
    }
  }
  needOffsetDatetime(errors, record.created_at, 'created_at')
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: record }
}

// ---- pattern proposal ----

/**
 * Validate a pattern proposal against study_pattern_proposal.v1.
 * @param data - the candidate proposal.
 * @returns the validated record or normalized errors.
 */
export function validatePatternProposal(data: unknown): ValidationResult {
  const record = asRecord(data)
  if (record === null) return { ok: false, errors: [`proposal must be an object, got ${typeName(data)}`] }
  const errors: string[] = []
  if (record.schema_version !== PATTERN_PROPOSAL_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${PATTERN_PROPOSAL_SCHEMA_VERSION}`)
  }
  for (const key of ['proposal_id', 'project_id', 'title', 'change_type', 'status', 'rationale']) {
    needString(errors, record, key, key)
  }
  if (typeof record.project_id === 'string' && !PROJECT_ID_RE.test(record.project_id)) {
    errors.push(`project_id must match ${PROJECT_ID_PATTERN}`)
  }
  needEnum(errors, record.change_type, 'change_type', PATTERN_PROPOSAL_CHANGE_TYPES)
  needEnum(errors, record.status, 'status', PATTERN_PROPOSAL_STATUSES)
  needStringArray(errors, record.evidence_attempt_ids, 'evidence_attempt_ids', { nonEmpty: true })
  needOffsetDatetime(errors, record.created_at, 'created_at')
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: record }
}

// ---- plan proposal ----

function priorityBandFor(score: number): string {
  return score >= 80 ? 'high' : score >= 55 ? 'medium' : 'low'
}

function validatePlanItem(errors: string[], value: unknown, path: string, seenIds: Set<string>): void {
  const item = requireObject(errors, value, path)
  if (item === null) return
  for (const key of ['intervention_id', 'objective_id', 'capability', 'kind', 'evidence_dimension', 'priority_band']) {
    needString(errors, item, key, `${path}.${key}`)
  }
  if (typeof item.intervention_id === 'string') {
    if (!SCHEDULE_ID_RE.test(item.intervention_id)) {
      errors.push(`${path}.intervention_id must match ${SCHEDULE_ID_PATTERN}`)
    } else if (seenIds.has(item.intervention_id)) {
      errors.push(`${path}.intervention_id must be unique`)
    } else {
      seenIds.add(item.intervention_id)
    }
  }
  if (typeof item.objective_id === 'string' && !SCHEDULE_ID_RE.test(item.objective_id)) {
    errors.push(`${path}.objective_id must match ${SCHEDULE_ID_PATTERN}`)
  }
  needEnum(errors, item.kind, `${path}.kind`, INTERVENTION_KINDS)
  needEnum(errors, item.evidence_dimension, `${path}.evidence_dimension`, EVIDENCE_DIMENSIONS)
  const score = item.priority_score
  if (typeof score !== 'number' || !isFiniteNumber(score) || score < 0 || score > 100) {
    errors.push(`${path}.priority_score must be a number from 0 to 100`)
  } else if (item.priority_band !== priorityBandFor(score)) {
    errors.push(`${path}.priority_band must match priority_score`)
  }
  needStringArray(errors, item.reasons, `${path}.reasons`, { nonEmpty: true })
  const evidence = needStringArray(errors, item.evidence_attempt_ids, `${path}.evidence_attempt_ids`)
  if (evidence !== null && evidence.length !== new Set(evidence).size) {
    errors.push(`${path}.evidence_attempt_ids must not contain duplicates`)
  }
  const factors = requireObject(errors, item.reason_factors, `${path}.reason_factors`)
  if (factors !== null) {
    needEnum(errors, factors.verification_status, `${path}.reason_factors.verification_status`, VERIFICATION_STATUSES)
    if (factors.evidence_age_days !== undefined && factors.evidence_age_days !== null && !isNonNegativeInt(factors.evidence_age_days)) {
      errors.push(`${path}.reason_factors.evidence_age_days must be null or a non-negative integer`)
    }
    needEnum(errors, factors.evidence_age_band, `${path}.reason_factors.evidence_age_band`, EVIDENCE_AGE_BANDS)
    if (!isPositiveInt(factors.freshness_threshold_days)) {
      errors.push(`${path}.reason_factors.freshness_threshold_days must be a positive integer`)
    }
    if (factors.days_to_deadline !== undefined && factors.days_to_deadline !== null && !Number.isInteger(factors.days_to_deadline)) {
      errors.push(`${path}.reason_factors.days_to_deadline must be null or an integer`)
    }
    needEnum(errors, factors.deadline_band, `${path}.reason_factors.deadline_band`, DEADLINE_BANDS)
  }
  const activity = requireObject(errors, item.recommended_activity, `${path}.recommended_activity`)
  if (activity !== null) {
    needString(errors, activity, 'activity_kind', `${path}.recommended_activity.activity_kind`)
    needEnum(errors, activity.evidence_target, `${path}.recommended_activity.evidence_target`, EVIDENCE_DIMENSIONS)
    needEnum(errors, activity.assistance_level, `${path}.recommended_activity.assistance_level`, ASSISTANCE_LEVELS)
    const duration = activity.duration_minutes
    if (!isPositiveInt(duration) || duration > 720) {
      errors.push(`${path}.recommended_activity.duration_minutes must be an integer from 1 to 720`)
    }
    needStringArray(errors, activity.success_criteria, `${path}.recommended_activity.success_criteria`, { nonEmpty: true })
    if (activity.source_anchors !== undefined && activity.source_anchors !== null) {
      needSourceAnchors(errors, activity.source_anchors, `${path}.recommended_activity.source_anchors`)
    }
  }
}

function validateDayPlanEvents(
  errors: string[],
  value: unknown,
  path: string,
  interventionIds: Set<string>,
  seenEventIds: Set<string>,
  seenInterventionEvents: Set<string>,
  occupied: Array<{ id: string; start: Date; end: Date }>,
): void {
  const entry = requireObject(errors, value, path)
  if (entry === null) return
  needString(errors, entry, 'schedule_id', `${path}.schedule_id`)
  const events = requireArray(errors, entry.events, `${path}.events`)
  events?.forEach((event, index) => {
    const eventPath = `${path}.events[${index}]`
    const item = requireObject(errors, event, eventPath)
    if (item === null) return
    for (const key of ['id', 'title', 'subject_id', 'type', 'status']) {
      needString(errors, item, key, `${eventPath}.${key}`)
    }
    if (typeof item.id === 'string') {
      if (seenEventIds.has(item.id)) errors.push(`${eventPath}.id must be unique across the day plan`)
      seenEventIds.add(item.id)
    }
    needOffsetDatetime(errors, item.start, `${eventPath}.start`)
    needOffsetDatetime(errors, item.end, `${eventPath}.end`)
    const start = typeof item.start === 'string' ? parseOffsetDateTime(item.start) : null
    const end = typeof item.end === 'string' ? parseOffsetDateTime(item.end) : null
    const duration = item.duration_minutes
    if (!isPositiveInt(duration) || duration > 720) {
      errors.push(`${eventPath}.duration_minutes must be an integer from 1 to 720`)
    } else if (start !== null && end !== null) {
      if (end <= start) errors.push(`${eventPath}.end must be after start`)
      else if (Math.floor((end.getTime() - start.getTime()) / 60_000) !== duration) {
        errors.push(`${eventPath}.duration_minutes does not match start/end`)
      }
    }
    if (start !== null && end !== null && end > start) {
      for (const prior of occupied) {
        if (start < prior.end && end > prior.start) {
          errors.push(`${eventPath} overlaps day-plan event ${prior.id}`)
        }
      }
      occupied.push({ id: String(item.id ?? eventPath), start, end })
    }
    if (
      item.recommended_duration_minutes !== undefined
      && item.recommended_duration_minutes !== null
      && (!isPositiveInt(item.recommended_duration_minutes) || item.recommended_duration_minutes > 720)
    ) {
      errors.push(`${eventPath}.recommended_duration_minutes must be an integer from 1 to 720`)
    }
    if (
      item.duration_source !== undefined
      && item.duration_source !== null
      && !['recommended', 'placement_override', 'adaptive_fit'].includes(String(item.duration_source))
    ) {
      errors.push(`${eventPath}.duration_source must be recommended, placement_override, or adaptive_fit`)
    }
    needStringArray(errors, item.goals, `${eventPath}.goals`, { nonEmpty: true })
    const source = item.source_intervention_id
    if (typeof source !== 'string' || !source.trim()) {
      errors.push(`${eventPath}.source_intervention_id must be a non-empty string`)
    } else if (interventionIds.size > 0 && !interventionIds.has(source)) {
      errors.push(`${eventPath}.source_intervention_id must reference an Intervention in this proposal`)
    } else if (seenInterventionEvents.has(source)) {
      errors.push(`${eventPath}.source_intervention_id must appear at most once in the day plan`)
    } else {
      seenInterventionEvents.add(source)
    }
  })
}

function dayPlanClockMinutes(value: unknown, allowEndOfDay = false): number | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (match === null) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (allowEndOfDay && hour === 24 && minute === 0) return 1440
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return hour * 60 + minute
}

function validateDayPlanTimeWindows(errors: string[], value: unknown, path: string, nonEmpty = true): void {
  const windows = requireArray(errors, value, path)
  if (nonEmpty && windows !== null && windows.length === 0) errors.push(`${path} must be a non-empty array`)
  windows?.forEach((candidate, index) => {
    const itemPath = `${path}[${index}]`
    const window = requireObject(errors, candidate, itemPath)
    if (window === null) return
    const start = dayPlanClockMinutes(window.start)
    const end = dayPlanClockMinutes(window.end, true)
    if (start === null || end === null || end <= start) {
      errors.push(`${itemPath} must use same-day HH:MM values with end after start`)
    }
  })
}

function validateDayPlanScheduling(errors: string[], value: unknown, interventionIds: Set<string>): void {
  const scheduling = requireObject(errors, value, 'day_plan.scheduling')
  if (scheduling === null) return
  if (scheduling.mode !== 'automatic' && scheduling.mode !== 'custom') {
    errors.push('day_plan.scheduling.mode must be automatic or custom')
  }
  validateDayPlanTimeWindows(errors, scheduling.windows, 'day_plan.scheduling.windows')
  validateDayPlanTimeWindows(errors, scheduling.busy, 'day_plan.scheduling.busy', false)
  if (!isNonNegativeInt(scheduling.break_minutes) || Number(scheduling.break_minutes) > 120) {
    errors.push('day_plan.scheduling.break_minutes must be an integer from 0 to 120')
  }
  if (
    scheduling.max_minutes !== null
    && scheduling.max_minutes !== undefined
    && (!isPositiveInt(scheduling.max_minutes) || Number(scheduling.max_minutes) > 1440)
  ) {
    errors.push('day_plan.scheduling.max_minutes must be null or an integer from 1 to 1440')
  }
  if (typeof scheduling.allow_duration_adjustment !== 'boolean') {
    errors.push('day_plan.scheduling.allow_duration_adjustment must be a boolean')
  }
  if (!isPositiveInt(scheduling.min_duration_minutes) || Number(scheduling.min_duration_minutes) > 720) {
    errors.push('day_plan.scheduling.min_duration_minutes must be an integer from 1 to 720')
  }
  for (const key of ['intervention_order', 'defer_intervention_ids']) {
    const ids = needStringArray(errors, scheduling[key], `day_plan.scheduling.${key}`)
    if (ids !== null && ids.length !== new Set(ids).size) {
      errors.push(`day_plan.scheduling.${key} must not contain duplicates`)
    }
    if (ids !== null) {
      for (const interventionId of ids) {
        if (!interventionIds.has(interventionId)) {
          errors.push(`day_plan.scheduling.${key} must reference an Intervention in this proposal: ${interventionId}`)
        }
      }
    }
  }
  const placements = requireArray(errors, scheduling.placements, 'day_plan.scheduling.placements')
  const placementIds: string[] = []
  placements?.forEach((candidate, index) => {
    const path = `day_plan.scheduling.placements[${index}]`
    const placement = requireObject(errors, candidate, path)
    if (placement === null) return
    const interventionId = needString(errors, placement, 'intervention_id', `${path}.intervention_id`)
    if (interventionId !== null) {
      placementIds.push(interventionId)
      if (!interventionIds.has(interventionId)) {
        errors.push(`${path}.intervention_id must reference an Intervention in this proposal`)
      }
    }
    if (placement.schedule_id !== undefined && placement.schedule_id !== null) {
      needString(errors, placement, 'schedule_id', `${path}.schedule_id`)
    }
    if (placement.start_time !== undefined && placement.start_time !== null && dayPlanClockMinutes(placement.start_time) === null) {
      errors.push(`${path}.start_time must be HH:MM`)
    }
    if (
      placement.duration_minutes !== undefined
      && placement.duration_minutes !== null
      && (!isPositiveInt(placement.duration_minutes) || Number(placement.duration_minutes) > 720)
    ) {
      errors.push(`${path}.duration_minutes must be an integer from 1 to 720`)
    }
  })
  if (placementIds.length !== new Set(placementIds).size) {
    errors.push('day_plan.scheduling.placements must not repeat an intervention_id')
  }
  if (!isNonNegativeInt(scheduling.existing_event_conflicts)) {
    errors.push('day_plan.scheduling.existing_event_conflicts must be a non-negative integer')
  }
}

/**
 * Validate a plan proposal against study_plan_proposal.v1, including its day plan and
 * decision state rules.
 * @param data - the candidate proposal.
 * @returns the validated record or normalized errors.
 */
export function validatePlanProposal(data: unknown): ValidationResult {
  const record = asRecord(data)
  if (record === null) return { ok: false, errors: [`proposal must be an object, got ${typeName(data)}`] }
  const errors: string[] = []
  if (record.schema_version !== PLAN_PROPOSAL_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${PLAN_PROPOSAL_SCHEMA_VERSION}`)
  }
  if (record.policy_version !== INTERVENTION_POLICY_VERSION) {
    errors.push(`policy_version must be ${INTERVENTION_POLICY_VERSION}`)
  }
  for (const key of ['proposal_id', 'project_id', 'title', 'status', 'rationale', 'generation_fingerprint']) {
    needString(errors, record, key, key)
  }
  if (typeof record.proposal_id === 'string' && !SCHEDULE_ID_RE.test(record.proposal_id)) {
    errors.push(`proposal_id must match ${SCHEDULE_ID_PATTERN}`)
  }
  if (typeof record.project_id === 'string' && !PROJECT_ID_RE.test(record.project_id)) {
    errors.push(`project_id must match ${PROJECT_ID_PATTERN}`)
  }
  if (typeof record.generation_fingerprint === 'string') {
    if (!/^[0-9a-f]{64}$/.test(record.generation_fingerprint)) {
      errors.push('generation_fingerprint must be a 64-character lowercase hex digest')
    } else if (typeof record.proposal_id === 'string' && record.proposal_id !== `plan-${record.generation_fingerprint.slice(0, 20)}`) {
      errors.push('proposal_id must be derived from generation_fingerprint')
    }
  }
  needEnum(errors, record.status, 'status', PLAN_PROPOSAL_STATUSES)
  needOffsetDatetime(errors, record.created_at, 'created_at')
  needOffsetDatetime(errors, record.as_of, 'as_of')
  const proposalEvidence = needStringArray(errors, record.evidence_attempt_ids, 'evidence_attempt_ids')
  if (proposalEvidence !== null && proposalEvidence.length !== new Set(proposalEvidence).size) {
    errors.push('evidence_attempt_ids must not contain duplicates')
  }

  const seenInterventionIds = new Set<string>()
  const items = requireArray(errors, record.items, 'items')
  if (items !== null && items.length === 0) errors.push('items must be a non-empty array')
  const itemEvidence: string[] = []
  items?.forEach((item, index) => {
    validatePlanItem(errors, item, `items[${index}]`, seenInterventionIds)
    const parsed = asRecord(item)
    if (parsed !== null && Array.isArray(parsed.evidence_attempt_ids)) {
      itemEvidence.push(...(parsed.evidence_attempt_ids as string[]))
    }
  })
  if (proposalEvidence !== null && items !== null && items.length > 0) {
    const union = new Set(itemEvidence)
    if (union.size !== new Set(proposalEvidence).size || [...union].some(id => !proposalEvidence.includes(id))) {
      errors.push('evidence_attempt_ids must equal the union of item evidence_attempt_ids')
    }
  }

  if (record.day_plan !== undefined && record.day_plan !== null) {
    const plan = requireObject(errors, record.day_plan, 'day_plan')
    if (plan !== null) {
      if (plan.schema_version !== DAY_PLAN_SCHEMA_VERSION) {
        errors.push(`day_plan.schema_version must be ${DAY_PLAN_SCHEMA_VERSION}`)
      }
      if (typeof plan.target_date !== 'string' || parseDate(plan.target_date) === null) {
        errors.push('day_plan.target_date must be an ISO date')
      }
      const entries = requireArray(errors, plan.schedules, 'day_plan.schedules')
      const seenEventIds = new Set<string>()
      const seenInterventionEvents = new Set<string>()
      const occupied: Array<{ id: string; start: Date; end: Date }> = []
      entries?.forEach((entry, index) => {
        validateDayPlanEvents(
          errors,
          entry,
          `day_plan.schedules[${index}]`,
          seenInterventionIds,
          seenEventIds,
          seenInterventionEvents,
          occupied,
        )
      })
      if (plan.scheduling !== undefined && plan.scheduling !== null) {
        validateDayPlanScheduling(errors, plan.scheduling, seenInterventionIds)
      }
    }
  }

  if (record.schedule_change !== undefined && record.schedule_change !== null) {
    const change = requireObject(errors, record.schedule_change, 'schedule_change')
    if (change !== null) {
      if (change.state !== 'not_applied') errors.push('schedule_change.state must be not_applied')
      if (change.requires_explicit_save !== true) errors.push('schedule_change.requires_explicit_save must be true')
    }
  }

  const status = record.status
  const decision = record.decision
  if (status === 'proposed') {
    if (decision !== undefined && decision !== null) errors.push('decision must be absent while status is proposed')
  } else if (status === 'accepted' || status === 'rejected') {
    const decisionData = requireObject(errors, decision, 'decision')
    if (decisionData !== null) {
      if (decisionData.outcome !== status) errors.push('decision.outcome must match status')
      needOffsetDatetime(errors, decisionData.decided_at, 'decision.decided_at')
      if (decisionData.note !== undefined && decisionData.note !== null && (typeof decisionData.note !== 'string' || !decisionData.note.trim())) {
        errors.push('decision.note must be a non-empty string when provided')
      }
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: record }
}
