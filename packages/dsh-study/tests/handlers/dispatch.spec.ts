import { describe, expect, it } from 'vitest'

import { dispatchStudyActivity, mergePayload, scheduleRequest } from '../../src/handlers/dispatch.ts'
import { env, tempVault, writeProject } from '../helpers.ts'

const iso = '2026-01-15T08:00:00Z'

describe('mergePayload', () => {
  it('merges data and lifts vault_path/project_id', () => {
    const result = mergePayload({ data: { a: 1, project_id: 'x' }, vault_path: '/v', project_id: 'p', action: 'y' })
    expect(result).toEqual({ a: 1, project_id: 'p', vault_path: '/v' })
  })

  it('tolerates a non-object data', () => {
    expect(mergePayload({ data: 'nope', project_id: 'p' })).toEqual({ project_id: 'p' })
    expect(mergePayload({})).toEqual({})
  })
})

describe('scheduleRequest', () => {
  it('passes non-validate/save actions through', () => {
    expect(scheduleRequest('list', { project_id: 'p' })).toEqual({ project_id: 'p', action: 'list' })
  })

  it('adapts a nested schedule for validate/save', () => {
    const payload = { schedule: { schedule_id: 's' }, vault_path: '/v', project_id: 'p' }
    expect(scheduleRequest('validate', payload)).toEqual({ action: 'validate', data: { schedule_id: 's' }, vault_path: '/v', project_id: 'p' })
  })

  it('adapts nested data and falls back to top-level keys', () => {
    expect(scheduleRequest('save', { data: { schedule_id: 's' }, project_id: 'p' })).toEqual({ action: 'save', data: { schedule_id: 's' }, project_id: 'p' })
    expect(scheduleRequest('save', { schedule_id: 's', project_id: 'p', action: 'ignored' })).toEqual({ action: 'save', data: { schedule_id: 's', project_id: 'p' }, project_id: 'p' })
  })
})

describe('dispatchStudyActivity', () => {
  it('routes attempt', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = dispatchStudyActivity({
      resource: 'attempt', action: 'record', project_id: 'demo-project',
      data: { result: 'correct', response: 'x', item_id: 'i', occurred_at: '2026-01-15T08:00:00Z' },
    }, env(vault, iso))
    expect(result.ok).toBe(true)
  })

  it('routes project status', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = dispatchStudyActivity({ resource: 'project', action: 'status', project_id: 'demo-project' }, env(vault, iso))
    expect(result.ok).toBe(true)
  })

  it('routes schedule template', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = dispatchStudyActivity({ resource: 'schedule', action: 'template', project_id: 'demo-project' }, env(vault, iso))
    expect(result.ok).toBe(true)
  })

  it('routes prompt_context (invalid intent)', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = dispatchStudyActivity({ resource: 'prompt_context', action: 'load', project_id: 'demo-project', data: { intent: 'nope' } }, env(vault, iso))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_INTENT')
  })

  it('routes session log', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = dispatchStudyActivity({ resource: 'session', action: 'log', project_id: 'demo-project', data: { occurred_on: '2026-01-15' } }, env(vault, iso))
    expect(result.ok).toBe(true)
  })

  it('routes memory sync', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = dispatchStudyActivity({ resource: 'memory', action: 'sync', project_id: 'demo-project' }, env(vault, iso))
    expect(result.ok).toBe(true)
  })

  it('routes error log', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = dispatchStudyActivity({ resource: 'error', action: 'record', project_id: 'demo-project', data: { title: 'x' } }, env(vault, iso))
    expect(result.ok).toBe(true)
  })

  it('routes concept graph', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = dispatchStudyActivity({ resource: 'concept', action: 'graph' }, env(vault, iso))
    expect(result.ok).toBe(true)
  })

  it('routes note list', () => {
    const vault = tempVault()
    const result = dispatchStudyActivity({ resource: 'note', action: 'list' }, env(vault, iso))
    expect(result.ok).toBe(true)
  })

  it('routes review due', () => {
    const vault = tempVault()
    const result = dispatchStudyActivity({ resource: 'review', action: 'due' }, env(vault, iso))
    expect(result.ok).toBe(true)
  })

  it('throws INVALID_RESOURCE_ACTION for unknown resources', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = dispatchStudyActivity({ resource: 'definitely_unknown', action: 'list' }, env(vault, iso))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_RESOURCE_ACTION')
  })

  it('maps an unexpected throw to STUDY_ACTIVITY_FAILED', () => {
    const result = dispatchStudyActivity({ resource: 'attempt', action: 'record', project_id: 'demo-project' }, env(joinMissing()))
    expect(result.ok).toBe(false)
  })
})

function joinMissing(): string {
  return '/definitely/missing/vault/path'
}
