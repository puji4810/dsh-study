/**
 * Evidence-backed learning-session orchestration for StudyOS. `LearningRuntime` is the
 * narrow lifecycle interface between a conversation and StudyOS' durable evidence model.
 * It owns session state and activity selection; attempt persistence and competency
 * diagnosis stay injected. Every code, message, and field mirrors Python `runtime.py`.
 * @module @puji4810/dsh-study/runtime
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, isAbsolute, relative, resolve } from 'node:path'
import {
  ACTIVITY_SPEC_SCHEMA_VERSION,
  COMPETENCY_SNAPSHOT_SCHEMA_VERSION,
  EVIDENCE_DIMENSIONS,
  EVALUATOR_KINDS,
  LEARNING_CONTRACT_SCHEMA_VERSION,
  LEARNING_SESSION_SCHEMA_VERSION,
  PROJECT_ID_PATTERN,
  SCHEDULE_ID_PATTERN,
} from './constants.ts'
import { StudyOSError } from './errors.ts'
import { toIsoSeconds } from './datetime.ts'
import { validateLearningContract } from './validate.ts'
import { GeneralActivityAdapter, type ActivityAdapter } from './activities.ts'
import type { Diagnosis, LearningContract, LearningSession, Recommendation, StudyAttempt, StudyProject, StudySourceAnchor } from './types.ts'

const PROJECT_ID_RE = new RegExp(PROJECT_ID_PATTERN)
const SCHEDULE_ID_RE = new RegExp(SCHEDULE_ID_PATTERN)

/** The attempt recorder's total-or-error result contract. */
export type AttemptRecorderResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } }

/** A conversation-id to session binding entry inside the active-sessions index. */
interface BindingEntry {
  project_id: string
  learning_session_id: string
}

/**
 * Resolve an explicitly-bound active learning session without mutating state.
 * @param vaultPath - the vault root; the index lives at `.StudyOS/runtime/active-sessions.json`.
 * @param conversationId - the conversation session id to look up.
 * @returns the active session record, or null when unbound or invalid.
 */
export function activeSessionForConversation(vaultPath: string, conversationId: string): LearningSession | null {
  const key = conversationId.trim()
  if (!key) return null
  const indexPath = resolve(vaultPath, '.StudyOS', 'runtime', 'active-sessions.json')
  if (!existsSync(indexPath)) return null
  const index = readMapping(indexPath, 'active-sessions.json')
  const binding = index[key]
  if (!isObject(binding)) return null
  const projectId = stringValue(binding['project_id'])
  const learningSessionId = stringValue(binding['learning_session_id'])
  if (!PROJECT_ID_RE.test(projectId) || !SCHEDULE_ID_RE.test(learningSessionId)) return null
  const projectPath = resolve(vaultPath, '.StudyOS', 'projects', projectId)
  const sessionPath = resolve(projectPath, 'sessions', `${learningSessionId}.json`)
  if (!isInside(sessionPath, projectPath)) return null
  if (!existsSync(sessionPath)) return null
  const session = readMapping(sessionPath, `${learningSessionId}.json`)
  if (session['status'] !== 'active' || session['conversation_session_id'] !== key) return null
  return session as unknown as LearningSession
}

/**
 * Run one explicit learning contract through evidence-backed activities. Session state
 * lives at `{sessionsDir}/{id}.json`; the conversation binding index lives at the
 * configured `bindingIndexPath`.
 */
export class LearningRuntime {
  private readonly sessionsDir: string
  private readonly bindingIndexPath: string
  private readonly project: StudyProject
  private readonly attemptReader: (projectId: string) => StudyAttempt[]
  private readonly attemptRecorder: (args: Record<string, unknown>) => AttemptRecorderResult
  private readonly snapshotBuilder: (attempts: StudyAttempt[]) => Diagnosis
  private readonly recommendationBuilder: (diagnosis: Diagnosis) => Recommendation[]
  private readonly activityAdapter: ActivityAdapter
  private readonly nowFn: () => Date

  /**
   * @param options - the runtime's injected dependencies and paths.
   */
  constructor(options: {
    project: StudyProject
    sessionsDir: string
    bindingIndexPath: string
    attemptReader: (projectId: string) => StudyAttempt[]
    attemptRecorder: (args: Record<string, unknown>) => AttemptRecorderResult
    snapshotBuilder: (attempts: StudyAttempt[]) => Diagnosis
    recommendationBuilder: (diagnosis: Diagnosis) => Recommendation[]
    activityAdapter?: ActivityAdapter
    now?: () => Date
  }) {
    this.project = options.project
    this.sessionsDir = options.sessionsDir
    this.bindingIndexPath = options.bindingIndexPath
    this.attemptReader = options.attemptReader
    this.attemptRecorder = options.attemptRecorder
    this.snapshotBuilder = options.snapshotBuilder
    this.recommendationBuilder = options.recommendationBuilder
    this.activityAdapter = options.activityAdapter ?? new GeneralActivityAdapter()
    this.nowFn = options.now ?? (() => new Date())
  }

  /**
   * Create an active session and its first activity without fabricating evidence.
   * @param options - the session id, contract, and optional conversation binding.
   * @returns the session, first activity, competency snapshot, and continuation state.
   */
  start(options: { sessionId: unknown; contract: unknown; conversationSessionId?: unknown }): Record<string, unknown> {
    const resolvedSessionId = this.validateSessionId(options.sessionId)
    const path = this.sessionPath(resolvedSessionId)
    if (existsSync(path)) {
      throw new StudyOSError('SESSION_EXISTS', `Learning session already exists: ${resolvedSessionId}`)
    }
    const normalizedContract = this.normalizeContract(options.contract, resolvedSessionId)
    const conversationId = stringValue(options.conversationSessionId).trim() || null
    if (conversationId) this.assertConversationAvailable(conversationId)
    const now = this.now()
    const session: Record<string, unknown> = {
      schema_version: LEARNING_SESSION_SCHEMA_VERSION,
      session_id: resolvedSessionId,
      project_id: this.project.project_id,
      contract: normalizedContract,
      status: 'active',
      started_at: now,
      updated_at: now,
      evidence_ids: [],
      activity_history: [],
    }
    if (conversationId) session['conversation_session_id'] = conversationId
    const snapshot = this.competencySnapshot(session)
    const continuation = this.continuationState(session)
    session['current_activity'] = this.nextActivity(session, continuation)
    this.saveSession(session)
    if (conversationId) this.bindConversation(conversationId, resolvedSessionId)
    return {
      session,
      next_activity: session['current_activity'],
      competency_snapshot: snapshot,
      continuation,
    }
  }

  /**
   * Record one evaluated observation and select the next activity.
   * @param options - the session id and the evaluated observation.
   * @returns the updated session, evidence, next activity, snapshot, and recommendations.
   */
  advance(options: { sessionId: unknown; observation: unknown }): Record<string, unknown> {
    const session = this.loadSession(options.sessionId)
    LearningRuntime.requireActive(session)
    if (!isObject(options.observation)) {
      throw new StudyOSError('VALIDATION_FAILED', 'observation must be an object')
    }
    const observation = options.observation
    const evaluator = observation['evaluator']
    if (!isObject(evaluator)) {
      throw new StudyOSError(
        'EVALUATOR_REQUIRED',
        'advance requires observation.evaluator so evidence provenance is explicit',
      )
    }
    const evaluatorRecord = evaluator
    if (!(EVALUATOR_KINDS as readonly string[]).includes(String(evaluatorRecord['kind']))) {
      throw new StudyOSError(
        'VALIDATION_FAILED',
        `observation.evaluator.kind must be one of: ${[...EVALUATOR_KINDS].sort().join(', ')}`,
      )
    }

    const activity = session['current_activity']
    if (!isObject(activity)) {
      throw new StudyOSError('SESSION_STATE_INVALID', 'Active session has no current activity')
    }
    const activityRecord = activity
    const issues = this.activityAdapter.validateObservation(activityRecord, observation)
    if (issues.length > 0) {
      const issue = issues[0] as { code: string; message: string }
      throw new StudyOSError(issue.code, issue.message)
    }
    const attemptResult = this.attemptRecorder(this.attemptArgs(session, activityRecord, observation))
    if (!attemptResult.ok) {
      const error = attemptResult.error
      const details = error.details !== undefined && isObject(error.details)
        ? error.details
        : undefined
      throw new StudyOSError(
        error.code || 'EVIDENCE_RECORD_FAILED',
        error.message || 'Failed to record learning evidence',
        details,
      )
    }
    const evidence = attemptResult.data['attempt']
    if (!isObject(evidence)) {
      throw new StudyOSError('EVIDENCE_RECORD_FAILED', 'Attempt recorder returned no evidence')
    }
    const evidenceRecord = evidence
    const evidenceId = String(evidenceRecord['attempt_id'])
    const completedActivity = {
      ...activityRecord,
      status: 'completed',
      completed_at: this.now(),
      evidence_attempt_id: evidenceId,
    }
    const history = (session['activity_history'] as unknown[] | undefined) ?? []
    history.push(completedActivity)
    session['activity_history'] = history
    const evidenceIds = [...((session['evidence_ids'] as unknown[] | undefined) ?? [])]
    session['evidence_ids'] = [...new Set([...evidenceIds, evidenceId])]
    const snapshot = this.competencySnapshot(session)
    const recommendations = this.recommendationBuilder(this.diagnosisFor(session))
    const continuation = this.continuationState(session)
    session['current_activity'] = this.nextActivity(session, continuation)
    session['updated_at'] = this.now()
    this.saveSession(session)
    return {
      session,
      evidence,
      next_activity: session['current_activity'],
      competency_snapshot: snapshot,
      recommendations,
      continuation,
    }
  }

  /**
   * Rebuild the current competency view from immutable evidence.
   * @param options - the session id.
   * @returns the session and its competency snapshot.
   */
  snapshot(options: { sessionId: unknown }): Record<string, unknown> {
    const session = this.loadSession(options.sessionId)
    return { session, competency_snapshot: this.competencySnapshot(session) }
  }

  /**
   * Close an active session and report only evidence-supported outcomes.
   * @param options - the session id.
   * @returns the completed session and its outcome.
   */
  finish(options: { sessionId: unknown }): Record<string, unknown> {
    const session = this.loadSession(options.sessionId)
    LearningRuntime.requireActive(session)
    const snapshot = this.competencySnapshot(session)
    const current = session['current_activity']
    if (isObject(current)) {
      const history = (session['activity_history'] as unknown[] | undefined) ?? []
      history.push({ ...(current), status: 'not_completed', completed_at: this.now() })
      session['activity_history'] = history
    }
    delete session['current_activity']
    const now = this.now()
    session['status'] = 'completed'
    session['completed_at'] = now
    session['updated_at'] = now
    this.saveSession(session)
    const conversationId = session['conversation_session_id']
    if (typeof conversationId === 'string') {
      this.unbindConversation(conversationId, String(session['session_id']))
    }
    const contract = session['contract'] as Record<string, unknown>
    const requiredDimensions = (contract['evidence_targets'] as unknown[]).map(String)
    const snapshotDimensions = (snapshot['dimensions'] ?? {}) as Record<string, Record<string, unknown>>
    const unverified = requiredDimensions.filter(
      dimension => snapshotDimensions[dimension]?.['verification_status'] !== 'independent',
    )
    const observed = requiredDimensions.filter(
      dimension => snapshotDimensions[dimension]?.['status'] === 'observed',
    )
    const outcome = {
      evidence_count: ((session['evidence_ids'] as unknown[] | undefined) ?? []).length,
      evidence_attempt_ids: [...((session['evidence_ids'] as unknown[] | undefined) ?? [])],
      observed_dimensions: observed,
      verified_dimensions: requiredDimensions.filter(dimension => !unverified.includes(dimension)),
      unverified_dimensions: unverified,
      competency_snapshot: snapshot,
    }
    return { session, outcome }
  }

  private now(): string {
    return toIsoSeconds(this.nowFn())
  }

  private validateSessionId(value: unknown): string {
    const sessionId = stringValue(value).trim()
    if (!SCHEDULE_ID_RE.test(sessionId)) {
      throw new StudyOSError('VALIDATION_FAILED', 'session_id must match ^[a-z0-9][a-z0-9-]{2,79}$')
    }
    return sessionId
  }

  private sessionPath(sessionId: string): string {
    return join(this.sessionsDir, `${sessionId}.json`)
  }

  private loadSession(sessionId: unknown): Record<string, unknown> {
    const resolvedSessionId = this.validateSessionId(sessionId)
    const path = this.sessionPath(resolvedSessionId)
    if (!existsSync(path)) {
      throw new StudyOSError('SESSION_NOT_FOUND', `Learning session not found: ${resolvedSessionId}`)
    }
    const session = readMapping(path, `${resolvedSessionId}.json`)
    if (
      session['schema_version'] !== LEARNING_SESSION_SCHEMA_VERSION
      || session['session_id'] !== resolvedSessionId
      || session['project_id'] !== this.project.project_id
    ) {
      throw new StudyOSError('SESSION_STATE_INVALID', `Invalid learning session: ${resolvedSessionId}`)
    }
    this.syncEvidenceIds(session)
    return session
  }

  private static requireActive(session: Record<string, unknown>): void {
    if (session['status'] !== 'active') {
      throw new StudyOSError('SESSION_NOT_ACTIVE', `Learning session is not active: ${stringValue(session['session_id'])}`)
    }
  }

  private normalizeContract(value: unknown, sessionId: string): Record<string, unknown> {
    if (!isObject(value)) {
      throw new StudyOSError('VALIDATION_FAILED', 'contract must be an object')
    }
    const record = value
    const contract: Record<string, unknown> = {
      ...record,
      schema_version: record['schema_version'] || LEARNING_CONTRACT_SCHEMA_VERSION,
      contract_id: record['contract_id'] || `contract-${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      project_id: record['project_id'] || this.project.project_id,
      created_at: record['created_at'] || this.now(),
    }
    const result = validateLearningContract(contract, this.project)
    if (!result.ok) {
      const validationErrors = result.errors
      throw new StudyOSError(
        'VALIDATION_FAILED',
        validationErrors.join('; '),
        { errors: validationErrors, session_id: sessionId },
      )
    }
    if (!isObject(result.value)) {
      throw new StudyOSError('VALIDATION_FAILED', 'Learning contract validator returned invalid data')
    }
    return result.value
  }

  private relevantAttempts(session: Record<string, unknown>): StudyAttempt[] {
    const attempts = this.attemptReader(this.project.project_id)
    const contract = session['contract'] as Record<string, unknown>
    const objectiveIds = (contract['objective_ids'] as unknown[] | undefined) ?? []
    if (objectiveIds.length > 0) {
      const objectiveSet = new Set(objectiveIds.map(String))
      return attempts.filter(attempt =>
        (attempt.objective_ids ?? []).some(id => objectiveSet.has(id)),
      )
    }
    const learningSessionId = String(session['session_id'])
    return attempts.filter(attempt => attempt.session_id === learningSessionId)
  }

  private sessionAttempts(session: Record<string, unknown>): StudyAttempt[] {
    const learningSessionId = String(session['session_id'])
    return this.attemptReader(this.project.project_id)
      .filter(attempt => attempt.session_id === learningSessionId)
  }

  private continuationState(session: Record<string, unknown>): Record<string, unknown> {
    const attempts = this.sessionAttempts(session)
    const observed = new Set(
      attempts
        .filter(attempt => attempt.transfer_level !== undefined
          && (EVIDENCE_DIMENSIONS as readonly string[]).includes(attempt.transfer_level))
        .map(attempt => String(attempt.transfer_level)),
    )
    const contract = session['contract'] as Record<string, unknown>
    const required = (contract['evidence_targets'] as unknown[]).map(String)
    const pending = required.filter(dimension => !observed.has(dimension))
    const elapsedSeconds = attempts.reduce((sum, attempt) => {
      const duration = attempt.duration_seconds
      return typeof duration === 'number' && Number.isInteger(duration) && duration >= 0
        ? sum + duration
        : sum
    }, 0)
    const budgetSeconds = Number(contract['time_budget_minutes']) * 60
    let state: string
    let reason: string
    if (elapsedSeconds >= budgetSeconds) {
      state = 'ready_to_finish'
      reason = 'time_budget_reached'
    } else if (pending.length === 0) {
      state = 'ready_to_finish'
      reason = 'contract_evidence_observed'
    } else {
      state = 'continue'
      reason = 'contract_evidence_pending'
    }
    return {
      state,
      reason,
      observed_evidence_targets: required.filter(dimension => observed.has(dimension)),
      pending_evidence_targets: pending,
      elapsed_activity_seconds: elapsedSeconds,
      time_budget_seconds: budgetSeconds,
      learner_controls_follow_up: true,
    }
  }

  private syncEvidenceIds(session: Record<string, unknown>): void {
    const recorded = this.attemptReader(this.project.project_id)
      .filter(attempt => attempt.session_id === session['session_id'] && attempt.attempt_id)
      .map(attempt => attempt.attempt_id)
    const existing = ((session['evidence_ids'] as unknown[] | undefined) ?? []).map(String)
    session['evidence_ids'] = [...new Set([...existing, ...recorded])]
  }

  private diagnosisFor(session: Record<string, unknown>): Diagnosis {
    return this.snapshotBuilder(this.relevantAttempts(session))
  }

  private competencySnapshot(session: Record<string, unknown>): Record<string, unknown> {
    const attempts = this.relevantAttempts(session)
    const diagnosis = this.snapshotBuilder(attempts)
    const dimensions = diagnosis.evidence_dimensions as unknown as Record<string, Record<string, unknown>>
    const provenance = new Map<string, number>()
    for (const attempt of attempts) {
      const evaluator = attempt.evaluator
      const kind = evaluator !== undefined ? evaluator.kind : 'unprovenanced'
      provenance.set(kind, (provenance.get(kind) ?? 0) + 1)
    }
    const contract = session['contract'] as Record<string, unknown>
    return {
      schema_version: COMPETENCY_SNAPSHOT_SCHEMA_VERSION,
      project_id: this.project.project_id,
      objective_ids: [...((contract['objective_ids'] as unknown[] | undefined) ?? [])],
      built_at: this.now(),
      evidence_count: attempts.length,
      evidence_attempt_ids: attempts.map(attempt => attempt.attempt_id),
      dimensions,
      concepts: diagnosis.concepts,
      diagnosis_clusters: diagnosis.diagnosis_clusters,
      score_delta_earlier_to_later: diagnosis.score_delta_earlier_to_later,
      evaluator_provenance: Object.fromEntries(provenance),
      unverified_dimensions: (EVIDENCE_DIMENSIONS as readonly string[]).filter(
        dimension => dimensions[dimension]?.['verification_status'] !== 'independent',
      ),
    }
  }

  private objectiveDetails(contract: Record<string, unknown>): { criteria: string[]; anchors: StudySourceAnchor[] } {
    const objectiveIds = new Set((contract['objective_ids'] as unknown[] | undefined) ?? [])
    const criteria: string[] = []
    const anchors: StudySourceAnchor[] = []
    const seenAnchors = new Set<string>()
    const objectives = (this.project['objectives'] as Record<string, unknown>[] | undefined) ?? []
    for (const objective of objectives) {
      if (!isObject(objective) || !objectiveIds.has(objective['objective_id'])) {
        continue
      }
      const successCriteria = objective['success_criteria']
      if (Array.isArray(successCriteria)) {
        for (const item of successCriteria) criteria.push(String(item))
      }
      const sourceAnchors = objective['source_anchors']
      if (Array.isArray(sourceAnchors)) {
        for (const anchor of sourceAnchors) {
          const fingerprint = canonicalJson(anchor)
          if (isObject(anchor) && !seenAnchors.has(fingerprint)) {
            anchors.push(anchor as unknown as StudySourceAnchor)
            seenAnchors.add(fingerprint)
          }
        }
      }
    }
    return { criteria: [...new Set(criteria)], anchors }
  }

  private nextActivity(session: Record<string, unknown>, continuation: Record<string, unknown>): Record<string, unknown> | null {
    const contract = session['contract'] as Record<string, unknown>
    const pendingTargets = [...(continuation['pending_evidence_targets'] as unknown[])]
    if (continuation['state'] === 'ready_to_finish' || pendingTargets.length === 0) return null
    const target = String(pendingTargets[0])
    const reason = `The learning contract still needs ${target} evidence.`
    const assistanceLevel = contract['assistance_level']
    const { criteria, anchors } = this.objectiveDetails(contract)
    const sequence = ((session['activity_history'] as unknown[] | undefined) ?? []).length + 1
    const interventionKind = stringValue(contract['intervention_kind'])
    const recommendation: Recommendation | null = interventionKind
      ? {
        priority: 'accepted-plan',
        intervention: interventionKind,
        reason: `Execute accepted Intervention ${stringValue(contract['source_intervention_id'])}.`,
        evidence_attempt_ids: [],
        evidence_dimension: target,
      }
      : null
    const activity: Record<string, unknown> = {
      schema_version: ACTIVITY_SPEC_SCHEMA_VERSION,
      activity_id: `activity-${String(session['session_id'])}-${String(sequence).padStart(3, '0')}`,
      session_id: session['session_id'],
      project_id: this.project.project_id,
      kind: 'evidence_probe',
      objective: contract['objective'],
      objective_ids: [...((contract['objective_ids'] as unknown[] | undefined) ?? [])],
      evidence_target: target,
      assistance_level: assistanceLevel,
      instructions: `Produce learner-authored ${target} evidence for: ${stringValue(contract['objective'])}`,
      response_policy: "Collect the learner's response before feedback or evaluator judgment.",
      rubric_requirements: criteria.length > 0
        ? criteria
        : ['valid result', 'reasoning made explicit', 'independent contribution identified'],
      source_anchors: anchors,
      reason,
      status: 'pending',
      created_at: this.now(),
    }
    Object.assign(activity, this.activityAdapter.build({
      project: this.project,
      contract: contract as unknown as LearningContract,
      evidence_target: target,
      recommendation,
      success_criteria: criteria,
      source_anchors: anchors,
    }))
    if (interventionKind) {
      activity['intervention_kind'] = interventionKind
      activity['source_plan_proposal_id'] = contract['source_plan_proposal_id']
      activity['source_intervention_id'] = contract['source_intervention_id']
    }
    return activity
  }

  private attemptArgs(
    session: Record<string, unknown>,
    activity: Record<string, unknown>,
    observation: Record<string, unknown>,
  ): Record<string, unknown> {
    const contract = session['contract'] as Record<string, unknown>
    const assistanceValue = observation['assistance']
    const assistance: Record<string, unknown> = isObject(assistanceValue)
      ? { ...(assistanceValue) }
      : {}
    let hintsUsed = assistance['hints_used'] ?? observation['hints_used']
    if (hintsUsed === undefined) hintsUsed = 0
    assistance['level'] = assistance['level']
      ?? observation['assistance_level']
      ?? activity['assistance_level']
      ?? contract['assistance_level']
    assistance['hints_used'] = hintsUsed
    return {
      vault_path: '',
      project_id: this.project.project_id,
      attempt_id: observation['attempt_id'],
      item_id: observation['item_id'] ?? activity['activity_id'],
      occurred_at: observation['occurred_at'] ?? this.now(),
      response: observation['response'],
      result: observation['result'],
      score: observation['score'],
      duration_seconds: observation['duration_seconds'],
      hints_used: hintsUsed,
      evaluator_confidence: observation['evaluator_confidence'],
      evaluator: observation['evaluator'],
      assistance,
      transfer_level: observation['transfer_level'] ?? activity['evidence_target'],
      concepts: observation['concepts'] ?? [],
      patterns: observation['patterns'] ?? [],
      objective_ids: [...((contract['objective_ids'] as unknown[] | undefined) ?? [])],
      diagnoses: observation['diagnoses'] ?? [],
      source_anchors: observation['source_anchors'] ?? activity['source_anchors'] ?? [],
      artifact_refs: observation['artifact_refs'],
      activity_kind: activity['kind'],
      intervention_kind: activity['intervention_kind'],
      source_plan_proposal_id: activity['source_plan_proposal_id'],
      source_intervention_id: activity['source_intervention_id'],
      source: activity['activity_id'],
      session_id: session['session_id'],
    }
  }

  private readActiveIndex(): Record<string, unknown> {
    if (!existsSync(this.bindingIndexPath)) return {}
    return readMapping(this.bindingIndexPath, 'active-sessions.json')
  }

  private assertConversationAvailable(conversationId: string): void {
    const binding = this.readActiveIndex()[conversationId]
    if (isObject(binding)) {
      throw new StudyOSError(
        'CONVERSATION_SESSION_ACTIVE',
        `Conversation already has an active learning session: ${stringValue(binding['learning_session_id'])}`,
      )
    }
  }

  private bindConversation(conversationId: string, learningSessionId: string): void {
    const index = this.readActiveIndex()
    const entry: BindingEntry = {
      project_id: this.project.project_id,
      learning_session_id: learningSessionId,
    }
    index[conversationId] = entry
    writeMapping(this.bindingIndexPath, index)
  }

  private unbindConversation(conversationId: string, learningSessionId: string): void {
    const index = this.readActiveIndex()
    const binding = index[conversationId]
    if (isObject(binding) && binding['learning_session_id'] === learningSessionId) {
      Reflect.deleteProperty(index, conversationId)
      writeMapping(this.bindingIndexPath, index)
    }
  }

  private saveSession(session: Record<string, unknown>): void {
    writeMapping(this.sessionPath(String(session['session_id'])), session)
  }
}

/** True for a non-null, non-array object — Python `isinstance(value, dict)` semantics. */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A string value of an unknown record field, empty when absent or non-string. */
function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Serialize a value with sorted keys for canonical fingerprinting. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

/** Deep-copy then sort object keys recursively. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) sorted[key] = sortKeys(record[key])
    return sorted
  }
  return value
}

/** Read and parse a JSON mapping file, mapping bad JSON onto SESSION_STATE_INVALID. */
function readMapping(path: string, name: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (_error) {
    throw new StudyOSError('SESSION_STATE_INVALID', `Invalid JSON in ${name}`)
  }
  if (!isObject(parsed)) {
    throw new StudyOSError('SESSION_STATE_INVALID', `${name} must contain an object`)
  }
  return parsed
}

/** Atomically write a JSON mapping: temp file in the same directory, then rename. */
function writeMapping(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID().replace(/-/g, '')}.tmp`)
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
}

/** Whether `candidate` resolves inside `base` without escaping it. */
function isInside(candidate: string, base: string): boolean {
  const relativePath = relative(base, candidate)
  return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath)
}
