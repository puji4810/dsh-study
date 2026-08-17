// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InterventionItem, PlanProposal, StudyDashboardOverview } from '@puji4810/dsh-study/types'

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

const intervention: InterventionItem = {
  intervention_id: 'iv-1',
  objective_id: 'obj-1',
  capability: '独立完成导数计算',
  kind: 'independence_probe',
  evidence_dimension: 'execution',
  priority_score: 88,
  priority_band: 'high',
  reasons: ['最近证据仍需要提示，应该验证独立执行。'],
  reason_factors: {
    verification_status: 'supported',
    evidence_age_days: 3,
    evidence_age_band: 'fresh',
    freshness_threshold_days: 14,
    days_to_deadline: 12,
    deadline_band: 'near',
    repeated_diagnosis_count: 1,
    outcome_adjustment: 0,
    outcome_improvement_rate: null,
    outcome_sample_size: 0,
    outcome_source: 'insufficient_evidence',
  },
  latest_evidence_at: '2026-08-14T12:00:00+08:00',
  evidence_attempt_ids: ['attempt-1'],
  recommended_activity: {
    activity_kind: 'independence_probe',
    evidence_target: 'execution',
    assistance_level: 'independent',
    duration_minutes: 30,
    duration_source: 'domain-pack-default',
    duration_sample_size: 0,
    requires_evaluator: true,
    success_criteria: ['无提示完成一题导数计算。'],
    source_anchors: [],
  },
}

const proposedPlan: PlanProposal = {
  schema_version: 'study_plan_proposal.v1',
  proposal_id: 'plan-demo',
  project_id: 'math',
  policy_version: 'study_intervention_policy.v1',
  generation_fingerprint: 'a'.repeat(64),
  title: '今日干预计划',
  status: 'proposed',
  rationale: '根据最新证据优先验证独立执行。',
  created_at: '2026-08-17T10:00:00+08:00',
  as_of: '2026-08-17T10:00:00+08:00',
  items: [intervention],
  day_plan: {
    schema_version: 'study_day_plan.v1',
    target_date: '2026-08-18',
    timezone: 'Asia/Shanghai',
    study_window: { start_hour: 19, end_hour: 22, source: 'custom', sample_size: 0, coverage: null },
    scheduling: {
      mode: 'custom',
      windows: [{ start: '19:00', end: '23:00' }],
      busy: [],
      break_minutes: 10,
      max_minutes: 60,
      allow_duration_adjustment: true,
      min_duration_minutes: 15,
      intervention_order: ['iv-1'],
      defer_intervention_ids: [],
      placements: [],
      existing_event_conflicts: 0,
    },
    capacity: null,
    minutes_budget: 60,
    minutes_budget_nominal: 60,
    minutes_planned: 30,
    schedules: [{
      schedule_id: 's1',
      schedule_title: '主线',
      phase_id: 'b',
      phase_goal: '强化',
      minutes_budget: 60,
      minutes_budget_nominal: 60,
      minutes_planned: 30,
      events: [{
        id: 'dp-2026-08-18-iv-1',
        title: 'independence probe: 独立完成导数计算',
        subject_id: 'math',
        type: 'independence_probe',
        start: '2026-08-18T19:00:00+08:00',
        end: '2026-08-18T19:30:00+08:00',
        duration_minutes: 30,
        recommended_duration_minutes: 30,
        duration_source: 'recommended',
        goals: ['无提示完成一题导数计算。'],
        status: 'planned',
        source_intervention_id: 'iv-1',
        source_objective_id: 'obj-1',
        evidence_dimension: 'execution',
        routing: 'objective-token-match',
      }],
    }],
    unplaced: [],
  },
  evidence_attempt_ids: ['attempt-1'],
  schedule_change: { state: 'not_applied', requires_explicit_save: true },
}

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
  const previewPlan = vi.fn(() => Promise.resolve({
    projectId: 'math',
    interventionQueue: {
      schema_version: 'study_intervention_queue.v1' as const,
      project_id: 'math',
      policy_version: 'study_intervention_policy.v1' as const,
      generated_at: '2026-08-17T10:00:00+08:00',
      as_of: '2026-08-17T10:00:00+08:00',
      deadline: '2026-08-30',
      days_to_deadline: 13,
      items: [intervention],
      evidence_attempt_ids: ['attempt-1'],
      unscoped_attempt_ids: [],
      deferred_objectives: [],
      warnings: [],
    },
    proposal: proposedPlan,
  }))
  const latestPlan = vi.fn(() => Promise.resolve(null))
  const savePlan = vi.fn(() => Promise.resolve({ proposal: proposedPlan, created: true, path: 'plan-proposals/plan-demo.json' }))
  const decidePlan = vi.fn((_sessionId, request) => Promise.resolve({
    proposal: {
      ...proposedPlan,
      status: request.decision === 'accept' ? 'accepted' as const : 'rejected' as const,
      decision: {
        outcome: request.decision === 'accept' ? 'accepted' as const : 'rejected' as const,
        decided_at: '2026-08-17T10:05:00+08:00',
      },
    },
    changed: true,
  }))
  const applyPlan = vi.fn(() => Promise.resolve({
    proposalId: proposedPlan.proposal_id,
    targetDate: '2026-08-18',
    appliedScheduleCount: 1,
    appliedEventCount: 1,
  }))
  return {
    wide: true,
    useSessions: ((selector: (state: { current: string }) => unknown) => selector({ current: 'session-1' })) as StudyOSPanelProps['useSessions'],
    useWorkspaces: (() => undefined) as StudyOSPanelProps['useWorkspaces'],
    load,
    selectProject,
    previewPlan,
    latestPlan,
    savePlan,
    decidePlan,
    applyPlan,
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


  it('customizes, previews, decides, and applies an intervention plan', async () => {
    const panelProps = props()
    render(<StudyOSPanel {...panelProps} />)
    fireEvent.click(screen.getByRole('button', { name: 'StudyOS 学习面板' }))
    fireEvent.click(await screen.findByRole('button', { name: '计划' }))

    expect(await screen.findByText('干预计划')).toBeTruthy()
    await waitFor(() => expect(panelProps.latestPlan).toHaveBeenCalledWith('session-1', 'math'))

    fireEvent.click(screen.getByRole('checkbox', { name: /自定义学习窗口/ }))
    fireEvent.change(screen.getByLabelText('计划日期'), { target: { value: '2026-08-18' } })
    fireEvent.click(screen.getByRole('button', { name: '生成预览' }))

    expect(await screen.findByText('独立完成导数计算')).toBeTruthy()
    await waitFor(() => expect(panelProps.previewPlan).toHaveBeenCalledWith('session-1', expect.objectContaining({
      projectId: 'math',
      scheduling: expect.objectContaining({
        target_date: '2026-08-18',
        windows: [{ start: '19:00', end: '23:00' }],
        allow_duration_adjustment: true,
      }),
    })))

    fireEvent.change(screen.getByLabelText('开始时间'), { target: { value: '20:30' } })
    expect(screen.getByText('约束或队列已改变，请重新生成预览。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '生成预览' }))
    await waitFor(() => expect(panelProps.previewPlan).toHaveBeenCalledTimes(2))
    expect(panelProps.previewPlan).toHaveBeenLastCalledWith('session-1', expect.objectContaining({
      scheduling: expect.objectContaining({
        placements: [expect.objectContaining({ intervention_id: 'iv-1', start_time: '20:30' })],
      }),
    }))

    fireEvent.click(screen.getByRole('button', { name: '保存提案' }))
    await waitFor(() => expect(panelProps.savePlan).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: '接受' }))
    await waitFor(() => expect(panelProps.decidePlan).toHaveBeenCalledWith('session-1', expect.objectContaining({ decision: 'accept' })))
    fireEvent.click(screen.getByRole('button', { name: '写入日程' }))
    await waitFor(() => expect(panelProps.applyPlan).toHaveBeenCalledWith('session-1', {
      projectId: 'math',
      proposalId: 'plan-demo',
    }))
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
