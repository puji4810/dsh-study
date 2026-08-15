import { describe, expect, it } from 'vitest'
import { InterventionOrchestrator, parseAsOf } from '../src/interventions.ts'
import type { Diagnosis, StudyAttempt, StudyData, StudyProject } from '../src/types.ts'
import type { VerificationStatus } from '../src/constants.ts'

function mkAttempt(partial: Partial<StudyAttempt> & { attempt_id: string }): StudyAttempt {
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

function mkProject(partial: Partial<StudyProject> & { schema_version: 'study_project.v1' | 'study_project.v2' }): StudyProject {
  const base = {
    project_id: 'proj-1',
    title: 'Math study',
    domain: 'math',
    timezone: 'UTC',
    phase: 'active',
    domain_pack: 'general.v1',
    prompt_policy: {
      base_max_chars: 2000,
      intent_max_chars: 2500,
      domain_max_chars: 2000,
      project_summary_max_chars: 1200,
      total_max_chars: 6000,
      total_max_tokens: 1800,
      updates_apply: 'next_session' as const,
    },
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
  }
  if (partial.schema_version === 'study_project.v1') {
    return {
      ...base,
      exam_type: 'exam',
      exam_date: '2026-08-30',
      subjects: [{ id: 'subj-1', label: 'S' }],
      ...partial,
    } as StudyProject
  }
  return {
    ...base,
    workspace_type: 'dir',
    artifact_policy: 'keep',
    deadline: '2026-08-30',
    tracks: [{ id: 'track-1', label: 'T' }],
    objectives: [
      {
        objective_id: 'obj-1',
        capability: 'Solve the thing',
        success_criteria: ['Produce evidence.'],
        evidence_targets: ['recall', 'recognition'],
      },
    ],
    ...partial,
  } as StudyProject
}

/** A diagnosis that pins one dimension to a status, optionally with clusters. */
function diagnosisFor(
  dimension: string,
  verificationStatus: string,
  options: { clusters?: Array<{ kind: string; concept: string; count: number; evidence_attempt_ids: string[] }>; evidenceIds?: string[] } = {},
): Diagnosis {
  return {
    attempt_count: 1,
    average_score: 0,
    concepts: [],
    diagnosis_clusters: options.clusters ?? [],
    transfer_evidence: {},
    evidence_dimensions: {
      [dimension]: {
        status: 'observed',
        verification_status: verificationStatus as VerificationStatus,
        attempt_count: 1,
        average_score: 0,
        evidence_attempt_ids: options.evidenceIds ?? [],
        independently_verified_attempt_ids: [],
        assistance_provenance: {},
        evaluator_provenance: {},
      },
    },
    score_delta_earlier_to_later: null,
  }
}

const asOf = new Date('2026-07-01T12:00:00Z')

describe('parseAsOf', () => {
  it('returns now when no value is given', () => {
    const before = Date.now()
    const result = parseAsOf(undefined)
    expect(result.getTime()).toBeGreaterThanOrEqual(before - 1000)
  })

  it('throws for a non-string value', () => {
    expect(() => parseAsOf(42)).toThrow('as_of must be an ISO datetime with timezone offset')
    expect(() => parseAsOf('   ')).toThrow('as_of must be an ISO datetime with timezone offset')
  })

  it('throws for a malformed timestamp', () => {
    expect(() => parseAsOf('not-a-date')).toThrow('as_of must be a valid ISO datetime with timezone offset')
  })

  it('throws for a naive timestamp', () => {
    expect(() => parseAsOf('2026-07-01T12:00:00')).toThrow('as_of must include a timezone offset')
  })

  it('accepts a Z or offset timestamp', () => {
    expect(parseAsOf('2026-07-01T12:00:00Z').getTime()).toBe(new Date('2026-07-01T12:00:00Z').getTime())
    expect(parseAsOf('2026-07-01T12:00:00+08:00').getTime()).toBe(new Date('2026-07-01T04:00:00Z').getTime())
  })
})

describe('InterventionOrchestrator', () => {
  it('derives an evidence_probe for an unobserved dimension', () => {
    const orchestrator = new InterventionOrchestrator({
      project: mkProject({ schema_version: 'study_project.v2' }),
      diagnosisBuilder: () => diagnosisFor('recall', 'unobserved'),
    })
    const { queue, proposal } = orchestrator.build({
      attempts: [],
      asOf,
    })
    expect(queue.items.length).toBe(1)
    const item = queue.items[0]!
    expect(item.kind).toBe('evidence_probe')
    expect(item.evidence_dimension).toBe('recall')
    expect(item.reason_factors.verification_status).toBe('unobserved')
    expect(item.reason_factors.evidence_age_band).toBe('unobserved')
    expect(item.reason_factors.deadline_band).toBe('approaching')
    expect(item.priority_score).toBe(76)
    expect(item.reasons).toEqual(['No evaluator-provenanced recall evidence has been recorded.'])
    expect(queue.deadline).toBe('2026-08-30')
    expect(queue.days_to_deadline).toBe(60)
    expect(proposal).not.toBeNull()
    expect(proposal!.status).toBe('proposed')
    expect(proposal!.proposal_id.startsWith('plan-')).toBe(true)
  })

  it('derives a retention_probe for an independent stale dimension', () => {
    const orchestrator = new InterventionOrchestrator({
      project: mkProject({ schema_version: 'study_project.v2', objectives: [{ objective_id: 'obj-1', capability: 'C', success_criteria: ['x'], evidence_targets: ['recall'] }] }),
      diagnosisBuilder: () => diagnosisFor('recall', 'independent', { evidenceIds: ['at-1'] }),
    })
    const { queue } = orchestrator.build({
      attempts: [mkAttempt({ attempt_id: 'at-1', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-05-01T12:00:00Z' })],
      asOf,
    })
    const item = queue.items[0]!
    expect(item.kind).toBe('retention_probe')
    expect(item.reason_factors.verification_status).toBe('independent')
    expect(item.reason_factors.evidence_age_band).toBe('stale')
    expect(item.reasons.join(' ')).toContain('Independent recall evidence is')
  })

  it('derives an independence_probe for a supported dimension', () => {
    const orchestrator = new InterventionOrchestrator({
      project: mkProject({ schema_version: 'study_project.v2' }),
      diagnosisBuilder: () => diagnosisFor('recall', 'supported'),
    })
    const { queue } = orchestrator.build({ attempts: [], asOf })
    expect(queue.items[0]!.kind).toBe('independence_probe')
    expect(queue.items[0]!.recommended_activity.assistance_level).toBe('independent')
  })

  it('derives a prerequisite_repair for a concept_confusion cluster', () => {
    const orchestrator = new InterventionOrchestrator({
      project: mkProject({ schema_version: 'study_project.v2' }),
      diagnosisBuilder: () =>
        diagnosisFor('recall', 'developing', {
          clusters: [{ kind: 'concept_confusion', concept: 'c', count: 2, evidence_attempt_ids: ['at-1'] }],
        }),
    })
    const { queue } = orchestrator.build({ attempts: [], asOf })
    expect(queue.items[0]!.kind).toBe('prerequisite_repair')
  })

  it('derives a misconception_probe for a non-confusion repeated cluster', () => {
    const orchestrator = new InterventionOrchestrator({
      project: mkProject({ schema_version: 'study_project.v2' }),
      diagnosisBuilder: () =>
        diagnosisFor('recall', 'developing', {
          clusters: [{ kind: 'condition_missed', concept: 'c', count: 3, evidence_attempt_ids: ['at-1'] }],
        }),
    })
    const { queue } = orchestrator.build({ attempts: [], asOf })
    expect(queue.items[0]!.kind).toBe('misconception_probe')
  })

  it('derives a guided_repair for a plain developing dimension', () => {
    const orchestrator = new InterventionOrchestrator({
      project: mkProject({ schema_version: 'study_project.v2' }),
      diagnosisBuilder: () => diagnosisFor('recall', 'developing'),
    })
    const { queue } = orchestrator.build({ attempts: [], asOf })
    expect(queue.items[0]!.kind).toBe('guided_repair')
  })

  it('derives near/far transfer probes', () => {
    const near = new InterventionOrchestrator({
      project: mkProject({ schema_version: 'study_project.v2', objectives: [{ objective_id: 'obj-1', capability: 'C', success_criteria: ['x'], evidence_targets: ['near_transfer'] }] }),
      diagnosisBuilder: () => diagnosisFor('near_transfer', 'unobserved'),
    })
    expect(near.build({ attempts: [], asOf }).queue.items[0]!.kind).toBe('near_transfer_probe')

    const far = new InterventionOrchestrator({
      project: mkProject({ schema_version: 'study_project.v2', objectives: [{ objective_id: 'obj-1', capability: 'C', success_criteria: ['x'], evidence_targets: ['far_transfer'] }] }),
      diagnosisBuilder: () => diagnosisFor('far_transfer', 'unobserved'),
    })
    expect(far.build({ attempts: [], asOf }).queue.items[0]!.kind).toBe('far_transfer_probe')
  })

  it('applies the deadline boost for near/critical/overdue', () => {
    const mk = (deadline: string) =>
      new InterventionOrchestrator({
        project: mkProject({ schema_version: 'study_project.v2', deadline }),
        diagnosisBuilder: () => diagnosisFor('recall', 'unobserved'),
      }).build({ attempts: [], asOf }).queue.items[0]!.priority_score
    expect(mk('2026-07-20')).toBe(70 + 12) // near
    expect(mk('2026-07-02')).toBe(70 + 18) // critical
    expect(mk('2026-06-01')).toBe(70 + 20) // overdue
  })

  it('clamps the priority score into [0, 100]', () => {
    const orchestrator = new InterventionOrchestrator({
      project: mkProject({ schema_version: 'study_project.v2', deadline: '2026-06-01' }),
      diagnosisBuilder: () => diagnosisFor('recall', 'unobserved'),
    })
    const score = orchestrator.build({ attempts: [], asOf }).queue.items[0]!.priority_score
    expect(score).toBeLessThanOrEqual(100)
    expect(score).toBeGreaterThanOrEqual(0)
  })

  it('applies outcome adjustment to the score and appends a reason', () => {
    const orchestrator = new InterventionOrchestrator({
      project: mkProject({ schema_version: 'study_project.v2' }),
      diagnosisBuilder: () => diagnosisFor('recall', 'unobserved'),
    })
    const { queue } = orchestrator.build({
      attempts: [],
      asOf,
      outcomes: { by_kind: [{ kind: 'evidence_probe', acted_on: 5, verdict: 'measured', improvement_rate: 1.0 }] },
    })
    const item = queue.items[0]!
    expect(item.reason_factors.outcome_adjustment).toBe(8)
    expect(item.reason_factors.outcome_source).toBe('measured')
    expect(item.priority_score).toBe(84)
    expect(item.reasons.some(reason => reason.includes('has improved this project'))).toBe(true)
  })

  it('uses a synthetic project-readiness objective for v1 projects', () => {
    const orchestrator = new InterventionOrchestrator({
      project: mkProject({ schema_version: 'study_project.v1' }),
      diagnosisBuilder: () => diagnosisFor('recall', 'unobserved'),
    })
    const { queue } = orchestrator.build({ attempts: [], asOf })
    const item = queue.items[0]!
    expect(item.objective_id).toBe('project-readiness')
    expect(queue.deadline).toBe('2026-08-30')
  })

  it('defers objectives whose activates_on is in the future', () => {
    const project = mkProject({
      schema_version: 'study_project.v2',
      objectives: [
        { objective_id: 'obj-later', capability: 'C', success_criteria: ['x'], evidence_targets: ['recall'], activates_on: '2026-08-01' },
        { objective_id: 'obj-now', capability: 'C', success_criteria: ['x'], evidence_targets: ['recall'] },
      ],
    })
    const orchestrator = new InterventionOrchestrator({
      project,
      diagnosisBuilder: () => diagnosisFor('recall', 'unobserved'),
    })
    const { queue } = orchestrator.build({ attempts: [], asOf })
    expect(queue.deferred_objectives).toEqual(['obj-later until 2026-08-01'])
    expect(queue.warnings).toContain('Objectives not yet in scope were held back: obj-later until 2026-08-01')
    expect(queue.items[0]!.objective_id).toBe('obj-now')
  })

  it('reports unscoped attempts and their warning', () => {
    const project = mkProject({ schema_version: 'study_project.v2' })
    const orchestrator = new InterventionOrchestrator({
      project,
      diagnosisBuilder: () => diagnosisFor('recall', 'unobserved'),
    })
    const { queue } = orchestrator.build({
      attempts: [mkAttempt({ attempt_id: 'at-unscoped', objective_ids: [] })],
      asOf,
    })
    expect(queue.unscoped_attempt_ids).toEqual(['at-unscoped'])
    expect(queue.warnings).toContain('Some attempts were not attributed to a declared Objective and did not affect priority.')
  })

  it('enforces the sequential gate: a non-independent dimension truncates later dimensions', () => {
    const diagnosis: Diagnosis = {
      attempt_count: 0,
      average_score: 0,
      concepts: [],
      diagnosis_clusters: [],
      transfer_evidence: {},
      evidence_dimensions: {
        recall: { status: 'observed', verification_status: 'developing', attempt_count: 1, average_score: 0, evidence_attempt_ids: [], independently_verified_attempt_ids: [], assistance_provenance: {}, evaluator_provenance: {} },
        recognition: { status: 'observed', verification_status: 'unobserved', attempt_count: 0, average_score: null, evidence_attempt_ids: [], independently_verified_attempt_ids: [], assistance_provenance: {}, evaluator_provenance: {} },
      },
      score_delta_earlier_to_later: null,
    }
    const orchestrator = new InterventionOrchestrator({
      project: mkProject({ schema_version: 'study_project.v2' }),
      diagnosisBuilder: () => diagnosis,
    })
    const { queue } = orchestrator.build({ attempts: [], asOf })
    expect(queue.items.length).toBe(1)
    expect(queue.items[0]!.evidence_dimension).toBe('recall')
  })

  it('validates max_items range', () => {
    const orchestrator = new InterventionOrchestrator({
      project: mkProject({ schema_version: 'study_project.v2' }),
      diagnosisBuilder: () => diagnosisFor('recall', 'unobserved'),
    })
    expect(() => orchestrator.build({ attempts: [], asOf, maxItems: 0 })).toThrow('max_items must be an integer from 1 to 20')
    expect(() => orchestrator.build({ attempts: [], asOf, maxItems: 21 })).toThrow('max_items must be an integer from 1 to 20')
    expect(() => orchestrator.build({ attempts: [], asOf, maxItems: 1.5 })).toThrow('max_items must be an integer from 1 to 20')
  })

  it('throws for an invalid project timezone', () => {
    const orchestrator = new InterventionOrchestrator({
      project: mkProject({ schema_version: 'study_project.v2', timezone: 'Not/AZone' }),
      diagnosisBuilder: () => diagnosisFor('recall', 'unobserved'),
    })
    expect(() => orchestrator.build({ attempts: [], asOf })).toThrow('project timezone is not a valid IANA timezone:')
  })

  it('returns no day plan or proposal when there are no items', () => {
    const orchestrator = new InterventionOrchestrator({
      project: mkProject({
        schema_version: 'study_project.v2',
        objectives: [{ objective_id: 'obj-1', capability: 'C', success_criteria: ['x'], evidence_targets: ['recall'] }],
      }),
      diagnosisBuilder: () => diagnosisFor('recall', 'independent', { evidenceIds: [] }),
    })
    const result = orchestrator.build({ attempts: [], asOf })
    expect(result.queue.items.length).toBe(0)
    expect(result.dayPlan).toBeNull()
    expect(result.proposal).toBeNull()
  })

  it('produces a stable fingerprint for identical semantics', () => {
    const orchestrator = new InterventionOrchestrator({
      project: mkProject({ schema_version: 'study_project.v2' }),
      diagnosisBuilder: () => diagnosisFor('recall', 'unobserved'),
    })
    const one = orchestrator.build({ attempts: [], asOf })
    const two = orchestrator.build({ attempts: [], asOf })
    expect(one.proposal!.generation_fingerprint).toBe(two.proposal!.generation_fingerprint)
    expect(one.proposal!.proposal_id).toBe(two.proposal!.proposal_id)
  })

  it('includes day-plan events in the fingerprint when something is placed', () => {
    const orchestrator = new InterventionOrchestrator({
      project: mkProject({ schema_version: 'study_project.v2' }),
      diagnosisBuilder: () => diagnosisFor('recall', 'unobserved'),
    })
    const withSchedule = orchestrator.build({
      attempts: [],
      asOf,
      schedules: [
        {
          schema_version: 'study_schedule.v1',
          schedule_id: 'sch-1',
          title: 'S',
          timezone: 'UTC',
          range: { start: '2026-06-01', end: '2026-07-31' },
          phases: [{ id: 'ph-1', title: 'P', start: '2026-06-01', end: '2026-07-31', goal: 'g' }],
          events: [],
        } as StudyData,
      ],
    })
    const withoutSchedule = orchestrator.build({ attempts: [], asOf })
    expect(withSchedule.proposal!.generation_fingerprint).not.toBe(withoutSchedule.proposal!.generation_fingerprint)
    expect(withSchedule.dayPlan).not.toBeNull()
    expect(withoutSchedule.dayPlan).not.toBeNull()
    expect(withoutSchedule.dayPlan!.schedules).toEqual([])
  })

  it('rounds derived durations into the recommended activity', () => {
    const orchestrator = new InterventionOrchestrator({
      project: mkProject({ schema_version: 'study_project.v2' }),
      diagnosisBuilder: () => diagnosisFor('recall', 'unobserved'),
    })
    const { queue } = orchestrator.build({ attempts: [], asOf })
    expect(queue.items[0]!.recommended_activity.duration_minutes).toBe(30)
    expect(queue.items[0]!.recommended_activity.duration_source).toBe('domain-pack-default')
  })

  it('resolves domain-pack durations by exact id, family, unknown, and empty', () => {
    const mk = (project: StudyProject) =>
      new InterventionOrchestrator({ project, diagnosisBuilder: () => diagnosisFor('recall', 'unobserved') })
        .build({ attempts: [], asOf }).queue.items[0]!.recommended_activity.duration_minutes
    expect(mk(mkProject({ schema_version: 'study_project.v2', domain_pack: 'engineering.v1' }))).toBe(45)
    expect(mk(mkProject({ schema_version: 'study_project.v2', domain_pack: 'research.v1' }))).toBe(60)
    expect(mk(mkProject({ schema_version: 'study_project.v2', domain_pack: 'engineering' }))).toBe(45)
    expect(mk(mkProject({ schema_version: 'study_project.v2', domain_pack: 'foo.bar' }))).toBe(30)
    expect(mk(mkProject({ schema_version: 'study_project.v2', domain_pack: '', domain: 'kaoyan' }))).toBe(30)
    expect(mk(mkProject({ schema_version: 'study_project.v2', domain_pack: '', domain: '' }))).toBe(30)
    expect(mk(mkProject({ schema_version: 'study_project.v2', domain_pack: '', domain: 'foo' }))).toBe(30)
  })

  it('handles a deadline of none and distant', () => {
    const noDeadline = new InterventionOrchestrator({
      project: mkProject({ schema_version: 'study_project.v2', deadline: undefined } as unknown as Partial<StudyProject> & { schema_version: 'study_project.v2' }),
      diagnosisBuilder: () => diagnosisFor('recall', 'unobserved'),
    }).build({ attempts: [], asOf }).queue
    expect(noDeadline.deadline).toBeNull()
    expect(noDeadline.days_to_deadline).toBeNull()
    expect(noDeadline.items[0]!.reason_factors.deadline_band).toBe('none')

    const distant = new InterventionOrchestrator({
      project: mkProject({ schema_version: 'study_project.v2', deadline: '2026-12-31' }),
      diagnosisBuilder: () => diagnosisFor('recall', 'unobserved'),
    }).build({ attempts: [], asOf }).queue
    expect(distant.items[0]!.reason_factors.deadline_band).toBe('distant')
    expect(distant.items[0]!.priority_score).toBe(70)
  })

  it('handles an invalid deadline string', () => {
    const q = new InterventionOrchestrator({
      project: mkProject({ schema_version: 'study_project.v2', deadline: '2026-13-99' }),
      diagnosisBuilder: () => diagnosisFor('recall', 'unobserved'),
    }).build({ attempts: [], asOf }).queue
    expect(q.deadline).toBeNull()
  })

  it('computes fresh and aging evidence age bands', () => {
    const mk = (occurredAt: string) =>
      new InterventionOrchestrator({
        project: mkProject({ schema_version: 'study_project.v2', objectives: [{ objective_id: 'obj-1', capability: 'C', success_criteria: ['x'], evidence_targets: ['recall'] }] }),
        diagnosisBuilder: () => diagnosisFor('recall', 'supported', { evidenceIds: ['at-1'] }),
      }).build({
        attempts: [mkAttempt({ attempt_id: 'at-1', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: occurredAt })],
        asOf,
      }).queue.items[0]!.reason_factors

    // recall threshold 14: fresh is <= 7 days, aging <= 14, stale > 14.
    expect(mk('2026-07-01T12:00:00Z').evidence_age_band).toBe('fresh')
    expect(mk('2026-06-20T12:00:00Z').evidence_age_band).toBe('aging')
    expect(mk('2026-05-01T12:00:00Z').evidence_age_band).toBe('stale')
  })

  it('assigns a low and medium priority band', () => {
    const stale = new InterventionOrchestrator({
      project: mkProject({ schema_version: 'study_project.v2', deadline: undefined, objectives: [{ objective_id: 'obj-1', capability: 'C', success_criteria: ['x'], evidence_targets: ['recall'] }] } as unknown as Partial<StudyProject> & { schema_version: 'study_project.v2' }),
      diagnosisBuilder: () => diagnosisFor('recall', 'independent', { evidenceIds: ['at-1'] }),
    }).build({
      attempts: [mkAttempt({ attempt_id: 'at-1', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-05-01T12:00:00Z' })],
      asOf,
    }).queue.items[0]!
    expect(stale.priority_band).toBe('low')
    expect(stale.priority_score).toBe(52)

    const medium = new InterventionOrchestrator({
      project: mkProject({ schema_version: 'study_project.v2', deadline: '2026-12-31', objectives: [{ objective_id: 'obj-1', capability: 'C', success_criteria: ['x'], evidence_targets: ['recall'] }] }),
      diagnosisBuilder: () => diagnosisFor('recall', 'supported'),
    }).build({ attempts: [], asOf }).queue.items[0]!
    expect(medium.priority_band).toBe('medium')
  })

  it('ignores a malformed activates_on', () => {
    const project = mkProject({
      schema_version: 'study_project.v2',
      objectives: [{ objective_id: 'obj-1', capability: 'C', success_criteria: ['x'], evidence_targets: ['recall'], activates_on: 'garbage' }],
    })
    const { queue } = new InterventionOrchestrator({
      project,
      diagnosisBuilder: () => diagnosisFor('recall', 'unobserved'),
    }).build({ attempts: [], asOf })
    expect(queue.deferred_objectives).toEqual([])
    expect(queue.items[0]!.objective_id).toBe('obj-1')
  })

  it('reports attempts pointing at undeclared objectives as unscoped', () => {
    const project = mkProject({ schema_version: 'study_project.v2' })
    const { queue } = new InterventionOrchestrator({
      project,
      diagnosisBuilder: () => diagnosisFor('recall', 'unobserved'),
    }).build({
      attempts: [mkAttempt({ attempt_id: 'at-x', objective_ids: ['not-declared'] })],
      asOf,
    })
    expect(queue.unscoped_attempt_ids).toEqual(['at-x'])
  })

  it('appends the overdue and repeated-cluster reasons', () => {
    const { queue } = new InterventionOrchestrator({
      project: mkProject({
        schema_version: 'study_project.v2',
        deadline: '2026-06-01',
        objectives: [{ objective_id: 'obj-1', capability: 'C', success_criteria: ['x'], evidence_targets: ['recall'] }],
      }),
      diagnosisBuilder: () =>
        diagnosisFor('recall', 'developing', {
          clusters: [{ kind: 'concept_confusion', concept: 'c', count: 2, evidence_attempt_ids: ['at-1'] }],
        }),
    }).build({ attempts: [], asOf })
    const item = queue.items[0]!
    expect(item.reasons.join(' ')).toContain('The project deadline is overdue.')
    expect(item.reasons.join(' ')).toContain('concept_confusion repeated 2 times.')
  })

  it('appends the days-remain reason for a near deadline', () => {
    const { queue } = new InterventionOrchestrator({
      project: mkProject({ schema_version: 'study_project.v2', deadline: '2026-07-20' }),
      diagnosisBuilder: () => diagnosisFor('recall', 'unobserved'),
    }).build({ attempts: [], asOf })
    expect(queue.items[0]!.reasons.join(' ')).toContain('Only 19 days remain before the project deadline.')
  })

  it('orders multiple targets and multiple objectives', () => {
    const multiObjective: Diagnosis = {
      attempt_count: 0,
      average_score: 0,
      concepts: [],
      diagnosis_clusters: [],
      transfer_evidence: {},
      evidence_dimensions: {
        recall: { status: 'observed', verification_status: 'unobserved', attempt_count: 0, average_score: null, evidence_attempt_ids: [], independently_verified_attempt_ids: [], assistance_provenance: {}, evaluator_provenance: {} },
        recognition: { status: 'observed', verification_status: 'unobserved', attempt_count: 0, average_score: null, evidence_attempt_ids: [], independently_verified_attempt_ids: [], assistance_provenance: {}, evaluator_provenance: {} },
      },
      score_delta_earlier_to_later: null,
    }
    const project = mkProject({
      schema_version: 'study_project.v2',
      objectives: [
        { objective_id: 'aa-obj', capability: 'C', success_criteria: ['x'], evidence_targets: ['recall'] },
        { objective_id: 'bb-obj', capability: 'C', success_criteria: ['x'], evidence_targets: ['recall'] },
      ],
    })
    const { queue } = new InterventionOrchestrator({
      project,
      diagnosisBuilder: () => multiObjective,
    }).build({ attempts: [], asOf })
    expect(queue.items.length).toBe(2)
  })

  it('orders equal-score targets by target index', () => {
    const independentStale: Diagnosis = {
      attempt_count: 0,
      average_score: 0,
      concepts: [],
      diagnosis_clusters: [],
      transfer_evidence: {},
      evidence_dimensions: {
        recall: { status: 'observed', verification_status: 'independent', attempt_count: 1, average_score: 1, evidence_attempt_ids: ['at-1'], independently_verified_attempt_ids: ['at-1'], assistance_provenance: {}, evaluator_provenance: {} },
        recognition: { status: 'observed', verification_status: 'independent', attempt_count: 1, average_score: 1, evidence_attempt_ids: ['at-1'], independently_verified_attempt_ids: ['at-1'], assistance_provenance: {}, evaluator_provenance: {} },
      },
      score_delta_earlier_to_later: null,
    }
    const project = mkProject({
      schema_version: 'study_project.v2',
      objectives: [{ objective_id: 'obj-1', capability: 'C', success_criteria: ['x'], evidence_targets: ['recall', 'recognition'] }],
    })
    const { queue } = new InterventionOrchestrator({
      project,
      diagnosisBuilder: () => independentStale,
    }).build({
      attempts: [mkAttempt({ attempt_id: 'at-1', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-05-01T12:00:00Z' })],
      asOf,
    })
    // both stale-independent retention probes; score equal so targetIndex order wins.
    expect(queue.items.length).toBe(1)
    expect(queue.items[0]!.kind).toBe('retention_probe')
    expect(queue.items[0]!.evidence_dimension).toBe('recall')
  })

  it('uses the latest of several evidence timestamps and skips invalid ones', () => {
    const project = mkProject({
      schema_version: 'study_project.v2',
      objectives: [{ objective_id: 'obj-1', capability: 'C', success_criteria: ['x'], evidence_targets: ['recall'] }],
    })
    const { queue } = new InterventionOrchestrator({
      project,
      diagnosisBuilder: () => diagnosisFor('recall', 'supported', { evidenceIds: ['at-1', 'at-2', 'at-3', 'at-4'] }),
    }).build({
      attempts: [
        mkAttempt({ attempt_id: 'at-1', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-06-01T12:00:00Z' }),
        mkAttempt({ attempt_id: 'at-2', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-01T12:00:00Z' }),
        mkAttempt({ attempt_id: 'at-3', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: 'naive-timestamp' }),
        mkAttempt({ attempt_id: 'at-4', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-06-15T12:00:00Z' }),
      ],
      asOf,
    })
    expect(queue.items[0]!.latest_evidence_at).toBe('2026-07-01T12:00:00Z')
  })

  it('reports an attempt without objective ids as unscoped', () => {
    const project = mkProject({ schema_version: 'study_project.v2' })
    const { queue } = new InterventionOrchestrator({
      project,
      diagnosisBuilder: () => diagnosisFor('recall', 'unobserved'),
    }).build({
      attempts: [mkAttempt({ attempt_id: 'at-no-obj', objective_ids: undefined } as unknown as Partial<StudyAttempt> & { attempt_id: string })],
      asOf,
    })
    expect(queue.unscoped_attempt_ids).toEqual(['at-no-obj'])
  })

  it('keeps a known attempt with a declared objective out of the unscoped bucket', () => {
    const project = mkProject({ schema_version: 'study_project.v2' })
    const { queue } = new InterventionOrchestrator({
      project,
      diagnosisBuilder: () => diagnosisFor('recall', 'unobserved'),
    }).build({
      attempts: [
        mkAttempt({ attempt_id: 'at-shared', objective_ids: ['obj-1'] }),
        mkAttempt({ attempt_id: 'at-internal', objective_ids: ['obj-1', 'undeclared'] }),
      ],
      asOf,
    })
    expect(queue.unscoped_attempt_ids).toEqual([])
    expect(queue.evidence_attempt_ids).toEqual(['at-shared', 'at-internal'])
  })

  it('defaults a projection missing verification status and evidence ids', () => {
    const emptyProjection: Diagnosis = {
      attempt_count: 0,
      average_score: 0,
      concepts: [],
      diagnosis_clusters: [],
      transfer_evidence: {},
      evidence_dimensions: {},
      score_delta_earlier_to_later: null,
    }
    const { queue } = new InterventionOrchestrator({
      project: mkProject({ schema_version: 'study_project.v2' }),
      diagnosisBuilder: () => emptyProjection,
    }).build({ attempts: [], asOf })
    expect(queue.items[0]!.reason_factors.verification_status).toBe('unobserved')
  })

  it('folds a null and undefined day plan into an empty fingerprint', () => {
    const project = mkProject({ schema_version: 'study_project.v2' })
    const orchestrator = new InterventionOrchestrator({
      project,
      diagnosisBuilder: () => diagnosisFor('recall', 'unobserved'),
    })
    const items = orchestrator.build({ attempts: [], asOf, schedules: [] }).queue.items
    const viaNull = InterventionOrchestrator.fingerprint({ project, items, dayPlan: null })
    const viaUndefined = InterventionOrchestrator.fingerprint({ project, items })
    expect(viaNull).toBe(viaUndefined)
  })

  it('orders multiple objectives by score then index then objective id', () => {
    const diagnosis: Diagnosis = {
      attempt_count: 0,
      average_score: 0,
      concepts: [],
      diagnosis_clusters: [],
      transfer_evidence: {},
      evidence_dimensions: {
        recall: { status: 'observed', verification_status: 'unobserved', attempt_count: 0, average_score: null, evidence_attempt_ids: [], independently_verified_attempt_ids: [], assistance_provenance: {}, evaluator_provenance: {} },
        recognition: { status: 'observed', verification_status: 'unobserved', attempt_count: 0, average_score: null, evidence_attempt_ids: [], independently_verified_attempt_ids: [], assistance_provenance: {}, evaluator_provenance: {} },
      },
      score_delta_earlier_to_later: null,
    }
    const project = mkProject({
      schema_version: 'study_project.v2',
      deadline: undefined,
      objectives: [
        { objective_id: 'a-obj', capability: 'C', success_criteria: ['x'], evidence_targets: ['recall'] },
        { objective_id: 'b-obj', capability: 'C', success_criteria: ['x'], evidence_targets: ['recall'] },
        { objective_id: 'c-obj', capability: 'C', success_criteria: ['x'], evidence_targets: ['recall'] },
      ],
    } as unknown as Partial<StudyProject> & { schema_version: 'study_project.v2' })
    const { queue } = new InterventionOrchestrator({
      project,
      diagnosisBuilder: () => diagnosis,
    }).build({ attempts: [], asOf })
    expect(queue.items.map(item => item.objective_id)).toEqual(['a-obj', 'b-obj', 'c-obj'])
  })

  it('ignores an empty attempt id', () => {
    const project = mkProject({ schema_version: 'study_project.v2' })
    const { queue } = new InterventionOrchestrator({
      project,
      diagnosisBuilder: () => diagnosisFor('recall', 'unobserved'),
    }).build({
      attempts: [mkAttempt({ attempt_id: '', objective_ids: ['obj-1'] })],
      asOf,
    })
    expect(queue.unscoped_attempt_ids).toEqual([])
  })

  it('orders target candidates by descending score when scores differ', () => {
    const diagnosis: Diagnosis = {
      attempt_count: 1,
      average_score: 0,
      concepts: [],
      diagnosis_clusters: [],
      transfer_evidence: {},
      evidence_dimensions: {
        recall: { status: 'observed', verification_status: 'independent', attempt_count: 1, average_score: 1, evidence_attempt_ids: ['at-1'], independently_verified_attempt_ids: ['at-1'], assistance_provenance: {}, evaluator_provenance: {} },
        recognition: { status: 'observed', verification_status: 'supported', attempt_count: 1, average_score: 1, evidence_attempt_ids: [], independently_verified_attempt_ids: [], assistance_provenance: {}, evaluator_provenance: {} },
      },
      score_delta_earlier_to_later: null,
    }
    const project = mkProject({
      schema_version: 'study_project.v2',
      deadline: undefined,
      objectives: [{ objective_id: 'obj-1', capability: 'C', success_criteria: ['x'], evidence_targets: ['recall', 'recognition'] }],
    } as unknown as Partial<StudyProject> & { schema_version: 'study_project.v2' })
    const { queue } = new InterventionOrchestrator({
      project,
      diagnosisBuilder: () => diagnosis,
    }).build({
      attempts: [mkAttempt({ attempt_id: 'at-1', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-05-01T12:00:00Z' })],
      asOf,
    })
    // recall = independent+stale (52) but recognition = supported (60) -> recognition wins
    expect(queue.items[0]!.evidence_dimension).toBe('recognition')
    expect(queue.items[0]!.kind).toBe('independence_probe')
  })

  it('orders objectives by descending priority score', () => {
    const builder = (attempts: StudyAttempt[]): Diagnosis =>
      attempts.length > 0
        ? diagnosisFor('recall', 'unobserved')
        : diagnosisFor('recall', 'supported')
    const project = mkProject({
      schema_version: 'study_project.v2',
      deadline: undefined,
      objectives: [
        { objective_id: 'low-obj', capability: 'C', success_criteria: ['x'], evidence_targets: ['recall'] },
        { objective_id: 'high-obj', capability: 'C', success_criteria: ['x'], evidence_targets: ['recall'] },
      ],
    } as unknown as Partial<StudyProject> & { schema_version: 'study_project.v2' })
    const { queue } = new InterventionOrchestrator({
      project,
      diagnosisBuilder: builder,
    }).build({
      attempts: [mkAttempt({ attempt_id: 'at-1', objective_ids: ['high-obj'], transfer_level: 'recall', occurred_at: '2026-07-01T12:00:00Z' })],
      asOf,
    })
    // high-obj has an attempt -> unobserved (70); low-obj empty -> supported (60).
    expect(queue.items.map(item => item.objective_id)).toEqual(['high-obj', 'low-obj'])
  })
})
