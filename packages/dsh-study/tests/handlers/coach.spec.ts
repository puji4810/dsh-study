import { describe, expect, it } from 'vitest'

import { handleStudyCoach } from '../../src/handlers/coach.ts'
import { env, tempVault, writeProject } from '../helpers.ts'

const iso = '2026-01-15T08:00:00Z'

function contract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 'learning_contract.v1',
    contract_id: 'contract-1',
    project_id: 'demo-project',
    objective: 'Learn derivatives',
    mode: 'learn',
    assistance_level: 'independent',
    time_budget_minutes: 30,
    objective_ids: ['obj-1'],
    evidence_targets: ['recall'],
    created_at: '2026-01-15T08:00:00Z',
    ...overrides,
  }
}

describe('handleStudyCoach session lifecycle', () => {
  it('generates contract and activity timestamps when start omits created_at', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')

    const start = handleStudyCoach({
      action: 'start',
      project_id: 'demo-project',
      data: { session_id: 'ses-clock', contract: contract({ created_at: undefined }) },
    }, env(vault, iso))

    expect(start.ok).toBe(true)
    if (!start.ok) return
    const session = start.data['session'] as { contract: { created_at: string }; current_activity: { created_at: string } }
    expect(session.contract.created_at).toBe(iso)
    expect(session.current_activity.created_at).toBe(iso)
  })

  it('runs start -> advance -> snapshot -> finish end to end', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const e = env(vault, iso)

    const start = handleStudyCoach({ action: 'start', project_id: 'demo-project', data: { session_id: 'ses-abc', contract: contract() } }, e)
    expect(start.ok).toBe(true)
    if (start.ok) {
      const session = start.data['session'] as { session_id: string }
      expect(session['session_id']).toBe('ses-abc')
      expect(start.data['next_activity']).toBeDefined()
    }

    const advance = handleStudyCoach({ action: 'advance', project_id: 'demo-project', data: {
      session_id: 'ses-abc',
      observation: {
        response: '42',
        result: 'correct',
        evaluator: { kind: 'agent' },
        transfer_level: 'recall',
        duration_seconds: 300,
      },
    } }, e)
    expect(advance.ok).toBe(true)

    const snapshot = handleStudyCoach({ action: 'snapshot', project_id: 'demo-project', data: { session_id: 'ses-abc' } }, e)
    expect(snapshot.ok).toBe(true)

    const finish = handleStudyCoach({ action: 'finish', project_id: 'demo-project', data: { session_id: 'ses-abc' } }, e)
    expect(finish.ok).toBe(true)
    if (finish.ok) expect(finish.data['outcome']).toBeDefined()
  })

  it('start rejects a duplicate conversation binding via a second start with same conversation', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const e = env(vault, iso)
    const first = handleStudyCoach({ action: 'start', project_id: 'demo-project', data: { session_id: 'ses-abc', contract: contract() } }, e)
    expect(first.ok).toBe(true)
    const second = handleStudyCoach({ action: 'start', project_id: 'demo-project', data: { session_id: 'ses-abc', contract: contract() } }, e)
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error.code).toBe('SESSION_EXISTS')
  })
})

describe('handleStudyCoach analysis actions', () => {
  it('diagnose on project scope returns a diagnosis', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handleStudyCoach({ action: 'diagnose', scope: 'project', project_id: 'demo-project' }, env(vault, iso))
    expect(result.ok).toBe(true)
    if (result.ok) expect((result.data['diagnosis'] as { attempt_count: number })['attempt_count']).toBe(0)
  })

  it('summarize returns a summary', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handleStudyCoach({ action: 'summarize', scope: 'project', project_id: 'demo-project' }, env(vault, iso))
    expect(result.ok).toBe(true)
    if (result.ok) expect((result.data['summary'] as { attempt_count: number })['attempt_count']).toBe(0)
  })

  it('recommend returns recommendations and diagnosis', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handleStudyCoach({ action: 'recommend', scope: 'project', project_id: 'demo-project' }, env(vault, iso))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data['diagnosis']).toBeDefined()
  })

  it('propose_pattern returns candidate proposals', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handleStudyCoach({ action: 'propose_pattern', scope: 'project', project_id: 'demo-project' }, env(vault, iso))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data['policy']).toBeDefined()
  })

  it('generate_probe with no attempts reports INSUFFICIENT_EVIDENCE', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handleStudyCoach({ action: 'generate_probe', scope: 'project', project_id: 'demo-project' }, env(vault, iso))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INSUFFICIENT_EVIDENCE')
  })

  it('prioritize returns an intervention queue', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handleStudyCoach({ action: 'prioritize', scope: 'project', project_id: 'demo-project' }, env(vault, iso))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data['intervention_queue']).toBeDefined()
  })

  it('evaluate_adherence requires project scope', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const bad = handleStudyCoach({ action: 'evaluate_adherence', scope: 'session', project_id: 'demo-project' }, env(vault, iso))
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.code).toBe('INVALID_SCOPE')
    const good = handleStudyCoach({ action: 'evaluate_adherence', scope: 'project', project_id: 'demo-project' }, env(vault, iso))
    expect(good.ok).toBe(true)
    if (good.ok) expect(good.data['plan_adherence']).toBeDefined()
  })

  it('evaluate_adherence validates the date range', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const e = env(vault, iso)
    const badRange = handleStudyCoach({ action: 'evaluate_adherence', scope: 'project', project_id: 'demo-project', data: { start_date: '2026-02-01', end_date: '2026-01-01' } }, e)
    expect(badRange.ok).toBe(false)
    if (!badRange.ok) expect(badRange.error.code).toBe('VALIDATION_FAILED')
    const badDate = handleStudyCoach({ action: 'evaluate_adherence', scope: 'project', project_id: 'demo-project', data: { start_date: 'nope' } }, e)
    expect(badDate.ok).toBe(false)
  })

  it('evaluate_interventions requires project scope', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const bad = handleStudyCoach({ action: 'evaluate_interventions', scope: 'concept', project_id: 'demo-project' }, env(vault, iso))
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.code).toBe('INVALID_SCOPE')
    const good = handleStudyCoach({ action: 'evaluate_interventions', scope: 'project', project_id: 'demo-project' }, env(vault, iso))
    expect(good.ok).toBe(true)
    if (good.ok) expect(good.data['intervention_outcomes']).toBeDefined()
  })

  it('session scope requires a filter', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handleStudyCoach({ action: 'diagnose', scope: 'session', project_id: 'demo-project', data: {} }, env(vault, iso))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('MISSING_SCOPE_FILTER')
  })

  it('concept scope requires a concept', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handleStudyCoach({ action: 'diagnose', scope: 'concept', project_id: 'demo-project', data: {} }, env(vault, iso))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('MISSING_SCOPE_FILTER')
  })

  it('week scope defaults to Monday through today', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    // 2026-01-15 is a Thursday; Monday is 2026-01-12.
    const result = handleStudyCoach({ action: 'diagnose', scope: 'week', project_id: 'demo-project' }, env(vault, '2026-01-15T08:00:00Z'))
    expect(result.ok).toBe(true)
  })

  it('unknown action returns INVALID_ACTION', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handleStudyCoach({ action: 'nope', scope: 'project', project_id: 'demo-project' }, env(vault, iso))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_ACTION')
  })
})

describe('handleStudyCoach coverage complement', () => {
  it('propose_plan returns a proposal', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handleStudyCoach({ action: 'propose_plan', scope: 'project', project_id: 'demo-project' }, env(vault, iso))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data['proposal']).toBeDefined()
      expect(result.data['intervention_queue']).toBeDefined()
    }
  })

  it('propose_plan requires project scope', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handleStudyCoach({ action: 'propose_plan', scope: 'concept', project_id: 'demo-project' }, env(vault, iso))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_SCOPE')
  })

  it('prioritize requires project scope', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handleStudyCoach({ action: 'prioritize', scope: 'week', project_id: 'demo-project' }, env(vault, iso))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_SCOPE')
  })

  it('evaluate_adherence with explicit valid dates', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handleStudyCoach({ action: 'evaluate_adherence', scope: 'project', project_id: 'demo-project', data: { start_date: '2026-01-01', end_date: '2026-01-14' } }, env(vault, iso))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data['capacity']).toBeDefined()
  })

  it('evaluate_adherence with invalid dates', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handleStudyCoach({ action: 'evaluate_adherence', scope: 'project', project_id: 'demo-project', data: { start_date: 'not-a-date' } }, env(vault, iso))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('evaluate_interventions with no proposals', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handleStudyCoach({ action: 'evaluate_interventions', scope: 'project', project_id: 'demo-project' }, env(vault, iso))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect((result.data['intervention_outcomes'] as { by_kind: unknown[] })['by_kind']).toEqual([])
      expect(result.data['calibration']).toEqual([])
    }
  })

  it('mapping a StudyOSError passthrough', () => {
    const result = handleStudyCoach({ action: 'diagnose', scope: 'project', project_id: 'demo-project' }, env('/missing/vault'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('NOT_FOUND')
  })
})
