import { describe, expect, it } from 'vitest'

import { handleStudyCoach } from '../../src/handlers/coach.ts'
import { handlePlanProposalActivity } from '../../src/handlers/plan-proposal.ts'
import type { StudySchedule } from '../../src/types.ts'
import { env, tempVault, writeProject, writeSchedule } from '../helpers.ts'

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

  it('starts an accepted Intervention and records its provenance on evidence', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const schedule: StudySchedule = {
      schema_version: 'study_schedule.v1',
      schedule_id: 'demo-schedule',
      project_id: 'demo-project',
      title: 'Demo Schedule',
      timezone: 'UTC',
      range: { start: '2026-01-01', end: '2026-01-31' },
      phases: [{ id: 'phase-one', title: 'Phase One', start: '2026-01-01', end: '2026-01-31', goal: 'Learn' }],
      events: [],
    }
    writeSchedule(vault, 'demo-project', schedule)
    const e = env(vault, iso)
    const ensured = handlePlanProposalActivity('ensure_today', {
      project_id: 'demo-project',
      as_of: iso,
      scheduling: {
        windows: [{ start: '09:00', end: '10:00' }],
        max_minutes: 20,
        allow_duration_adjustment: true,
        min_duration_minutes: 15,
      },
    }, e)
    expect(ensured.ok).toBe(true)
    if (!ensured.ok) return
    const proposal = ensured.data['proposal'] as Record<string, unknown>
    const proposalId = String(proposal['proposal_id'])
    const item = (proposal['items'] as Array<Record<string, unknown>>)[0]!
    const interventionId = String(item['intervention_id'])
    const accepted = handlePlanProposalActivity('accept', {
      project_id: 'demo-project',
      proposal_id: proposalId,
      decided_at: iso,
    }, e)
    expect(accepted.ok).toBe(true)

    const started = handleStudyCoach({
      action: 'start_intervention',
      project_id: 'demo-project',
      data: {
        session_id: 'ses-intervention',
        proposal_id: proposalId,
        intervention_id: interventionId,
        execution: { assistance_level: 'independent' },
      },
    }, e)
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(started.data['proposal_id']).toBe(proposalId)
    expect(started.data['intervention_id']).toBe(interventionId)
    expect(started.data['planned_event']).toMatchObject({ duration_minutes: 20 })
    expect(started.data['execution_adjustments']).toMatchObject({
      time_budget_source: 'day_plan_event',
      assistance_source: 'execution_override',
    })
    expect((started.data['session'] as { contract: Record<string, unknown> }).contract).toMatchObject({
      time_budget_minutes: 20,
      assistance_level: 'independent',
    })
    expect(started.data['next_activity']).toMatchObject({
      intervention_kind: item['kind'],
      source_plan_proposal_id: proposalId,
      source_intervention_id: interventionId,
    })

    const advanced = handleStudyCoach({
      action: 'advance',
      project_id: 'demo-project',
      data: {
        session_id: 'ses-intervention',
        observation: {
          response: 'answer',
          result: 'correct',
          evaluator: { kind: 'agent' },
          duration_seconds: 300,
        },
      },
    }, e)
    expect(advanced.ok).toBe(true)
    if (!advanced.ok) return
    expect(advanced.data['evidence']).toMatchObject({
      intervention_kind: item['kind'],
      source_plan_proposal_id: proposalId,
      source_intervention_id: interventionId,
    })
  })

  it('refuses to start an Intervention before the proposal is accepted', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const e = env(vault, iso)
    const ensured = handlePlanProposalActivity('ensure_today', { project_id: 'demo-project', as_of: iso }, e)
    expect(ensured.ok).toBe(true)
    if (!ensured.ok) return
    const proposal = ensured.data['proposal'] as Record<string, unknown>
    const result = handleStudyCoach({
      action: 'start_intervention',
      project_id: 'demo-project',
      data: {
        proposal_id: String(proposal['proposal_id']),
        intervention_id: String((proposal['items'] as Array<Record<string, unknown>>)[0]!['intervention_id']),
      },
    }, e)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('PROPOSAL_NOT_ACCEPTED')
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

  it('propose_plan accepts custom scheduling preferences', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    writeSchedule(vault, 'demo-project', {
      schema_version: 'study_schedule.v1',
      schedule_id: 'demo-schedule',
      project_id: 'demo-project',
      title: 'Demo Schedule',
      timezone: 'UTC',
      range: { start: '2026-01-01', end: '2026-01-31' },
      phases: [{ id: 'phase-one', title: 'Phase One', start: '2026-01-01', end: '2026-01-31', goal: 'Learn' }],
      events: [],
    })
    const result = handleStudyCoach({
      action: 'propose_plan',
      scope: 'project',
      project_id: 'demo-project',
      data: { scheduling: { windows: [{ start: '09:00', end: '10:00' }], break_minutes: 5 } },
    }, env(vault, iso))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const proposal = result.data['proposal'] as Record<string, unknown>
    const dayPlan = proposal['day_plan'] as Record<string, unknown>
    expect(dayPlan['study_window']).toMatchObject({ source: 'custom', start_hour: 9, end_hour: 9 })
    expect(dayPlan['scheduling']).toMatchObject({ mode: 'custom', break_minutes: 5 })
  })

  it('rejects malformed scheduling preferences as validation errors', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handleStudyCoach({
      action: 'propose_plan',
      scope: 'project',
      project_id: 'demo-project',
      data: { scheduling: { windows: [{ start: '20:00', end: '19:00' }] } },
    }, env(vault, iso))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED')
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
