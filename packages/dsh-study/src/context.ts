/**
 * Turn-local context rendering for an active learning session. Mirrors the original
 * `_context_payload` and `_render_context` verbatim so the injected
 * user-message context for a bound conversation stays byte-identical.
 * @module @puji4810/dsh-study/context
 */

import type { LearningSession } from './types.ts'

/** Hard ceiling on the rendered active-session context string. */
export const MAX_ACTIVE_CONTEXT_CHARS = 2800

/** Clip a value to a character limit, truncating to `limit - 1` plus an ellipsis. */
function clip(value: unknown, limit: number): string {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length <= limit ? text : `${text.slice(0, limit - 1).replace(/\s+$/, '')}…`
}

/** The session payload rendered into the context, optionally with detail fields. */
function contextPayload(session: LearningSession, includeDetails = true): Record<string, unknown> {
  const contractValue = session.contract
  const contract = contractValue as unknown as Record<string, unknown>
  const activityValue = session.current_activity
  const activity = activityValue !== undefined
    ? activityValue as unknown as Record<string, unknown>
    : {}
  let currentActivity: Record<string, unknown> | null = null
  if (Object.keys(activity).length > 0) {
    currentActivity = {
      activity_id: activity['activity_id'],
      activity_adapter: activity['activity_adapter'],
      kind: activity['kind'],
      evidence_target: activity['evidence_target'],
      assistance_level: activity['assistance_level'],
      evidence_requirements: [...(asArray(activity['evidence_requirements']))],
      instructions: clip(activity['instructions'], 600),
      response_policy: clip(activity['response_policy'], 300),
      reason: clip(activity['reason'], 350),
    }
  }
  const payload: Record<string, unknown> = {
    session_id: session.session_id,
    project_id: session.project_id,
    mode: contract['mode'],
    objective: clip(contract['objective'], 600),
    objective_ids: asArray(contract['objective_ids']).slice(0, 12),
    assistance_level: contract['assistance_level'],
    required_evidence: asArray(contract['evidence_targets']),
    recorded_evidence_ids: asArray(session.evidence_ids).slice(-20),
    current_activity: currentActivity,
    continuation: {
      state: currentActivity !== null ? 'continue' : 'ready_to_finish',
      learner_controls_follow_up: true,
    },
  }
  if (includeDetails && currentActivity !== null) {
    currentActivity['rubric_requirements'] = (asArray(activity['rubric_requirements']))
      .slice(0, 4)
      .map(item => clip(item, 140))
    currentActivity['source_anchors'] = asArray(activity['source_anchors'])
      .slice(0, 3)
      .filter(anchor => anchor !== null && typeof anchor === 'object')
      .map((anchor) => {
        const record = anchor as Record<string, unknown>
        return {
          kind: record['kind'],
          ref: clip(record['ref'], 160),
          locator: clip(record['locator'], 100),
        }
      })
  }
  return payload
}

/** Render a value as an array, tolerating a non-array. */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * Render an active learning session into the turn-local context string.
 * @param session - the active learning session.
 * @returns the prefixed, payload-encoded, length-capped context.
 */
export function renderActiveSessionContext(session: LearningSession): string {
  const prefix = (
    '[StudyOS active learning session — turn-local context]\n'
    + 'This is workflow state, not proof of mastery. Follow the assistance level, collect the learner\'s '
    + 'own response before feedback, and record evaluated evidence with study_coach.advance. The learner '
    + 'controls scope, pace, and stopping. Interaction completion and evidence verification are separate; '
    + 'never prolong the interaction solely to strengthen verification. Stopping closes future work '
    + 'without erasing supported observations already produced.\n'
  )
  let context = prefix + JSON.stringify(contextPayload(session))
  if (context.length > MAX_ACTIVE_CONTEXT_CHARS) {
    context = prefix + JSON.stringify(contextPayload(session, false))
  }
  return context.length <= MAX_ACTIVE_CONTEXT_CHARS
    ? context
    : `${context.slice(0, MAX_ACTIVE_CONTEXT_CHARS - 1)}…`
}
