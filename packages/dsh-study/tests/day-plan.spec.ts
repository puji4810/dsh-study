import { describe, expect, it } from 'vitest'
import { activePhase, buildDayPlan, studyWindow } from '../src/day-plan.ts'
import type { InterventionItem, StudyAttempt, StudyData, StudyProject } from '../src/types.ts'

function mkAttempt(hour: number, attemptId: string): StudyAttempt {
  return {
    schema_version: 'study_attempt.v1',
    project_id: 'proj-1',
    item_id: 'item-1',
    occurred_at: `2026-07-01T${String(hour).padStart(2, '0')}:00:00Z`,
    response: 'r',
    result: 'correct',
    score: 1.0,
    attempt_id: attemptId,
  }
}

function mkItem(partial: Partial<InterventionItem> & { intervention_id: string; objective_id: string }): InterventionItem {
  return {
    capability: 'Solve the thing',
    kind: 'evidence_probe',
    evidence_dimension: 'recall',
    priority_score: 80,
    priority_band: 'high',
    reasons: ['No evaluator-provenanced recall evidence has been recorded.'],
    reason_factors: {
      verification_status: 'unobserved',
      evidence_age_days: null,
      evidence_age_band: 'unobserved',
      freshness_threshold_days: 14,
      days_to_deadline: null,
      deadline_band: 'none',
      repeated_diagnosis_count: 0,
      outcome_adjustment: 0,
      outcome_improvement_rate: null,
      outcome_sample_size: 0,
      outcome_source: 'insufficient_evidence',
    },
    latest_evidence_at: null,
    evidence_attempt_ids: [],
    recommended_activity: {
      activity_kind: 'evidence_probe',
      evidence_target: 'recall',
      assistance_level: 'hints_only',
      duration_minutes: 30,
      duration_source: 'domain-pack-default',
      duration_sample_size: 0,
      requires_evaluator: true,
      success_criteria: ['Produce evidence.'],
      source_anchors: [],
    },
    ...partial,
  }
}

function mkPhase(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'ph-1',
    title: 'Phase one',
    start: '2026-06-01',
    end: '2026-07-31',
    goal: 'master recall',
    ...partial,
  }
}

function mkSchedule(scheduleId: string, phases: Array<Record<string, unknown>>, title = 'Schedule'): StudyData {
  return {
    schema_version: 'study_schedule.v1',
    schedule_id: scheduleId,
    title,
    timezone: 'UTC',
    range: { start: '2026-06-01', end: '2026-07-31' },
    phases,
    events: [],
  } as StudyData
}

function mkProject(partial: Partial<StudyProject> = {}): StudyProject {
  return {
    schema_version: 'study_project.v2',
    project_id: 'proj-1',
    title: 'Math study',
    domain: 'math',
    timezone: 'UTC',
    phase: 'active',
    domain_pack: 'general.v1',
    workspace_type: 'dir',
    artifact_policy: 'keep',
    deadline: '2026-08-30',
    tracks: [{ id: 'track-math', label: 'Math' }],
    objectives: [
      {
        objective_id: 'obj-1',
        capability: 'Solve the thing',
        success_criteria: ['Produce evidence.'],
        evidence_targets: ['recall'],
      },
    ],
    prompt_policy: {
      base_max_chars: 2000,
      intent_max_chars: 2500,
      domain_max_chars: 2000,
      project_summary_max_chars: 1200,
      total_max_chars: 6000,
      total_max_tokens: 1800,
      updates_apply: 'next_session',
    },
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...partial,
  } as StudyProject
}

const target = '2026-07-01'
const timeZone = 'UTC'

describe('studyWindow', () => {
  it('falls back to the default window when the sample is thin', () => {
    const attempts = [1, 2, 3].map(i => mkAttempt(20, `a-${i}`))
    expect(studyWindow(attempts, timeZone)).toEqual({
      start_hour: 19,
      end_hour: 23,
      source: 'default',
      sample_size: 3,
      coverage: null,
    })
  })

  it('skips attempts without a valid offset timestamp', () => {
    const attempts = [
      mkAttempt(20, 'a-1'),
      { ...mkAttempt(20, 'a-2'), occurred_at: '2026-07-01T20:00:00' },
      { ...mkAttempt(20, 'a-3'), occurred_at: 'garbage' },
    ]
    expect(studyWindow(attempts, timeZone).sample_size).toBe(1)
  })

  it('derives an evidence window from a dense single hour', () => {
    const attempts = Array.from({ length: 14 }, (_, i) => mkAttempt(7, `a-${i}`))
    const window = studyWindow(attempts, timeZone)
    expect(window.source).toBe('evidence')
    expect(window.start_hour).toBe(7)
    expect(window.end_hour).toBe(7)
    expect(window.coverage).toBe(1)
  })

  it('clamps a derived window wider than ten hours', () => {
    const attempts = [
      ...Array.from({ length: 6 }, (_, i) => mkAttempt(0, `a-${i}`)),
      ...Array.from({ length: 6 }, (_, i) => mkAttempt(23, `b-${i}`)),
    ]
    const window = studyWindow(attempts, timeZone)
    expect(window.source).toBe('evidence')
    expect(window.start_hour).toBe(0)
    expect(window.end_hour).toBe(9)
  })
})

describe('activePhase', () => {
  it('returns the phase whose range contains the target', () => {
    const schedule = mkSchedule('sch-1', [mkPhase({ start: '2026-06-01', end: '2026-07-31' })])
    const phase = activePhase(schedule, '2026-07-15')
    expect(phase).not.toBeNull()
    expect((phase as Record<string, unknown>).id).toBe('ph-1')
  })

  it('returns null when no phase covers the target or phases are malformed', () => {
    expect(activePhase(mkSchedule('sch-1', [mkPhase({ start: 'bad', end: '2026-07-31' })]), target)).toBeNull()
    expect(activePhase(mkSchedule('sch-1', [mkPhase({ start: '2026-08-01', end: '2026-08-31' })]), target)).toBeNull()
    expect(activePhase({} as StudyData, target)).toBeNull()
  })
})

describe('buildDayPlan', () => {
  const emptyAttempts: StudyAttempt[] = []

  it('marks everything unplaced when no phase covers the target', () => {
    const plan = buildDayPlan({
      queueItems: [mkItem({ intervention_id: 'iv-1', objective_id: 'obj-1' })],
      schedules: [],
      attempts: emptyAttempts,
      project: mkProject(),
      target,
      timeZone,
    })
    expect(plan.schedules).toEqual([])
    expect(plan.minutes_planned).toBe(0)
    expect(plan.unplaced).toEqual([
      { intervention_id: 'iv-1', reason: 'no Schedule phase covers the target date' },
    ])
  })

  it('falls back to the window minutes when a phase has no budget', () => {
    const plan = buildDayPlan({
      queueItems: [mkItem({ intervention_id: 'iv-1', objective_id: 'obj-1' })],
      schedules: [mkSchedule('sch-1', [mkPhase({ effort_minutes: undefined })])],
      attempts: emptyAttempts,
      project: mkProject(),
      target,
      timeZone,
    })
    const schedule = plan.schedules[0]!
    expect(schedule.minutes_budget).toBe(300)
    expect(schedule.minutes_budget_nominal).toBe(300)
    expect(plan.minutes_budget).toBe(300)
  })

  it('splits a phase budget across its remaining days', () => {
    const plan = buildDayPlan({
      queueItems: [mkItem({ intervention_id: 'iv-1', objective_id: 'obj-1' })],
      schedules: [mkSchedule('sch-1', [mkPhase({ effort_minutes: 60, end: target })])],
      attempts: emptyAttempts,
      project: mkProject(),
      target,
      timeZone,
    })
    expect(plan.schedules[0]!.minutes_budget).toBe(60)
  })

  it('tightens the budget by the capacity factor', () => {
    const plan = buildDayPlan({
      queueItems: [mkItem({ intervention_id: 'iv-1', objective_id: 'obj-1' })],
      schedules: [mkSchedule('sch-1', [mkPhase({ effort_minutes: 200, end: target })])],
      attempts: emptyAttempts,
      project: mkProject(),
      target,
      timeZone,
      capacity: { factor: 0.5 },
    })
    expect(plan.schedules[0]!.minutes_budget).toBe(100)
    expect(plan.schedules[0]!.minutes_budget_nominal).toBe(200)
  })

  it('places an event with a routed title, subject, and times', () => {
    const plan = buildDayPlan({
      queueItems: [mkItem({ intervention_id: 'iv-1', objective_id: 'obj-1' })],
      schedules: [mkSchedule('sch-1', [mkPhase({})])],
      attempts: emptyAttempts,
      project: mkProject(),
      target,
      timeZone,
    })
    const event = plan.schedules[0]!.events[0]!
    expect(event.routing).toBe('sole-covering-schedule')
    expect(event.id).toBe('dp-2026-07-01-01-evidence_probe')
    expect(event.subject_id).toBe('track-math')
    expect(event.start).toBe('2026-07-01T19:00:00+00:00')
    expect(event.end).toBe('2026-07-01T19:30:00+00:00')
    expect(event.duration_minutes).toBe(30)
  })

  it('routes to the schedule matching the objective by shared token', () => {
    const plan = buildDayPlan({
      queueItems: [mkItem({ intervention_id: 'iv-1', objective_id: 'lin-algebra-objective' })],
      schedules: [
        mkSchedule('linear-algebra', [mkPhase({})]),
        mkSchedule('probability', [mkPhase({})]),
      ],
      attempts: emptyAttempts,
      project: mkProject(),
      target,
      timeZone,
    })
    expect(plan.schedules[0]!.events[0]!.routing).toBe('objective-token-match')
    expect(plan.schedules[0]!.schedule_id).toBe('linear-algebra')
  })

  it('falls back to the first covering schedule on a token tie', () => {
    const plan = buildDayPlan({
      queueItems: [mkItem({ intervention_id: 'iv-1', objective_id: 'linear-algebra-objective' })],
      schedules: [
        mkSchedule('algebra-lin', [mkPhase({})]),
        mkSchedule('algebra-prob', [mkPhase({})]),
      ],
      attempts: emptyAttempts,
      project: mkProject(),
      target,
      timeZone,
    })
    expect(plan.schedules[0]!.events[0]!.routing).toBe('fallback-first-covering-schedule')
    expect(plan.schedules[0]!.schedule_id).toBe('algebra-lin')
  })

  it('uses the phase subject list and the project domain as fallbacks', () => {
    const withSubject = buildDayPlan({
      queueItems: [mkItem({ intervention_id: 'iv-1', objective_id: 'obj-1' })],
      schedules: [mkSchedule('sch-1', [mkPhase({ subject_ids: ['ph-subject'] })])],
      attempts: emptyAttempts,
      project: mkProject(),
      target,
      timeZone,
    })
    expect(withSubject.schedules[0]!.events[0]!.subject_id).toBe('ph-subject')

    const noTrack = buildDayPlan({
      queueItems: [mkItem({ intervention_id: 'iv-1', objective_id: 'obj-1' })],
      schedules: [mkSchedule('sch-1', [mkPhase({})])],
      attempts: emptyAttempts,
      project: mkProject({ tracks: [] }),
      target,
      timeZone,
    })
    expect(noTrack.schedules[0]!.events[0]!.subject_id).toBe('math')

    const noDomain = buildDayPlan({
      queueItems: [mkItem({ intervention_id: 'iv-1', objective_id: 'obj-1' })],
      schedules: [mkSchedule('sch-1', [mkPhase({})])],
      attempts: emptyAttempts,
      project: mkProject({ tracks: [], domain: '' }),
      target,
      timeZone,
    })
    expect(noDomain.schedules[0]!.events[0]!.subject_id).toBe('general')
  })

  it('truncates an over-long capability in the event title', () => {
    const long = 'x'.repeat(80)
    const plan = buildDayPlan({
      queueItems: [mkItem({ intervention_id: 'iv-1', objective_id: 'obj-1', capability: long })],
      schedules: [mkSchedule('sch-1', [mkPhase({})])],
      attempts: emptyAttempts,
      project: mkProject(),
      target,
      timeZone,
    })
    const title = plan.schedules[0]!.events[0]!.title
    expect(title.endsWith('…')).toBe(true)
    expect(title).toBe(`evidence probe: ${'x'.repeat(59)}…`)
  })

  it('rejects items with a missing or non-positive duration', () => {
    const plan = buildDayPlan({
      queueItems: [
        mkItem({
          intervention_id: 'iv-1',
          objective_id: 'obj-1',
          recommended_activity: { ...mkItem({ intervention_id: 'iv-1', objective_id: 'obj-1' }).recommended_activity, duration_minutes: 0 },
        }),
      ],
      schedules: [mkSchedule('sch-1', [mkPhase({})])],
      attempts: emptyAttempts,
      project: mkProject(),
      target,
      timeZone,
    })
    expect(plan.unplaced).toEqual([
      { intervention_id: 'iv-1', reason: 'recommended_activity.duration_minutes is missing or not positive' },
    ])
  })

  it('marks an item unplaced when it exceeds the phase budget', () => {
    const plan = buildDayPlan({
      queueItems: [
        mkItem({ intervention_id: 'iv-1', objective_id: 'obj-1' }),
        mkItem({ intervention_id: 'iv-2', objective_id: 'obj-1' }),
      ],
      schedules: [mkSchedule('sch-1', [mkPhase({ effort_minutes: 40, end: target })])],
      attempts: emptyAttempts,
      project: mkProject(),
      target,
      timeZone,
    })
    expect(plan.schedules[0]!.events.length).toBe(1)
    expect(plan.unplaced).toEqual([
      { intervention_id: 'iv-2', reason: 'exceeds the 40 minute daily budget of phase ph-1 in sch-1' },
    ])
  })

  it('marks an item unplaced when it does not fit in the study window', () => {
    const plan = buildDayPlan({
      queueItems: [
        mkItem({ intervention_id: 'iv-1', objective_id: 'obj-1', recommended_activity: { ...mkItem({ intervention_id: 'iv-1', objective_id: 'obj-1' }).recommended_activity, duration_minutes: 500 } }),
      ],
      schedules: [mkSchedule('sch-1', [mkPhase({})])],
      attempts: emptyAttempts,
      project: mkProject(),
      target,
      timeZone,
    })
    expect(plan.unplaced.length).toBe(1)
    expect(plan.unplaced[0]!.reason).toContain('does not fit between')
  })

  it('anchors the cursor at the rounded-up now when generating today', () => {
    const plan = buildDayPlan({
      queueItems: [mkItem({ intervention_id: 'iv-1', objective_id: 'obj-1' })],
      schedules: [mkSchedule('sch-1', [mkPhase({})])],
      attempts: emptyAttempts,
      project: mkProject(),
      target,
      timeZone,
      now: new Date('2026-07-01T19:12:00Z'),
    })
    expect(plan.schedules[0]!.events[0]!.start).toBe('2026-07-01T19:15:00+00:00')
  })

  it('keeps the day start when now is not today', () => {
    const plan = buildDayPlan({
      queueItems: [mkItem({ intervention_id: 'iv-1', objective_id: 'obj-1' })],
      schedules: [mkSchedule('sch-1', [mkPhase({})])],
      attempts: emptyAttempts,
      project: mkProject(),
      target,
      timeZone,
      now: new Date('2026-06-30T12:00:00Z'),
    })
    expect(plan.schedules[0]!.events[0]!.start).toBe('2026-07-01T19:00:00+00:00')
  })

  it('derives a fractional coverage above half', () => {
    const attempts = [
      ...Array.from({ length: 14 }, (_, i) => mkAttempt(7, `a-${i}`)),
      ...Array.from({ length: 4 }, (_, i) => mkAttempt(0, `b-${i}`)),
    ]
    const window = studyWindow(attempts, timeZone)
    expect(window.source).toBe('evidence')
    expect(window.coverage).toBe(0.778)
  })

  it('skips attempts with empty and invalid timestamps', () => {
    const attempts = [
      { ...mkAttempt(7, 'a-1'), occurred_at: '' },
      { ...mkAttempt(7, 'a-2'), occurred_at: '2026-13-99T99:00:00Z' },
    ]
    expect(studyWindow(attempts, timeZone).sample_size).toBe(0)
  })

  it('rejects a malformed target in activePhase', () => {
    expect(activePhase(mkSchedule('sch-1', [mkPhase({})]), 'not-a-date')).toBeNull()
  })

  it('returns null when a schedule has no phases array', () => {
    expect(activePhase({ schema_version: 'study_schedule.v1', schedule_id: 's' } as StudyData, target)).toBeNull()
  })

  it('skips phases with malformed dates', () => {
    const schedule = mkSchedule('sch-1', [mkPhase({ start: undefined, end: undefined })])
    expect(activePhase(schedule, target)).toBeNull()
  })

  it('falls back to no budget when effort is invalid', () => {
    const plan = buildDayPlan({
      queueItems: [mkItem({ intervention_id: 'iv-1', objective_id: 'obj-1' })],
      schedules: [mkSchedule('sch-1', [mkPhase({ effort_minutes: 0 })])],
      attempts: [],
      project: mkProject(),
      target, timeZone,
    })
    expect(plan.schedules[0]!.minutes_budget).toBe(300)
    expect(plan.schedules[0]!.minutes_budget_nominal).toBe(300)
  })

  it('routes the first covering schedule when tokens are absent or numeric', () => {
    const item = mkItem({ intervention_id: 'iv-1', objective_id: '408' })
    const other = mkItem({ intervention_id: 'iv-2', objective_id: 'ab' })
    const plan = buildDayPlan({
      queueItems: [item, other],
      schedules: [mkSchedule('sch-first', [mkPhase({})]), mkSchedule('sch-second', [mkPhase({})])],
      attempts: [],
      project: mkProject(),
      target, timeZone,
    })
    // '408' and 'ab' yield no discriminative tokens -> fallback to first schedule
    expect(plan.schedules[0]!.events[0]!.routing).toBe('fallback-first-covering-schedule')
  })

  it('uses a statusless title when the capability is empty', () => {
    const plan = buildDayPlan({
      queueItems: [mkItem({ intervention_id: 'iv-1', objective_id: 'obj-1', capability: '' })],
      schedules: [mkSchedule('sch-1', [mkPhase({})])],
      attempts: [],
      project: mkProject(),
      target, timeZone,
    })
    expect(plan.schedules[0]!.events[0]!.title).toBe('evidence probe')
  })

  it('anchors at the exact minute when now is on the dot', () => {
    const plan = buildDayPlan({
      queueItems: [mkItem({ intervention_id: 'iv-1', objective_id: 'obj-1' })],
      schedules: [mkSchedule('sch-1', [mkPhase({})])],
      attempts: [],
      project: mkProject(),
      target, timeZone,
      now: new Date('2026-07-01T19:15:00Z'),
    })
    expect(plan.schedules[0]!.events[0]!.start).toBe('2026-07-01T19:15:00+00:00')
  })

  it('uses the fallback goal when reasons and criteria are empty', () => {
    const plan = buildDayPlan({
      queueItems: [mkItem({ intervention_id: 'iv-1', objective_id: 'obj-1', reasons: [], recommended_activity: { ...mkItem({ intervention_id: 'iv-1', objective_id: 'obj-1' }).recommended_activity, success_criteria: [] } })],
      schedules: [mkSchedule('sch-1', [mkPhase({ id: undefined, goal: undefined })])],
      attempts: [],
      project: mkProject(),
      target, timeZone,
    })
    expect(plan.schedules[0]!.events[0]!.goals).toEqual(['Produce evaluator-provenanced evidence.'])
  })

  it('tracks a schedule missing its id and title', () => {
    const plan = buildDayPlan({
      queueItems: [mkItem({ intervention_id: 'iv-1', objective_id: 'obj-1' })],
      schedules: [{ phases: [mkPhase({})], events: [] } as StudyData],
      attempts: [],
      project: mkProject(),
      target, timeZone,
    })
    expect(plan.schedules[0]!.schedule_id).toBe('')
    expect(plan.schedules[0]!.schedule_title).toBe('')
  })

  it('rejects a non-integer duration_minutes', () => {
    const plan = buildDayPlan({
      queueItems: [mkItem({ intervention_id: 'iv-1', objective_id: 'obj-1', recommended_activity: { ...mkItem({ intervention_id: 'iv-1', objective_id: 'obj-1' }).recommended_activity, duration_minutes: 30.5 } })],
      schedules: [mkSchedule('sch-1', [mkPhase({})])],
      attempts: [],
      project: mkProject(),
      target, timeZone,
    })
    expect(plan.unplaced).toEqual([{ intervention_id: 'iv-1', reason: 'recommended_activity.duration_minutes is missing or not positive' }])
  })

  it('keeps the first shortest span when a later start spans longer', () => {
    // 5 at hour 0, 9 at hour 2, 6 at hour 10: total 20, needed 14. start=0 spans
    // 3 (hours 0..2), later starts span longer, so the shorter span wins.
    const attempts = [
      ...Array.from({ length: 5 }, (_, i) => mkAttempt(0, `a-${i}`)),
      ...Array.from({ length: 9 }, (_, i) => mkAttempt(2, `b-${i}`)),
      ...Array.from({ length: 6 }, (_, i) => mkAttempt(10, `c-${i}`)),
    ]
    const window = studyWindow(attempts, timeZone)
    expect(window.source).toBe('evidence')
    expect(window.start_hour).toBe(0)
    expect(window.end_hour).toBe(2)
    expect(window.coverage).toBe(0.7)
  })

  it('prefers the phase subject list over an empty list', () => {
    const plan = buildDayPlan({
      queueItems: [mkItem({ intervention_id: 'iv-1', objective_id: 'obj-1' })],
      schedules: [mkSchedule('sch-1', [mkPhase({ subject_ids: [''] })])],
      attempts: [],
      project: mkProject({ tracks: [{ id: '' }, { id: 'second-track' }] }),
      target, timeZone,
    })
    expect(plan.schedules[0]!.events[0]!.subject_id).toBe('second-track')
  })

  it('skips non-object phases in activePhase', () => {
    expect(activePhase(mkSchedule('sch-1', [null, 'str'] as unknown as Array<Record<string, unknown>>), target)).toBeNull()
  })

  it('uses a nullish phase subject as an empty fallback', () => {
    const plan = buildDayPlan({
      queueItems: [mkItem({ intervention_id: 'iv-1', objective_id: 'obj-1' })],
      schedules: [mkSchedule('sch-1', [mkPhase({ subject_ids: [undefined] })])],
      attempts: [],
      project: mkProject({ tracks: [null, {}, { id: 'after-null' }] }),
      target, timeZone,
    })
    // subjects[0] is nullish -> falls through to the tracks, first null track skipped,
    // second track has no id, third track has an id.
    expect(plan.schedules[0]!.events[0]!.subject_id).toBe('after-null')
  })

  it('falls back to domain when tracks is not an array (v1 project)', () => {
    const v1 = mkProject({ schema_version: 'study_project.v1', tracks: undefined } as Partial<StudyProject> & { schema_version: 'study_project.v1' })
    const plan = buildDayPlan({
      queueItems: [mkItem({ intervention_id: 'iv-1', objective_id: 'obj-1' })],
      schedules: [mkSchedule('sch-1', [mkPhase({})])],
      attempts: [],
      project: v1,
      target, timeZone,
    })
    expect(plan.schedules[0]!.events[0]!.subject_id).toBe('math')
  })

  it('skips schedules whose phases do not cover the target', () => {
    const plan = buildDayPlan({
      queueItems: [mkItem({ intervention_id: 'iv-1', objective_id: 'obj-1' })],
      schedules: [mkSchedule('sch-1', [mkPhase({ start: '2026-01-01', end: '2026-01-31' })])],
      attempts: [],
      project: mkProject(),
      target, timeZone,
    })
    expect(plan.unplaced).toEqual([{ intervention_id: 'iv-1', reason: 'no Schedule phase covers the target date' }])
  })

  it('keeps the window start when now is earlier than it', () => {
    const plan = buildDayPlan({
      queueItems: [mkItem({ intervention_id: 'iv-1', objective_id: 'obj-1' })],
      schedules: [mkSchedule('sch-1', [mkPhase({})])],
      attempts: [],
      project: mkProject(),
      target, timeZone,
      now: new Date('2026-07-01T18:00:00Z'),
    })
    expect(plan.schedules[0]!.events[0]!.start).toBe('2026-07-01T19:00:00+00:00')
  })

  it('prefers a shorter covering span and an earlier start on a tie', () => {
    // Two hours of 6 attempts each at hour 2 and hour 10; a span covering 70%
    // (8.4) requires both, but the shortest single-hour span that reaches it is
    // anchored at each hour. This exercises the span-length and start tiebreak.
    const attempts = [
      ...Array.from({ length: 8 }, (_, i) => mkAttempt(2, `a-${i}`)),
      ...Array.from({ length: 8 }, (_, i) => mkAttempt(10, `b-${i}`)),
    ]
    const window = studyWindow(attempts, timeZone)
    expect(window.source).toBe('evidence')
    expect(window.coverage).toBe(1)
  })
})
