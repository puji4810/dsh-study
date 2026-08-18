/**
 * StudyOS calibration: convert measured adherence and outcome aggregates into
 * bounded corrections for the recommender's own constants. Mirrors the original
 * calibration module rule for rule so a re-derived plan traces to the
 * observation that shaped it.
 * @module @puji4810/dsh-study/calibration
 */

import type { StudyAttempt } from './types.ts'
import { median, roundToStep } from './util.ts'

/** Fewer same-kind attempts than this describe a session's mood, not a habit. */
const MIN_DURATION_SAMPLE = 5

/** Calibrated durations stay within these multiples of the Domain Pack default. */
const DURATION_BAND_LOW = 0.5
const DURATION_BAND_HIGH = 2.0

/** Calibrated durations land on this five-minute grid. */
const DURATION_STEP = 5

/** The most a measured improvement rate may move a priority score. */
const MAX_OUTCOME_ADJUSTMENT = 8

/** The rate at which an Intervention kind is neither credited nor penalised. */
const NEUTRAL_IMPROVEMENT_RATE = 0.5

/** Calibration may tighten a day, never below this share of the phase budget. */
const MIN_CAPACITY_FACTOR = 0.5

/** The Schedule contract's per-event minute ceiling. */
const MAX_DURATION_MINUTES = 720

/** Round-half-to-even for integer results. */
function roundHalfEven(value: number): number {
  const floor = Math.floor(value)
  const diff = value - floor
  if (diff < 0.5) return floor
  if (diff > 0.5) return floor + 1
  return floor % 2 === 0 ? floor : floor + 1
}

/** Round-half-to-even at a fixed decimal scale. */
function roundHalfEvenN(value: number, digits: number): number {
  const factor = 10 ** digits
  return roundHalfEven(value * factor) / factor
}

/** Positive whole minutes from a duration in seconds, or null. */
function positiveMinutes(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return Math.max(1, roundHalfEven(value / 60))
}

/** The string `kind` of an outcome row, empty when absent or non-string. */
function candidateKind(row: Record<string, unknown>): string {
  const kind = row['kind']
  return typeof kind === 'string' ? kind : ''
}

/**
 * How long this learner actually takes over an Intervention of `kind`.
 * Same-kind evidence only, median rather than mean, on a five-minute grid.
 * @param options.attempts - the observed attempts.
 * @param options.kind - the Intervention kind being calibrated.
 * @param options.defaultMinutes - the Domain Pack stated duration.
 * @returns minutes/default_minutes/sample_size/observed_median_minutes/source/clamped.
 */
export function calibratedDuration(options: {
  attempts: StudyAttempt[]
  kind: string
  defaultMinutes: number
}): Record<string, unknown> {
  const { attempts, kind, defaultMinutes } = options
  const observed: number[] = []
  for (const attempt of attempts) {
    if ((attempt.intervention_kind ?? attempt.activity_kind ?? '') !== kind) continue
    const minutes = positiveMinutes(attempt.duration_seconds)
    if (minutes !== null) observed.push(minutes)
  }
  const result: Record<string, unknown> = {
    minutes: defaultMinutes,
    default_minutes: defaultMinutes,
    sample_size: observed.length,
    observed_median_minutes: null,
    source: 'domain-pack-default',
    clamped: false,
  }
  if (observed.length < MIN_DURATION_SAMPLE) return result

  const raw = roundHalfEven(median(observed))
  result.observed_median_minutes = raw
  const floor = Math.max(1, Math.trunc(defaultMinutes * DURATION_BAND_LOW))
  const ceiling = Math.max(floor, Math.min(MAX_DURATION_MINUTES, Math.trunc(defaultMinutes * DURATION_BAND_HIGH)))
  const bounded = Math.min(Math.max(raw, floor), ceiling)
  const stepped = roundToStep(bounded, DURATION_STEP)
  result.minutes = Math.min(Math.max(stepped, floor), ceiling)
  result.source = 'observed-median'
  result.clamped = bounded !== raw
  return result
}

/**
 * How much of a day's nominal budget this learner actually completes, bounded
 * to (0.5, 1.0] and never above the phase's own stated effort.
 * @param adherence - the adherence summary carrying `totals.completion_rate`.
 * @returns factor/source/days_measured/completion_rate.
 */
export function capacityFactor(adherence: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const totals = (adherence?.['totals'] as Record<string, unknown> | undefined) ?? {}
  const result: Record<string, unknown> = {
    factor: 1.0,
    source: 'uncalibrated',
    days_measured: Math.trunc(Number(totals['days_measured']) || 0),
    completion_rate: null,
  }
  if (totals['verdict'] !== 'measured') return result
  const rate = totals['completion_rate']
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return result
  result.completion_rate = roundHalfEvenN(rate, 3)
  result.factor = roundHalfEvenN(Math.min(1.0, Math.max(MIN_CAPACITY_FACTOR, rate)), 3)
  result.source = 'observed-adherence'
  return result
}

/**
 * Move an Intervention kind's priority by how often it has worked, capped at
 * `MAX_OUTCOME_ADJUSTMENT`, reading effectiveness and never compliance.
 * @param options.byKind - the per-kind outcome rows to search.
 * @param options.kind - the Intervention kind being scored.
 * @returns delta/source/improvement_rate/sample_size.
 */
export function outcomeAdjustment(options: {
  byKind: unknown[] | null | undefined
  kind: string
}): Record<string, unknown> {
  const { byKind, kind } = options
  const result: Record<string, unknown> = {
    delta: 0,
    source: 'insufficient_evidence',
    improvement_rate: null,
    sample_size: 0,
  }
  let row: Record<string, unknown> | undefined
  for (const item of byKind ?? []) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const candidate = item as Record<string, unknown>
    if (candidateKind(candidate) === kind) {
      row = candidate
      break
    }
  }
  if (row === undefined) return result
  result.sample_size = Math.trunc(Number(row['acted_on']) || 0)
  if (row['verdict'] !== 'measured') return result
  const rate = row['improvement_rate']
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return result
  result.improvement_rate = roundHalfEvenN(rate, 3)
  const scaled = (rate - NEUTRAL_IMPROVEMENT_RATE) / NEUTRAL_IMPROVEMENT_RATE
  const delta = roundHalfEven(MAX_OUTCOME_ADJUSTMENT * scaled)
  result.delta = Math.max(-MAX_OUTCOME_ADJUSTMENT, Math.min(MAX_OUTCOME_ADJUSTMENT, delta))
  result.source = 'measured'
  return result
}
