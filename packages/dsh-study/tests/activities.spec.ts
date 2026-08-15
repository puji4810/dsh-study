import { describe, expect, it } from 'vitest'
import {
  APPLIED_EVIDENCE_TARGETS,
  EngineeringActivityAdapter,
  GeneralActivityAdapter,
  ResearchActivityAdapter,
  activityAdapterFor,
  type ActivityAdapter,
  type ActivityContext,
} from '../src/activities.ts'
import type { LearningContract, StudyProject } from '../src/types.ts'

const project = {
  schema_version: 'study_project.v2',
  project_id: 'demo-project',
  title: 'Demo',
  domain: 'general',
  timezone: 'Asia/Shanghai',
  phase: 'foundation',
  domain_pack: 'general.v1',
  workspace_type: 'skill-vault',
  artifact_policy: 'lightweight',
  tracks: [{ id: 't1', label: 'Track' }],
  objectives: [],
  prompt_policy: {
    base_max_chars: 2000,
    intent_max_chars: 2500,
    domain_max_chars: 2000,
    project_summary_max_chars: 1200,
    total_max_chars: 6000,
    updates_apply: 'next_session' as const,
  },
  created_at: '2026-07-01T10:00:00Z',
  updated_at: '2026-07-01T10:00:00Z',
} as unknown as StudyProject

const contract = {
  schema_version: 'learning_contract.v1',
  contract_id: 'contract-1',
  project_id: 'demo-project',
  objective: 'Learn derivatives',
  mode: 'learn' as const,
  assistance_level: 'independent' as const,
  time_budget_minutes: 30,
  evidence_targets: ['execution'],
  created_at: '2026-07-01T10:00:00Z',
} as unknown as LearningContract

function context(overrides: Partial<ActivityContext> = {}): ActivityContext {
  return {
    project,
    contract,
    evidence_target: 'execution',
    recommendation: null,
    success_criteria: ['criterion'],
    source_anchors: [],
    ...overrides,
  }
}

describe('APPLIED_EVIDENCE_TARGETS', () => {
  it('contains the three applied targets', () => {
    expect([...APPLIED_EVIDENCE_TARGETS].sort()).toEqual(['execution', 'far_transfer', 'near_transfer'])
  })
})

describe('GeneralActivityAdapter', () => {
  it('builds evidence_probe fields with the recommendation intervention', () => {
    const adapter = new GeneralActivityAdapter()
    const built = adapter.build(context({ evidence_target: 'recall', recommendation: { priority: 'high', intervention: 'misconception_probe', reason: 'r', evidence_attempt_ids: [] } }))
    expect(built).toEqual({
      activity_adapter: 'general.v1',
      kind: 'misconception_probe',
      instructions: 'Produce learner-authored recall evidence for: Learn derivatives',
      response_policy: "Collect the learner's response before feedback or evaluator judgment.",
      rubric_requirements: ['criterion'],
      evidence_requirements: ['evaluator'],
    })
  })

  it('defaults kind to evidence_probe and rubric to defaults', () => {
    const adapter = new GeneralActivityAdapter()
    const built = adapter.build(context({ evidence_target: 'recall', success_criteria: [] }))
    expect(built['kind']).toBe('evidence_probe')
    expect(built['rubric_requirements']).toEqual(['valid result', 'reasoning made explicit', 'independent contribution identified'])
  })

  it('accepts any observation', () => {
    const adapter = new GeneralActivityAdapter()
    expect(adapter.validateObservation({}, {})).toEqual([])
  })
})

describe('EngineeringActivityAdapter', () => {
  it('maps targets to engineering kinds', () => {
    const adapter = new EngineeringActivityAdapter()
    const cases: Array<[string, string]> = [
      ['recall', 'engineering_retrieval'],
      ['recognition', 'engineering_source_trace'],
      ['execution', 'engineering_execution'],
      ['explanation', 'engineering_invariant_explanation'],
      ['near_transfer', 'engineering_near_transfer'],
      ['far_transfer', 'engineering_design_transfer'],
    ]
    for (const [target, kind] of cases) {
      expect(adapter.build(context({ evidence_target: target }))['kind']).toBe(kind)
    }
  })

  it('falls back to source_trace kind and a default instruction', () => {
    const adapter = new EngineeringActivityAdapter()
    const built = adapter.build(context({ evidence_target: 'unknown_target' }))
    expect(built['kind']).toBe('engineering_source_trace')
    expect(built['instructions']).toBe('Retrieve the engineering concept from the actual source and identify where it controls runtime behavior.')
  })

  it('adds artifact_refs requirement for applied targets only', () => {
    const adapter = new EngineeringActivityAdapter()
    expect(adapter.build(context({ evidence_target: 'execution' }))['evidence_requirements']).toEqual(['evaluator', 'source_anchors', 'artifact_refs'])
    expect(adapter.build(context({ evidence_target: 'recall' }))['evidence_requirements']).toEqual(['evaluator', 'source_anchors'])
  })

  it('uses default rubric when no criteria', () => {
    const adapter = new EngineeringActivityAdapter()
    const built = adapter.build(context({ success_criteria: [] }))
    expect(built['rubric_requirements']).toEqual([
      'source file, symbol, command, or benchmark identified',
      'observable result recorded',
      'controlling invariant explained',
      'verification or failure condition stated',
    ])
  })

  it('requires a source anchor', () => {
    const adapter = new EngineeringActivityAdapter()
    const issues = adapter.validateObservation({ evidence_target: 'recall' }, {})
    expect(issues).toEqual([{
      code: 'SOURCE_ANCHOR_REQUIRED',
      message: 'This activity requires a file, command, paper, dataset, or other source anchor.',
    }])
  })

  it('accepts a source anchor inferred from the activity', () => {
    const adapter = new EngineeringActivityAdapter()
    const activity = { evidence_target: 'recall', source_anchors: [{ kind: 'file', ref: 'x.ts' }] }
    expect(adapter.validateObservation(activity, {})).toEqual([])
  })

  it('requires artifact_refs for applied targets', () => {
    const adapter = new EngineeringActivityAdapter()
    const activity = { evidence_target: 'execution', source_anchors: [{ kind: 'file', ref: 'x.ts' }] }
    expect(adapter.validateObservation(activity, {})).toEqual([{
      code: 'ARTIFACT_REFERENCE_REQUIRED',
      message: 'Applied evidence requires artifact_refs naming reproducible commands, outputs, files, or results.',
    }])
  })

  it('rejects artifact_refs with blank entries', () => {
    const adapter = new EngineeringActivityAdapter()
    const activity = { evidence_target: 'near_transfer', source_anchors: [{ kind: 'file', ref: 'x.ts' }] }
    const issues = adapter.validateObservation(activity, { artifact_refs: ['  '] })
    expect(issues.map(i => i.code)).toContain('ARTIFACT_REFERENCE_REQUIRED')
  })

  it('accepts artifact_refs of non-empty strings', () => {
    const adapter = new EngineeringActivityAdapter()
    const activity = { evidence_target: 'near_transfer', source_anchors: [{ kind: 'file', ref: 'x.ts' }] }
    expect(adapter.validateObservation(activity, { artifact_refs: ['out.txt'] })).toEqual([])
  })

  it('reports both issues when anchors and artifacts are missing', () => {
    const adapter = new EngineeringActivityAdapter()
    const issues = adapter.validateObservation({ evidence_target: 'far_transfer' }, { source_anchors: [] })
    expect(issues.map(i => i.code)).toEqual(['SOURCE_ANCHOR_REQUIRED', 'ARTIFACT_REFERENCE_REQUIRED'])
  })

  it('accepts anchors from observation rather than activity', () => {
    const adapter = new EngineeringActivityAdapter()
    const issues = adapter.validateObservation({ evidence_target: 'recall' }, { source_anchors: [{ kind: 'command', ref: 'make' }] })
    expect(issues).toEqual([])
  })
})

describe('ResearchActivityAdapter', () => {
  it('maps targets to research kinds', () => {
    const adapter = new ResearchActivityAdapter()
    const cases: Array<[string, string]> = [
      ['recall', 'research_claim_retrieval'],
      ['recognition', 'research_source_grounding'],
      ['execution', 'research_replication'],
      ['explanation', 'research_mechanism_explanation'],
      ['near_transfer', 'research_boundary_replication'],
      ['far_transfer', 'research_hypothesis_transfer'],
    ]
    for (const [target, kind] of cases) {
      expect(adapter.build(context({ evidence_target: target }))['kind']).toBe(kind)
    }
  })

  it('falls back to source_grounding kind', () => {
    const adapter = new ResearchActivityAdapter()
    expect(adapter.build(context({ evidence_target: 'odd' }))['kind']).toBe('research_source_grounding')
  })

  it('adds artifact_refs for applied targets and uses default rubric', () => {
    const adapter = new ResearchActivityAdapter()
    const built = adapter.build(context({ evidence_target: 'far_transfer', success_criteria: [] }))
    expect(built['evidence_requirements']).toEqual(['evaluator', 'source_anchors', 'artifact_refs'])
    expect(built['rubric_requirements']).toEqual([
      'claim and exact source location identified',
      'method and environment recorded',
      'observed result distinguished from interpretation',
      'uncertainty, assumption, or limitation stated',
    ])
  })

  it('validates grounding like engineering', () => {
    const adapter = new ResearchActivityAdapter()
    expect(adapter.validateObservation({ evidence_target: 'execution' }, { source_anchors: [] })).toEqual([
      { code: 'SOURCE_ANCHOR_REQUIRED', message: 'This activity requires a file, command, paper, dataset, or other source anchor.' },
      { code: 'ARTIFACT_REFERENCE_REQUIRED', message: 'Applied evidence requires artifact_refs naming reproducible commands, outputs, files, or results.' },
    ])
  })
})

describe('activityAdapterFor', () => {
  it('returns a GeneralActivityAdapter for a general project', () => {
    expect(activityAdapterFor(project)).toBeInstanceOf(GeneralActivityAdapter)
  })

  it('returns an adapter of the base type', () => {
    const adapter: ActivityAdapter = activityAdapterFor(project)
    expect(adapter.name).toBe('general.v1')
  })
})
