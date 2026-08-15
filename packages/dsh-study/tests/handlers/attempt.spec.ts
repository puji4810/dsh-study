import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { handleAttemptActivity, recordAttempt } from '../../src/handlers/attempt.ts'
import { env, tempVault, writeProject } from '../helpers.ts'

const iso = '2026-01-15T08:00:00.000Z'

function attemptArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project_id: 'demo-project',
    attempt_id: 'att-1',
    item_id: 'item-1',
    occurred_at: '2026-01-15T08:00:00Z',
    response: '42',
    result: 'correct',
    ...overrides,
  }
}

describe('handleAttemptActivity', () => {
  it('record writes an attempt with a default score and id', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handleAttemptActivity('record', { project_id: 'demo-project', result: 'partial', response: 'x', occurred_at: '2026-01-15T08:00:00Z', item_id: 'i' }, env(vault, iso))
    expect(result.ok).toBe(true)
    if (result.ok) {
      const attempt = result.data['attempt'] as { score: number; attempt_id: string }
      expect(attempt['score']).toBe(0.5)
      expect(String(attempt['attempt_id']).startsWith('att-')).toBe(true)
      expect(result.data['path']).toContain('attempts-2026-01.jsonl')
    }
  })

  it('record rejects an invalid attempt', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handleAttemptActivity('record', { project_id: 'demo-project', result: 'invalid', response: 'x' }, env(vault, iso))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('record deduplicates by attempt_id', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const a = attemptArgs()
    handleAttemptActivity('record', { ...a, attempt_id: 'att-dup' }, env(vault, iso))
    const result = handleAttemptActivity('record', { ...a, attempt_id: 'att-dup' }, env(vault, iso))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('ATTEMPT_EXISTS')
  })

  it('list returns the last N attempts', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    for (let i = 1; i <= 3; i += 1) {
      handleAttemptActivity('record', { ...attemptArgs(), attempt_id: `att-${i}`, occurred_at: `2026-01-15T0${i}:00:00Z` }, env(vault, iso))
    }
    const result = handleAttemptActivity('list', { project_id: 'demo-project', limit: 2 }, env(vault, iso))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data['count']).toBe(3)
      expect(result.data['attempts']).toHaveLength(2)
    }
  })

  it('list clamps limit to 1..500', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handleAttemptActivity('list', { project_id: 'demo-project', limit: 9999 }, env(vault, iso))
    expect(result.ok).toBe(true)
    const zero = handleAttemptActivity('list', { project_id: 'demo-project', limit: 0 }, env(vault, iso))
    expect(zero.ok).toBe(true)
  })

  it('read returns an attempt by id or not found', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    handleAttemptActivity('record', attemptArgs(), env(vault, iso))
    const found = handleAttemptActivity('read', { project_id: 'demo-project', attempt_id: 'att-1' }, env(vault, iso))
    expect(found.ok).toBe(true)
    const missing = handleAttemptActivity('read', { project_id: 'demo-project', attempt_id: 'nope' }, env(vault, iso))
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('ATTEMPT_NOT_FOUND')
  })

  it('unknown action returns INVALID_ACTION', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handleAttemptActivity('nope', {}, env(vault, iso))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_ACTION')
  })

  it('recordAttempt returns an envelope for a missing vault', () => {
    const vault = tempVault()
    const result = recordAttempt({ project_id: 'demo-project', result: 'correct' }, env(join(vault, 'missing')))
    expect(result.ok).toBe(false)
  })
})
