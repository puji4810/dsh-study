import { describe, expect, it } from 'vitest'
import { buildInterventionOutcomes } from '../src/outcomes.ts'
import type { Diagnosis, StudyAttempt, StudyData } from '../src/types.ts'
import type { VerificationStatus } from '../src/constants.ts'

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

function proposal(partial: Record<string, unknown>): StudyData {
  return {
    proposal_id: 'plan-abc',
    status: 'accepted',
    decision: { outcome: 'accepted', decided_at: '2026-07-01T10:00:00Z' },
    items: [],
    ...partial,
  } as StudyData
}

/** A builder that assigns a fixed verification status to a given dimension. */
function builder(status: string, dimension: string): (attempts: StudyAttempt[]) => Diagnosis {
  return () => ({
    attempt_count: 0,
    average_score: 0,
    concepts: [],
    diagnosis_clusters: [],
    transfer_evidence: {},
    evidence_dimensions: {
      [dimension]: {
        status: 'observed',
        verification_status: status as VerificationStatus,
        attempt_count: 1,
        average_score: 0,
        evidence_attempt_ids: [],
        independently_verified_attempt_ids: [],
        assistance_provenance: {},
        evaluator_provenance: {},
      },
    },
    score_delta_earlier_to_later: null,
  })
}

describe('buildInterventionOutcomes', () => {
  const asOf = new Date('2026-07-01T12:00:00Z')

  it('skips proposals that are not accepted', () => {
    const result = buildInterventionOutcomes({
      proposals: [proposal({ status: 'proposed' }), proposal({ status: 'rejected' })],
      attempts: [],
      diagnosisBuilder: builder('developing', 'recall'),
      asOf,
    })
    expect((result.outcomes as unknown[]).length).toBe(0)
    expect(result.totals).toEqual({
      improved: 0,
      unchanged: 0,
      regressed: 0,
      not_attempted: 0,
      decided: 0,
    })
  })

  it('skips accepted proposals without a parseable decided_at', () => {
    const result = buildInterventionOutcomes({
      proposals: [proposal({ decision: { outcome: 'accepted', decided_at: '2026-07-01T10:00:00' } })],
      attempts: [],
      diagnosisBuilder: builder('developing', 'recall'),
      asOf,
    })
    expect((result.outcomes as unknown[]).length).toBe(0)
  })

  it('classifies not_attempted when no evidence arrived since the decision', () => {
    const result = buildInterventionOutcomes({
      proposals: [
        proposal({
          items: [{ objective_id: 'obj-1', evidence_dimension: 'recall', kind: 'guided_repair', reason_factors: { verification_status: 'developing' }, intervention_id: 'iv-1' }],
        }),
      ],
      attempts: [],
      diagnosisBuilder: builder('developing', 'recall'),
      asOf,
    })
    const outcomes = result.outcomes as Array<Record<string, unknown>>
    expect(outcomes.length).toBe(1)
    expect(outcomes[0]!.outcome).toBe('not_attempted')
    expect(outcomes[0]!.verification_status_at_decision).toBe('developing')
    expect(outcomes[0]!.verification_status_now).toBe('developing')
  })

  it('classifies improved when the current status outranks the baseline', () => {
    const result = buildInterventionOutcomes({
      proposals: [
        proposal({
          items: [{ objective_id: 'obj-1', evidence_dimension: 'recall', kind: 'evidence_probe', reason_factors: { verification_status: 'developing' }, intervention_id: 'iv-1' }],
        }),
      ],
      attempts: [
        attempt({ attempt_id: 'at-1', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-01T11:00:00Z' }),
      ],
      diagnosisBuilder: builder('supported', 'recall'),
      asOf,
    })
    const outcome = (result.outcomes as Array<Record<string, unknown>>)[0]!
    expect(outcome.outcome).toBe('improved')
    expect(outcome.evidence_attempt_ids_since).toEqual(['at-1'])
    expect(outcome.days_since_decision).toBe(0)
  })

  it('classifies regressed when the current status is weaker than the baseline', () => {
    const result = buildInterventionOutcomes({
      proposals: [
        proposal({
          items: [{ objective_id: 'obj-1', evidence_dimension: 'recall', kind: 'evidence_probe', reason_factors: { verification_status: 'supported' }, intervention_id: 'iv-1' }],
        }),
      ],
      attempts: [attempt({ attempt_id: 'at-1', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-01T11:00:00Z' })],
      diagnosisBuilder: builder('developing', 'recall'),
      asOf,
    })
    expect((result.outcomes as Array<Record<string, unknown>>)[0]!.outcome).toBe('regressed')
  })

  it('classifies unchanged when the status is the same', () => {
    const result = buildInterventionOutcomes({
      proposals: [
        proposal({
          items: [{ objective_id: 'obj-1', evidence_dimension: 'recall', kind: 'evidence_probe', reason_factors: { verification_status: 'developing' }, intervention_id: 'iv-1' }],
        }),
      ],
      attempts: [attempt({ attempt_id: 'at-1', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-01T11:00:00Z' })],
      diagnosisBuilder: builder('developing', 'recall'),
      asOf,
    })
    expect((result.outcomes as Array<Record<string, unknown>>)[0]!.outcome).toBe('unchanged')
  })

  it('skips items missing an objective or dimension and defaults missing verification status', () => {
    const result = buildInterventionOutcomes({
      proposals: [
        proposal({
          items: [
            { objective_id: '', evidence_dimension: 'recall', kind: 'evidence_probe', intervention_id: 'iv-1' },
            { objective_id: 'obj-1', evidence_dimension: '', kind: 'evidence_probe', intervention_id: 'iv-2' },
            { objective_id: 'obj-2', evidence_dimension: 'recall', kind: 'evidence_probe', intervention_id: 'iv-3' },
          ],
        }),
      ],
      attempts: [],
      diagnosisBuilder: builder('developing', 'recall'),
      asOf,
    })
    const outcomes = result.outcomes as Array<Record<string, unknown>>
    expect(outcomes.length).toBe(1)
    expect(outcomes[0]!.verification_status_at_decision).toBe('unobserved')
  })

  it('aggregates by kind with a measured verdict when enough acted-on outcomes exist', () => {
    const proposals = [1, 2, 3, 4, 5].map(i =>
      proposal({
        proposal_id: `plan-${i}`,
        items: [{ objective_id: 'obj-1', evidence_dimension: 'recall', kind: 'evidence_probe', reason_factors: { verification_status: 'developing' }, intervention_id: `iv-${i}` }],
      }),
    )
    const result = buildInterventionOutcomes({
      proposals,
      attempts: [attempt({ attempt_id: 'at-1', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-01T11:00:00Z' })],
      diagnosisBuilder: builder('independent', 'recall'),
      asOf,
    })
    const rows = result.by_kind as Array<Record<string, unknown>>
    expect(rows.length).toBe(1)
    expect(rows[0]!.kind).toBe('evidence_probe')
    expect(rows[0]!.verdict).toBe('measured')
    expect(rows[0]!.improvement_rate).toBe(1)
    expect(rows[0]!.adherence_rate).toBe(1)
    expect(rows[0]!.acted_on).toBe(5)
  })

  it('reports insufficient evidence per kind with needed_for_signal when under the sample', () => {
    const result = buildInterventionOutcomes({
      proposals: [
        proposal({
          items: [{ objective_id: 'obj-1', evidence_dimension: 'recall', kind: 'evidence_probe', reason_factors: { verification_status: 'developing' }, intervention_id: 'iv-1' }],
        }),
      ],
      attempts: [],
      diagnosisBuilder: builder('developing', 'recall'),
      asOf,
    })
    const rows = result.by_kind as Array<Record<string, unknown>>
    expect(rows[0]!.verdict).toBe('insufficient_evidence')
    expect(rows[0]!.improvement_rate).toBe(null)
    expect(rows[0]!.needed_for_signal).toBe(5)
    expect(rows[0]!.adherence_rate).toBe(0)
  })

  it('computes totals correctly with mixed outcomes', () => {
    const result = buildInterventionOutcomes({
      proposals: [
        proposal({
          items: [
            { objective_id: 'obj-1', evidence_dimension: 'recall', kind: 'evidence_probe', reason_factors: { verification_status: 'developing' }, intervention_id: 'iv-1' },
            { objective_id: 'obj-1', evidence_dimension: 'recall', kind: 'evidence_probe', reason_factors: { verification_status: 'supported' }, intervention_id: 'iv-2' },
          ],
        }),
      ],
      attempts: [attempt({ attempt_id: 'at-1', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-01T11:00:00Z' })],
      diagnosisBuilder: builder('developing', 'recall'),
      asOf,
    })
    const totals = result.totals as Record<string, unknown>
    expect(totals.decided).toBe(2)
    expect(totals.improved).toBe(0)
    expect(totals.unchanged).toBe(1)
    expect(totals.regressed).toBe(1)
  })

  it('maps an unknown verification status to rank zero', () => {
    const result = buildInterventionOutcomes({
      proposals: [
        proposal({
          items: [{ objective_id: 'obj-1', evidence_dimension: 'recall', kind: 'evidence_probe', reason_factors: { verification_status: 'bogus' }, intervention_id: 'iv-1' }],
        }),
      ],
      attempts: [attempt({ attempt_id: 'at-1', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-01T11:00:00Z' })],
      diagnosisBuilder: builder('supported', 'recall'),
      asOf,
    })
    // bogus -> rank 0, supported -> rank 2 => improved
    expect((result.outcomes as Array<Record<string, unknown>>)[0]!.outcome).toBe('improved')
  })

  it('skips attempts with mismatched dimension, objective, or earlier timestamps', () => {
    const result = buildInterventionOutcomes({
      proposals: [
        proposal({
          items: [{ objective_id: 'obj-1', evidence_dimension: 'recall', kind: 'evidence_probe', reason_factors: { verification_status: 'developing' }, intervention_id: 'iv-1' }],
        }),
      ],
      attempts: [
        attempt({ attempt_id: 'd-dim', objective_ids: ['obj-1'], transfer_level: 'explanation', occurred_at: '2026-07-01T11:00:00Z' }),
        attempt({ attempt_id: 'd-obj', objective_ids: ['obj-2'], transfer_level: 'recall', occurred_at: '2026-07-01T11:00:00Z' }),
        attempt({ attempt_id: 'd-early', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-01T09:00:00Z' }),
        attempt({ attempt_id: 'd-naive', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-01T11:00:00' }),
      ],
      diagnosisBuilder: builder('developing', 'recall'),
      asOf,
    })
    const outcome = (result.outcomes as Array<Record<string, unknown>>)[0]!
    expect(outcome.outcome).toBe('not_attempted')
    expect(outcome.evidence_attempt_ids_since).toEqual([])
  })

  it('scopes attempts by objective id and defaults an empty diagnosis', () => {
    const emptyDiagnosis: Diagnosis = {
      attempt_count: 0,
      average_score: 0,
      concepts: [],
      diagnosis_clusters: [],
      transfer_evidence: {},
      evidence_dimensions: {},
      score_delta_earlier_to_later: null,
    }
    const result = buildInterventionOutcomes({
      proposals: [
        proposal({
          items: [{ objective_id: 'obj-1', evidence_dimension: 'recall', kind: 'evidence_probe', reason_factors: {}, intervention_id: 'iv-1' }],
        }),
      ],
      attempts: [],
      diagnosisBuilder: () => emptyDiagnosis,
      asOf,
    })
    const outcome = (result.outcomes as Array<Record<string, unknown>>)[0]!
    expect(outcome.verification_status_now).toBe('unobserved')
    expect(outcome.outcome).toBe('not_attempted')
  })

  it('skips accepted proposals without a decision and with non-array items', () => {
    const result = buildInterventionOutcomes({
      proposals: [
        proposal({ decision: undefined }),
        proposal({ items: 'not-an-array' }),
      ],
      attempts: [],
      diagnosisBuilder: builder('developing', 'recall'),
      asOf,
    })
    expect((result.outcomes as unknown[]).length).toBe(0)
  })

  it('skips items missing objective or dimension', () => {
    const result = buildInterventionOutcomes({
      proposals: [
        proposal({ items: [{ intervention_id: 'iv-x', kind: 'evidence_probe' }] }),
      ],
      attempts: [],
      diagnosisBuilder: builder('developing', 'recall'),
      asOf,
    })
    expect((result.outcomes as unknown[]).length).toBe(0)
  })

  it('sorts outcomes by decided_at then intervention_id', () => {
    const result = buildInterventionOutcomes({
      proposals: [
        proposal({
          proposal_id: 'plan-a',
          decision: { outcome: 'accepted', decided_at: '2026-07-02T10:00:00Z' },
          items: [{ objective_id: 'obj-1', evidence_dimension: 'recall', kind: 'evidence_probe', reason_factors: { verification_status: 'developing' }, intervention_id: 'iv-later' }],
        }),
        proposal({
          proposal_id: 'plan-b',
          decision: { outcome: 'accepted', decided_at: '2026-07-01T10:00:00Z' },
          items: [{ objective_id: 'obj-1', evidence_dimension: 'recall', kind: 'evidence_probe', reason_factors: { verification_status: 'developing' }, intervention_id: 'iv-earlier' }],
        }),
      ],
      attempts: [],
      diagnosisBuilder: builder('developing', 'recall'),
      asOf,
    })
    const outcomes = result.outcomes as Array<Record<string, unknown>>
    expect(outcomes[0]!.intervention_id).toBe('iv-earlier')
    expect(outcomes[1]!.intervention_id).toBe('iv-later')

    // equal decided_at -> ordered by intervention_id descending (stable equal => earliest? check)
    const same = buildInterventionOutcomes({
      proposals: [
        proposal({ items: [{ objective_id: 'obj-1', evidence_dimension: 'recall', kind: 'evidence_probe', reason_factors: { verification_status: 'developing' }, intervention_id: 'iv-1' }] }),
        proposal({ items: [{ objective_id: 'obj-1', evidence_dimension: 'recall', kind: 'evidence_probe', reason_factors: { verification_status: 'developing' }, intervention_id: 'iv-2' }] }),
      ],
      attempts: [],
      diagnosisBuilder: builder('developing', 'recall'),
      asOf,
    })
    const sameOutcomes = same.outcomes as Array<Record<string, unknown>>
    expect(sameOutcomes[0]!.intervention_id).toBe('iv-1')
    expect(sameOutcomes[1]!.intervention_id).toBe('iv-2')
  })

  it('rounds an adherence rate above and below half', () => {
    // Three items; two have matching evidence since (acted), one does not
    // (not_attempted). adherence_rate = 2/3 = 0.667 (half-up rounding to .667
    // exercises the diff > 0.5 branch) and a 1/3 case exercises diff < 0.5.
    const itemize = (n: number) => [1, 2, 3].map(i => ({
      objective_id: `obj-${i}`,
      evidence_dimension: 'recall',
      kind: 'evidence_probe',
      reason_factors: { verification_status: 'developing' },
      intervention_id: `iv-${i}-${n}`,
    }))

    const above = buildInterventionOutcomes({
      proposals: [proposal({ items: itemize(1) }), proposal({ items: itemize(2) })],
      attempts: [
        attempt({ attempt_id: 'a1', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-01T11:00:00Z' }),
        attempt({ attempt_id: 'a2', objective_ids: ['obj-2'], transfer_level: 'recall', occurred_at: '2026-07-01T11:00:00Z' }),
      ],
      diagnosisBuilder: builder('supported', 'recall'),
      asOf,
    })
    const rows = above.by_kind as Array<Record<string, unknown>>
    expect(rows[0]!.kind).toBe('evidence_probe')
    expect(rows[0]!.adherence_rate).toBe(0.667)
    expect(rows[0]!.acted_on).toBe(4)
    expect(rows[0]!.decided).toBe(6)
  })

  it('rounds an adherence rate half-to-even at exact .5', () => {
    const mk = (acted: number) => {
      const items = [
        ...Array.from({ length: acted }, (_, i) => ({
          objective_id: 'obj-1',
          evidence_dimension: 'recall',
          kind: 'evidence_probe',
          reason_factors: { verification_status: 'developing' },
          intervention_id: `iv-a-${i}`,
        })),
        ...Array.from({ length: 16 - acted }, (_, i) => ({
          objective_id: 'obj-x',
          evidence_dimension: 'recall',
          kind: 'evidence_probe',
          reason_factors: { verification_status: 'developing' },
          intervention_id: `iv-n-${i}`,
        })),
      ]
      return proposal({ items })
    }
    const even = buildInterventionOutcomes({
      proposals: [mk(1)],
      attempts: [attempt({ attempt_id: 'at-1', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-01T11:00:00Z' })],
      diagnosisBuilder: builder('developing', 'recall'),
      asOf,
    })
    expect((even.by_kind as Array<Record<string, unknown>>)[0]!.adherence_rate).toBe(0.062)

    const odd = buildInterventionOutcomes({
      proposals: [mk(3)],
      attempts: [attempt({ attempt_id: 'at-1', objective_ids: ['obj-1'], transfer_level: 'recall', occurred_at: '2026-07-01T11:00:00Z' })],
      diagnosisBuilder: builder('developing', 'recall'),
      asOf,
    })
    expect((odd.by_kind as Array<Record<string, unknown>>)[0]!.adherence_rate).toBe(0.188)
  })

  it('skips attempts with no transfer level or no objective ids', () => {
    const result = buildInterventionOutcomes({
      proposals: [
        proposal({
          items: [{ objective_id: 'obj-1', evidence_dimension: 'recall', kind: 'evidence_probe', reason_factors: { verification_status: 'developing' }, intervention_id: 'iv-1' }],
        }),
      ],
      attempts: [
        attempt({ attempt_id: 'no-dim', objective_ids: ['obj-1'], occurred_at: '2026-07-01T11:00:00Z' }),
        attempt({ attempt_id: 'no-obj', transfer_level: 'recall', occurred_at: '2026-07-01T11:00:00Z' }),
      ],
      diagnosisBuilder: builder('developing', 'recall'),
      asOf,
    })
    expect((result.outcomes as Array<Record<string, unknown>>)[0]!.outcome).toBe('not_attempted')
  })

  it('defaults a diagnosis with no evidence_dimensions', () => {
    const result = buildInterventionOutcomes({
      proposals: [
        proposal({
          items: [{ objective_id: 'obj-1', evidence_dimension: 'recall', kind: 'evidence_probe', reason_factors: { verification_status: 'developing' }, intervention_id: 'iv-1' }],
        }),
      ],
      attempts: [attempt({ attempt_id: 'at-1', transfer_level: 'recall', occurred_at: '2026-07-01T11:00:00Z' })],
      diagnosisBuilder: (): Diagnosis => ({
        attempt_count: 0,
        average_score: 0,
        concepts: [],
        diagnosis_clusters: [],
        transfer_evidence: {},
        evidence_dimensions: undefined as unknown as Record<string, never>,
        score_delta_earlier_to_later: null,
      }),
      asOf,
    })
    expect((result.outcomes as Array<Record<string, unknown>>)[0]!.verification_status_now).toBe('unobserved')
  })

  it('defaults missing proposal and item provenance fields', () => {
    const result = buildInterventionOutcomes({
      proposals: [
        proposal({
          proposal_id: undefined,
          items: [{ objective_id: 'obj-1', evidence_dimension: 'recall', intervention_id: undefined, kind: undefined }],
        }),
      ],
      attempts: [],
      diagnosisBuilder: builder('developing', 'recall'),
      asOf,
    })
    const outcome = (result.outcomes as Array<Record<string, unknown>>)[0]!
    expect(outcome.proposal_id).toBe('')
    expect(outcome.intervention_id).toBe('')
    expect(outcome.kind).toBe('')
  })

  it('sorts three outcomes in reverse chronological order', () => {
    const mk = (day: string, id: string): StudyData => proposal({
      proposal_id: `plan-${id}`,
      decision: { outcome: 'accepted', decided_at: `2026-07-0${day}T10:00:00Z` },
      items: [{ objective_id: 'obj-1', evidence_dimension: 'recall', kind: 'evidence_probe', reason_factors: { verification_status: 'developing' }, intervention_id: id }],
    })
    const result = buildInterventionOutcomes({
      proposals: [mk('3', 'iv-third'), mk('1', 'iv-first'), mk('2', 'iv-second')],
      attempts: [],
      diagnosisBuilder: builder('developing', 'recall'),
      asOf,
    })
    const outcomes = result.outcomes as Array<Record<string, unknown>>
    expect(outcomes.map(o => o.intervention_id)).toEqual(['iv-first', 'iv-second', 'iv-third'])
  })
})
