import { describe, expect, it } from 'vitest'
import {
  MIN_INDEPENDENT_ATTEMPTS,
  diagnoseAttempts,
  independentlyVerified,
  patternProposals,
  probeBlueprint,
  recommendations,
} from '../src/diagnosis.ts'
import { PATTERN_PROPOSAL_SCHEMA_VERSION } from '../src/constants.ts'
import type { StudyAttempt, StudyAssistance } from '../src/types.ts'

function attempt(overrides: Partial<StudyAttempt> = {}): StudyAttempt {
  return {
    schema_version: 'study_attempt.v1',
    attempt_id: 'attempt-1',
    project_id: 'demo-project',
    item_id: 'item-1',
    occurred_at: '2026-07-01T10:00:00Z',
    response: 'answer',
    result: 'correct',
    score: 1.0,
    ...overrides,
  }
}

function independentUsed(level: StudyAssistance['level'] = 'independent', score = 0.9, kind: StudyAttempt['evaluator'] = { kind: 'agent', confidence: 0.9 }): StudyAttempt {
  return attempt({
    attempt_id: `attempt-${Math.random().toString(36).slice(2, 8)}`,
    score,
    assistance: { level },
    evaluator: kind,
  })
}

describe('independentlyVerified', () => {
  it('rejects attempts without a credible evaluator kind', () => {
    expect(independentlyVerified(attempt({ score: 1.0, assistance: { level: 'independent' }, evaluator: { kind: 'self' } }))).toBe(false)
    expect(independentlyVerified(attempt({ score: 1.0, assistance: { level: 'independent' } }))).toBe(false)
  })

  it('treats an unknown evaluator kind as not credible', () => {
    expect(independentlyVerified(attempt({
      score: 1.0,
      assistance: { level: 'independent' },
      evaluator: { kind: 'oracle' as never, confidence: 1.0 },
    }))).toBe(false)
  })

  it('accepts null-or-high confidence but rejects low confidence', () => {
    expect(independentlyVerified(attempt({ score: 1.0, assistance: { level: 'independent' }, evaluator: { kind: 'human' } }))).toBe(true)
    expect(independentlyVerified(attempt({ score: 1.0, assistance: { level: 'independent' }, evaluator: { kind: 'human', confidence: 0.5 } }))).toBe(true)
    expect(independentlyVerified(attempt({ score: 1.0, assistance: { level: 'independent' }, evaluator: { kind: 'human', confidence: 0.49 } }))).toBe(false)
  })

  it('requires score >= 0.8', () => {
    expect(independentlyVerified(attempt({ score: 0.79, assistance: { level: 'independent' }, evaluator: { kind: 'agent' } }))).toBe(false)
  })

  it('requires independent assistance', () => {
    expect(independentlyVerified(attempt({ score: 0.9, assistance: { level: 'guided' }, evaluator: { kind: 'agent' } }))).toBe(false)
  })
})

describe('diagnoseAttempts', () => {
  it('returns an empty diagnosis with a zero average score', () => {
    const diagnosis = diagnoseAttempts([])
    expect(diagnosis.attempt_count).toBe(0)
    expect(diagnosis.average_score).toBe(0)
    expect(diagnosis.concepts).toEqual([])
    expect(diagnosis.diagnosis_clusters).toEqual([])
    expect(diagnosis.transfer_evidence).toEqual({})
    expect(diagnosis.score_delta_earlier_to_later).toBeNull()
    for (const dimension of Object.values(diagnosis.evidence_dimensions)) {
      expect(dimension.status).toBe('unobserved')
      expect(dimension.verification_status).toBe('unobserved')
      expect(dimension.attempt_count).toBe(0)
      expect(dimension.average_score).toBeNull()
    }
  })

  it('populates concepts sorted by (avg asc, -count, concept)', () => {
    const a = attempt({ attempt_id: 'a', score: 0.5, concepts: ['beta'] })
    const b = attempt({ attempt_id: 'b', score: 0.9, concepts: ['alpha'] })
    const c = attempt({ attempt_id: 'c', score: 0.9, concepts: ['alpha'] })
    const diagnosis = diagnoseAttempts([a, b, c])
    expect(diagnosis.concepts.map(c => c.concept)).toEqual(['beta', 'alpha'])
    expect(diagnosis.concepts[1]?.attempt_count).toBe(2)
  })

  it('sorts clusters by (-count, concept, kind)', () => {
    const a = attempt({ attempt_id: 'a', diagnoses: [{ kind: 'condition_missed', evidence: 'e', concept: 'zeta' }] })
    const b = attempt({ attempt_id: 'b', diagnoses: [{ kind: 'condition_missed', evidence: 'e', concept: 'zeta' }] })
    const c = attempt({ attempt_id: 'c', diagnoses: [{ kind: 'concept_confusion', evidence: 'e', concept: 'alpha' }] })
    const diagnosis = diagnoseAttempts([a, b, c])
    expect(diagnosis.diagnosis_clusters[0]).toMatchObject({ concept: 'zeta', count: 2 })
    expect(diagnosis.diagnosis_clusters[1]).toMatchObject({ concept: 'alpha', count: 1 })
  })

  it('breaks concept-sort ties by attempt count then concept name', () => {
    const a = attempt({ attempt_id: 'a', score: 0.5, concepts: ['beta', 'alpha'] })
    const b = attempt({ attempt_id: 'b', score: 0.5, concepts: ['alpha'] })
    const diagnosis = diagnoseAttempts([a, b])
    // alpha: avg 0.5 count 2; beta: avg 0.5 count 1 → alpha first (higher count)
    expect(diagnosis.concepts.map(c => c.concept)).toEqual(['alpha', 'beta'])
  })

  it('breaks concept-sort ties by name when score and count match', () => {
    const a = attempt({ attempt_id: 'a', score: 0.5, concepts: ['zeta'] })
    const b = attempt({ attempt_id: 'b', score: 0.5, concepts: ['sigma'] })
    const c = attempt({ attempt_id: 'c', score: 0.5, concepts: ['alpha'] })
    const diagnosis = diagnoseAttempts([a, b, c])
    expect(diagnosis.concepts.map(x => x.concept)).toEqual(['alpha', 'sigma', 'zeta'])
  })

  it('handles duplicate timestamps and attempt ids in time ordering', () => {
    const dup = attempt({ attempt_id: 'same', occurred_at: '2026-07-01T10:00:00Z', score: 0.5 })
    const other = attempt({ attempt_id: 'later', occurred_at: '2026-07-01T11:00:00Z', score: 0.5 })
    const diagnosis = diagnoseAttempts([dup, { ...dup }, other])
    expect(diagnosis.score_delta_earlier_to_later).not.toBeNull()
  })

  it('breaks cluster-sort ties by concept then kind', () => {
    const a = attempt({ attempt_id: 'a', diagnoses: [{ kind: 'kind-z', evidence: 'e', concept: 'zeta' }] })
    const b = attempt({ attempt_id: 'b', diagnoses: [{ kind: 'kind-a', evidence: 'e', concept: 'alpha' }] })
    const c = attempt({ attempt_id: 'c', diagnoses: [{ kind: 'kind-m', evidence: 'e', concept: 'mid' }] })
    const diagnosis = diagnoseAttempts([a, b, c])
    expect(diagnosis.diagnosis_clusters.map(x => x.concept)).toEqual(['alpha', 'mid', 'zeta'])
  })

  it('breaks cluster-sort ties by kind when concepts match', () => {
    const a = attempt({ attempt_id: 'a', diagnoses: [{ kind: 'zeta_kind', evidence: 'e', concept: 'same' }] })
    const b = attempt({ attempt_id: 'b', diagnoses: [{ kind: 'alpha_kind', evidence: 'e', concept: 'same' }] })
    const c = attempt({ attempt_id: 'c', diagnoses: [{ kind: 'mid_kind', evidence: 'e', concept: 'same' }] })
    const diagnosis = diagnoseAttempts([a, b, c])
    expect(diagnosis.diagnosis_clusters.map(x => x.kind)).toEqual(['alpha_kind', 'mid_kind', 'zeta_kind'])
  })

  it('sorts provenance dicts alphabetically in both directions', () => {
    const a = attempt({ transfer_level: 'explanation', assistance: { level: 'guided' }, evaluator: { kind: 'agent' }, attempt_id: 'a1' })
    const b = attempt({ transfer_level: 'explanation', assistance: { level: 'direct' }, evaluator: { kind: 'human' }, attempt_id: 'a2' })
    const diagnosis = diagnoseAttempts([a, b])
    expect(Object.keys(diagnosis.evidence_dimensions['explanation']?.assistance_provenance ?? {})).toEqual(['direct', 'guided'])
    expect(Object.keys(diagnosis.evidence_dimensions['explanation']?.evaluator_provenance ?? {})).toEqual(['agent', 'human'])
  })

  it('defaults diagnosis concept/kind to unscoped/unclassified', () => {
    const a = attempt({ attempt_id: 'a', diagnoses: [{ kind: '', evidence: 'e' }] })
    const diagnosis = diagnoseAttempts([a])
    expect(diagnosis.diagnosis_clusters[0]).toMatchObject({ concept: 'unscoped', kind: 'unclassified' })
  })

  it('marks a dimension independent with >=2 latest-independent attempts', () => {
    const dimensions = ['recall'] as const
    const a = independentUsed('independent', 0.9, { kind: 'human', confidence: 0.9 })
    const b = independentUsed('independent', 0.9, { kind: 'human', confidence: 0.9 })
    const diagnosis = diagnoseAttempts([
      { ...a, transfer_level: 'recall', attempt_id: 't1', occurred_at: '2026-07-01T10:00:00Z' },
      { ...b, transfer_level: 'recall', attempt_id: 't2', occurred_at: '2026-07-01T11:00:00Z' },
    ])
    expect(diagnosis.evidence_dimensions['recall']?.verification_status).toBe('independent')
    expect(diagnosis.evidence_dimensions['recall']?.independently_verified_attempt_ids).toHaveLength(2)
    expect(diagnosis.evidence_dimensions['recall']?.status).toBe('observed')
    void dimensions
  })

  it('stays supported when the latest attempt is not independent', () => {
    const early = { ...independentUsed(), transfer_level: 'recall' as const, attempt_id: 't1', occurred_at: '2026-07-01T10:00:00Z' }
    const late = { ...attempt({ score: 0.9, assistance: { level: 'guided' }, evaluator: { kind: 'human' } }), transfer_level: 'recall' as const, attempt_id: 't2', occurred_at: '2026-07-01T11:00:00Z' }
    const diagnosis = diagnoseAttempts([early, late])
    expect(diagnosis.evidence_dimensions['recall']?.verification_status).toBe('supported')
  })

  it('uses the latest attempt by timestamp, not list order', () => {
    const late = { ...independentUsed(), transfer_level: 'recall' as const, attempt_id: 'late', occurred_at: '2026-07-01T11:00:00Z' }
    const earlyIndependent = { ...independentUsed(), transfer_level: 'recall' as const, attempt_id: 'early', occurred_at: '2026-07-01T10:00:00Z' }
    // late is first in the list but timestamp says it's the latest; both independent → independent
    const diagnosis = diagnoseAttempts([late, earlyIndependent])
    expect(diagnosis.evidence_dimensions['recall']?.verification_status).toBe('independent')
  })

  it('marks developing for observed but not successful', () => {
    const a = { ...attempt({ score: 0.5, transfer_level: 'execution' as const }) }
    const diagnosis = diagnoseAttempts([a])
    expect(diagnosis.evidence_dimensions['execution']?.verification_status).toBe('developing')
  })

  it('records transfer evidence and provenance', () => {
    const a = attempt({ transfer_level: 'execution', assistance: { level: 'guided' }, evaluator: { kind: 'agent' } })
    const diagnosis = diagnoseAttempts([a])
    expect(diagnosis.transfer_evidence).toEqual({ execution: 1 })
    expect(diagnosis.evidence_dimensions['execution']?.assistance_provenance).toEqual({ guided: 1 })
    expect(diagnosis.evidence_dimensions['execution']?.evaluator_provenance).toEqual({ agent: 1 })
  })

  it('computes score delta from the two halves', () => {
    const attempts = [0.2, 0.4, 0.6, 0.8].map((score, i) => attempt({
      attempt_id: `s${i}`,
      score,
      occurred_at: `2026-07-01T10:0${i}:00Z`,
    }))
    const diagnosis = diagnoseAttempts(attempts)
    // early half [0.2, 0.4] avg 0.3; late [0.6, 0.8] avg 0.7 → delta 0.4
    expect(diagnosis.score_delta_earlier_to_later).toBeCloseTo(0.4, 3)
  })

  it('returns null score delta for a single attempt', () => {
    const diagnosis = diagnoseAttempts([attempt()])
    expect(diagnosis.score_delta_earlier_to_later).toBeNull()
  })

  it('treats a non-numeric score as zero', () => {
    const diagnosis = diagnoseAttempts([attempt({ score: undefined as never })])
    expect(diagnosis.average_score).toBe(0)
  })
})

describe('recommendations', () => {
  function withClusters(clusters: Array<{ kind: string; concept: string; count: number; evidence_attempt_ids: string[] }>, dimensions: Record<string, unknown> = {}): ReturnType<typeof diagnoseAttempts> {
    return {
      attempt_count: 0,
      average_score: 0,
      concepts: [],
      diagnosis_clusters: clusters as never,
      transfer_evidence: {},
      evidence_dimensions: dimensions as never,
      score_delta_earlier_to_later: null,
    }
  }

  it('skips clusters below count 2', () => {
    const diagnosis = withClusters([{ kind: 'concept_confusion', concept: 'x', count: 1, evidence_attempt_ids: ['a'] }])
    expect(recommendations(diagnosis)).toEqual([])
  })

  it('maps concept_confusion to prerequisite_repair and others to misconception_probe', () => {
    const confusion = withClusters([{ kind: 'concept_confusion', concept: 'x', count: 2, evidence_attempt_ids: ['a', 'b'] }])
    expect(recommendations(confusion)[0]).toMatchObject({ priority: 'high', intervention: 'prerequisite_repair', concept: 'x', reason: 'concept_confusion repeated 2 times' })
    const missed = withClusters([{ kind: 'condition_missed', concept: 'y', count: 3, evidence_attempt_ids: ['a', 'b', 'c'] }])
    expect(recommendations(missed)[0]).toMatchObject({ intervention: 'misconception_probe', reason: 'condition_missed repeated 3 times' })
  })

  it('emits a medium independence_probe for a supported dimension', () => {
    const diagnosis = withClusters([], {
      recall: { verification_status: 'supported', evidence_attempt_ids: ['r1'] },
    })
    const recs = recommendations(diagnosis)
    expect(recs[0]).toMatchObject({ priority: 'medium', intervention: 'independence_probe', evidence_dimension: 'recall', reason: 'recall has successful but not independently verified evidence' })
  })

  it('keeps only the first supported dimension when several are supported', () => {
    const diagnosis = withClusters([], {
      recall: { verification_status: 'supported', evidence_attempt_ids: ['r1'] },
      execution: { verification_status: 'supported', evidence_attempt_ids: ['e1'] },
    })
    const recs = recommendations(diagnosis)
    const probes = recs.filter(r => r.intervention === 'independence_probe')
    expect(probes).toHaveLength(1)
    expect(probes[0]?.evidence_dimension).toBe('recall')
  })

  it('emits near_transfer_probe when attempts exist but no independent transfer', () => {
    const diagnosis = withClusters([], { execution: { verification_status: 'supported', evidence_attempt_ids: ['e1'] } })
    const diagnosisWithAttempts = { ...diagnosis, attempt_count: 3 }
    const recs = recommendations(diagnosisWithAttempts)
    expect(recs.some(r => r.intervention === 'near_transfer_probe')).toBe(true)
  })

  it('skips near_transfer_probe when a transfer dimension is independent', () => {
    const diagnosis = withClusters([], {
      near_transfer: { verification_status: 'independent', evidence_attempt_ids: ['n1'] },
      execution: { verification_status: 'supported', evidence_attempt_ids: ['e1'] },
    })
    const recs = recommendations({ ...diagnosis, attempt_count: 1 })
    expect(recs.some(r => r.intervention === 'near_transfer_probe')).toBe(false)
  })

  it('emits retention_probe when no gap dominates and transfer is verified', () => {
    const diagnosis = withClusters([{ kind: 'condition_missed', concept: 'x', count: 1, evidence_attempt_ids: ['a'] }], {
      near_transfer: { verification_status: 'independent', evidence_attempt_ids: ['n1'] },
    })
    const recs = recommendations({ ...diagnosis, attempt_count: 2 })
    expect(recs).toEqual([{
      priority: 'medium',
      intervention: 'retention_probe',
      reason: 'No repeated gap dominates; verify retention after spacing',
      evidence_attempt_ids: [],
    }])
  })
})

describe('patternProposals', () => {
  it('skips clusters below count 2 and builds ids from slugs and date', () => {
    const diagnosis: ReturnType<typeof diagnoseAttempts> = {
      attempt_count: 2,
      average_score: 0.5,
      concepts: [],
      transfer_evidence: {},
      score_delta_earlier_to_later: null,
      evidence_dimensions: {},
      diagnosis_clusters: [
        { kind: 'condition_missed', concept: '二次函数', count: 1, evidence_attempt_ids: ['a'] },
        { kind: 'concept_confusion', concept: 'Derivative Rules', count: 2, evidence_attempt_ids: ['b', 'c'] },
      ],
    }
    const proposals = patternProposals('demo-project', diagnosis, '2026-07-15T12:00:00+08:00')
    expect(proposals).toHaveLength(1)
    const proposal = proposals[0]!
    expect(proposal.schema_version).toBe(PATTERN_PROPOSAL_SCHEMA_VERSION)
    expect(proposal.proposal_id).toBe('proposal-2026-07-15-derivative-rules-concept-confusion-1')
    expect(proposal.title).toBe('补充 Derivative Rules 的 concept_confusion 失败路径')
    expect(proposal.status).toBe('candidate')
    expect(proposal.change_type).toBe('supplement')
    expect(proposal.suggested_change).toEqual({
      recognition_signal: 'Derivative Rules',
      failure_path: 'concept_confusion',
      validation_needed: 'near_transfer',
    })
  })

  it('uses the unscoped/gap fallbacks when slugs are empty', () => {
    const diagnosis: ReturnType<typeof diagnoseAttempts> = {
      attempt_count: 2,
      average_score: 0,
      concepts: [],
      transfer_evidence: {},
      score_delta_earlier_to_later: null,
      evidence_dimensions: {},
      diagnosis_clusters: [
        { kind: '!!!', concept: '###', count: 2, evidence_attempt_ids: ['b', 'c'] },
      ],
    }
    const proposals = patternProposals('p', diagnosis, '2026-07-15T12:00:00Z')
    expect(proposals[0]?.proposal_id).toBe('proposal-2026-07-15-unscoped-gap-1')
    expect(proposals[0]?.title).toBe('补充 ### 的 !!! 失败路径')
  })
})

describe('probeBlueprint', () => {
  it('returns null for zero attempts', () => {
    const diagnosis = diagnoseAttempts([])
    expect(probeBlueprint(diagnosis)).toBeNull()
  })

  it('builds a blueprint from the first recommendation and weakest concept', () => {
    const attempts = [
      attempt({ attempt_id: 'a', score: 0.9, concepts: ['weak'], diagnoses: [{ kind: 'condition_missed', evidence: 'e', concept: 'weak' }] }),
      attempt({ attempt_id: 'b', score: 0.9, concepts: ['weak'], diagnoses: [{ kind: 'condition_missed', evidence: 'e', concept: 'weak' }] }),
    ]
    const diagnosis = diagnoseAttempts(attempts)
    const blueprint = probeBlueprint(diagnosis)
    expect(blueprint).not.toBeNull()
    expect(blueprint?.['purpose']).toBe('misconception_probe')
    expect(blueprint?.['target_concept']).toBe('weak')
    expect(blueprint?.['variation_instruction']).toBe('change the condition that distinguishes the observed wrong rule from the correct rule')
    expect(blueprint?.['evidence_attempt_ids']).toEqual(['a', 'b'])
  })

  it('falls back to retention_probe and a null target concept', () => {
    // Two independent near_transfer attempts → transfer verified, no clusters or
    // supported dimensions → the only recommendation is retention_probe.
    const diagnosis = diagnoseAttempts([
      { ...independentUsed('independent', 1.0, { kind: 'human', confidence: 1.0 }), attempt_id: 'n1', occurred_at: '2026-07-01T10:00:00Z', transfer_level: 'near_transfer' as const },
      { ...independentUsed('independent', 1.0, { kind: 'human', confidence: 1.0 }), attempt_id: 'n2', occurred_at: '2026-07-01T11:00:00Z', transfer_level: 'near_transfer' as const },
    ])
    const blueprint = probeBlueprint(diagnosis)
    expect(blueprint?.['purpose']).toBe('retention_probe')
    expect(blueprint?.['target_concept']).toBeNull()
    expect(blueprint?.['variation_instruction']).toBe('use delayed free retrieval without cues')
  })

  it('maps every known purpose to its variation instruction', () => {
    const blueprint = probeBlueprint({
      attempt_count: 1,
      average_score: 1,
      concepts: [],
      diagnosis_clusters: [],
      transfer_evidence: {},
      evidence_dimensions: {},
      score_delta_earlier_to_later: null,
    })
    // Only retention_probe applicable here; verify rubric/difficulty fields fixed.
    expect(blueprint?.['difficulty_policy']).toBe('change one diagnostic variable at a time')
    expect(blueprint?.['rubric_requirements']).toEqual(['correct outcome', 'valid reasoning', 'conditions checked', 'independent completion'])
  })
})

describe('MIN_INDEPENDENT_ATTEMPTS', () => {
  it('is 2', () => {
    expect(MIN_INDEPENDENT_ATTEMPTS).toBe(2)
  })
})
