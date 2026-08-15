import { describe, expect, it } from 'vitest'
import { buildPlanAdherence } from '../src/adherence.ts'
import type { StudyAttempt, StudyData } from '../src/types.ts'

function attempt(partial: Partial<StudyAttempt> & { attempt_id: string }): StudyAttempt {
  return {
    schema_version: 'study_attempt.v1',
    project_id: 'proj-1',
    item_id: 'item-1',
    occurred_at: '2026-07-01T08:00:00Z',
    response: 'r',
    result: 'correct',
    score: 1.0,
    ...partial,
  }
}

function event(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'dp-1',
    title: 'evidence probe: x',
    subject_id: 's',
    type: 'evidence_probe',
    start: '2026-07-01T08:00:00Z',
    end: '2026-07-01T08:30:00Z',
    duration_minutes: 30,
    source_plan_proposal_id: 'plan-1',
    source_intervention_id: 'iv-1',
    source_objective_id: 'obj-1',
    evidence_dimension: 'recall',
    ...partial,
  }
}

function schedule(events: unknown[], scheduleId = 'sch-1'): StudyData {
  return { schema_version: 'study_schedule.v1', schedule_id: scheduleId, events } as StudyData
}

const asOf = new Date('2026-07-01T12:00:00Z')
const timeZone = 'UTC'
const range = { start: '2026-07-01', end: '2026-07-01' }

describe('buildPlanAdherence', () => {
  it('returns empty totals for no events and no attempts', () => {
    const result = buildPlanAdherence({
      schedules: [schedule([])],
      attempts: [],
      timeZone,
      start: range.start,
      end: range.end,
      asOf,
    })
    expect(result.unmeasured_events).toBe(0)
    expect(result.totals).toEqual({
      days_measured: 0,
      days_pending: 0,
      events_measured: 0,
      events_occurred: 0,
      minutes_planned: 0,
      minutes_observed: 0,
      unplanned_attempts: 0,
      completion_rate: null,
      effort_ratio: null,
      verdict: 'insufficient_evidence',
      needed_for_signal: 3,
    })
  })

  it('counts events without a source_plan_proposal_id as unmeasured', () => {
    const result = buildPlanAdherence({
      schedules: [schedule([event({ source_plan_proposal_id: '' })])],
      attempts: [],
      timeZone,
      start: range.start,
      end: range.end,
      asOf,
    })
    expect(result.unmeasured_events).toBe(1)
  })

  it('skips events whose start is unparseable or out of range', () => {
    const result = buildPlanAdherence({
      schedules: [
        schedule([
          event({ start: 'not-a-date' }),
          event({ start: '2026-06-30T08:00:00Z' }),
          event({ start: '2026-07-02T08:00:00Z' }),
        ]),
      ],
      attempts: [],
      timeZone,
      start: range.start,
      end: range.end,
      asOf,
    })
    expect(result.unmeasured_events).toBe(0)
    expect((result.totals as Record<string, unknown>).days_measured).toBe(0)
  })

  it('reports events ending after as_of as pending', () => {
    const result = buildPlanAdherence({
      schedules: [schedule([event({ start: '2026-07-01T20:00:00Z', end: '2026-07-01T20:30:00Z' })])],
      attempts: [],
      timeZone,
      start: range.start,
      end: range.end,
      asOf,
    })
    const day = (result.days as Array<Record<string, unknown>>)[0]!
    expect(day.events_measured).toBe(0)
    expect(day.events_pending).toBe(1)
    expect((day.events as Array<Record<string, unknown>>)[0]!.status).toBe('pending')
  })

  it('reports events lacking an objective or dimension as unmeasurable', () => {
    const result = buildPlanAdherence({
      schedules: [schedule([event({ source_objective_id: '' })])],
      attempts: [],
      timeZone,
      start: range.start,
      end: range.end,
      asOf,
    })
    const day = (result.days as Array<Record<string, unknown>>)[0]!
    expect((day.events as Array<Record<string, unknown>>)[0]!.status).toBe('unmeasurable')
    expect(day.events_measured).toBe(0)
  })

  it('reports not_started when no attempt matches the event', () => {
    const result = buildPlanAdherence({
      schedules: [schedule([event({})])],
      attempts: [],
      timeZone,
      start: range.start,
      end: range.end,
      asOf,
    })
    const day = (result.days as Array<Record<string, unknown>>)[0]!
    expect((day.events as Array<Record<string, unknown>>)[0]!.status).toBe('not_started')
    expect(day.events_measured).toBe(1)
  })

  it('classifies on_plan when observed effort is within tolerance', () => {
    const result = buildPlanAdherence({
      schedules: [schedule([event({})])],
      attempts: [
        attempt({ attempt_id: 'at-1', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-01T08:10:00Z', duration_seconds: 1800 }),
      ],
      timeZone,
      start: range.start,
      end: range.end,
      asOf,
    })
    const rendered = ((result.days as Array<Record<string, unknown>>)[0]!.events as Array<Record<string, unknown>>)[0]!
    expect(rendered.status).toBe('on_plan')
    expect(rendered.observed_minutes).toBe(30)
    expect(rendered.start_delay_minutes).toBe(10)
    expect(rendered.attempt_ids).toEqual(['at-1'])
  })

  it('classifies under_run and over_run', () => {
    const under = buildPlanAdherence({
      schedules: [schedule([event({})])],
      attempts: [attempt({ attempt_id: 'at-1', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-01T08:10:00Z', duration_seconds: 600 })],
      timeZone, start: range.start, end: range.end, asOf,
    })
    expect(((under.days as Array<Record<string, unknown>>)[0]!.events as Array<Record<string, unknown>>)[0]!.status).toBe('under_run')

    const over = buildPlanAdherence({
      schedules: [schedule([event({})])],
      attempts: [attempt({ attempt_id: 'at-1', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-01T08:10:00Z', duration_seconds: 3600 })],
      timeZone, start: range.start, end: range.end, asOf,
    })
    expect(((over.days as Array<Record<string, unknown>>)[0]!.events as Array<Record<string, unknown>>)[0]!.status).toBe('over_run')
  })

  it('reports occurred with unknown duration and no planned duration', () => {
    const noDuration = buildPlanAdherence({
      schedules: [schedule([event({ duration_minutes: 0 })])],
      attempts: [attempt({ attempt_id: 'at-1', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-01T08:10:00Z' })],
      timeZone, start: range.start, end: range.end, asOf,
    })
    expect(((noDuration.days as Array<Record<string, unknown>>)[0]!.events as Array<Record<string, unknown>>)[0]!.status).toBe('occurred')
  })

  it('claims each attempt by at most one event and reports unplanned attempts', () => {
    const result = buildPlanAdherence({
      schedules: [
        schedule([
          event({ id: 'dp-1', source_objective_id: 'obj-1' }),
          event({ id: 'dp-2', source_objective_id: 'obj-1' }),
        ]),
      ],
      attempts: [
        attempt({ attempt_id: 'at-1', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-01T08:10:00Z' }),
        attempt({ attempt_id: 'at-2', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-01T08:20:00Z' }),
        attempt({ attempt_id: 'at-3', objective_ids: ['obj-1'], transfer_level: 'explanation', occurred_at: '2026-07-01T08:30:00Z' }),
      ],
      timeZone, start: range.start, end: range.end, asOf,
    })
    const day = (result.days as Array<Record<string, unknown>>)[0]!
    expect(day.unplanned_attempt_ids).toEqual(['at-3'])
  })

  it('reports measured totals once enough days carry a measurable plan', () => {
    const result = buildPlanAdherence({
      schedules: [
        schedule([
          event({ id: 'dp-1', start: '2026-07-01T08:00:00Z' }),
          event({ id: 'dp-2', start: '2026-07-02T08:00:00Z' }),
          event({ id: 'dp-3', start: '2026-07-03T08:00:00Z' }),
        ]),
      ],
      attempts: [
        attempt({ attempt_id: 'a1', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-01T08:10:00Z', duration_seconds: 1800 }),
        attempt({ attempt_id: 'a2', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-02T08:10:00Z', duration_seconds: 1800 }),
        attempt({ attempt_id: 'a3', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-03T08:10:00Z', duration_seconds: 1800 }),
      ],
      timeZone,
      start: '2026-07-01',
      end: '2026-07-03',
      asOf: new Date('2026-07-04T12:00:00Z'),
    })
    const totals = result.totals as Record<string, unknown>
    expect(totals.verdict).toBe('measured')
    expect(totals.days_measured).toBe(3)
    expect(totals.completion_rate).toBe(1)
    expect(totals.effort_ratio).toBe(1)
  })

  it('falls back to the start time plus duration when end is missing', () => {
    const result = buildPlanAdherence({
      schedules: [schedule([event({ end: undefined })])],
      attempts: [attempt({ attempt_id: 'at-1', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-01T08:10:00Z' })],
      timeZone, start: range.start, end: range.end, asOf,
    })
    const rendered = ((result.days as Array<Record<string, unknown>>)[0]!.events as Array<Record<string, unknown>>)[0]!
    expect(rendered.status).toBe('occurred')
    expect(rendered.planned_minutes).toBe(30)
  })

  it('skips schedules without events array and non-object events', () => {
    const result = buildPlanAdherence({
      schedules: [{ schedule_id: 'sch-x', events: 'not-array' } as unknown as StudyData, schedule([null, 'str'])],
      attempts: [],
      timeZone, start: range.start, end: range.end, asOf,
    })
    expect(result.unmeasured_events).toBe(0)
    expect((result.totals as Record<string, unknown>).events_measured).toBe(0)
  })

  it('treats a missing duration_minutes as zero planned minutes', () => {
    const result = buildPlanAdherence({
      schedules: [schedule([event({ duration_minutes: undefined })])],
      attempts: [attempt({ attempt_id: 'at-1', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-01T08:10:00Z', duration_seconds: 1800 })],
      timeZone, start: range.start, end: range.end, asOf,
    })
    const rendered = ((result.days as Array<Record<string, unknown>>)[0]!.events as Array<Record<string, unknown>>)[0]!
    expect(rendered.status).toBe('occurred')
    expect(rendered.planned_minutes).toBe(0)
  })

  it('defaults missing event provenance fields to empty strings', () => {
    const result = buildPlanAdherence({
      schedules: [schedule([event({ id: undefined, type: undefined, source_intervention_id: undefined, source_objective_id: 'obj-1', evidence_dimension: 'recall' })])],
      attempts: [attempt({ attempt_id: 'at-1', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-01T08:10:00Z' })],
      timeZone, start: range.start, end: range.end, asOf,
    })
    const rendered = ((result.days as Array<Record<string, unknown>>)[0]!.events as Array<Record<string, unknown>>)[0]!
    expect(rendered.event_id).toBe('')
    expect(rendered.kind).toBe('')
    expect(rendered.source_intervention_id).toBe('')
  })

  it('orders events with equal start times by event id', () => {
    const one = event({ id: 'dp-b', start: '2026-07-01T08:00:00Z' })
    const two = event({ id: 'dp-a', start: '2026-07-01T08:00:00Z' })
    const result = buildPlanAdherence({
      schedules: [schedule([one, two])],
      attempts: [],
      timeZone, start: range.start, end: range.end, asOf,
    })
    const events = (result.days as Array<Record<string, unknown>>)[0]!.events as Array<Record<string, unknown>>
    expect(events[0]!.event_id).toBe('dp-a')
    expect(events[1]!.event_id).toBe('dp-b')
  })

  it('skips attempts with naive or out-of-range timestamps', () => {
    const result = buildPlanAdherence({
      schedules: [schedule([event({})])],
      attempts: [
        attempt({ attempt_id: 'a-naive', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-01T08:10:00' }),
        attempt({ attempt_id: 'a-out', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-06-30T08:10:00Z' }),
      ],
      timeZone, start: range.start, end: range.end, asOf,
    })
    const day = (result.days as Array<Record<string, unknown>>)[0]!
    expect(day.events_measured).toBe(1)
    expect((day.events as Array<Record<string, unknown>>)[0]!.status).toBe('not_started')
  })

  it('claims matching attempts but leaves mismatched transfer/objective unclaimed', () => {
    const result = buildPlanAdherence({
      schedules: [schedule([event({})])],
      attempts: [
        attempt({ attempt_id: 'a-other-obj', objective_ids: ['obj-x'], transfer_level: 'recall', occurred_at: '2026-07-01T08:10:00Z' }),
        attempt({ attempt_id: 'a-other-dim', objective_ids: ['obj-1'], transfer_level: 'explanation', occurred_at: '2026-07-01T08:11:00Z' }),
      ],
      timeZone, start: range.start, end: range.end, asOf,
    })
    const day = (result.days as Array<Record<string, unknown>>)[0]!
    expect((day.events as Array<Record<string, unknown>>)[0]!.status).toBe('not_started')
    expect(day.unplanned_attempt_ids).toEqual(['a-other-obj', 'a-other-dim'])
  })

  it('reports occurred when a matched attempt has no duration (observed null), skipping NaN durations', () => {
    const result = buildPlanAdherence({
      schedules: [schedule([event({})])],
      attempts: [
        attempt({ attempt_id: 'a-no-dur', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-01T08:10:00Z' }),
        attempt({ attempt_id: 'a-neg', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-01T08:11:00Z', duration_seconds: -5 }),
      ],
      timeZone, start: range.start, end: range.end, asOf,
    })
    const rendered = ((result.days as Array<Record<string, unknown>>)[0]!.events as Array<Record<string, unknown>>)[0]!
    expect(rendered.status).toBe('occurred')
    expect(rendered.observed_minutes).toBe(null)
  })

  it('uses the effort_ratio path when minutes_planned is zero', () => {
    const result = buildPlanAdherence({
      schedules: [
        schedule([event({ start: '2026-07-01T08:00:00Z', duration_minutes: 0 })]),
        schedule([event({ start: '2026-07-02T08:00:00Z', duration_minutes: 0 })]),
        schedule([event({ start: '2026-07-03T08:00:00Z', duration_minutes: 0 })]),
      ],
      attempts: [],
      timeZone,
      start: '2026-07-01',
      end: '2026-07-03',
      asOf: new Date('2026-07-04T12:00:00Z'),
    })
    expect((result.totals as Record<string, unknown>).effort_ratio).toBe(null)
    expect((result.totals as Record<string, unknown>).verdict).toBe('measured')
  })

  it('rounds an improvement ratio above half and below half through the conclusion', () => {
    const above = buildPlanAdherence({
      schedules: [
        schedule([event({ start: '2026-07-01T08:00:00Z', source_objective_id: 'obj-1' })]),
        schedule([event({ start: '2026-07-02T08:00:00Z', source_objective_id: 'obj-1' })]),
        schedule([event({ start: '2026-07-03T08:00:00Z', source_objective_id: 'obj-1' })]),
      ],
      attempts: [
        attempt({ attempt_id: 'a1', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-01T08:10:00Z', duration_seconds: 1800 }),
        attempt({ attempt_id: 'a2', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-02T08:10:00Z', duration_seconds: 1800 }),
      ],
      timeZone, start: '2026-07-01', end: '2026-07-03', asOf: new Date('2026-07-04T12:00:00Z'),
    })
    expect((above.totals as Record<string, unknown>).completion_rate).toBe(0.667)

    const below = buildPlanAdherence({
      schedules: [
        schedule([event({ start: '2026-07-01T08:00:00Z', source_objective_id: 'obj-1' })]),
        schedule([event({ start: '2026-07-02T08:00:00Z', source_objective_id: 'obj-1' })]),
        schedule([event({ start: '2026-07-03T08:00:00Z', source_objective_id: 'obj-1' })]),
      ],
      attempts: [
        attempt({ attempt_id: 'a1', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-01T08:10:00Z', duration_seconds: 1800 }),
      ],
      timeZone, start: '2026-07-01', end: '2026-07-03', asOf: new Date('2026-07-04T12:00:00Z'),
    })
    expect((below.totals as Record<string, unknown>).completion_rate).toBe(0.333)
  })

  it('rounds a half-to-even effort ratio across the median boundary', () => {
    // minutes_planned = 2000, minutes_observed = 1 -> 0.0005 -> half-to-even (even floor 0) -> 0
    const even = buildPlanAdherence({
      schedules: [
        schedule([event({ start: '2026-07-01T08:00:00Z', source_objective_id: 'obj-1', duration_minutes: 2000 })]),
        schedule([event({ start: '2026-07-02T08:00:00Z', source_objective_id: 'obj-1', duration_minutes: 0 })]),
        schedule([event({ start: '2026-07-03T08:00:00Z', source_objective_id: 'obj-1', duration_minutes: 0 })]),
      ],
      attempts: [
        attempt({ attempt_id: 'a1', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-01T08:10:00Z', duration_seconds: 60 }),
      ],
      timeZone, start: '2026-07-01', end: '2026-07-03', asOf: new Date('2026-07-04T12:00:00Z'),
    })
    expect((even.totals as Record<string, unknown>).effort_ratio).toBe(0)

    // minutes_observed = 3 -> 0.0015 -> half-to-even (odd floor 1) -> 0.002
    const odd = buildPlanAdherence({
      schedules: [
        schedule([event({ start: '2026-07-01T08:00:00Z', source_objective_id: 'obj-1', duration_minutes: 2000 })]),
        schedule([event({ start: '2026-07-02T08:00:00Z', source_objective_id: 'obj-1', duration_minutes: 0 })]),
        schedule([event({ start: '2026-07-03T08:00:00Z', source_objective_id: 'obj-1', duration_minutes: 0 })]),
      ],
      attempts: [
        attempt({ attempt_id: 'a1', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-01T08:10:00Z', duration_seconds: 60 }),
        attempt({ attempt_id: 'a2', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-01T08:11:00Z', duration_seconds: 60 }),
        attempt({ attempt_id: 'a3', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-01T08:12:00Z', duration_seconds: 60 }),
      ],
      timeZone, start: '2026-07-01', end: '2026-07-03', asOf: new Date('2026-07-04T12:00:00Z'),
    })
    expect((odd.totals as Record<string, unknown>).effort_ratio).toBe(0.002)
  })

  it('skips events whose start parses to an invalid instant', () => {
    const result = buildPlanAdherence({
      schedules: [schedule([event({ start: '2026-13-01T08:00:00Z' })])],
      attempts: [],
      timeZone, start: range.start, end: range.end, asOf,
    })
    expect(result.unmeasured_events).toBe(0)
    expect((result.totals as Record<string, unknown>).events_measured).toBe(0)
  })

  it('treats a missing objective_ids as uncommitted evidence', () => {
    const result = buildPlanAdherence({
      schedules: [schedule([event({})])],
      attempts: [
        attempt({ attempt_id: 'at-1', transfer_level: 'recall', occurred_at: '2026-07-01T08:10:00Z' }),
      ],
      timeZone, start: range.start, end: range.end, asOf,
    })
    const day = (result.days as Array<Record<string, unknown>>)[0]!
    expect((day.events as Array<Record<string, unknown>>)[0]!.status).toBe('not_started')
  })

  it('defaults a schedule without schedule_id to an empty id', () => {
    const result = buildPlanAdherence({
      schedules: [{ events: [event({})] } as StudyData],
      attempts: [],
      timeZone, start: range.start, end: range.end, asOf,
    })
    expect((((result.days as Array<Record<string, unknown>>)[0]!.events as Array<Record<string, unknown>>)[0]!)).toMatchObject({ schedule_id: '' })
  })

  it('counts an event missing its source proposal id as unmeasured', () => {
    const result = buildPlanAdherence({
      schedules: [schedule([event({ source_plan_proposal_id: undefined })])],
      attempts: [],
      timeZone, start: range.start, end: range.end, asOf,
    })
    expect(result.unmeasured_events).toBe(1)
  })

  it('defaults missing objective and dimension provenance to empty strings (unmeasurable)', () => {
    const result = buildPlanAdherence({
      schedules: [schedule([event({ source_objective_id: undefined, evidence_dimension: undefined })])],
      attempts: [],
      timeZone, start: range.start, end: range.end, asOf,
    })
    const rendered = ((result.days as Array<Record<string, unknown>>)[0]!.events as Array<Record<string, unknown>>)[0]!
    expect(rendered.status).toBe('unmeasurable')
    expect(rendered.objective_id).toBe('')
    expect(rendered.evidence_dimension).toBe('')
  })

  it('includes attempt-only dates as days with no events', () => {
    const result = buildPlanAdherence({
      schedules: [],
      attempts: [
        attempt({ attempt_id: 'at-1', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-01T08:10:00Z' }),
      ],
      timeZone, start: range.start, end: range.end, asOf,
    })
    expect((result.days as Array<Record<string, unknown>>).length).toBe(1)
    expect((result.days as Array<Record<string, unknown>>)[0]!.events).toEqual([])
  })

  it('skips attempts without a transfer level when matching', () => {
    const result = buildPlanAdherence({
      schedules: [schedule([event({})])],
      attempts: [
        attempt({ attempt_id: 'at-1', objective_ids: ['obj-1'], occurred_at: '2026-07-01T08:10:00Z' }),
      ],
      timeZone, start: range.start, end: range.end, asOf,
    })
    const day = (result.days as Array<Record<string, unknown>>)[0]!
    expect((day.events as Array<Record<string, unknown>>)[0]!.status).toBe('not_started')
    expect(day.unplanned_attempt_ids).toEqual(['at-1'])
  })
})
