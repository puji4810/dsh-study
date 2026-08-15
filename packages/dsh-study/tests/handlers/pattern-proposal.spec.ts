import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { handleAttemptActivity } from '../../src/handlers/attempt.ts'
import { handlePatternProposalActivity } from '../../src/handlers/pattern-proposal.ts'
import { env, tempVault, writeProject } from '../helpers.ts'

const iso = '2026-01-15T08:00:00.000Z'

function seedAttempt(vault: string): void {
  handleAttemptActivity('record', {
    project_id: 'demo-project',
    attempt_id: 'att-1',
    item_id: 'item-1',
    occurred_at: '2026-01-15T08:00:00Z',
    response: '42',
    result: 'correct',
  }, env(vault, iso))
}

function proposalArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project_id: 'demo-project',
    proposal: {
      proposal_id: 'proposal-1',
      title: 'Pattern',
      change_type: 'supplement',
      rationale: 'repeated',
      evidence_attempt_ids: ['att-1'],
      ...overrides,
    },
  }
}

describe('handlePatternProposalActivity', () => {
  it('save writes a proposal with defaults', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    seedAttempt(vault)
    const result = handlePatternProposalActivity('save', proposalArgs(), env(vault, iso))
    expect(result.ok).toBe(true)
    if (result.ok) {
      const proposal = result.data['proposal'] as { status: string; schema_version: string }
      expect(proposal['status']).toBe('candidate')
      expect(proposal['schema_version']).toBe('study_pattern_proposal.v1')
      expect(existsSync(join(vault, '.StudyOS', 'projects', 'demo-project', 'pattern-proposals', 'proposal-1.json'))).toBe(true)
    }
  })

  it('save rejects unknown evidence', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handlePatternProposalActivity('save', proposalArgs({ evidence_attempt_ids: ['unknown-att'] }), env(vault, iso))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('EVIDENCE_NOT_FOUND')
  })

  it('save rejects a duplicated proposal', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    seedAttempt(vault)
    handlePatternProposalActivity('save', proposalArgs(), env(vault, iso))
    const result = handlePatternProposalActivity('save', proposalArgs(), env(vault, iso))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('PROPOSAL_EXISTS')
  })

  it('save validates the proposal shape', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    seedAttempt(vault)
    const result = handlePatternProposalActivity('save', proposalArgs({ change_type: 'nope' }), env(vault, iso))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('list and read return proposals', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    seedAttempt(vault)
    handlePatternProposalActivity('save', proposalArgs(), env(vault, iso))
    const list = handlePatternProposalActivity('list', { project_id: 'demo-project' }, env(vault, iso))
    expect(list.ok).toBe(true)
    if (list.ok) expect(list.data['proposals']).toHaveLength(1)
    const read = handlePatternProposalActivity('read', { project_id: 'demo-project', proposal_id: 'proposal-1' }, env(vault, iso))
    expect(read.ok).toBe(true)
  })

  it('read reports a missing proposal', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handlePatternProposalActivity('read', { project_id: 'demo-project', proposal_id: 'missing-1' }, env(vault, iso))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('PROPOSAL_NOT_FOUND')
  })

  it('unknown action returns INVALID_ACTION', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handlePatternProposalActivity('nope', { project_id: 'demo-project' }, env(vault, iso))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_ACTION')
  })
})
