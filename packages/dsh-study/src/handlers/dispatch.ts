/**
 * StudyOS activity dispatch: resolve a `resource.action` pair from one merged payload and
 * route it to the owning handler. Mirrors the Python `learning.py` `handle_study_activity` /
 * `_dispatch_resource` / `_payload` / `_schedule_request` verbatim so vaults and model-facing
 * envelopes stay identical.
 * @module @puji4810/dsh-study/handlers/dispatch
 */

import { err, errFrom, type StudyEnvelope } from '../errors.ts'
import type { StudyData } from '../types.ts'
import { StudyOSError } from '../errors.ts'
import { handleAttemptActivity } from './attempt.ts'
import { handlePatternProposalActivity } from './pattern-proposal.ts'
import { handlePlanProposalActivity } from './plan-proposal.ts'
import { handleStudyProject } from './project.ts'
import { handleStudySchedule } from './schedule.ts'
import { handleStudyPromptContext } from './prompt-context.ts'
import { handleStudyConcept } from './concept.ts'
import { handleStudyNote } from './note.ts'
import { handleStudyReview } from './review.ts'
import { handleStudyCurriculum } from './curriculum.ts'
import { handleStudyLearningRecord, handleStudyDecision, handleStudyLesson } from './records.ts'
import { handleStudyError, handleStudyLogSession, handleStudySyncMemory } from './misc.ts'

/**
 * The handler environment: a unified clock, the workspace or configured vault path, and the calling
 * agent's conversation id (used to bind active learning sessions).
 */
export interface HandlerEnv {
  /** The unified clock every handler timestamps with. */
  now: () => Date
  /** The current workspace path, or the configured fallback for calls without a workspace. */
  vaultPath?: string
  /** The calling agent's conversation id string, when one exists. */
  conversationId?: string
}

/**
 * The unified clock rendered as a seconds-precision ISO timestamp with a `Z` offset.
 * @param env - the handler environment.
 * @returns the timestamp, e.g. `2026-01-15T08:00:00Z`.
 */
export function nowIso(env: HandlerEnv): string {
  return env.now().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Merge an activity payload the Python `_payload` way: spread the `data` object, then lift
 * `vault_path` and `project_id` from the top-level args when present.
 * @param args - the raw activity arguments.
 * @returns the merged payload.
 */
export function mergePayload(args: StudyData): StudyData {
  const data = args['data']
  const result: StudyData = data !== null && typeof data === 'object' && !Array.isArray(data)
    ? { ...(data as StudyData) }
    : {}
  for (const key of ['vault_path', 'project_id']) {
    if (args[key] !== null && args[key] !== undefined) result[key] = args[key]
  }
  return result
}

/**
 * Adapt the public single-data envelope to the legacy schedule handler the Python
 * `_schedule_request` way.
 * @param action - the schedule action.
 * @param payload - the merged payload.
 * @returns the adapted request.
 */
export function scheduleRequest(action: string, payload: StudyData): StudyData {
  const request: StudyData = { ...payload }
  request['action'] = action
  if (action !== 'validate' && action !== 'save') return request

  const nestedSchedule = payload['schedule']
  const nestedData = payload['data']
  let schedule: StudyData
  if (nestedSchedule !== null && typeof nestedSchedule === 'object' && !Array.isArray(nestedSchedule)) {
    schedule = { ...(nestedSchedule as StudyData) }
  } else if (nestedData !== null && typeof nestedData === 'object' && !Array.isArray(nestedData)) {
    schedule = { ...(nestedData as StudyData) }
  } else {
    schedule = {}
    for (const [key, value] of Object.entries(payload)) {
      if (!['action', 'data', 'schedule', 'vault_path'].includes(key)) schedule[key] = value
    }
  }

  const adapted: StudyData = { action, data: schedule }
  for (const key of ['vault_path', 'project_id']) {
    if (payload[key] !== null && payload[key] !== undefined) adapted[key] = payload[key]
  }
  return adapted
}

/**
 * Resolve a `resource.action` pair to its handler and return the envelope.
 * @param args - the activity arguments carrying `resource`, `action`, and optional payload.
 * @param env - the handler environment.
 * @returns the handler's envelope.
 */
export function dispatchStudyActivity(args: StudyData, env: HandlerEnv): StudyEnvelope {
  try {
    return dispatchInner(args, env)
  } catch (error) {
    if (error instanceof StudyOSError) return errFrom(error)
    return err('STUDY_ACTIVITY_FAILED', String(error))
  }
}

/** The unmapped routing logic; dispatch's try/catch wraps it against unexpected throws. */
function dispatchInner(args: StudyData, env: HandlerEnv): StudyEnvelope {
  const resource = String(args['resource'] ?? '').trim()
  const action = String(args['action'] ?? '').trim()
  const data = mergePayload(args)
  if (resource === 'attempt') return handleAttemptActivity(action, data, env)
  if (resource === 'pattern_proposal') return handlePatternProposalActivity(action, data, env)
  if (resource === 'plan_proposal') return handlePlanProposalActivity(action, data, env)
  if (resource === 'schedule') return handleStudySchedule(scheduleRequest(action, data), env)
  if (resource === 'project') {
    if (data['action'] === undefined) data['action'] = action
    return handleStudyProject(data, env)
  }
  if (resource === 'prompt_context') return handleStudyPromptContext(data, env)
  if (resource === 'session') return handleStudyLogSession(data, env)
  if (resource === 'memory') return handleStudySyncMemory(data, env)
  if (resource === 'error') return handleStudyError(data, env)
  if (resource === 'concept') {
    if (data['action'] === undefined) data['action'] = action
    return handleStudyConcept(data, env)
  }
  if (resource === 'note') {
    if (data['action'] === undefined) data['action'] = action
    return handleStudyNote(data, env)
  }
  if (resource === 'review') {
    if (data['action'] === undefined) data['action'] = action
    return handleStudyReview(data, env)
  }
  if (resource === 'curriculum') {
    if (data['action'] === undefined) data['action'] = action
    return handleStudyCurriculum(data, env)
  }
  if (resource === 'learning_record') {
    if (data['action'] === undefined) data['action'] = action
    return handleStudyLearningRecord(data, env)
  }
  if (resource === 'decision') {
    if (data['action'] === undefined) data['action'] = action
    return handleStudyDecision(data, env)
  }
  if (resource === 'lesson') {
    if (data['action'] === undefined) data['action'] = action
    return handleStudyLesson(data, env)
  }
  return err('INVALID_RESOURCE_ACTION', `Unsupported StudyOS operation: ${resource}.${action}`)
}
