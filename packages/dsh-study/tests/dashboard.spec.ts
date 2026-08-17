import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it } from 'vitest'

import { buildStudyDashboardOverview, dashboardVault } from '../src/dashboard.ts'
import {
  exampleNoteBody,
  scheduledEvent,
  tempVault,
  writeNote,
  writeProject,
  writeSchedule,
} from './helpers.ts'

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

  it('projects schedule events, milestones, and due-review badges into the calendar', () => {
    const vault = tempVault()
    writeProject(vault, 'learn-math')
    writeSchedule(vault, 'learn-math', {
      schema_version: 'study_schedule.v1',
      schedule_id: 'calc-s1',
      project_id: 'learn-math',
      title: 'Calculus',
      timezone: 'UTC',
      range: { start: '2026-01-01', end: '2026-02-01' },
      phases: [{
        id: 'p1',
        title: 'Differentiation',
        start: '2026-01-18',
        end: '2026-01-31',
        goal: 'Master derivatives',
        effort_minutes: 600,
      }],
      events: [
        scheduledEvent({ id: 'e1', title: 'Derivative drill', start: '2026-01-19T10:00:00Z', end: '2026-01-19T11:00:00Z', status: 'planned' }),
        scheduledEvent({ id: 'e2', title: 'Chain rule', start: '2026-01-20T09:00:00Z', end: '2026-01-20T10:00:00Z', status: 'completed' }),
      ],
    })
    // A due review lands on a distinct day.
    writeNote(vault, 'math/examples/integral.md', exampleNoteBody({
      title: 'Integral recall',
      reviewLevel: 1,
      reviewCount: 2,
      nextReviewAt: '2026-01-21',
      concepts: ['integral'],
    }))

    const overview = buildStudyDashboardOverview(
      agentAt(vault),
      undefined,
      () => new Date('2026-01-15T08:00:00.000Z'),
    )

    expect(overview.calendar.days.length).toBeGreaterThan(0)
    const byDate = new Map(overview.calendar.days.map(day => [day.date, day]))
    const on19 = byDate.get('2026-01-19')
    expect(on19?.events).toHaveLength(1)
    expect(on19?.events[0]?.title).toBe('Derivative drill')
    expect(byDate.get('2026-01-18')?.milestones.some(m => m.kind === 'phase' && m.label === 'Differentiation')).toBe(true)
    expect(byDate.get('2026-01-21')?.dueReviewCount).toBe(1)

    // The project row carries its Schedules (日程安排) with phases for the big window.
    const project = overview.projects[0]
    expect(project).toBeDefined()
    expect(project?.schedules).toHaveLength(1)
    expect(project?.schedules[0]?.scheduleId).toBe('calc-s1')
    expect(project?.schedules[0]?.title).toBe('Calculus')
    expect(project?.schedules[0]?.phaseCount).toBe(1)
    expect(project?.schedules[0]?.eventCount).toBe(2)
    expect(project?.schedules[0]?.phases[0]).toMatchObject({
      id: 'p1', title: 'Differentiation', start: '2026-01-18', end: '2026-01-31',
      goal: 'Master derivatives', effortMinutes: 600,
    })
  })
})
