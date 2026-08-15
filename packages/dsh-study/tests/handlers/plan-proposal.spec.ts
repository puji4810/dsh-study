import { describe, expect, it } from 'vitest'

import { handlePlanProposalActivity } from '../../src/handlers/plan-proposal.ts'
import { interventionOrchestration } from '../../src/handlers/coach.ts'
import { InterventionOrchestrator } from '../../src/interventions.ts'
import type { DayPlan, InterventionItem, StudyData, StudyProject } from '../../src/types.ts'
import { env, tempVault, writeProject } from '../helpers.ts'

const iso = '2026-01-15T08:00:00Z'

async function deriveProposal(vault: string): Promise<{ proposal: StudyData; project: StudyProject }> {
  // Read the manifest through the handler layer for a validated project.
  const { readProjectManifest } = await import('../../src/vault.ts')
  const project = readProjectManifest(vault, 'demo-project')
  const orchestration = interventionOrchestration(vault, project, { as_of: iso }, env(vault, iso))
  return { proposal: orchestration.proposal as unknown as StudyData, project }
}

async function saveBase(vault: string): Promise<StudyData> {
  const { proposal } = await deriveProposal(vault)
  const result = handlePlanProposalActivity('save', { project_id: 'demo-project', proposal }, env(vault, iso))
  if (!result.ok) throw new Error(JSON.stringify(result))
  return result.data['proposal'] as StudyData
}

describe('handlePlanProposalActivity', () => {
  it('save creates a derived proposal then is idempotent', async () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const { proposal } = await deriveProposal(vault)
    const first = handlePlanProposalActivity('save', { project_id: 'demo-project', proposal }, env(vault, iso))
    expect(first.ok).toBe(true)
    const second = handlePlanProposalActivity('save', { project_id: 'demo-project', proposal }, env(vault, iso))
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.data['created']).toBe(false)
  })

  it('save rejects a non-proposed status', async () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const { proposal } = await deriveProposal(vault)
    const result = handlePlanProposalActivity('save', { project_id: 'demo-project', proposal: { ...proposal, status: 'accepted' } }, env(vault, iso))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_PROPOSAL_TRANSITION')
  })

  it('save rejects a fingerprint mismatch', async () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const { proposal } = await deriveProposal(vault)
    // A fingerprint that passes the proposal_id derivation check but does not
    // match the semantic content triggers the mismatch path.
    const fakeFingerprint = 'ab'.repeat(32)
    const tampered = { ...proposal, generation_fingerprint: fakeFingerprint, proposal_id: `plan-${fakeFingerprint.slice(0, 20)}` }
    const result = handlePlanProposalActivity('save', { project_id: 'demo-project', proposal: tampered }, env(vault, iso))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('PROPOSAL_FINGERPRINT_MISMATCH')
  })

  it('save rejects unknown objectives (v2)', async () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const { proposal, project } = await deriveProposal(vault)
    const items = (proposal['items'] as InterventionItem[]).map(item => ({ ...item, objective_id: 'unknown-obj' }))
    const fingerprint = InterventionOrchestrator.fingerprint({ project, items, dayPlan: proposal['day_plan'] as DayPlan | null })
    const tampered = { ...proposal, items, generation_fingerprint: fingerprint, proposal_id: `plan-${fingerprint.slice(0, 20)}` }
    const result = handlePlanProposalActivity('save', { project_id: 'demo-project', proposal: tampered }, env(vault, iso))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('OBJECTIVE_NOT_FOUND')
  })

  it('save rejects unknown evidence', async () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const { proposal, project } = await deriveProposal(vault)
    const items = (proposal['items'] as InterventionItem[]).map(item => ({ ...item, evidence_attempt_ids: ['unknown-att'] }))
    const fingerprint = InterventionOrchestrator.fingerprint({ project, items, dayPlan: proposal['day_plan'] as DayPlan | null })
    const tampered = {
      ...proposal,
      items,
      evidence_attempt_ids: ['unknown-att'],
      generation_fingerprint: fingerprint,
      proposal_id: `plan-${fingerprint.slice(0, 20)}`,
    }
    const result = handlePlanProposalActivity('save', { project_id: 'demo-project', proposal: tampered }, env(vault, iso))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('EVIDENCE_NOT_FOUND')
  })

  it('validate and accept/reject the state machine', async () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const saved = await saveBase(vault)
    const proposalId = String(saved['proposal_id'])

    const accept = handlePlanProposalActivity('accept', { project_id: 'demo-project', proposal_id: proposalId }, env(vault, iso))
    expect(accept.ok).toBe(true)
    if (accept.ok) {
      expect(accept.data['changed']).toBe(true)
      expect(accept.data['schedule_mutated']).toBe(false)
      expect(String(accept.data['schedule_policy']).length).toBeGreaterThan(0)
    }

    const acceptAgain = handlePlanProposalActivity('accept', { project_id: 'demo-project', proposal_id: proposalId }, env(vault, iso))
    expect(acceptAgain.ok).toBe(true)
    if (acceptAgain.ok) expect(acceptAgain.data['changed']).toBe(false)

    const reject = handlePlanProposalActivity('reject', { project_id: 'demo-project', proposal_id: proposalId }, env(vault, iso))
    expect(reject.ok).toBe(false)
    if (!reject.ok) expect(reject.error.code).toBe('INVALID_PROPOSAL_TRANSITION')
  })

  it('read and read-missing', async () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const saved = await saveBase(vault)
    const read = handlePlanProposalActivity('read', { project_id: 'demo-project', proposal_id: String(saved['proposal_id']) }, env(vault, iso))
    expect(read.ok).toBe(true)
    const missing = handlePlanProposalActivity('read', { project_id: 'demo-project', proposal_id: 'missing-proposal-id' }, env(vault, iso))
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('PROPOSAL_NOT_FOUND')
  })

  it('list with and without status', async () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    await saveBase(vault)
    const list = handlePlanProposalActivity('list', { project_id: 'demo-project' }, env(vault, iso))
    expect(list.ok).toBe(true)
    if (list.ok) expect(list.data['proposals']).toHaveLength(1)
    const bad = handlePlanProposalActivity('list', { project_id: 'demo-project', status: 'nope' }, env(vault, iso))
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.code).toBe('VALIDATION_FAILED')
  })

  it('apply on a non-accepted proposal reports PROPOSAL_NOT_ACCEPTED', async () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const saved = await saveBase(vault)
    const result = handlePlanProposalActivity('apply', { project_id: 'demo-project', proposal_id: String(saved['proposal_id']) }, env(vault, iso))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('PROPOSAL_NOT_ACCEPTED')
  })

  it('ensure_today derives then is idempotent', async () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const first = handlePlanProposalActivity('ensure_today', { project_id: 'demo-project', as_of: iso }, env(vault, iso))
    expect(first.ok).toBe(true)
    const second = handlePlanProposalActivity('ensure_today', { project_id: 'demo-project', as_of: iso }, env(vault, iso))
    expect(second.ok).toBe(true)
    if (second.ok) {
      expect(second.data['created']).toBe(false)
      expect(second.data['reason']).toBe('a proposed plan already exists for this date')
    }
  })

  it('unknown action returns INVALID_ACTION', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handlePlanProposalActivity('nope', { project_id: 'demo-project' }, env(vault, iso))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_ACTION')
  })
})

describe('handlePlanProposalActivity coverage complement', () => {
  it('save conflicts on different content for the same id', async () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const { proposal } = await deriveProposal(vault)
    const realGfp = String(proposal['generation_fingerprint'])
    const id = String(proposal['proposal_id'])
    // Write a valid file at the same proposal id whose fingerprint shares the first
    // 20 chars (so the id still derives from it) but differs in the tail.
    const { writeFileSync, mkdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = join(vault, '.StudyOS', 'projects', 'demo-project', 'plan-proposals')
    mkdirSync(dir, { recursive: true })
    const clashingGfp = `${realGfp.slice(0, 20)}${'f'.repeat(44)}`
    const strip = (s: unknown): string => String(s).replace(/\.\d{3}Z$/, 'Z')
    const clashing = {
      ...proposal,
      genesis: undefined,
      generation_fingerprint: clashingGfp,
      proposal_id: id,
      created_at: strip(proposal['created_at']),
      as_of: strip(proposal['as_of']),
    }
    writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(clashing, null, 2)}\n`)
    const result = handlePlanProposalActivity('save', { project_id: 'demo-project', proposal }, env(vault, iso))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('PROPOSAL_CONFLICT')
  })

  it('apply on a missing proposal reports PROPOSAL_NOT_FOUND', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handlePlanProposalActivity('apply', { project_id: 'demo-project', proposal_id: 'missing-proposal-id' }, env(vault, iso))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('PROPOSAL_NOT_FOUND')
  })

  it('accept a missing proposal reports PROPOSAL_NOT_FOUND', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handlePlanProposalActivity('accept', { project_id: 'demo-project', proposal_id: 'missing-proposal-id' }, env(vault, iso))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('PROPOSAL_NOT_FOUND')
  })

  it('ensure_today reports the decided reason', async () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const saved = await saveBase(vault)
    const id = String(saved['proposal_id'])
    // Accept it first, so ensure_today finds a decided plan for this date.
    handlePlanProposalActivity('accept', { project_id: 'demo-project', proposal_id: id, decided_at: iso }, env(vault, iso))
    const result = handlePlanProposalActivity('ensure_today', { project_id: 'demo-project', as_of: iso }, env(vault, iso))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data['created']).toBe(false)
      expect(result.data['reason']).toContain('this date was already')
    }
  })
})
