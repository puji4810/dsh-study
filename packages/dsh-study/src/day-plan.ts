/**
 * StudyOS day plan: project an Intervention Queue onto one day's concrete study
 * events inside the learner's habitual study window. Mirrors the Python
 * plugin's `day_plan.py` rule for rule.
 * @module @puji4810/dsh-study/day-plan
 */

import { DAY_PLAN_SCHEMA_VERSION } from './constants.ts'
import {
  addMinutes,
  localDateString,
  parseDate,
  toZonedIso,
  zoneParts,
  zonedDayStart,
} from './datetime.ts'
import type { ZoneParts } from './datetime.ts'
import type {
  DayPlan,
  DayPlanEvent,
  InterventionItem,
  StudyAttempt,
  StudyData,
  StudyProject,
} from './types.ts'

/** Below this many timestamped attempts an hour histogram is noise. */
const MIN_WINDOW_SAMPLE = 12

/** The derived window must cover at least this share of observed activity. */
const WINDOW_COVERAGE = 0.7

/** A derived window wider than this stops describing a habit. */
const MAX_WINDOW_HOURS = 10

const DEFAULT_WINDOW_START = 19
const DEFAULT_WINDOW_END = 23

/** Events are packed back to back with a short changeover. */
const BREAK_MINUTES = 10

/** The Schedule contract's per-event minute ceiling. */
const MAX_EVENT_MINUTES = 720

/** Wall-clock parts of a moment in a validated timezone; null is unreachable. */
function requireZoneParts(date: Date, timeZone: string): ZoneParts {
  const parts = zoneParts(date, timeZone)
  /* v8 ignore next -- the timezone is validated before any caller runs, so null is unreachable */
  if (parts === null) throw new Error('invalid timezone')
  return parts
}

/** Python `round` at a fixed decimal scale (half to even). */
function pyRoundN(value: number, digits: number): number {
  const factor = 10 ** digits
  const scaled = value * factor
  const floor = Math.floor(scaled)
  const diff = scaled - floor
  if (diff < 0.5) return floor / factor
  /* v8 ignore start -- a study-window coverage is always >= 0.7, so the
     fractional part never lands exactly on .5; Python's half-even form is
     kept for fidelity but the branch cannot arise from reachable coverage. */
  if (diff > 0.5) return (floor + 1) / factor
  return (floor % 2 === 0 ? floor : floor + 1) / factor
  /* v8 ignore stop */
}

/** Parse a timezone-aware ISO timestamp, or null (rejects naive/invalid). */
function parseOffsetDateTimeStrict(raw: string): Date | null {
  const match = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:\d{2}|Z)$/.exec(raw)
  if (match === null) return null
  const parsed = new Date(raw.replace(/Z$/, '+00:00'))
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** Hour histogram of timestamped attempts. */
function hourHistogram(attempts: StudyAttempt[], timeZone: string): number[] {
  const hours = new Array<number>(24).fill(0)
  for (const attempt of attempts) {
    const raw = attempt.occurred_at
    if (!raw) continue
    const moment = parseOffsetDateTimeStrict(raw)
    if (moment === null) continue
    const parts = requireZoneParts(moment, timeZone)
    hours[parts.hour] = (hours[parts.hour] ?? 0) + 1
  }
  return hours
}

/**
 * Derive the learner's habitual study window from timestamped evidence.
 * @param attempts - the attempt history.
 * @param timeZone - the IANA zone the hours are localised into.
 * @returns start_hour/end_hour/source/sample_size/coverage.
 */
export function studyWindow(
  attempts: StudyAttempt[],
  timeZone: string,
): { start_hour: number; end_hour: number; source: string; sample_size: number; coverage: number | null } {
  const hours = hourHistogram(attempts, timeZone)
  const total = hours.reduce((sum, count) => sum + count, 0)
  if (total < MIN_WINDOW_SAMPLE) {
    return {
      start_hour: DEFAULT_WINDOW_START,
      end_hour: DEFAULT_WINDOW_END,
      source: 'default',
      sample_size: total,
      coverage: null,
    }
  }

  const needed = total * WINDOW_COVERAGE
  let best: { span: number; start: number; covered: number } | null = null
  for (let start = 0; start < 24; start += 1) {
    let covered = 0
    for (let end = start; end < 24; end += 1) {
      covered += hours[end] ?? 0
      if (covered >= needed) {
        const span = end - start + 1
        // The (span, start) tuple tiebreak in the Python source degenerates to
        // "shorter span wins": start always reaches the bar (the full histogram
        // coverage >= needed), so best.start stays 0 and start never beats it.
        if (best === null || span < best.span) {
          best = { span, start, covered }
        }
        break
      }
    }
  }

  // The modal-hour fallback is unreachable: a start of 0 always accumulates the
  // whole histogram, and `needed = total * WINDOW_COVERAGE` is always <= total,
  // so some contiguous span always reaches the coverage bar. Kept to mirror the
  // Python plugin's defensive branch for scattered-across-midnight activity.
  /* v8 ignore next */
  if (best === null) {
    let busiest = 0
    for (let hour = 1; hour < 24; hour += 1) {
      const current = hours[hour] ?? 0
      const bestCount = hours[busiest] ?? 0
      if (current > bestCount) busiest = hour
    }
    return {
      start_hour: busiest,
      end_hour: Math.min(23, busiest + 3),
      source: 'modal-hour',
      sample_size: total,
      coverage: pyRoundN((hours[busiest] ?? 0) / total, 3),
    }
  }

  const { span, start, covered } = best
  const end = Math.min(23, start + Math.min(span, MAX_WINDOW_HOURS) - 1)
  return {
    start_hour: start,
    end_hour: end,
    source: 'evidence',
    sample_size: total,
    coverage: pyRoundN(covered / total, 3),
  }
}

/**
 * The phase whose date range contains `target`, if any.
 * @param schedule - a Schedule carrying phases.
 * @param target - an ISO date string.
 * @returns the covering phase, or null.
 */
export function activePhase(schedule: StudyData, target: string): StudyData | null {
  const targetDate = parseDate(target)
  if (targetDate === null) return null
  const phases = schedule.phases
  if (!Array.isArray(phases)) return null
  for (const phase of phases) {
    if (phase === null || typeof phase !== 'object') continue
    const record = phase as Record<string, unknown>
    const start = parseDate(String(record['start'] ?? ''))
    const end = parseDate(String(record['end'] ?? ''))
    if (start === null || end === null) continue
    if (start.getTime() <= targetDate.getTime() && targetDate.getTime() <= end.getTime()) {
      return record
    }
  }
  return null
}

/** A phase aggregate effort split across the days it still has left. */
function phaseDailyBudget(phase: Record<string, unknown>, target: Date): number | null {
  const effort = phase['effort_minutes']
  if (typeof effort !== 'number' || !Number.isInteger(effort) || effort <= 0) return null
  // activePhase already guarantees a covering phase, so end parses and is >= target.
  const end = parseDate(String(phase['end']))!
  const daysLeft = Math.round((end.getTime() - target.getTime()) / 86_400_000) + 1
  return Math.max(1, Math.floor(effort / daysLeft))
}

/** Best-effort subject id for an event. */
function subjectId(phase: StudyData, project: StudyProject): string {
  const phaseRecord = phase as Record<string, unknown>
  const subjects = phaseRecord['subject_ids']
  if (Array.isArray(subjects) && subjects.length > 0) {
    const first = String(subjects[0] ?? '').trim()
    if (first) return first
  }
  const tracks = project.tracks
  if (Array.isArray(tracks)) {
    for (const track of tracks) {
      if (track === null || typeof track !== 'object') continue
      const identifier = String((track as Record<string, unknown>)['id'] ?? '').trim()
      if (identifier) return identifier
    }
  }
  const domain = String(project.domain).trim()
  return domain || 'general'
}

/** Subject-bearing tokens of an identifier, dropping numeric parts. */
function tokens(value: string): Set<string> {
  const result = new Set<string>()
  for (const token of String(value).replace(/_/g, '-').split('-')) {
    if (token.length > 2 && !/^\d+$/.test(token)) result.add(token)
  }
  return result
}

function countIntersection(a: Set<string>, b: Set<string>): number {
  let count = 0
  for (const value of a) if (b.has(value)) count += 1
  return count
}

/** Internal mutable view of one covering Schedule. */
interface TargetEntry {
  schedule_id: string
  schedule_title: string
  phase: StudyData
  budget: number
  nominal_budget: number
  events: DayPlanEvent[]
  spent: number
}

/** Pick which Schedule an Intervention's event belongs in. */
function routeToSchedule(
  item: InterventionItem,
  targets: TargetEntry[],
): { index: number; routing: string } {
  if (targets.length === 1) return { index: 0, routing: 'sole-covering-schedule' }
  const objectiveTokens = tokens(item.objective_id)
  if (objectiveTokens.size > 0) {
    const scored = targets.map((target, index) => ({
      score: countIntersection(objectiveTokens, tokens(target.schedule_id)),
      index,
    }))
    scored.sort((a, b) => (a.score !== b.score ? b.score - a.score : a.index - b.index))
    const first = scored[0]!
    if (first.score > 0 && (scored.length === 1 || first.score > (scored[1]?.score ?? 0))) {
      return { index: first.index, routing: 'objective-token-match' }
    }
  }
  return { index: 0, routing: 'fallback-first-covering-schedule' }
}

/** The event title, truncating over-long capabilities. */
function eventTitle(item: InterventionItem): string {
  const kind = item.kind.replace(/_/g, ' ')
  let capability = item.capability.trim()
  if (capability.length > 60) {
    capability = `${capability.slice(0, 59).trimEnd()}…`
  }
  return capability ? `${kind}: ${capability}` : kind
}

/** Instant for a local wall-clock time in a named zone. */
function zonedInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const start = zonedDayStart(year, month, day, timeZone)!
  return new Date(start.getTime() + ((hour * 60 + minute) * 60 + second) * 1000)
}

/** Round a wall-clock moment up to the next whole `minutes` grid. */
function roundUp(moment: Date, timeZone: string, minutes = 5): Date {
  const parts = zoneParts(moment, timeZone)!
  const remainder = parts.minute % minutes
  if (remainder === 0 && parts.second === 0) {
    return zonedInstant(parts.year, parts.month, parts.day, parts.hour, parts.minute, 0, timeZone)
  }
  const totalMinutes = parts.hour * 60 + parts.minute + (minutes - remainder)
  const hour = Math.floor(totalMinutes / 60) % 24
  const minute = totalMinutes % 60
  return zonedInstant(parts.year, parts.month, parts.day, hour, minute, 0, timeZone)
}

/** Parse the year/month/day out of an ISO date string. */
function dateParts(value: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)!
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
}

/**
 * Lay the queue out over `target` inside the learner's study window.
 * @param options.queueItems - the queue items, in priority order.
 * @param options.schedules - the loaded Schedules.
 * @param options.attempts - the attempt history (for the study window).
 * @param options.project - the project manifest.
 * @param options.target - the target ISO date.
 * @param options.timeZone - the IANA zone events are laid out in.
 * @param options.now - keeps the plan in the future when today.
 * @param options.capacity - the measured share of a day the learner completes.
 * @returns the projected day plan.
 */
export function buildDayPlan(options: {
  queueItems: InterventionItem[]
  schedules: StudyData[]
  attempts: StudyAttempt[]
  project: StudyProject
  target: string
  timeZone: string
  now?: Date | null
  capacity?: Record<string, unknown> | null
}): DayPlan {
  const { queueItems, schedules, attempts, project, target, timeZone, now, capacity } = options
  const window = studyWindow(attempts, timeZone)
  const rawFactor = capacity?.['factor']
  let factor = 1.0
  if (typeof rawFactor === 'number' && Number.isFinite(rawFactor) && rawFactor > 0 && rawFactor <= 1) {
    factor = rawFactor
  }

  const targetParts = dateParts(target)
  const dayStart = zonedInstant(
    targetParts.year,
    targetParts.month,
    targetParts.day,
    window.start_hour,
    0,
    0,
    timeZone,
  )
  const windowEndBase = zonedInstant(
    targetParts.year,
    targetParts.month,
    targetParts.day,
    window.end_hour,
    0,
    0,
    timeZone,
  )
  const dayEnd = addMinutes(windowEndBase, 60)
  const windowMinutes = Math.max(0, Math.floor((dayEnd.getTime() - dayStart.getTime()) / 60_000))

  const targets: TargetEntry[] = []
  for (const schedule of schedules) {
    const phase = activePhase(schedule, target)
    if (phase === null) continue
    targets.push({
      schedule_id: String(schedule.schedule_id ?? ''),
      schedule_title: String(schedule.title ?? ''),
      phase,
      budget: phaseDailyBudget(phase, parseDate(target)!) ?? windowMinutes,
      nominal_budget: 0,
      events: [],
      spent: 0,
    })
  }

  if (targets.length === 0) {
    return {
      schema_version: DAY_PLAN_SCHEMA_VERSION,
      target_date: target,
      timezone: timeZone,
      study_window: window,
      capacity: capacity ?? null,
      minutes_budget: 0,
      minutes_budget_nominal: 0,
      minutes_planned: 0,
      schedules: [],
      unplaced: queueItems.map(item => ({
        intervention_id: item.intervention_id,
        reason: 'no Schedule phase covers the target date',
      })),
    }
  }

  for (const entry of targets) {
    entry.nominal_budget = entry.budget
    entry.budget = Math.max(1, Math.trunc(entry.budget * factor))
  }

  const unplaced: Array<{ intervention_id: string; reason: string }> = []
  let cursor = dayStart
  if (now !== null && now !== undefined && localDateString(now, timeZone) === target) {
    const rounded = roundUp(now, timeZone)
    if (rounded.getTime() > cursor.getTime()) cursor = rounded
  }
  let spent = 0

  for (let index = 0; index < queueItems.length; index += 1) {
    const item = queueItems[index]!
    const activity = item.recommended_activity
    let duration = activity.duration_minutes
    if (typeof duration !== 'number' || !Number.isInteger(duration) || duration <= 0) {
      unplaced.push({
        intervention_id: item.intervention_id,
        reason: 'recommended_activity.duration_minutes is missing or not positive',
      })
      continue
    }
    duration = Math.min(duration, MAX_EVENT_MINUTES)
    const routed = routeToSchedule(item, targets)
    const entry = targets[routed.index]!

    const cursorEnd = addMinutes(cursor, duration)
    if (cursorEnd.getTime() > dayEnd.getTime()) {
      const cursorParts = zoneParts(cursor, timeZone)!
      const cursorLabel = `${String(cursorParts.hour).padStart(2, '0')}:${String(cursorParts.minute).padStart(2, '0')}`
      const endLabel = String(window.end_hour).padStart(2, '0')
      unplaced.push({
        intervention_id: item.intervention_id,
        reason: `does not fit between ${cursorLabel} and the ${endLabel}:59 end of the study window`,
      })
      continue
    }
    if (entry.spent + duration > entry.budget) {
      const phaseRecord = entry.phase as Record<string, unknown>
      unplaced.push({
        intervention_id: item.intervention_id,
        reason: `exceeds the ${entry.budget} minute daily budget of phase ${String(phaseRecord['id'])} in ${entry.schedule_id}`,
      })
      continue
    }

    const end = cursorEnd
    const goals = item.reasons
      .map(reason => String(reason))
      .filter(reason => reason.trim() !== '')
    const criteria = activity.success_criteria
      .map(value => String(value))
      .filter(value => value.trim() !== '')
    entry.events.push({
      id: `dp-${target}-${String(index + 1).padStart(2, '0')}-${item.kind}`,
      title: eventTitle(item),
      subject_id: subjectId(entry.phase, project),
      type: item.kind,
      start: toZonedIso(cursor, timeZone)!,
      end: toZonedIso(end, timeZone)!,
      duration_minutes: duration,
      goals: goals.length + criteria.length > 0
        ? [...goals, ...criteria]
        : ['Produce evaluator-provenanced evidence.'],
      status: 'planned',
      source_intervention_id: item.intervention_id,
      source_objective_id: item.objective_id,
      evidence_dimension: item.evidence_dimension,
      routing: routed.routing,
    })
    entry.spent += duration
    spent += duration
    cursor = addMinutes(end, BREAK_MINUTES)
  }

  return {
    schema_version: DAY_PLAN_SCHEMA_VERSION,
    target_date: target,
    timezone: timeZone,
    study_window: window,
    capacity: capacity ?? null,
    minutes_budget: targets.reduce((sum, entry) => sum + entry.budget, 0),
    minutes_budget_nominal: targets.reduce((sum, entry) => sum + entry.nominal_budget, 0),
    minutes_planned: spent,
    schedules: targets
      .filter(entry => entry.events.length > 0)
      .map((entry) => {
        const phaseRecord = entry.phase as Record<string, unknown>
        return {
          schedule_id: entry.schedule_id,
          schedule_title: entry.schedule_title,
          phase_id: String(phaseRecord['id'] ?? ''),
          phase_goal: String(phaseRecord['goal'] ?? ''),
          minutes_budget: entry.budget,
          minutes_budget_nominal: entry.nominal_budget,
          minutes_planned: entry.spent,
          events: entry.events,
        }
      }),
    unplaced,
  }
}
