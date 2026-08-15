// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StudyDashboardOverview } from '@puji4810/dsh-study/types'

import { inject } from '../../src/client/index.ts'
import { StudyOSPanel, type StudyOSPanelProps } from '../../src/client/StudyOSPanel.tsx'
import { zh } from '../../src/client/locales.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconSkillOutline16: ({ size }: { size?: number }) => <svg data-studyos-icon width={size} height={size} />,
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
  }, {
    projectId: 'physics',
    title: '物理',
    domain: 'science',
    phase: 'practice',
    scheduleCount: 1,
    attemptCount: 4,
  }],
  dueReviewCount: 1,
  dueReviews: [{
    path: 'cards/derivative.md',
    title: '导数回忆',
    reviewLevel: 2,
    reviewCount: 3,
    concepts: ['derivative'],
  }],
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
  it('loads the current workspace and selects another project', async () => {
    const panelProps = props()
    render(<StudyOSPanel {...panelProps} />)

    const trigger = screen.getByRole('button', { name: 'StudyOS 学习面板' })
    expect(trigger.querySelector('svg')).toBeTruthy()
    expect(trigger.textContent).not.toContain('📚')
    fireEvent.click(trigger)
    expect(await screen.findByText('/notes/math')).toBeTruthy()
    expect(screen.getByText('数学分析')).toBeTruthy()
    expect(screen.getByText('导数回忆')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '设为当前项目' }))
    expect(panelProps.selectProject).toHaveBeenCalledWith('session-1', 'physics')
    expect(await screen.findByText('当前')).toBeTruthy()
  })
})

describe('StudyOS Client plugin', () => {
  it('mounts its Remote contribution before waiting for the namespace', () => {
    expect(inject).toEqual(['remote'])
  })
})
