import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it } from 'vitest'

import { buildStudyDashboardOverview, dashboardVault } from '../src/dashboard.ts'
import { exampleNoteBody, tempVault, writeNote, writeProject } from './helpers.ts'

function agentAt(cwd: string): Agent {
  return { session: { header: { cwd } } } as unknown as Agent
}

describe('StudyOS dashboard', () => {
  it('uses the calling Session workspace instead of the deployment fallback', () => {
    const workspace = tempVault()
    const fallback = tempVault()
    expect(dashboardVault(agentAt(workspace), fallback)).toBe(workspace)
  })

  it('projects workspace projects and due reviews without persisted dashboard state', () => {
    const vault = tempVault()
    writeProject(vault, 'learn-math')
    writeNote(vault, 'math/examples/derivative.md', exampleNoteBody({
      title: 'Derivative recall',
      reviewLevel: 2,
      reviewCount: 3,
      nextReviewAt: '2026-01-14',
      concepts: ['derivative'],
    }))

    const overview = buildStudyDashboardOverview(
      agentAt(vault),
      undefined,
      () => new Date('2026-01-15T08:00:00.000Z'),
    )

    expect(overview).toMatchObject({
      vaultPath: vault,
      activeProjectId: 'learn-math',
      dueReviewCount: 1,
      projects: [{ projectId: 'learn-math', title: 'Demo Project' }],
      dueReviews: [{ title: 'Derivative recall', reviewLevel: 2, concepts: ['derivative'] }],
    })
  })
})
