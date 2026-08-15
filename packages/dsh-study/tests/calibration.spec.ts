import { describe, expect, it } from 'vitest'
import { calibratedDuration, capacityFactor, outcomeAdjustment } from '../src/calibration.ts'
import type { StudyAttempt } from '../src/types.ts'

function attempt(partial: Partial<StudyAttempt> & { attempt_id: string }): StudyAttempt {
  return {
    schema_version: 'study_attempt.v1',
    project_id: 'proj-1',
    item_id: 'item-1',
    occurred_at: '2026-07-01T12:00:00Z',
    response: 'r',
    result: 'correct',
    score: 1.0,
    ...partial,
  }
}

describe('calibratedDuration', () => {
  it('returns the domain-pack default when the same-kind sample is thin', () => {
    const attempts = [1, 2, 3].map(i =>
      attempt({ attempt_id: `a-${i}`, activity_kind: 'evidence_probe', duration_seconds: 1800 }),
    )
    const result = calibratedDuration({ attempts, kind: 'evidence_probe', defaultMinutes: 30 })
    expect(result).toEqual({
      minutes: 30,
      default_minutes: 30,
      sample_size: 3,
      observed_median_minutes: null,
      source: 'domain-pack-default',
      clamped: false,
    })
  })

  it('ignores attempts of other kinds and invalid durations', () => {
    const attempts = [
      attempt({ attempt_id: 'a-1', activity_kind: 'evidence_probe', duration_seconds: 1800 }),
      attempt({ attempt_id: 'a-2', activity_kind: 'other', duration_seconds: 1800 }),
      attempt({ attempt_id: 'a-3', activity_kind: 'evidence_probe', duration_seconds: 0 }),
      attempt({ attempt_id: 'a-4', activity_kind: 'evidence_probe' }),
    ]
    const result = calibratedDuration({ attempts, kind: 'evidence_probe', defaultMinutes: 30 })
    expect(result.sample_size).toBe(1)
    expect(result.source).toBe('domain-pack-default')
  })

  it('rounds a fractional median half-to-even and reports observed-median', () => {
    // median of [10, 20] minutes is 15 (whole); use an even-count list for a .5 median.
    const attempts = [10, 20, 30, 40, 50, 60].map((minutes, i) =>
      attempt({
        attempt_id: `a-${i}`,
        activity_kind: 'evidence_probe',
        duration_seconds: minutes * 60,
      }),
    )
    const result = calibratedDuration({ attempts, kind: 'evidence_probe', defaultMinutes: 30 })
    expect(result.source).toBe('observed-median')
    expect(result.sample_size).toBe(6)
    expect(result.clamped).toBe(false)
    expect(result.minutes).toBe(35)
  })

  it('clamps a low median up to the band floor', () => {
    const attempts = [1, 2, 3, 4, 5].map((minutes, i) =>
      attempt({
        attempt_id: `a-${i}`,
        activity_kind: 'evidence_probe',
        duration_seconds: minutes * 60,
      }),
    )
    const result = calibratedDuration({ attempts, kind: 'evidence_probe', defaultMinutes: 30 })
    expect(result.clamped).toBe(true)
    expect(result.observed_median_minutes).toBe(3)
    expect(result.minutes).toBe(15)
  })

  it('clamps a high median down to the band ceiling', () => {
    const attempts = [100, 110, 120, 130, 140].map((minutes, i) =>
      attempt({
        attempt_id: `a-${i}`,
        activity_kind: 'evidence_probe',
        duration_seconds: minutes * 60,
      }),
    )
    const result = calibratedDuration({ attempts, kind: 'evidence_probe', defaultMinutes: 30 })
    expect(result.clamped).toBe(true)
    expect(result.minutes).toBe(60)
  })

  it('steps the clamped value on the five-minute grid then re-clamps to the floor', () => {
    // default 13 -> floor 6, ceiling 26. A tiny median (raw 1) is bounded to 6,
    // then stepped to 5, then clamped back up to 6.
    const attempts = [1, 1, 1, 1, 1].map((minutes, i) =>
      attempt({
        attempt_id: `a-${i}`,
        activity_kind: 'evidence_probe',
        duration_seconds: minutes * 60,
      }),
    )
    const result = calibratedDuration({ attempts, kind: 'evidence_probe', defaultMinutes: 13 })
    expect(result.clamped).toBe(true)
    expect(result.observed_median_minutes).toBe(1)
    expect(result.minutes).toBe(6)
  })

  it('covers positive-minutes rounding for fractional and half values', () => {
    const attempts = [30, 72, 90, 102, 120].map((seconds, i) =>
      attempt({ attempt_id: `a-${i}`, activity_kind: 'evidence_probe', duration_seconds: seconds }),
    )
    const result = calibratedDuration({ attempts, kind: 'evidence_probe', defaultMinutes: 30 })
    expect(result.sample_size).toBe(5)
    expect(result.source).toBe('observed-median')
  })
})

describe('capacityFactor', () => {
  it('is uncalibrated when the verdict is not measured', () => {
    expect(capacityFactor(undefined)).toEqual({
      factor: 1.0,
      source: 'uncalibrated',
      days_measured: 0,
      completion_rate: null,
    })
    expect(capacityFactor({ totals: { verdict: 'insufficient_evidence', days_measured: 2 } })).toMatchObject({
      factor: 1.0,
      source: 'uncalibrated',
      days_measured: 2,
      completion_rate: null,
    })
  })

  it('is uncalibrated when completion_rate is not a number', () => {
    expect(capacityFactor({ totals: { verdict: 'measured', completion_rate: 'x', days_measured: 5 } }).source).toBe(
      'uncalibrated',
    )
  })

  it('clamps the factor into [0.5, 1.0]', () => {
    const low = capacityFactor({ totals: { verdict: 'measured', completion_rate: 0.2, days_measured: 5 } })
    expect(low).toEqual({
      factor: 0.5,
      source: 'observed-adherence',
      days_measured: 5,
      completion_rate: 0.2,
    })
    const high = capacityFactor({ totals: { verdict: 'measured', completion_rate: 1.5, days_measured: 5 } })
    expect(high.factor).toBe(1.0)
    expect(high.completion_rate).toBe(1.5)
  })
})

describe('outcomeAdjustment', () => {
  it('reports insufficient evidence when the kind has no row', () => {
    expect(outcomeAdjustment({ byKind: [], kind: 'guided_repair' })).toEqual({
      delta: 0,
      source: 'insufficient_evidence',
      improvement_rate: null,
      sample_size: 0,
    })
  })

  it('reports insufficient evidence when the row verdict is not measured', () => {
    expect(
      outcomeAdjustment({ byKind: [{ kind: 'guided_repair', acted_on: 3, verdict: 'insufficient_evidence' }], kind: 'guided_repair' }),
    ).toEqual({
      delta: 0,
      source: 'insufficient_evidence',
      improvement_rate: null,
      sample_size: 3,
    })
  })

  it('is unchanged when the row has a non-numeric improvement_rate', () => {
    expect(
      outcomeAdjustment({ byKind: [{ kind: 'guided_repair', acted_on: 5, verdict: 'measured', improvement_rate: 'n/a' }], kind: 'guided_repair' }).source,
    ).toBe('insufficient_evidence')
  })

  it('scales improvement above the neutral rate into a positive delta', () => {
    const result = outcomeAdjustment({
      byKind: [{ kind: 'guided_repair', acted_on: 5, verdict: 'measured', improvement_rate: 1.0 }],
      kind: 'guided_repair',
    })
    expect(result).toEqual({
      delta: 8,
      source: 'measured',
      improvement_rate: 1.0,
      sample_size: 5,
    })
  })

  it('scales improvement below the neutral rate into a negative delta, clamped at -8', () => {
    const result = outcomeAdjustment({
      byKind: [{ kind: 'guided_repair', acted_on: 5, verdict: 'measured', improvement_rate: 0.0 }],
      kind: 'guided_repair',
    })
    expect(result.delta).toBe(-8)
    expect(result.source).toBe('measured')
  })

  it('yields a zero delta at the neutral improvement rate', () => {
    const result = outcomeAdjustment({
      byKind: [{ kind: 'guided_repair', acted_on: 5, verdict: 'measured', improvement_rate: 0.5 }],
      kind: 'guided_repair',
    })
    expect(result.delta).toBe(0)
    expect(result.source).toBe('measured')
  })

  it('skips null, non-object, and array rows while searching by kind', () => {
    const result = outcomeAdjustment({
      byKind: [null, 'nope', ['array'], { kind: 'guided_repair', acted_on: 5, verdict: 'measured', improvement_rate: 0.8 }] as unknown as Array<Record<string, unknown>>,
      kind: 'guided_repair',
    })
    expect(result.source).toBe('measured')
    expect(result.sample_size).toBe(5)
  })

  it('uses zero sample size when acted_on is falsy', () => {
    const result = outcomeAdjustment({
      byKind: [{ kind: 'guided_repair', acted_on: 0, verdict: 'measured', improvement_rate: 0.8 }],
      kind: 'guided_repair',
    })
    expect(result.sample_size).toBe(0)
  })

  it('defaults byKind to an empty list and skips rows without a kind', () => {
    expect(outcomeAdjustment({ byKind: null, kind: 'x' }).delta).toBe(0)
    expect(outcomeAdjustment({ byKind: undefined, kind: 'x' }).delta).toBe(0)
    expect(outcomeAdjustment({ byKind: [{ acted_on: 5 }], kind: 'x' }).delta).toBe(0)
  })

  it('does not measure a kind whose row is another kind with no activity_kind', () => {
    const result = calibratedDuration({ attempts: [attempt({ attempt_id: 'a-9' })], kind: 'evidence_probe', defaultMinutes: 30 })
    expect(result.sample_size).toBe(0)
    expect(result.source).toBe('domain-pack-default')
  })
})
