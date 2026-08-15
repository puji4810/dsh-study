import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { handleStudySchedule } from '../../src/handlers/schedule.ts'
import { env, tempVault, writeProject } from '../helpers.ts'

function scheduleData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 'study_schedule.v1',
    schedule_id: 'master-plan',
    project_id: 'demo-project',
    title: 'Plan',
    timezone: 'UTC',
    range: { start: '2026-01-01', end: '2026-01-31' },
    phases: [{ id: 'f', title: 'F', start: '2026-01-01', end: '2026-01-31', goal: 'g' }],
    events: [{
      id: 'e1',
      title: 'E',
      subject_id: 't1',
      type: 'learning',
      start: '2026-01-15T19:00:00Z',
      end: '2026-01-15T20:00:00Z',
      duration_minutes: 60,
      goals: ['g'],
      status: 'planned',
    }],
    ...overrides,
  }
}

describe('handleStudySchedule', () => {
  it('template returns the pack template', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handleStudySchedule({ action: 'template', project_id: 'demo-project' }, env(vault))
    expect(result.ok).toBe(true)
    if (result.ok) expect((result.data['schedule'] as { schema_version: string })['schema_version']).toBe('study_schedule.v1')
  })

  it('validate accepts a valid schedule', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handleStudySchedule({ action: 'validate', project_id: 'demo-project', data: scheduleData() }, env(vault))
    expect(result.ok).toBe(true)
  })

  it('validate rejects an invalid schedule with errors', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const bad = scheduleData({ schema_version: 'nope' })
    const result = handleStudySchedule({ action: 'validate', project_id: 'demo-project', data: bad }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION_FAILED')
      expect(result.error.details?.['errors']).toBeDefined()
    }
  })

  it('save writes the schedule with registration fields', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handleStudySchedule({ action: 'save', project_id: 'demo-project', data: scheduleData() }, env(vault))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data['registered']).toBe(true)
      expect(result.data['panel_discovery']).toBe('automatic_on_next_refresh')
      expect(existsSync(join(vault, '.StudyOS', 'projects', 'demo-project', 'schedules', 'master-plan.json'))).toBe(true)
    }
  })

  it('save rejects a non-object data payload', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handleStudySchedule({ action: 'save', project_id: 'demo-project', data: 'nope' }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('list discovers schedules', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    handleStudySchedule({ action: 'save', project_id: 'demo-project', data: scheduleData() }, env(vault))
    const result = handleStudySchedule({ action: 'list', project_id: 'demo-project' }, env(vault))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data['schedules']).toHaveLength(1)
  })

  it('read returns the schedule and path', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    handleStudySchedule({ action: 'save', project_id: 'demo-project', data: scheduleData() }, env(vault))
    const result = handleStudySchedule({ action: 'read', project_id: 'demo-project', schedule_id: 'master-plan' }, env(vault))
    expect(result.ok).toBe(true)
    if (result.ok) expect((result.data['schedule'] as { schedule_id: string })['schedule_id']).toBe('master-plan')
  })

  it('read reports a missing schedule', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handleStudySchedule({ action: 'read', project_id: 'demo-project', schedule_id: 'missing-plan' }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('SCHEDULE_NOT_FOUND')
  })

  it('unknown action returns INVALID_ACTION', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handleStudySchedule({ action: 'nope' }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_ACTION')
  })
})
