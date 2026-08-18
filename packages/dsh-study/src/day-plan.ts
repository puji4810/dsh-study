/**
 * StudyOS day plan: project an Intervention Queue onto one day's concrete study
 * events, combining evidence-derived habits with constrained user/agent scheduling.
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
  DayPlanPlacementPreference,
  DayPlanPreferences,
  DayPlanTimeWindow,
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

/** Smallest useful adaptive fragment when a full recommendation will not fit. */
const MIN_ADAPTIVE_DURATION_MINUTES = 15

/** The Schedule contract's per-event minute ceiling. */
const MAX_EVENT_MINUTES = 720

/** Parse a local wall-clock `HH:MM`; `24:00` is accepted only as an end. */
function wallClockMinutes(value: unknown, allowEndOfDay = false): number | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (match === null) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (allowEndOfDay && hour === 24 && minute === 0) return 24 * 60
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return hour * 60 + minute
}

/** Canonical `HH:MM` rendering for a minute-of-day value. */
function wallClockLabel(minutes: number): string {
  if (minutes === 24 * 60) return '24:00'
  const hour = Math.floor(minutes / 60)
  const minute = minutes % 60
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/** Validate and normalize one non-empty array of local wall-clock windows. */
function timeWindows(value: unknown, path: string): DayPlanTimeWindow[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path} must be a non-empty array`)
  }
  if (value.length > 24) throw new Error(`${path} may contain at most 24 windows`)
  return value.map((candidate, index) => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`${path}[${index}] must be an object`)
    }
    const record = candidate as Record<string, unknown>
    const start = wallClockMinutes(record['start'])
    const end = wallClockMinutes(record['end'], true)
    if (start === null || end === null || end <= start) {
      throw new Error(`${path}[${index}] must use same-day HH:MM values with end after start`)
    }
    return { start: wallClockLabel(start), end: wallClockLabel(end) }
  })
}

/** Validate a unique string-id array used by scheduling preferences. */
function identifierList(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`)
  const result = value.map((candidate, index) => {
    if (typeof candidate !== 'string' || !candidate.trim()) {
      throw new Error(`${path}[${index}] must be a non-empty string`)
    }
    return candidate.trim()
  })
  if (new Set(result).size !== result.length) throw new Error(`${path} must not contain duplicates`)
  return result
}

/** Parse the optional agent/user scheduling layer accepted by propose_plan. */
export function parseDayPlanPreferences(value: unknown): DayPlanPreferences | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('scheduling must be an object')
  const record = value as Record<string, unknown>
  const result: DayPlanPreferences = {}
  if (record['target_date'] !== undefined) {
    if (typeof record['target_date'] !== 'string' || parseDate(record['target_date']) === null) {
      throw new Error('scheduling.target_date must be an ISO date (YYYY-MM-DD)')
    }
    result.target_date = record['target_date']
  }
  if (record['windows'] !== undefined) result.windows = timeWindows(record['windows'], 'scheduling.windows')
  if (record['busy'] !== undefined) result.busy = timeWindows(record['busy'], 'scheduling.busy')
  if (record['break_minutes'] !== undefined) {
    const minutes = record['break_minutes']
    if (!Number.isInteger(minutes) || Number(minutes) < 0 || Number(minutes) > 120) {
      throw new Error('scheduling.break_minutes must be an integer from 0 to 120')
    }
    result.break_minutes = Number(minutes)
  }
  if (record['max_minutes'] !== undefined) {
    const minutes = record['max_minutes']
    if (!Number.isInteger(minutes) || Number(minutes) < 1 || Number(minutes) > 1440) {
      throw new Error('scheduling.max_minutes must be an integer from 1 to 1440')
    }
    result.max_minutes = Number(minutes)
  }
  if (record['allow_duration_adjustment'] !== undefined) {
    if (typeof record['allow_duration_adjustment'] !== 'boolean') {
      throw new Error('scheduling.allow_duration_adjustment must be a boolean')
    }
    result.allow_duration_adjustment = record['allow_duration_adjustment']
  }
  if (record['min_duration_minutes'] !== undefined) {
    const minutes = record['min_duration_minutes']
    if (!Number.isInteger(minutes) || Number(minutes) < 1 || Number(minutes) > MAX_EVENT_MINUTES) {
      throw new Error(`scheduling.min_duration_minutes must be an integer from 1 to ${MAX_EVENT_MINUTES}`)
    }
    result.min_duration_minutes = Number(minutes)
  }
  if (record['intervention_order'] !== undefined) {
    result.intervention_order = identifierList(record['intervention_order'], 'scheduling.intervention_order')
  }
  if (record['defer_intervention_ids'] !== undefined) {
    result.defer_intervention_ids = identifierList(record['defer_intervention_ids'], 'scheduling.defer_intervention_ids')
  }
  if (record['placements'] !== undefined) {
    if (!Array.isArray(record['placements'])) throw new Error('scheduling.placements must be an array')
    const placements = record['placements'].map((candidate, index): DayPlanPlacementPreference => {
      if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new Error(`scheduling.placements[${index}] must be an object`)
      }
      const placement = candidate as Record<string, unknown>
      if (typeof placement['intervention_id'] !== 'string' || !placement['intervention_id'].trim()) {
        throw new Error(`scheduling.placements[${index}].intervention_id must be a non-empty string`)
      }
      const normalized: DayPlanPlacementPreference = { intervention_id: placement['intervention_id'].trim() }
      if (placement['schedule_id'] !== undefined) {
        if (typeof placement['schedule_id'] !== 'string' || !placement['schedule_id'].trim()) {
          throw new Error(`scheduling.placements[${index}].schedule_id must be a non-empty string`)
        }
        normalized.schedule_id = placement['schedule_id'].trim()
      }
      if (placement['start_time'] !== undefined) {
        const start = wallClockMinutes(placement['start_time'])
        if (start === null) throw new Error(`scheduling.placements[${index}].start_time must be HH:MM`)
        normalized.start_time = wallClockLabel(start)
      }
      if (placement['duration_minutes'] !== undefined) {
        const duration = placement['duration_minutes']
        if (!Number.isInteger(duration) || Number(duration) < 1 || Number(duration) > MAX_EVENT_MINUTES) {
          throw new Error(`scheduling.placements[${index}].duration_minutes must be an integer from 1 to ${MAX_EVENT_MINUTES}`)
        }
        normalized.duration_minutes = Number(duration)
      }
      return normalized
    })
    const ids = placements.map(item => item.intervention_id)
    if (new Set(ids).size !== ids.length) throw new Error('scheduling.placements must not repeat an intervention_id')
    result.placements = placements
  }
  return result
}

/** Wall-clock parts of a moment in a validated timezone; null is unreachable. */
function requireZoneParts(date: Date, timeZone: string): ZoneParts {
  const parts = zoneParts(date, timeZone)
  /* v8 ignore next -- the timezone is validated before any caller runs, so null is unreachable */
  if (parts === null) throw new Error('invalid timezone')
  return parts
}

/** Round-half-to-even at a fixed decimal scale. */
function roundHalfEvenN(value: number, digits: number): number {
  const factor = 10 ** digits
  const scaled = value * factor
  const floor = Math.floor(scaled)
  const diff = scaled - floor
  if (diff < 0.5) return floor / factor
  /* v8 ignore start -- a study-window coverage is always >= 0.7, so the
     fractional part never lands exactly on .5; the half-even form is
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
        // The (span, start) tuple tiebreak in the original source degenerates to
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
  // original plugin's defensive branch for scattered-across-midnight activity.
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
      coverage: roundHalfEvenN((hours[busiest] ?? 0) / total, 3),
    }
  }

  const { span, start, covered } = best
  const end = Math.min(23, start + Math.min(span, MAX_WINDOW_HOURS) - 1)
  return {
    start_hour: start,
    end_hour: end,
    source: 'evidence',
    sample_size: total,
    coverage: roundHalfEvenN(covered / total, 3),
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
  preferredScheduleId?: string,
): { index: number; routing: string } {
  if (preferredScheduleId !== undefined) {
    const preferred = targets.findIndex(target => target.schedule_id === preferredScheduleId)
    if (preferred < 0) {
      throw new Error(
        `scheduling placement for ${item.intervention_id} targets ${preferredScheduleId}, `
        + 'which has no phase covering the target date',
      )
    }
    return { index: preferred, routing: 'placement-preference' }
  }
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
  const base = zonedInstant(parts.year, parts.month, parts.day, parts.hour, parts.minute, 0, timeZone)
  if (remainder === 0 && parts.second === 0) {
    return base
  }
  return addMinutes(base, minutes - remainder)
}

/** Parse the year/month/day out of an ISO date string. */
function dateParts(value: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)!
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
}

interface PlanningInterval {
  start: Date
  end: Date
}

/** Build one target-day interval from a normalized local window. */
function planningInterval(target: string, timeZone: string, window: DayPlanTimeWindow): PlanningInterval {
  const targetParts = dateParts(target)
  const dayStart = zonedInstant(targetParts.year, targetParts.month, targetParts.day, 0, 0, 0, timeZone)
  const startMinutes = wallClockMinutes(window.start)!
  const endMinutes = wallClockMinutes(window.end, true)!
  return {
    start: addMinutes(dayStart, startMinutes),
    end: addMinutes(dayStart, endMinutes),
  }
}

/** Merge overlapping or touching intervals into a stable ordered set. */
function mergeIntervals(intervals: PlanningInterval[]): PlanningInterval[] {
  const ordered = intervals
    .filter(interval => interval.end.getTime() > interval.start.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime())
  const merged: PlanningInterval[] = []
  for (const interval of ordered) {
    const previous = merged[merged.length - 1]
    if (previous === undefined || interval.start.getTime() > previous.end.getTime()) {
      merged.push({ start: new Date(interval.start), end: new Date(interval.end) })
    } else if (interval.end.getTime() > previous.end.getTime()) {
      previous.end = new Date(interval.end)
    }
  }
  return merged
}

/** Subtract blocked time from availability. */
function subtractIntervals(available: PlanningInterval[], blocked: PlanningInterval[]): PlanningInterval[] {
  let slots = mergeIntervals(available)
  for (const conflict of mergeIntervals(blocked)) {
    const next: PlanningInterval[] = []
    for (const slot of slots) {
      if (conflict.end <= slot.start || conflict.start >= slot.end) {
        next.push(slot)
        continue
      }
      if (conflict.start > slot.start) next.push({ start: slot.start, end: conflict.start })
      if (conflict.end < slot.end) next.push({ start: conflict.end, end: slot.end })
    }
    slots = next
  }
  return slots
}

/** Existing calendar events that overlap the target day become hard conflicts. */
function existingEventIntervals(
  schedules: StudyData[],
  target: string,
  timeZone: string,
): PlanningInterval[] {
  const fullDay = planningInterval(target, timeZone, { start: '00:00', end: '24:00' })
  const intervals: PlanningInterval[] = []
  for (const schedule of schedules) {
    const events = schedule['events']
    if (!Array.isArray(events)) continue
    for (const event of events) {
      if (event === null || typeof event !== 'object' || Array.isArray(event)) continue
      const record = event as Record<string, unknown>
      if (typeof record['start'] !== 'string' || typeof record['end'] !== 'string') continue
      const start = parseOffsetDateTimeStrict(record['start'])
      const end = parseOffsetDateTimeStrict(record['end'])
      if (start === null || end === null || end <= start) continue
      if (end <= fullDay.start || start >= fullDay.end) continue
      intervals.push({
        start: start < fullDay.start ? fullDay.start : start,
        end: end > fullDay.end ? fullDay.end : end,
      })
    }
  }
  return mergeIntervals(intervals)
}

/** Milliseconds converted to whole minutes, rounding down. */
function intervalMinutes(interval: PlanningInterval): number {
  return Math.max(0, Math.floor((interval.end.getTime() - interval.start.getTime()) / 60_000))
}

/** Find an exact-start or earliest slot and optionally shrink to fit. */
function fitIntoSlots(options: {
  slots: PlanningInterval[]
  requestedMinutes: number
  preferredStart: Date | null
  allowAdjustment: boolean
  minMinutes: number
}): { start: Date; duration: number; adjusted: boolean } | null {
  const { slots, requestedMinutes, preferredStart, allowAdjustment, minMinutes } = options
  const candidates = preferredStart === null
    ? slots.map(slot => ({ slot, start: slot.start }))
    : slots
      .filter(slot => preferredStart >= slot.start && preferredStart < slot.end)
      .map(slot => ({ slot, start: preferredStart }))
  for (const candidate of candidates) {
    const available = Math.max(0, Math.floor((candidate.slot.end.getTime() - candidate.start.getTime()) / 60_000))
    if (available >= requestedMinutes) {
      return { start: candidate.start, duration: requestedMinutes, adjusted: false }
    }
  }
  if (!allowAdjustment) return null
  let best: { start: Date; duration: number } | null = null
  for (const candidate of candidates) {
    const available = Math.max(0, Math.floor((candidate.slot.end.getTime() - candidate.start.getTime()) / 60_000))
    const duration = Math.min(requestedMinutes, available)
    if (duration < minMinutes) continue
    if (best === null || duration > best.duration || (duration === best.duration && candidate.start < best.start)) {
      best = { start: candidate.start, duration }
    }
  }
  return best === null ? null : { ...best, adjusted: best.duration !== requestedMinutes }
}

/** Stable queue ordering after an optional explicit intervention prefix. */
function orderedItems(items: InterventionItem[], order: string[]): InterventionItem[] {
  const byId = new Map(items.map(item => [item.intervention_id, item]))
  for (const interventionId of order) {
    if (!byId.has(interventionId)) {
      throw new Error(`scheduling.intervention_order references unknown Intervention ${interventionId}`)
    }
  }
  const requested = order.map(interventionId => byId.get(interventionId)!)
  const requestedIds = new Set(order)
  return [...requested, ...items.filter(item => !requestedIds.has(item.intervention_id))]
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
  preferences?: DayPlanPreferences | null
}): DayPlan {
  const { queueItems, schedules, attempts, project, target, timeZone, now, capacity } = options
  const preferences = parseDayPlanPreferences(options.preferences)
  if (preferences?.target_date !== undefined && preferences.target_date !== target) {
    throw new Error('scheduling.target_date must match the day-plan target')
  }

  const evidenceWindow = studyWindow(attempts, timeZone)
  const defaultWindows: DayPlanTimeWindow[] = [{
    start: wallClockLabel(evidenceWindow.start_hour * 60),
    end: wallClockLabel((evidenceWindow.end_hour + 1) * 60),
  }]
  const configuredWindows = preferences?.windows ?? defaultWindows
  const configuredBusy = preferences?.busy ?? []
  const availability = mergeIntervals(
    configuredWindows.map(window => planningInterval(target, timeZone, window)),
  )
  const windowMinutes = availability.reduce((sum, interval) => sum + intervalMinutes(interval), 0)
  const customWindowStart = Math.min(...configuredWindows.map(window => wallClockMinutes(window.start)!))
  const customWindowEnd = Math.max(...configuredWindows.map(window => wallClockMinutes(window.end, true)!))
  const window = preferences?.windows === undefined
    ? evidenceWindow
    : {
        start_hour: Math.floor(customWindowStart / 60),
        end_hour: Math.min(23, Math.max(0, Math.ceil(customWindowEnd / 60) - 1)),
        source: 'custom',
        sample_size: evidenceWindow.sample_size,
        coverage: null,
      }

  const rawFactor = capacity?.['factor']
  let factor = 1.0
  if (typeof rawFactor === 'number' && Number.isFinite(rawFactor) && rawFactor > 0 && rawFactor <= 1) {
    factor = rawFactor
  }

  const interventionIds = new Set(queueItems.map(item => item.intervention_id))
  const order = preferences?.intervention_order ?? []
  const deferredIds = preferences?.defer_intervention_ids ?? []
  for (const interventionId of deferredIds) {
    if (!interventionIds.has(interventionId)) {
      throw new Error(`scheduling.defer_intervention_ids references unknown Intervention ${interventionId}`)
    }
  }
  const placements = preferences?.placements ?? []
  for (const placement of placements) {
    if (!interventionIds.has(placement.intervention_id)) {
      throw new Error(`scheduling.placements references unknown Intervention ${placement.intervention_id}`)
    }
  }
  const placementById = new Map(placements.map(placement => [placement.intervention_id, placement]))
  const explicitlyOrdered = orderedItems(queueItems, order)
  const fixed = explicitlyOrdered
    .filter(item => placementById.get(item.intervention_id)?.start_time !== undefined)
    .sort((a, b) => {
      const aStart = wallClockMinutes(placementById.get(a.intervention_id)!.start_time!)!
      const bStart = wallClockMinutes(placementById.get(b.intervention_id)!.start_time!)!
      return aStart - bStart
    })
  const fixedIds = new Set(fixed.map(item => item.intervention_id))
  const items = [...fixed, ...explicitlyOrdered.filter(item => !fixedIds.has(item.intervention_id))]

  const existingConflicts = existingEventIntervals(schedules, target, timeZone)
    .filter(conflict => availability.some(window => conflict.start < window.end && conflict.end > window.start))
  const blocked = [
    ...configuredBusy.map(window => planningInterval(target, timeZone, window)),
    ...existingConflicts,
  ]
  if (now !== null && now !== undefined && localDateString(now, timeZone) === target) {
    const day = planningInterval(target, timeZone, { start: '00:00', end: '24:00' })
    const rounded = roundUp(now, timeZone)
    if (rounded > day.start) blocked.push({ start: day.start, end: rounded > day.end ? day.end : rounded })
  }
  let slots = subtractIntervals(availability, blocked)
  const breakMinutes = preferences?.break_minutes ?? BREAK_MINUTES
  const maxMinutes = preferences?.max_minutes ?? null
  const allowAdjustment = preferences?.allow_duration_adjustment ?? false
  const minDuration = preferences?.min_duration_minutes ?? MIN_ADAPTIVE_DURATION_MINUTES
  const scheduling = {
    mode: preferences === null ? 'automatic' as const : 'custom' as const,
    windows: configuredWindows,
    busy: configuredBusy,
    break_minutes: breakMinutes,
    max_minutes: maxMinutes,
    allow_duration_adjustment: allowAdjustment,
    min_duration_minutes: minDuration,
    intervention_order: order,
    defer_intervention_ids: deferredIds,
    placements,
    existing_event_conflicts: existingConflicts.length,
  }

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
      scheduling,
      capacity: capacity ?? null,
      minutes_budget: 0,
      minutes_budget_nominal: 0,
      minutes_planned: 0,
      schedules: [],
      unplaced: items.map(item => ({
        intervention_id: item.intervention_id,
        reason: deferredIds.includes(item.intervention_id)
          ? 'deferred by scheduling preference'
          : 'no Schedule phase covers the target date',
      })),
    }
  }

  for (const entry of targets) {
    entry.nominal_budget = entry.budget
    entry.budget = Math.max(1, Math.trunc(entry.budget * factor))
  }

  const unplaced: Array<{ intervention_id: string; reason: string }> = []
  let spent = 0
  for (const item of items) {
    if (deferredIds.includes(item.intervention_id)) {
      unplaced.push({ intervention_id: item.intervention_id, reason: 'deferred by scheduling preference' })
      continue
    }
    const activity = item.recommended_activity
    const recommendedDuration = activity.duration_minutes
    if (typeof recommendedDuration !== 'number' || !Number.isInteger(recommendedDuration) || recommendedDuration <= 0) {
      unplaced.push({
        intervention_id: item.intervention_id,
        reason: 'recommended_activity.duration_minutes is missing or not positive',
      })
      continue
    }
    const placement = placementById.get(item.intervention_id)
    const requestedDuration = Math.min(placement?.duration_minutes ?? recommendedDuration, MAX_EVENT_MINUTES)
    const routed = routeToSchedule(item, targets, placement?.schedule_id)
    const entry = targets[routed.index]!
    const phaseRecord = entry.phase as Record<string, unknown>
    const preferredStart = placement?.start_time === undefined
      ? null
      : planningInterval(target, timeZone, { start: placement.start_time, end: '24:00' }).start
    if (!allowAdjustment && fitIntoSlots({
      slots,
      requestedMinutes: requestedDuration,
      preferredStart,
      allowAdjustment: false,
      minMinutes: requestedDuration,
    }) === null) {
      const first = slots[0]
      const startLabel = first === undefined
        ? configuredWindows[0]!.start
        : wallClockLabel(requireZoneParts(first.start, timeZone).hour * 60 + requireZoneParts(first.start, timeZone).minute)
      const endLabel = configuredWindows[configuredWindows.length - 1]!.end
      unplaced.push({
        intervention_id: item.intervention_id,
        reason: `does not fit between ${startLabel} and the ${endLabel} end of the available study windows`,
      })
      continue
    }
    const scheduleRemaining = Math.max(0, entry.budget - entry.spent)
    const totalRemaining = maxMinutes === null ? Number.POSITIVE_INFINITY : Math.max(0, maxMinutes - spent)
    const boundedDuration = Math.min(requestedDuration, scheduleRemaining, totalRemaining)
    let duration = requestedDuration
    let adaptForBudget = false
    if (boundedDuration < requestedDuration) {
      if (allowAdjustment && boundedDuration >= Math.min(minDuration, requestedDuration)) {
        duration = boundedDuration
        adaptForBudget = true
      } else if (scheduleRemaining < requestedDuration) {
        unplaced.push({
          intervention_id: item.intervention_id,
          reason: `exceeds the ${entry.budget} minute daily budget of phase ${String(phaseRecord['id'])} in ${entry.schedule_id}`,
        })
        continue
      } else {
        unplaced.push({
          intervention_id: item.intervention_id,
          reason: `exceeds the scheduling.max_minutes limit of ${maxMinutes} minutes`,
        })
        continue
      }
    }

    const fit = fitIntoSlots({
      slots,
      requestedMinutes: duration,
      preferredStart,
      allowAdjustment,
      minMinutes: Math.min(minDuration, duration),
    })
    if (fit === null) {
      const first = slots[0]
      const startLabel = first === undefined
        ? configuredWindows[0]!.start
        : wallClockLabel(requireZoneParts(first.start, timeZone).hour * 60 + requireZoneParts(first.start, timeZone).minute)
      const endLabel = configuredWindows[configuredWindows.length - 1]!.end
      unplaced.push({
        intervention_id: item.intervention_id,
        reason: `does not fit between ${startLabel} and the ${endLabel} end of the available study windows`,
      })
      continue
    }

    const end = addMinutes(fit.start, fit.duration)
    const goals = item.reasons
      .map(reason => String(reason))
      .filter(reason => reason.trim() !== '')
    const criteria = activity.success_criteria
      .map(value => String(value))
      .filter(value => value.trim() !== '')
    const durationAdjusted = adaptForBudget || fit.adjusted
    entry.events.push({
      id: `dp-${target}-${item.intervention_id}`,
      title: eventTitle(item),
      subject_id: subjectId(entry.phase, project),
      type: item.kind,
      start: toZonedIso(fit.start, timeZone)!,
      end: toZonedIso(end, timeZone)!,
      duration_minutes: fit.duration,
      recommended_duration_minutes: recommendedDuration,
      duration_source: durationAdjusted
        ? 'adaptive_fit'
        : placement?.duration_minutes === undefined ? 'recommended' : 'placement_override',
      goals: goals.length + criteria.length > 0
        ? [...goals, ...criteria]
        : ['Produce evaluator-provenanced evidence.'],
      status: 'planned',
      source_intervention_id: item.intervention_id,
      source_objective_id: item.objective_id,
      evidence_dimension: item.evidence_dimension,
      routing: routed.routing,
    })
    entry.spent += fit.duration
    spent += fit.duration
    slots = subtractIntervals(slots, [{ start: fit.start, end: addMinutes(end, breakMinutes) }])
  }

  return {
    schema_version: DAY_PLAN_SCHEMA_VERSION,
    target_date: target,
    timezone: timeZone,
    study_window: window,
    scheduling,
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
          events: entry.events.sort((a, b) => a.start.localeCompare(b.start)),
        }
      }),
    unplaced,
  }
}
