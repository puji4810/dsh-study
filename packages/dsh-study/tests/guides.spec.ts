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
        tool: 'study_activity',
        operation: 'plan_proposal.ensure_today|list|read|save|accept|reject|apply',
      },
    ])
  })

  it('records the remaining intents verbatim', () => {
    const scheduleAdjustment = PROMPT_OPERATION_GUIDES.schedule_adjustment
    expect(scheduleAdjustment).toHaveLength(3)
    expect(scheduleAdjustment?.[0]).toEqual({ tool: 'study_activity', operation: 'project.status' })

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
    expect(teaching).toHaveLength(5)
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
