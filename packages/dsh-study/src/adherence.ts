/**
 * StudyOS plan adherence: reconcile the day StudyOS planned against the day
 * the learner had, matching applied events to evidence by
 * (objective, evidence dimension, local date). Mirrors the original
 * adherence module rule for rule.
 * @module @puji4810/dsh-study/adherence
 */

import { ADHERENCE_SCHEMA_VERSION } from './constants.ts'
import { addMinutes, localDateString, toIsoSeconds, toZonedIso } from './datetime.ts'
import type { StudyAttempt, StudyData } from './types.ts'

/** Observed effort within this share of planned duration is the plan being followed. */
const EFFORT_TOLERANCE = 0.25

/** Fewer measured days than this cannot tell a habit from a bad week. */
const MIN_ADHERENCE_SAMPLE = 3

const STATUSES = ['not_started', 'occurred', 'on_plan', 'under_run', 'over_run'] as const

const OCCURRED = new Set(['occurred', 'on_plan', 'under_run', 'over_run'])

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:\d{2}|Z)$/

/** Round-half-to-even at a fixed decimal scale. */
function roundHalfEvenN(value: number, digits: number): number {
  const factor = 10 ** digits
  const scaled = value * factor
  const floor = Math.floor(scaled)
  const diff = scaled - floor
  const rounded = diff < 0.5 ? floor : diff > 0.5 ? floor + 1 : (floor % 2 === 0 ? floor : floor + 1)
  return rounded / factor
}

/** Parse a timezone-aware ISO timestamp, or null (rejects naive/invalid). */
function parseTimestamp(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const text = value.trim()
  if (!TIMESTAMP_RE.test(text)) return null
  const parsed = new Date(text.replace(/Z$/, '+00:00'))
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** Whole minutes from a duration in seconds, or null. */
function durationMinutes(attempt: StudyAttempt): number | null {
  const seconds = attempt.duration_seconds
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null
  return Math.max(1, Math.round(seconds / 60))
}

/** The set of objective ids an attempt claims. */
function objectiveIds(attempt: StudyAttempt): Set<string> {
  return new Set((attempt.objective_ids ?? []).map(value => String(value)))
}

/** Compare planned versus observed effort into a status. */
function status(planned: number, observed: number | null): string {
  if (observed === null) return 'occurred'
  if (planned <= 0) return 'occurred'
  const ratio = observed / planned
  if (ratio < 1 - EFFORT_TOLERANCE) return 'under_run'
  if (ratio > 1 + EFFORT_TOLERANCE) return 'over_run'
  return 'on_plan'
}

interface PlannedEvent extends Record<string, unknown> {
  event_id: string
  objective_id: string
  evidence_dimension: string
  planned_minutes: number
  _local: Date
  _ends: Date
}

/** Applied day-plan events inside the range, plus how many were skipped. */
function plannedEvents(
  schedules: StudyData[],
  timeZone: string,
  start: string,
  end: string,
): { events: PlannedEvent[]; unmeasured: number } {
  const planned: PlannedEvent[] = []
  let unmeasured = 0
  for (const schedule of schedules) {
    const scheduleId = String(schedule.schedule_id ?? '')
    const events = schedule.events
    if (!Array.isArray(events)) continue
    for (const rawEvent of events) {
      if (rawEvent === null || typeof rawEvent !== 'object') continue
      const event = rawEvent as Record<string, unknown>
      const begins = parseTimestamp(event['start'])
      if (begins === null) continue
      const localDate = localDateString(begins, timeZone)
      if (localDate === null || localDate < start || localDate > end) continue
      const sourceProposal = String(event['source_plan_proposal_id'] ?? '').trim()
      if (!sourceProposal) {
        unmeasured += 1
        continue
      }
      const duration = event['duration_minutes']
      const minutes =
        typeof duration === 'number' && Number.isInteger(duration) && duration > 0 ? duration : 0
      const parsedEnd = parseTimestamp(event['end'])
      const ends = parsedEnd ?? addMinutes(begins, minutes)
      planned.push({
        event_id: String(event['id'] ?? ''),
        schedule_id: scheduleId,
        source_plan_proposal_id: sourceProposal,
        source_intervention_id: String(event['source_intervention_id'] ?? ''),
        objective_id: String(event['source_objective_id'] ?? ''),
        evidence_dimension: String(event['evidence_dimension'] ?? ''),
        kind: String(event['type'] ?? ''),
        planned_start: toZonedIso(begins, timeZone)!,
        planned_minutes: minutes,
        _local: begins,
        _ends: ends,
      })
    }
  }
  planned.sort((a, b) => {
    const aTime = a._local.getTime()
    const bTime = b._local.getTime()
    if (aTime !== bTime) return aTime - bTime
    return a.event_id < b.event_id ? -1 : 1
  })
  return { events: planned, unmeasured }
}

/** Strip private `_` keys from a planned event for rendering. */
function publicFields(event: PlannedEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(event)) {
    if (!key.startsWith('_')) out[key] = value
  }
  return out
}

/** Aggregate over days that actually carried a measurable plan. */
function totals(days: Array<Record<string, unknown>>): Record<string, unknown> {
  const plannedDays = days.filter(day => Number(day['events_measured']) > 0)
  const eventsMeasured = plannedDays.reduce((sum, day) => sum + Number(day['events_measured']), 0)
  const eventsOccurred = plannedDays.reduce((sum, day) => sum + Number(day['events_occurred']), 0)
  const minutesPlanned = plannedDays.reduce((sum, day) => sum + Number(day['minutes_planned']), 0)
  const minutesObserved = plannedDays.reduce((sum, day) => sum + Number(day['minutes_observed']), 0)
  const result: Record<string, unknown> = {
    days_measured: plannedDays.length,
    days_pending: days.filter(day => Number(day['events_pending']) > 0).length,
    events_measured: eventsMeasured,
    events_occurred: eventsOccurred,
    minutes_planned: minutesPlanned,
    minutes_observed: minutesObserved,
    unplanned_attempts: days.reduce(
      (sum, day) => sum + (day['unplanned_attempt_ids'] as unknown[]).length,
      0,
    ),
  }
  if (plannedDays.length >= MIN_ADHERENCE_SAMPLE) {
    result['completion_rate'] = roundHalfEvenN(eventsOccurred / eventsMeasured, 3)
    result['effort_ratio'] = minutesPlanned ? roundHalfEvenN(minutesObserved / minutesPlanned, 3) : null
    result['verdict'] = 'measured'
  } else {
    result['completion_rate'] = null
    result['effort_ratio'] = null
    result['verdict'] = 'insufficient_evidence'
    result['needed_for_signal'] = MIN_ADHERENCE_SAMPLE - plannedDays.length
  }
  return result
}

/**
 * Compare applied day-plan events against the evidence recorded that day,
 * matching by (objective, evidence dimension, local date).
 * @param options.schedules - the Schedules carrying applied events.
 * @param options.attempts - the attempt history.
 * @param options.timeZone - the IANA zone both sides are localised into.
 * @param options.start - inclusive start date (ISO).
 * @param options.end - inclusive end date (ISO).
 * @param options.asOf - the measurement clock; later events are pending.
 * @returns schema_version/range/timezone/as_of/days/unmeasured_events/totals.
 */
export function buildPlanAdherence(options: {
  schedules: StudyData[]
  attempts: StudyAttempt[]
  timeZone: string
  start: string
  end: string
  asOf: Date
}): Record<string, unknown> {
  const { schedules, attempts, timeZone, start, end, asOf } = options
  const { events, unmeasured } = plannedEvents(schedules, timeZone, start, end)

  const byDate = new Map<string, PlannedEvent[]>()
  for (const event of events) {
    const key = localDateString(event._local, timeZone)!
    const list = byDate.get(key) ?? []
    list.push(event)
    byDate.set(key, list)
  }

  const attemptsByDate = new Map<string, Array<{ attempt: StudyAttempt; at: Date }>>()
  for (const attempt of attempts) {
    const occurred = parseTimestamp(attempt.occurred_at)
    if (occurred === null) continue
    const key = localDateString(occurred, timeZone)
    if (key === null || key < start || key > end) continue
    const list = attemptsByDate.get(key) ?? []
    list.push({ attempt, at: occurred })
    attemptsByDate.set(key, list)
  }

  const allDates = new Set<string>([...byDate.keys(), ...attemptsByDate.keys()])
  const days: Array<Record<string, unknown>> = []
  for (const target of [...allDates].sort()) {
    const dayEvents = byDate.get(target) ?? []
    const dayAttempts = [...(attemptsByDate.get(target) ?? [])].sort(
      (a, b) => a.at.getTime() - b.at.getTime(),
    )
    const claimed = new Set<number>()
    const rendered: Array<Record<string, unknown>> = []

    for (const event of dayEvents) {
      if (event._ends.getTime() > asOf.getTime()) {
        rendered.push({ ...publicFields(event), status: 'pending' })
        continue
      }
      if (!event.objective_id || !event.evidence_dimension) {
        rendered.push({ ...publicFields(event), status: 'unmeasurable' })
        continue
      }
      const matched: Array<{ attempt: StudyAttempt; at: Date }> = []
      for (let index = 0; index < dayAttempts.length; index += 1) {
        if (claimed.has(index)) continue
        const entry = dayAttempts[index]!
        if (event.source_intervention_id) {
          if ((entry.attempt.source_plan_proposal_id ?? '') !== event.source_plan_proposal_id) continue
          if ((entry.attempt.source_intervention_id ?? '') !== event.source_intervention_id) continue
        }
        if (String(entry.attempt.transfer_level ?? '') !== event.evidence_dimension) continue
        if (!objectiveIds(entry.attempt).has(event.objective_id)) continue
        claimed.add(index)
        matched.push(entry)
      }
      const observedParts: number[] = []
      for (const entry of matched) {
        const minutes = durationMinutes(entry.attempt)
        if (minutes !== null) observedParts.push(minutes)
      }
      const observed = observedParts.length ? observedParts.reduce((sum, v) => sum + v, 0) : null
      const first = matched[0]?.at ?? null
      rendered.push({
        ...publicFields(event),
        attempt_ids: matched.map(entry => String(entry.attempt.attempt_id)),
        observed_minutes: observed,
        first_evidence_at: first !== null ? toZonedIso(first, timeZone) : null,
        start_delay_minutes:
          first !== null ? Math.floor((first.getTime() - event._local.getTime()) / 60_000) : null,
        status: matched.length === 0 ? 'not_started' : status(event.planned_minutes, observed),
      })
    }

    const measured = rendered.filter(item =>
      (STATUSES as readonly string[]).includes(String(item['status'])),
    )
    const occurredEvents = rendered.filter(item => OCCURRED.has(String(item['status'])))
    days.push({
      date: target,
      events: rendered,
      events_measured: measured.length,
      events_occurred: occurredEvents.length,
      events_pending: rendered.filter(item => item['status'] === 'pending').length,
      minutes_planned: measured.reduce((sum, item) => sum + Number(item['planned_minutes']), 0),
      minutes_observed: occurredEvents.reduce(
        (sum, item) => sum + Number(item['observed_minutes'] ?? 0),
        0,
      ),
      unplanned_attempt_ids: dayAttempts
        .map((entry, index) => (claimed.has(index) ? null : String(entry.attempt.attempt_id)))
        .filter((value): value is string => value !== null),
    })
  }

  return {
    schema_version: ADHERENCE_SCHEMA_VERSION,
    range: { start, end },
    timezone: timeZone,
    as_of: toIsoSeconds(asOf),
    days,
    unmeasured_events: unmeasured,
    totals: totals(days),
  }
}
