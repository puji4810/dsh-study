// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StudyDashboardOverview } from '@puji4810/dsh-study/types'

import { inject } from '../../src/client/index.ts'
import { StudyOSPanel, type StudyOSPanelProps } from '../../src/client/StudyOSPanel.tsx'
import { zh } from '../../src/client/locales.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconSkillOutline16: ({ size }: { size?: number }) => <svg data-studyos-icon width={size} height={size} />,
  IconChevronLeftOutline14: () => <svg />,
  IconChevronRightOutline14: () => <svg />,
  IconCloseOutline16: () => <svg />,
  Modal: ({ open, children }: { open: boolean; children?: ReactNode }) => (open ? <div data-studyos-modal>{children}</div> : null),
}))

afterEach(cleanup)

const overview: StudyDashboardOverview = {
  vaultPath: '/notes/math',
  activeProjectId: 'math',
  projects: [{
    projectId: 'math',
    title: '数学分析',
    domain: 'math',
    phase: 'foundation',
    scheduleCount: 2,
    attemptCount: 7,
    trackCount: 3,
    objectiveCount: 4,
    subjectLabels: ['高等数学', '线性代数', '概率论'],
    schedules: [{
      scheduleId: 's1',
      title: '主线',
      rangeStart: '2026-08-01',
      rangeEnd: '2026-10-01',
      phaseCount: 2,
      eventCount: 0,
      phases: [
        { id: 'a', title: 'A段', start: '2026-08-01', end: '2026-08-15', goal: '基础', effortMinutes: 3600, status: 'completed' },
        { id: 'b', title: 'B段', start: '2026-08-16', end: '2026-09-01', goal: '强化', effortMinutes: 7200, status: 'planned' },
      ],
    }],
  }, {
    projectId: 'physics',
    title: '物理',
    domain: 'science',
    phase: 'practice',
    scheduleCount: 1,
    attemptCount: 4,
    trackCount: 1,
    objectiveCount: 2,
    subjectLabels: ['力学'],
    schedules: [],
  }],
  dueReviewCount: 1,
  dueReviews: [{
    path: 'cards/derivative.md',
    title: '导数回忆',
    reviewLevel: 2,
    reviewCount: 3,
    concepts: ['derivative'],
  }],
  calendar: { start: '2026-08-01', end: '2026-08-31', days: [] },
}

function props(): StudyOSPanelProps {
  const load = vi.fn(() => Promise.resolve(overview))
  const selectProject = vi.fn((_sessionId, projectId) => Promise.resolve({
    ...overview,
    activeProjectId: projectId,
  }))
  return {
    wide: true,
    useSessions: ((selector: (state: { current: string }) => unknown) => selector({ current: 'session-1' })) as StudyOSPanelProps['useSessions'],
    useWorkspaces: (() => undefined) as StudyOSPanelProps['useWorkspaces'],
    load,
    selectProject,
    t: ((key: keyof typeof zh, values?: Record<string, unknown>) => {
      let message: string = zh[key]
      for (const [name, value] of Object.entries(values ?? {})) message = message.replace(`{${name}}`, String(value))
      return message
    }) as StudyOSPanelProps['t'],
  }
}

describe('StudyOSPanel', () => {
  it('opens the big window and shows projects and the active schedule arrangement', async () => {
    const panelProps = props()
    render(<StudyOSPanel {...panelProps} />)

    const trigger = screen.getByRole('button', { name: 'StudyOS 学习面板' })
    expect(trigger.querySelector('svg')).toBeTruthy()
    expect(trigger.textContent).not.toContain('📚')
    fireEvent.click(trigger)

    // The modal window opens with the project listed and its active detail shown.
    expect((await screen.findAllByText('数学分析')).length).toBeGreaterThan(0)
    expect(screen.getByText('物理')).toBeTruthy()
    // The active project's schedule arrangement (phases) is shown in the detail pane.
    expect(screen.getByText('主线')).toBeTruthy()
    expect(screen.getByText('A段')).toBeTruthy()
    expect(screen.getByText('B段')).toBeTruthy()
  })

  it('selecting another project makes it active through the Remote call', async () => {
    const panelProps = props()
    render(<StudyOSPanel {...panelProps} />)
    fireEvent.click(screen.getByRole('button', { name: 'StudyOS 学习面板' }))

    // Rail item for the physics project.
    fireEvent.click(await screen.findByText('物理'))
    expect(panelProps.selectProject).toHaveBeenCalledWith('session-1', 'physics')
    // The math detail (its phases) is replaced by physics' (empty) detail.
    await screen.findByText('日程安排')
    expect(screen.queryByText('A段')).toBeNull()
  })
})

describe('StudyOS Client plugin', () => {
  it('mounts its Remote contribution before waiting for the namespace', () => {
    expect(inject).toEqual(['remote'])
  })
})
