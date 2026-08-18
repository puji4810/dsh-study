/**
 * StudyOS coach handler: session lifecycle, evidence projection, configurable planning,
 * and provenance-safe execution of accepted Interventions.
 * @module @puji4810/dsh-study/handlers/coach
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { ASSISTANCE_LEVELS } from '../constants.ts'
import { addDays, isValidTimeZone, localDateString } from '../datetime.ts'
import { err, errFrom, ok, StudyOSError, type StudyEnvelope } from '../errors.ts'
import { activityAdapterFor } from '../activities.ts'
import { buildPlanAdherence } from '../adherence.ts'
import { capacityFactor, outcomeAdjustment } from '../calibration.ts'
import { buildInterventionOutcomes } from '../outcomes.ts'
import { diagnoseAttempts, patternProposals, probeBlueprint, recommendations } from '../diagnosis.ts'
import { InterventionOrchestrator, parseAsOf } from '../interventions.ts'
import { parseDayPlanPreferences } from '../day-plan.ts'
import { LearningRuntime } from '../runtime.ts'
import type {
  DayPlan,
  InterventionItem,
  InterventionQueue,
  PlanProposal,
  StudyAttempt,
  StudyData,
  StudyProject,
} from '../types.ts'
import { validatePlanProposal } from '../validate.ts'
import {
  allAttempts,
  planProposalDir,
  readJsonFile,
  readProjectManifest,
  resolveVaultPath,
  runtimeIndexPath,
  sessionsDir,
  validateScheduleId,
} from '../vault.ts'
import { filteredAttempts, recordAttempt } from './attempt.ts'
import { nowIso, type HandlerEnv } from './dispatch.ts'

/** The outcome lookback horizon, days: decisions recent enough to still describe now. */
const OUTCOME_LOOKBACK_DAYS = 90

/** The adherence lookback horizon, days, matching the shared default. */
const DEFAULT_LOOKBACK_DAYS = 14

/** Render an unknown thrown value as a message string. */
function messageOf(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
}

/** True for a non-null, non-array object (plain-object check). */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Whether a value is an ISO `YYYY-MM-DD` date string. */
function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

/** Sorted `.json` names inside a directory, or empty when missing. */
function sortedJsonNames(root: string): string[] {
  try {
    return readdirSync(root).filter(name => name.endsWith('.json')).sort()
  } catch {
    return []
  }
}

/**
 * The project's own clock zone: its declared IANA name, validated, with a UTC fallback when
 * undeclared (mirrors the original timezone-resolution seam).
 * @param project - the project manifest.
 * @returns the timezone name.
 */
export function projectTimeZone(project: StudyProject): string {
  const name = project.timezone
  if (typeof name !== 'string' || !name.trim()) return 'UTC'
  const trimmed = name.trim()
  if (!isValidTimeZone(trimmed)) {
    throw new StudyOSError('VALIDATION_FAILED', `project timezone is not a valid IANA timezone: ${name}`)
  }
  return trimmed
}

/**
 * Load every Schedule of a project, skipping unreadable or malformed files.
 * @param vault - the resolved vault path.
 * @param projectId - the project id.
 * @returns the loaded schedule records.
 */
export function projectSchedules(vault: string, projectId: string): StudyData[] {
  const root = `${vault}/.StudyOS/projects/${projectId}/schedules`
  if (!existsSync(root) || !statSync(root).isDirectory()) return []
  const schedules: StudyData[] = []
  for (const name of sortedJsonNames(root)) {
    try {
      schedules.push(readJsonFile(`${root}/${name}`))
    } catch {
      // Unreadable or malformed schedules are skipped, not raised.
    }
  }
  return schedules
}

/**
 * Filter attempts by the original `_filtered_attempts` rules.
 * @param vault - the resolved vault path.
 * @param projectId - the project id.
 * @param filters - the filter record.
 * @returns the matching attempts.
 */
export { filteredAttempts }

/** Validate a plan proposal, returning it or null on any validation failure. */
function validatePlanProposalLocal(value: Record<string, unknown>): StudyData | null {
  const result = validatePlanProposal(value)
  if (!result.ok) return null
  return isObject(result.value) ? result.value : null
}

/** Resolve one accepted Intervention into the explicit Session contract that executes it. */
function acceptedInterventionContract(
  vault: string,
  project: StudyProject,
  data: StudyData,
): { proposalId: string; interventionId: string; contract: StudyData; plannedEvent: StudyData | null; adjustments: StudyData } {
  const proposalId = validateScheduleId(data['proposal_id'])
  const interventionId = validateScheduleId(data['intervention_id'])
  const path = `${planProposalDir(vault, project.project_id, false)}/${proposalId}.json`
  if (!existsSync(path)) {
    throw new StudyOSError('PROPOSAL_NOT_FOUND', `Plan Proposal not found: ${proposalId}`)
  }
  const proposal = validatePlanProposalLocal(readJsonFile(path))
  if (proposal === null || proposal['project_id'] !== project.project_id) {
    throw new StudyOSError('VALIDATION_FAILED', `Invalid Plan Proposal: ${proposalId}`)
  }
  if (proposal['status'] !== 'accepted') {
    throw new StudyOSError(
      'PROPOSAL_NOT_ACCEPTED',
      `Only an accepted Plan Proposal may start an Intervention; ${proposalId} is ${proposal['status']}`,
    )
  }
  const item = ((proposal['items'] as InterventionItem[] | undefined) ?? [])
    .find(candidate => candidate.intervention_id === interventionId)
  if (item === undefined) {
    throw new StudyOSError('INTERVENTION_NOT_FOUND', `Intervention not found in ${proposalId}: ${interventionId}`)
  }
  const activity = item.recommended_activity
  const repairKinds = new Set(['guided_repair', 'misconception_probe', 'prerequisite_repair'])
  let plannedEvent: StudyData | null = null
  const dayPlan = proposal['day_plan']
  if (isObject(dayPlan) && Array.isArray(dayPlan['schedules'])) {
    for (const schedule of dayPlan['schedules']) {
      if (!isObject(schedule) || !Array.isArray(schedule['events'])) continue
      const event = schedule['events'].find(candidate => (
        isObject(candidate) && candidate['source_intervention_id'] === interventionId
      ))
      if (isObject(event)) {
        plannedEvent = {
          schedule_id: schedule['schedule_id'],
          target_date: dayPlan['target_date'],
          ...event,
        }
        break
      }
    }
  }
  const execution = data['execution']
  if (execution !== undefined && !isObject(execution)) {
    throw new StudyOSError('VALIDATION_FAILED', 'execution must be an object')
  }
  const executionRecord = isObject(execution) ? execution : {}
  let timeBudget = typeof plannedEvent?.['duration_minutes'] === 'number'
    ? Number(plannedEvent['duration_minutes'])
    : activity.duration_minutes
  if (executionRecord['time_budget_minutes'] !== undefined) {
    const requested = executionRecord['time_budget_minutes']
    if (!Number.isInteger(requested) || Number(requested) < 1 || Number(requested) > 720) {
      throw new StudyOSError('VALIDATION_FAILED', 'execution.time_budget_minutes must be an integer from 1 to 720')
    }
    timeBudget = Number(requested)
  }
  let assistanceLevel = activity.assistance_level
  if (executionRecord['assistance_level'] !== undefined) {
    if (!ASSISTANCE_LEVELS.includes(executionRecord['assistance_level'] as never)) {
      throw new StudyOSError(
        'VALIDATION_FAILED',
        `execution.assistance_level must be one of: ${ASSISTANCE_LEVELS.join(', ')}`,
      )
    }
    assistanceLevel = executionRecord['assistance_level'] as typeof assistanceLevel
  }
  return {
    proposalId,
    interventionId,
    contract: {
      objective: item.capability,
      mode: repairKinds.has(item.kind) ? 'learn' : 'assess',
      assistance_level: assistanceLevel,
      time_budget_minutes: timeBudget,
      objective_ids: [item.objective_id],
      evidence_targets: [activity.evidence_target],
      intervention_kind: item.kind,
      source_plan_proposal_id: proposalId,
      source_intervention_id: interventionId,
    },
    plannedEvent,
    adjustments: {
      time_budget_source: executionRecord['time_budget_minutes'] !== undefined
        ? 'execution_override'
        : plannedEvent === null ? 'recommended_activity' : 'day_plan_event',
      assistance_source: executionRecord['assistance_level'] !== undefined
        ? 'execution_override'
        : 'recommended_activity',
    },
  }
}

/**
 * Every Plan Proposal that still validates, skipping the ones that do not.
 * @param vault - the resolved vault path.
 * @param projectId - the project id.
 * @returns the readable proposals.
 */
export function readablePlanProposals(vault: string, projectId: string): StudyData[] {
  const root = planProposalDir(vault, projectId, false)
  if (!existsSync(root) || !statSync(root).isDirectory()) return []
  const proposals: StudyData[] = []
  for (const name of sortedJsonNames(root)) {
    try {
      const validated = validatePlanProposalLocal(readJsonFile(`${root}/${name}`))
      if (validated !== null) proposals.push(validated)
    } catch {
      // Unreadable or invalid proposals are skipped, not raised.
    }
  }
  return proposals
}

/** Parse an offset-carrying ISO datetime, or null. */
function parseOffsetDateTimeSafe(value: string): Date | null {
  const parsed = new Date(value.replace(/Z$/, '+00:00'))
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** Whether a proposal was decided at or after a horizon instant. */
function decidedAfter(proposal: StudyData, horizon: Date): boolean {
  const decision = proposal['decision']
  const decided = isObject(decision) ? decision['decided_at'] : undefined
  if (typeof decided !== 'string') return false
  const moment = parseOffsetDateTimeSafe(decided)
  return moment !== null && moment.getTime() >= horizon.getTime()
}

/**
 * Measured effectiveness of decisions recent enough to still describe now.
 * @param vault - the resolved vault path.
 * @param project - the project manifest.
 * @param attempts - the full attempt history.
 * @param asOf - the orchestration clock.
 * @returns the outcome record.
 */
export function recentOutcomes(
  vault: string,
  project: StudyProject,
  attempts: StudyAttempt[],
  asOf: Date,
): Record<string, unknown> {
  const horizon = new Date(asOf.getTime() - OUTCOME_LOOKBACK_DAYS * 86_400_000)
  const proposals = readablePlanProposals(vault, project.project_id)
    .filter(proposal => decidedAfter(proposal, horizon))
  return buildInterventionOutcomes({
    proposals,
    attempts,
    diagnosisBuilder: diagnoseAttempts,
    asOf,
  })
}

/**
 * Measured plan adherence over a lookback window ending on the project-local date.
 * @param project - the project manifest.
 * @param schedules - the loaded schedules.
 * @param attempts - the full attempt history.
 * @param asOf - the measurement clock.
 * @param lookbackDays - the window length in days (default 14).
 * @returns the adherence record.
 */
export function recentAdherence(
  project: StudyProject,
  schedules: StudyData[],
  attempts: StudyAttempt[],
  asOf: Date,
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
): Record<string, unknown> {
  const timeZone = projectTimeZone(project)
  const end = localDateString(asOf, timeZone)!
  const start = localDateString(addDays(asOf, -lookbackDays), timeZone)!
  return buildPlanAdherence({ schedules, attempts, timeZone, start, end, asOf })
}

/**
 * Derive the Intervention Queue, day plan, and reviewable proposal with the recommender's
 * own measured history in hand. Shared by `coach` and `plan_proposal.ensure_today`.
 * @param vault - the resolved vault path.
 * @param project - the project manifest.
 * @param data - the orchestration payload (`max_items`, `as_of`).
 * @param env - the handler environment.
 * @returns the queue, day plan, and proposal.
 */
export function interventionOrchestration(
  vault: string,
  project: StudyProject,
  data: StudyData,
  env: HandlerEnv,
): { queue: InterventionQueue; dayPlan: DayPlan | null; proposal: PlanProposal | null } {
  const maxItems = data['max_items'] ?? 5
  const asOf = parseAsOf(data['as_of'])
  const attempts = allAttempts(vault, project.project_id)
  const schedules = projectSchedules(vault, project.project_id)
  let scheduling
  try {
    scheduling = parseDayPlanPreferences(data['scheduling'])
  } catch (error) {
    throw new StudyOSError('VALIDATION_FAILED', messageOf(error))
  }
  const orchestrator = new InterventionOrchestrator({ project, diagnosisBuilder: diagnoseAttempts })
  void env
  return orchestrator.build({
    attempts,
    asOf,
    maxItems: typeof maxItems === 'number' ? maxItems : 5,
    schedules,
    outcomes: recentOutcomes(vault, project, attempts, asOf),
    adherence: recentAdherence(project, schedules, attempts, asOf),
    scheduling,
  })
}

/** The attempt-recorder result the runtime expects. */
type RuntimeRecorderResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } }

/**
 * Bind the session lifecycle runtime to StudyOS's evidence interfaces.
 * @param vault - the resolved vault path.
 * @param project - the project manifest.
 * @param env - the handler environment.
 * @returns the configured runtime.
 */
function learningRuntime(vault: string, project: StudyProject, env: HandlerEnv): LearningRuntime {
  const attemptRecorder = (attemptArgs: Record<string, unknown>): RuntimeRecorderResult => {
    const envelope = recordAttempt(attemptArgs, env)
    if (envelope.ok) return { ok: true, data: envelope.data }
    return { ok: false, error: envelope.error }
  }
  return new LearningRuntime({
    project,
    sessionsDir: sessionsDir(vault, project.project_id),
    bindingIndexPath: runtimeIndexPath(vault),
    attemptReader: (projectId: string) => allAttempts(vault, projectId),
    attemptRecorder,
    snapshotBuilder: diagnoseAttempts,
    recommendationBuilder: recommendations,
    activityAdapter: activityAdapterFor(project),
    now: env.now,
  })
}

/** Merge the coach payload the original `_payload` way. */
function mergeCoachPayload(args: StudyData): StudyData {
  const data = args['data']
  const result: StudyData = isObject(data) ? { ...data } : {}
  for (const key of ['vault_path', 'project_id']) {
    if (args[key] !== null && args[key] !== undefined) result[key] = args[key]
  }
  return result
}

/**
 * Handle a study_coach action.
 * @param args - the action payload.
 * @param env - the handler environment.
 * @returns the action envelope.
 */
export function handleStudyCoach(args: StudyData, env: HandlerEnv): StudyEnvelope {
  try {
    const action = String(args['action'] || 'diagnose').trim()
    const scope = String(args['scope'] || 'project').trim()
    const data = mergeCoachPayload(args)
    const vault = resolveVaultPath(data['vault_path'], env.vaultPath)
    const project = readProjectManifest(vault, data['project_id'])
    if (action === 'start' || action === 'start_intervention' || action === 'advance' || action === 'snapshot' || action === 'finish') {
      const runtime = learningRuntime(vault, project, env)
      const sessionId = data['session_id']
      let output: Record<string, unknown>
      if (action === 'start_intervention') {
        const resolved = acceptedInterventionContract(vault, project, data)
        output = runtime.start({
          sessionId: sessionId ?? `session-${randomUUID().replace(/-/g, '').slice(0, 16)}`,
          contract: resolved.contract,
          conversationSessionId: data['conversation_session_id'] ?? env.conversationId,
        })
        output = {
          proposal_id: resolved.proposalId,
          intervention_id: resolved.interventionId,
          planned_event: resolved.plannedEvent,
          execution_adjustments: resolved.adjustments,
          ...output,
        }
      } else if (action === 'start') {
        output = runtime.start({
          sessionId,
          contract: data['contract'],
          conversationSessionId: data['conversation_session_id'] ?? env.conversationId,
        })
      } else if (action === 'advance') {
        output = runtime.advance({ sessionId, observation: data['observation'] })
      } else if (action === 'snapshot') {
        output = runtime.snapshot({ sessionId })
      } else {
        output = runtime.finish({ sessionId })
      }
      return ok({ project_id: project.project_id, ...output })
    }
    if (action === 'evaluate_adherence') {
      if (scope !== 'project') {
        return err('INVALID_SCOPE', 'evaluate_adherence requires project scope so every applied plan is read on one clock')
      }
      const asOf = parseAsOf(data['as_of'])
      const timeZone = projectTimeZone(project)
      const end = data['end_date'] ? String(data['end_date']) : localDateString(asOf, timeZone)!
      const start = data['start_date']
        ? String(data['start_date'])
        : localDateString(addDays(asOf, -DEFAULT_LOOKBACK_DAYS), timeZone)!
      if (!isIsoDate(end) || !isIsoDate(start)) {
        return err('VALIDATION_FAILED', 'start_date and end_date must be ISO dates (YYYY-MM-DD)')
      }
      if (start > end) {
        return err('VALIDATION_FAILED', 'start_date must not follow end_date')
      }
      const adherence = buildPlanAdherence({
        schedules: projectSchedules(vault, project.project_id),
        attempts: allAttempts(vault, project.project_id),
        timeZone,
        start,
        end,
        asOf,
      })
      return ok({
        project_id: project.project_id,
        plan_adherence: adherence,
        capacity: capacityFactor(adherence),
      })
    }
    if (action === 'evaluate_interventions') {
      if (scope !== 'project') {
        return err('INVALID_SCOPE', 'evaluate_interventions requires project scope so every decision is comparable')
      }
      const root = planProposalDir(vault, project.project_id)
      const proposals: StudyData[] = []
      for (const name of sortedJsonNames(root)) {
        try {
          const validated = validatePlanProposalLocal(readJsonFile(`${root}/${name}`))
          if (validated !== null) proposals.push(validated)
        } catch {
          // Unreadable proposals are skipped.
        }
      }
      const outcomes = buildInterventionOutcomes({
        proposals,
        attempts: allAttempts(vault, project.project_id),
        diagnosisBuilder: diagnoseAttempts,
        asOf: parseAsOf(data['as_of']),
      })
      const byKind = (outcomes['by_kind'] as Array<Record<string, unknown>> | undefined) ?? []
      return ok({
        project_id: project.project_id,
        intervention_outcomes: outcomes,
        calibration: byKind.map(row => ({
          kind: row['kind'],
          ...outcomeAdjustment({ byKind, kind: String(row['kind']) }),
        })),
      })
    }
    if (action === 'prioritize' || action === 'propose_plan') {
      if (scope !== 'project') {
        return err('INVALID_SCOPE', `${action} requires project scope so evidence age and all Objectives stay comparable`)
      }
      const orchestration = interventionOrchestration(vault, project, data, env)
      if (action === 'prioritize') {
        return ok({ project_id: project.project_id, intervention_queue: orchestration.queue })
      }
      return ok({
        project_id: project.project_id,
        proposal: orchestration.proposal,
        intervention_queue: orchestration.queue,
        policy: (
          'This call is read-only. Re-run it with data.scheduling to compare calendar '
          + 'alternatives without changing evidence priority. Persist with plan_proposal.save; '
          + 'only an explicit non-cron accept/reject may decide it. plan_proposal.apply writes '
          + 'accepted events after a fresh project-wide conflict check; phase/range changes '
          + 'still require schedule.validate then schedule.save.'
        ),
      })
    }
    if (scope === 'week' && !data['start_date'] && !data['end_date']) {
      const today = env.now().toISOString().slice(0, 10)
      const dayOfWeek = new Date(`${today}T00:00:00Z`).getUTCDay()
      const mondayShift = dayOfWeek === 0 ? 6 : dayOfWeek - 1
      data['start_date'] = shiftIsoDate(today, -mondayShift)
      data['end_date'] = today
    } else if (scope === 'session' && !data['session_id'] && !data['attempt_ids']) {
      return err('MISSING_SCOPE_FILTER', 'session scope requires data.session_id or data.attempt_ids')
    } else if (scope === 'concept' && !data['concept']) {
      return err('MISSING_SCOPE_FILTER', 'concept scope requires data.concept')
    }
    const attempts = filteredAttempts(vault, project.project_id, data)
    const diagnosis = diagnoseAttempts(attempts)
    const evidenceIds = attempts.map(item => String(item.attempt_id))
    let output: Record<string, unknown>
    if (action === 'diagnose') {
      output = { diagnosis }
    } else if (action === 'summarize') {
      const weakest = diagnosis.concepts.slice(0, 3)
      const strongest = [...diagnosis.concepts]
        .sort((a, b) => {
          if (a.average_score !== b.average_score) return b.average_score - a.average_score
          return b.attempt_count - a.attempt_count
        })
        .slice(0, 3)
      const transferVerified = ['near_transfer', 'far_transfer'].some(
        dimension => diagnosis.evidence_dimensions[dimension]?.verification_status === 'independent',
      )
      output = {
        summary: {
          scope,
          attempt_count: diagnosis.attempt_count,
          average_score: diagnosis.average_score,
          strongest_concepts: strongest,
          weakest_concepts: weakest,
          unverified: transferVerified ? [] : ['transfer'],
          unverified_dimensions: Object.entries(diagnosis.evidence_dimensions)
            .filter(([, result]) => result.verification_status !== 'independent')
            .map(([dimension]) => dimension),
          evidence_attempt_ids: evidenceIds,
        },
      }
    } else if (action === 'recommend') {
      output = { recommendations: recommendations(diagnosis), diagnosis }
    } else if (action === 'propose_pattern') {
      output = {
        proposals: patternProposals(project.project_id, diagnosis, nowIso(env)),
        policy: 'Proposals are not persisted or applied automatically; save explicitly with study_activity after review.',
      }
    } else if (action === 'generate_probe') {
      const blueprint = probeBlueprint(diagnosis)
      if (blueprint === null) {
        return err('INSUFFICIENT_EVIDENCE', 'Record at least one attempt before generating a diagnostic probe')
      }
      output = {
        probe_blueprint: blueprint,
        policy: 'Generate one problem from this blueprint; record the learner response as a new attempt before judging transfer.',
      }
    } else {
      return err('INVALID_ACTION', `Unsupported coach action: ${action}`)
    }
    return ok({ project_id: project.project_id, ...output, evidence_attempt_ids: evidenceIds })
  } catch (error) {
    if (error instanceof StudyOSError) return errFrom(error)
    return err('STUDY_COACH_FAILED', messageOf(error))
  }
}

/** Shift an ISO date string by a whole number of days. */
function shiftIsoDate(value: string, days: number): string {
  const parsed = new Date(`${value}T00:00:00Z`)
  return new Date(parsed.getTime() + days * 86_400_000).toISOString().slice(0, 10)
}
