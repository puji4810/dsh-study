/**
 * StudyOS plan-proposal handler: save / list / read / ensure_today / apply / accept / reject.
 * Mirrors the Python `learning.py` plan-proposal functions verbatim (lines 466-880) so the
 * derive → decide → apply state machine and its model-facing values stay identical.
 * @module @puji4810/dsh-study/handlers/plan-proposal
 */

import { existsSync, readdirSync } from 'node:fs'
import { INTERVENTION_POLICY_VERSION, PLAN_PROPOSAL_SCHEMA_VERSION, PROJECT_SCHEMA_VERSION_V2 } from '../constants.ts'
import { localDateString, parseDate } from '../datetime.ts'
import { err, errFrom, ok, StudyOSError, type StudyEnvelope } from '../errors.ts'
import { InterventionOrchestrator, parseAsOf } from '../interventions.ts'
import { activePhase } from '../day-plan.ts'
import { interventionOrchestration, projectTimeZone } from './coach.ts'
import type { DayPlan, InterventionItem, StudyData, StudyProject } from '../types.ts'
import { validateStudySchedule, validateScheduleRelationships, validatePlanProposal } from '../validate.ts'
import {
  allAttempts,
  planProposalDir,
  readJsonFile,
  readProjectManifest,
  resolveVaultPath,
  schedulePath,
  validateScheduleId,
  writeText,
} from '../vault.ts'
import { nowIso, type HandlerEnv } from './dispatch.ts'

/** True for a non-null, non-array object — Python `isinstance(value, dict)`. */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Sorted `.json` names inside a directory, or empty when missing. */
function sortedJsonNames(root: string): string[] {
  try {
    return readdirSync(root).filter(name => name.endsWith('.json')).sort()
  } catch {
    return []
  }
}

/** Render an unknown thrown value as a message string. */
function messageOf(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
}

/**
 * Normalize a derived proposal's timestamp strings to seconds precision, compensating for the
 * shared clock's millisecond rendering so validation matches the Python `timespec="seconds"`.
 * @param proposal - the proposal record, mutated in place.
 */
function normalizeProposalTimestamps(proposal: StudyData): void {
  for (const key of ['created_at', 'as_of']) {
    const value = proposal[key]
    if (typeof value === 'string') proposal[key] = stripMillis(value)
  }
  const decision = proposal['decision']
  if (isObject(decision) && typeof decision['decided_at'] === 'string') {
    decision['decided_at'] = stripMillis(decision['decided_at'])
  }
}

/** Strip a trailing `\.\d{3}Z` millisecond component from an ISO timestamp. */
function stripMillis(value: string): string {
  return value.replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Read and validate one plan proposal, raising `VALIDATION_FAILED` when invalid.
 * @param path - the proposal file.
 * @returns the validated proposal.
 */
function validatedPlanProposal(path: string): StudyData {
  const proposal = readJsonFile(path)
  const result = validatePlanProposal(proposal)
  if (!result.ok) {
    throw new StudyOSError('VALIDATION_FAILED', `Invalid Plan Proposal ${basenameOf(path)}: ${result.errors.join('; ')}`)
  }
  if (!isObject(result.value)) {
    throw new StudyOSError('VALIDATION_FAILED', 'Plan Proposal validator returned invalid data')
  }
  return result.value
}

/** The basename of a path. */
function basenameOf(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] ?? path
}

/** Validate a schedule against its project, returning `(value, errors)`. */
function validateScheduleForProject(
  project: StudyProject,
  schedule: StudyData,
): { value: StudyData | null; errors: string[] } {
  const result = validateStudySchedule(schedule)
  if (!result.ok) return { value: null, errors: result.errors }
  if (!isObject(result.value)) return { value: null, errors: ['Schedule validator returned invalid data'] }
  const relationshipErrors = validateScheduleRelationships(project, result.value)
  if (relationshipErrors.length > 0) return { value: null, errors: relationshipErrors }
  return { value: result.value, errors: [] }
}

/** True when two schedules differ in nothing but their `events`. */
function eventsOnlyChange(before: StudyData, after: StudyData): boolean {
  const beforeWithout = { ...before }
  const afterWithout = { ...after }
  delete beforeWithout['events']
  delete afterWithout['events']
  return JSON.stringify(beforeWithout) === JSON.stringify(afterWithout)
}

/** Save a candidate proposal the Python `_plan_proposal_activity` `save` way. */
function saveProposal(
  vault: string,
  project: StudyProject,
  args: StudyData,
  root: string,
): StudyEnvelope {
  const proposalValue = args['proposal']
  const proposal: StudyData = isObject(proposalValue) ? { ...proposalValue } : {}
  if (proposal['schema_version'] === undefined) proposal['schema_version'] = PLAN_PROPOSAL_SCHEMA_VERSION
  if (proposal['policy_version'] === undefined) proposal['policy_version'] = INTERVENTION_POLICY_VERSION
  if (proposal['project_id'] === undefined) proposal['project_id'] = project.project_id
  if (proposal['status'] === undefined) proposal['status'] = 'proposed'
  if (proposal['status'] !== 'proposed') {
    return err('INVALID_PROPOSAL_TRANSITION', 'plan_proposal.save only creates proposed items; use accept or reject for decisions')
  }
  normalizeProposalTimestamps(proposal)
  const validated = validatePlanProposal(proposal)
  if (!validated.ok) {
    return err('VALIDATION_FAILED', validated.errors.join('; '), { errors: validated.errors })
  }
  if (!isObject(validated.value)) {
    return err('VALIDATION_FAILED', 'Plan Proposal validator returned invalid data')
  }
  const record = validated.value
  if (record['project_id'] !== project.project_id) {
    return err('VALIDATION_FAILED', 'proposal project_id must match project manifest')
  }
  const expectedFingerprint = InterventionOrchestrator.fingerprint({
    project,
    items: record['items'] as InterventionItem[],
    dayPlan: record['day_plan'] as DayPlan | null,
  })
  const expectedProposalId = `plan-${expectedFingerprint.slice(0, 20)}`
  if (record['generation_fingerprint'] !== expectedFingerprint || record['proposal_id'] !== expectedProposalId) {
    return err('PROPOSAL_FINGERPRINT_MISMATCH', 'Plan Proposal id or fingerprint does not match its semantic content')
  }
  if (project.schema_version === PROJECT_SCHEMA_VERSION_V2) {
    const knownObjectives = new Set(
      ((project as unknown as Record<string, unknown>)['objectives'] as Array<Record<string, unknown>> | undefined ?? [])
        .filter(item => isObject(item))
        .map(item => String(item['objective_id'])),
    )
    const unknownObjectives = [...new Set(
      ((record['items'] as Array<Record<string, unknown>> | undefined ?? []).map(item => String(item['objective_id']))),
    )].filter(id => !knownObjectives.has(id)).sort()
    if (unknownObjectives.length > 0) {
      return err('OBJECTIVE_NOT_FOUND', 'Proposal references unknown Objectives', { objective_ids: unknownObjectives })
    }
  }
  const knownAttemptIds = new Set(allAttempts(vault, project.project_id).map(item => item.attempt_id))
  const missingAttemptIds = (record['evidence_attempt_ids'] as unknown[] ?? []).map(String)
    .filter(id => !knownAttemptIds.has(id))
  if (missingAttemptIds.length > 0) {
    return err('EVIDENCE_NOT_FOUND', 'Proposal references unknown attempts', { attempt_ids: missingAttemptIds })
  }
  const proposalId = validateScheduleId(record['proposal_id'])
  const path = `${root}/${proposalId}.json`
  if (existsSync(path)) {
    let existing: StudyData
    try {
      existing = validatedPlanProposal(path)
    } catch (error) {
      return errFrom(error as StudyOSError)
    }
    if (existing['generation_fingerprint'] !== record['generation_fingerprint']) {
      return err('PROPOSAL_CONFLICT', `Plan Proposal id is already used by different content: ${proposalId}`)
    }
    return ok({ proposal: existing, path: path.slice(vault.length + 1), created: false })
  }
  writeText(path, `${JSON.stringify(record, null, 2)}\n`)
  return ok({ proposal: record, path: path.slice(vault.length + 1), created: true })
}

/**
 * Handle a plan_proposal action.
 * @param action - the proposal action.
 * @param args - the payload.
 * @param env - the handler environment.
 * @returns the action envelope.
 */
export function handlePlanProposalActivity(action: string, args: StudyData, env: HandlerEnv): StudyEnvelope {
  try {
    const vault = resolveVaultPath(args['vault_path'], env.vaultPath)
    const project = readProjectManifest(vault, args['project_id'])
    const root = planProposalDir(vault, project.project_id)
    if (action === 'save') {
      return saveProposal(vault, project, args, root)
    }
    if (action === 'list') {
      const status = String(args['status'] || '').trim()
      if (status && !['proposed', 'accepted', 'rejected'].includes(status)) {
        return err('VALIDATION_FAILED', 'status must be proposed, accepted, or rejected')
      }
      const proposals: StudyData[] = []
      for (const name of sortedJsonNames(root)) {
        proposals.push(validatedPlanProposal(`${root}/${name}`))
      }
      const filtered = status ? proposals.filter(item => item['status'] === status) : proposals
      return ok({ project_id: project.project_id, proposals: filtered })
    }
    if (action === 'ensure_today') {
      return ensureTodayProposal(vault, project, args, root, env)
    }
    if (action === 'apply') {
      return applyPlanProposal(vault, project, args, root)
    }
    if (action !== 'read' && action !== 'accept' && action !== 'reject') {
      return err('INVALID_ACTION', `Unsupported plan_proposal action: ${action}`)
    }
    const proposalId = validateScheduleId(args['proposal_id'])
    const path = `${root}/${proposalId}.json`
    if (!existsSync(path)) {
      return err('PROPOSAL_NOT_FOUND', `Plan Proposal not found: ${proposalId}`)
    }
    const proposal = validatedPlanProposal(path)
    if (action === 'read') {
      return ok({ proposal })
    }
    const targetStatus = action === 'accept' ? 'accepted' : 'rejected'
    if (proposal['status'] === targetStatus) {
      return ok({
        proposal,
        path: path.slice(vault.length + 1),
        changed: false,
        schedule_mutated: false,
      })
    }
    if (proposal['status'] !== 'proposed') {
      return err('INVALID_PROPOSAL_TRANSITION', `Cannot ${action} a Plan Proposal with status ${proposal['status']}`)
    }
    const decidedAt = String(args['decided_at'] || nowIso(env))
    const decision: StudyData = { outcome: targetStatus, decided_at: decidedAt }
    const note = String(args['decision_note'] || '').trim()
    if (note) decision['note'] = note
    const updated: StudyData = { ...proposal, status: targetStatus, decision }
    const validated = validatePlanProposal(updated)
    if (!validated.ok) {
      return err('VALIDATION_FAILED', validated.errors.join('; '), { errors: validated.errors })
    }
    if (!isObject(validated.value)) {
      return err('VALIDATION_FAILED', 'Plan Proposal validator returned invalid data')
    }
    writeText(path, `${JSON.stringify(validated.value, null, 2)}\n`)
    return ok({
      proposal: validated.value,
      path: path.slice(vault.length + 1),
      changed: true,
      schedule_mutated: false,
      schedule_policy: (
        'Acceptance records the learner decision only. Call plan_proposal.apply to write this '
        + 'plan\'s events into their Schedules; it writes events and nothing else. A change to '
        + 'phases or range remains a separate schedule.validate then schedule.save.'
      ),
    })
  } catch (error) {
    if (error instanceof StudyOSError) return errFrom(error)
    return err('STUDY_ACTIVITY_FAILED', messageOf(error))
  }
}

/**
 * Derive and persist today's proposal exactly once, the Python `_ensure_today_proposal` way.
 * @param vault - the resolved vault path.
 * @param project - the project manifest.
 * @param args - the payload (`as_of`).
 * @param root - the plan-proposals directory.
 * @param env - the handler environment.
 * @returns the ensure-today envelope.
 */
function ensureTodayProposal(
  vault: string,
  project: StudyProject,
  args: StudyData,
  root: string,
  env: HandlerEnv,
): StudyEnvelope {
  const asOf = parseAsOf(args['as_of'])
  const target = localDateString(asOf, projectTimeZone(project))!
  const existing: StudyData[] = []
  for (const name of sortedJsonNames(root)) {
    existing.push(validatedPlanProposal(`${root}/${name}`))
  }
  const matching = existing.filter(item => (isObject(item['day_plan']) ? item['day_plan']['target_date'] : undefined) === target)
  const decided = matching.filter(item => item['status'] !== 'proposed')
  const pending = matching.filter(item => item['status'] === 'proposed')
  if (pending.length > 0) {
    return ok({
      project_id: project.project_id,
      proposal: pending[0],
      created: false,
      reason: 'a proposed plan already exists for this date',
    })
  }
  if (decided.length > 0) {
    const firstDecided = decided[0] as StudyData
    return ok({
      project_id: project.project_id,
      proposal: firstDecided,
      created: false,
      reason: `this date was already ${firstDecided['status']}`,
    })
  }
  const orchestration = interventionOrchestration(vault, project, args, env)
  const proposal = orchestration.proposal
  if (!proposal) {
    return ok({
      project_id: project.project_id,
      proposal: null,
      created: false,
      reason: 'the Intervention Queue is empty, so there is nothing to plan',
    })
  }
  const saved = saveProposal(vault, project, { ...args, proposal }, root)
  if (!saved.ok) return saved
  return ok({
    project_id: project.project_id,
    proposal: saved.data['proposal'],
    created: true,
    reason: 'derived from current evidence',
  })
}

/**
 * Write an accepted proposal's day-plan events into its Schedules, the Python
 * `_apply_plan_proposal` way.
 * @param vault - the resolved vault path.
 * @param project - the project manifest.
 * @param args - the payload (`proposal_id`).
 * @param root - the plan-proposals directory.
 * @returns the apply envelope.
 */
function applyPlanProposal(
  vault: string,
  project: StudyProject,
  args: StudyData,
  root: string,
): StudyEnvelope {
  const proposalId = validateScheduleId(args['proposal_id'])
  const path = `${root}/${proposalId}.json`
  if (!existsSync(path)) {
    return err('PROPOSAL_NOT_FOUND', `Plan Proposal not found: ${proposalId}`)
  }
  const proposal = validatedPlanProposal(path)
  if (proposal['status'] !== 'accepted') {
    return err('PROPOSAL_NOT_ACCEPTED', `Only an accepted Plan Proposal may be applied; ${proposalId} is ${proposal['status']}`)
  }
  const dayPlan = isObject(proposal['day_plan']) ? proposal['day_plan'] : {}
  const entries = (dayPlan['schedules'] as Array<Record<string, unknown>> | undefined ?? [])
    .filter(entry => Array.isArray(entry['events']) && entry['events'].length > 0)
  if (entries.length === 0) {
    return err('NOTHING_TO_APPLY', 'This Plan Proposal carries no day-plan events to write')
  }
  const target = String(dayPlan['target_date'] || '')
  if (parseDate(target) === null) {
    return err('VALIDATION_FAILED', 'day_plan.target_date must be an ISO date')
  }
  const applied: StudyData[] = []
  for (const entry of entries) {
    const scheduleId = String(entry['schedule_id'] || '')
    const scheduleFilePath = schedulePath(vault, project.project_id, scheduleId)
    if (!existsSync(scheduleFilePath)) {
      return err('SCHEDULE_NOT_FOUND', `Plan Proposal targets a Schedule that no longer exists: ${scheduleId}`)
    }
    const before = readJsonFile(scheduleFilePath)
    const phase = activePhase(before, target)
    if (phase === null || String(phase['id']) !== String(entry['phase_id'])) {
      return err('PHASE_DRIFTED', `Schedule ${scheduleId} no longer has phase ${entry['phase_id']} covering ${target}; re-derive the plan`)
    }
    const merged = new Map<string, Record<string, unknown>>()
    for (const event of (before['events'] as Array<Record<string, unknown>> | undefined ?? [])) {
      if (isObject(event)) merged.set(String(event['id']), event)
    }
    for (const event of (entry['events'] as Array<Record<string, unknown>> | undefined ?? [])) {
      merged.set(String(event['id']), { ...event, source_plan_proposal_id: proposalId })
    }
    const after: StudyData = {
      ...before,
      events: [...merged.values()].sort((a, b) => {
        const aKey = `${String(a['start'])}\u0000${String(a['id'])}`
        const bKey = `${String(b['start'])}\u0000${String(b['id'])}`
        return aKey < bKey ? -1 : aKey > bKey ? 1 : 0
      }),
    }
    if (!eventsOnlyChange(before, after)) {
      return err('APPLY_WOULD_CHANGE_MORE_THAN_EVENTS', `Refusing to write ${scheduleId}: applying a day plan may only add events`)
    }
    const scheduleValidation = validateScheduleForProject(project, after)
    if (scheduleValidation.errors.length > 0 || scheduleValidation.value === null) {
      return err('VALIDATION_FAILED', scheduleValidation.errors.join('; '), { errors: scheduleValidation.errors })
    }
    writeText(scheduleFilePath, JSON.stringify(scheduleValidation.value))
    applied.push({
      schedule_id: scheduleId,
      path: scheduleFilePath.slice(vault.length + 1),
      events_written: (entry['events'] as unknown[] ?? []).length,
      events_total: (scheduleValidation.value['events'] as unknown[] ?? []).length,
    })
  }
  return ok({
    project_id: project.project_id,
    proposal_id: proposalId,
    target_date: target,
    applied,
    schedule_mutated: true,
    scope_policy: (
      'Only events were written. Phases, range, and title are untouched, so '
      + 'an applied day never rewrites the long-term plan.'
    ),
  })
}
