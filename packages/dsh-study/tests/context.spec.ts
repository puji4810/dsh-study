import { describe, expect, it } from 'vitest'

import { MAX_ACTIVE_CONTEXT_CHARS, renderActiveSessionContext } from '../src/context.ts'
import type { LearningSession } from '../src/types.ts'

function session(overrides: Partial<LearningSession> = {}): LearningSession {
  return {
    schema_version: 'learning_session.v1',
    session_id: 'ses-abc',
    project_id: 'learn-math-2026',
    contract: {
      schema_version: 'learning_contract.v1',
      contract_id: 'contract-abc',
      project_id: 'learn-math-2026',
      objective: 'Differentiate polynomials',
      mode: 'learn',
      assistance_level: 'guided',
      time_budget_minutes: 30,
      objective_ids: ['obj-1'],
      evidence_targets: ['execution'],
      created_at: '2026-07-01T00:00:00Z',
    },
    status: 'active',
    started_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    evidence_ids: ['att-1'],
    activity_history: [],
    ...overrides,
  }
}

describe('renderActiveSessionContext', () => {
  it('exports the shared ceiling', () => {
    expect(MAX_ACTIVE_CONTEXT_CHARS).toBe(2800)
  })

  it('renders a prefixed payload with a current activity', () => {
    const s = session({
      current_activity: {
        schema_version: 'study_activity_spec.v1',
        activity_id: 'activity-1',
        session_id: 'ses-abc',
        project_id: 'learn-math-2026',
        kind: 'evidence_probe',
        objective: 'x',
        objective_ids: [],
        evidence_target: 'execution',
        assistance_level: 'guided',
        instructions: 'Produce learner-authored execution evidence',
        response_policy: 'Collect the response',
        rubric_requirements: ['correct'],
        source_anchors: [],
        evidence_requirements: ['evaluator'],
        reason: 'the contract needs execution evidence',
        status: 'pending',
        created_at: '2026-07-01T00:00:00Z',
      },
    })
    const rendered = renderActiveSessionContext(s)
    expect(rendered.startsWith('[StudyOS active learning session — turn-local context]\n')).toBe(true)
    expect(rendered).toContain('"session_id":"ses-abc"')
    expect(rendered).toContain('"state":"continue"')
  })

  it('renders ready_to_finish without a current activity', () => {
    const s = session({})
    const rendered = renderActiveSessionContext(s)
    expect(rendered).toContain('"state":"ready_to_finish"')
  })

  it('falls back to a details-stripped payload when over the ceiling', () => {
    const longInstructions = 'x'.repeat(3000)
    const s = session({
      current_activity: {
        schema_version: 'study_activity_spec.v1',
        activity_id: 'activity-1',
        session_id: 'ses-abc',
        project_id: 'learn-math-2026',
        kind: 'evidence_probe',
        objective: 'x',
        objective_ids: [],
        evidence_target: 'execution',
        assistance_level: 'guided',
        instructions: longInstructions,
        response_policy: 'y',
        rubric_requirements: ['r'.repeat(200), 'r2'.repeat(200), 'r3'.repeat(200)],
        source_anchors: [{ kind: 'file', ref: 'z'.repeat(200), locator: 'l'.repeat(200) }],
        evidence_requirements: ['evaluator'],
        reason: 'r',
        status: 'pending',
        created_at: '2026-07-01T00:00:00Z',
      },
    })
    const rendered = renderActiveSessionContext(s)
    expect(rendered.length).toBeLessThanOrEqual(MAX_ACTIVE_CONTEXT_CHARS)
  })

  it('truncates the objective, instructions, and other fields', () => {
    const s = session({
      contract: {
        ...session({}).contract,
        objective: 'o'.repeat(700),
      },
      current_activity: {
        schema_version: 'study_activity_spec.v1',
        activity_id: 'activity-1',
        session_id: 'ses-abc',
        project_id: 'learn-math-2026',
        kind: 'evidence_probe',
        objective: 'x',
        objective_ids: [],
        evidence_target: 'execution',
        assistance_level: 'guided',
        instructions: 'i'.repeat(700),
        response_policy: 'p'.repeat(400),
        reason: 'r'.repeat(400),
        rubric_requirements: ['rubric'],
        source_anchors: [],
        evidence_requirements: ['evaluator'],
        status: 'pending',
        created_at: '2026-07-01T00:00:00Z',
      },
    })
    const rendered = renderActiveSessionContext(s)
    expect(rendered).not.toContain('o'.repeat(600))
    expect(rendered).toContain('…')
  })
})
