import { describe, expect, it } from 'vitest'

import { PROMPT_OPERATION_GUIDES } from '../src/guides.ts'

describe('PROMPT_OPERATION_GUIDES', () => {
  it('exposes the seven intent keys in ladder order', () => {
    const keys = Object.keys(PROMPT_OPERATION_GUIDES)
    expect(keys).toEqual([
      'planning',
      'schedule_adjustment',
      'organizing',
      'reviewing',
      'teaching',
      'assessment',
      'error_analysis',
    ])
  })

  it('records planning operations verbatim', () => {
    const guide = PROMPT_OPERATION_GUIDES.planning
    expect(guide).toEqual([
      { tool: 'study_activity', operation: 'project.status' },
      { tool: 'study_activity', operation: 'curriculum.list' },
      { tool: 'study_activity', operation: 'schedule.list|read|template' },
      {
        tool: 'study_activity',
        operation: 'schedule.validate|save',
        data: 'complete study_schedule.v1 object returned from template',
      },
      {
        tool: 'study_coach',
        action: 'prioritize|propose_plan',
        data_fields: [
          'max_items?',
          'as_of?',
          'scheduling?{target_date?,windows?[],busy?[],break_minutes?,max_minutes?,allow_duration_adjustment?,min_duration_minutes?,intervention_order?[],defer_intervention_ids?[],placements?[]}',
        ],
      },
      {
        tool: 'study_activity',
        operation: 'plan_proposal.ensure_today|list|read|save|accept|reject|apply',
      },
      {
        tool: 'study_coach',
        action: 'start_intervention',
        data_fields: ['proposal_id', 'intervention_id', 'session_id?', 'execution?{time_budget_minutes?,assistance_level?}'],
      },
    ])
  })

  it('records the remaining intents verbatim', () => {
    const scheduleAdjustment = PROMPT_OPERATION_GUIDES.schedule_adjustment
    expect(scheduleAdjustment).toHaveLength(4)
    expect(scheduleAdjustment?.[0]).toEqual({ tool: 'study_activity', operation: 'project.status' })
    expect(scheduleAdjustment?.[3]?.['action']).toBe('prioritize|propose_plan')

    const organizing = PROMPT_OPERATION_GUIDES.organizing
    expect(organizing?.[0]).toEqual({
      tool: 'study_activity',
      operation: 'note.list|read|extract',
      data_fields: ['note', 'folder', 'query', 'include_body'],
    })

    const reviewing = PROMPT_OPERATION_GUIDES.reviewing
    expect(reviewing).toHaveLength(3)
    expect(reviewing?.[0]?.['operation']).toBe('review.due')

    const teaching = PROMPT_OPERATION_GUIDES.teaching
    expect(teaching).toHaveLength(6)
    expect(teaching?.[2]?.['tool']).toBe('study_coach')

    const assessment = PROMPT_OPERATION_GUIDES.assessment
    expect(assessment?.[0]?.['operation']).toBe('attempt.record|list|read')

    const errorAnalysis = PROMPT_OPERATION_GUIDES.error_analysis
    expect(errorAnalysis).toHaveLength(3)
    expect(errorAnalysis?.[1]).toEqual({ tool: 'study_activity', operation: 'error.record|review.create_task' })
  })

  it('freezes nothing structurally, but key lookup is deterministic', () => {
    expect(PROMPT_OPERATION_GUIDES['planning']).toBe(PROMPT_OPERATION_GUIDES.planning)
    expect(PROMPT_OPERATION_GUIDES['nope']).toBeUndefined()
  })
})
