/** Read-only StudyOS dashboard projection for one dsh workspace Vault. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { addDays } from './datetime.ts'
import { handleStudyReview } from './handlers/review.ts'
import type { HandlerEnv } from './handlers/dispatch.ts'
import { allAttempts, StudyWorkspace } from './vault.ts'
import type {
  StudyDashboardCalendar,
  StudyDashboardCalendarDay,
  StudyDashboardCalendarEvent,
  StudyDashboardOverview,
  StudyDashboardProject,
  StudyDashboardReview,
  StudyProject,
} from './types.ts'

/** The calendar window starts on the first day of the current month (inclusive). */
const CALENDAR_LEAD_DAYS = 1

/** How far past the current month the calendar extends. */
const CALENDAR_LOOKAHEAD_DAYS = 60

/**
 * Resolve the Vault owned by an agent's workspace.
 * @param agent - agent whose Session supplies the workspace directory.
 * @param fallbackVaultPath - deployment fallback for Sessions without a workspace.
 * @returns absolute or caller-provided Vault directory.
 */
export function dashboardVault(agent: Agent, fallbackVaultPath?: string): string {
  const vaultPath = agent.session.header.cwd ?? fallbackVaultPath
  if (vaultPath === undefined) {
    throw new Error('StudyOS panel needs a Session workspace or a configured vaultPath fallback')
  }
  return vaultPath
}

function projectRow(workspace: StudyWorkspace, project: StudyProject): StudyDashboardProject {
  const catalog = workspace.discoverSchedules(project.project_id)
  const subjects = 'subjects' in project ? project.subjects : 'tracks' in project ? project.tracks : []
  const subjectLabels = Array.isArray(subjects)
    ? subjects
      .map(subject => (subject as { label?: unknown })?.label)
      .filter((label): label is string => typeof label === 'string' && label.trim() !== '')
    : []
  const objectiveCount = 'objectives' in project && Array.isArray(project.objectives)
    ? project.objectives.length
    : 0
  const schedules = catalog.schedules.map(schedule => ({
    scheduleId: schedule.schedule_id,
    title: schedule.title,
    rangeStart: schedule.range.start,
    rangeEnd: schedule.range.end,
    phaseCount: schedule.phases.length,
    eventCount: schedule.events.length,
    phases: schedule.phases.map(phase => ({
      id: phase.id,
      title: phase.title,
      start: phase.start,
      end: phase.end,
      goal: phase.goal,
      ...phase.effort_minutes !== undefined ? { effortMinutes: phase.effort_minutes } : {},
      ...phase.status !== undefined ? { status: phase.status } : {},
    })),
  }))
  return {
    projectId: project.project_id,
    title: project.title,
    domain: project.domain,
    phase: project.phase,
    ...project.schema_version === 'study_project.v2' && project.deadline !== undefined
      ? { deadline: project.deadline }
      : {},
    scheduleCount: catalog.schedules.length,
    attemptCount: allAttempts(workspace.vault, project.project_id).length,
    trackCount: subjectLabels.length,
    objectiveCount,
    subjectLabels,
    schedules,
  }
}

function dueReviews(
  vaultPath: string,
  now: () => Date,
  options: { reviewState?: 'due' | 'all'; limit?: number } = {},
): { count: number; rows: StudyDashboardReview[] } {
  const env: HandlerEnv = { now, vaultPath }
  const reviewState = options.reviewState ?? 'due'
  const limit = options.limit ?? 10
  const result = handleStudyReview({ action: 'due', review_state: reviewState, limit }, env)
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  const due = Array.isArray(result.data['due']) ? result.data['due'] : []
  const rows: StudyDashboardReview[] = due.flatMap((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
    const row = value as Record<string, unknown>
    const path = row['path']
    const title = row['title']
    if (typeof path !== 'string' || typeof title !== 'string') return []
    const nextReviewAt = row['next_review_at']
    return [{
      path,
      title,
      reviewLevel: Math.trunc(Number(row['review_level']) || 0),
      reviewCount: Math.trunc(Number(row['review_count']) || 0),
      ...typeof nextReviewAt === 'string' && nextReviewAt !== '' ? { nextReviewAt } : {},
      concepts: Array.isArray(row['concepts'])
        ? row['concepts'].filter((item): item is string => typeof item === 'string')
        : [],
    }]
  })
  return { count: Number(result.data['available_count']) || rows.length, rows }
}

/**
 * The inclusive [start, end] window the calendar covers: the start of the
 * current month (UTC) through a fixed lookahead.
 * @param now - the injected clock.
 * @returns the bounds.
 */
function calendarWindow(now: Date): { start: Date; end: Date } {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const start = addDays(monthStart, -CALENDAR_LEAD_DAYS)
  const end = addDays(now, CALENDAR_LOOKAHEAD_DAYS)
  return { start, end }
}

/**
 * Build the learning calendar projection: scheduled events and milestones from
 * every project, with per-day due-review counts, within the calendar window.
 * @param workspace - the resolved StudyOS workspace.
 * @param now - the injected clock defining the window and review due dates.
 * @param vaultPath - the Vault used for the due-review query.
 * @returns the calendar projection.
 */
function buildCalendar(
  workspace: StudyWorkspace,
  now: Date,
  vaultPath: string,
): StudyDashboardCalendar {
  const { start, end } = calendarWindow(now)
  const startIso = start.toISOString().slice(0, 10)
  const endIso = end.toISOString().slice(0, 10)

  // Gather distinct review next-review dates so upcoming and overdue reviews
  // render as per-day badges across the calendar.
  const dueDates = new Map<string, number>()
  const allReviews = dueReviews(vaultPath, () => now, { reviewState: 'all', limit: 500 })
  for (const row of allReviews.rows) {
    if (row.nextReviewAt === undefined) continue
    dueDates.set(row.nextReviewAt, (dueDates.get(row.nextReviewAt) ?? 0) + 1)
  }

  const byDate = new Map<string, StudyDashboardCalendarDay>()

  const dayFor = (date: string): StudyDashboardCalendarDay => {
    let day = byDate.get(date)
    if (day === undefined) {
      day = { date, events: [], milestones: [], dueReviewCount: 0 }
      byDate.set(date, day)
    }
    return day
  }

  const projects = workspace.listProjects()
  for (const project of projects) {
    const catalog = workspace.discoverSchedules(project.project_id)
    // Project-level milestones.
    const v2Deadline = project.schema_version === 'study_project.v2' ? project.deadline : undefined
    if (v2Deadline !== undefined && v2Deadline >= startIso && v2Deadline <= endIso) {
      dayFor(v2Deadline).milestones.push({
        kind: 'deadline',
        label: project.title,
        projectId: project.project_id,
        projectTitle: project.title,
        date: v2Deadline,
      })
    }
    const v1Exam = project.schema_version === 'study_project.v1' ? project.exam_date : undefined
    if (v1Exam !== undefined && v1Exam >= startIso && v1Exam <= endIso) {
      dayFor(v1Exam).milestones.push({
        kind: 'exam',
        label: project.title,
        projectId: project.project_id,
        projectTitle: project.title,
        date: v1Exam,
      })
    }

    for (const schedule of catalog.schedules) {
      // Phase starts as milestones (capped at a handful to keep the view tidy).
      for (const phase of schedule.phases.slice(0, 6)) {
        const phaseStart = phase.start
        if (phaseStart >= startIso && phaseStart <= endIso) {
          dayFor(phaseStart).milestones.push({
            kind: 'phase',
            label: phase.title,
            projectId: project.project_id,
            projectTitle: project.title,
            date: phaseStart,
          })
        }
      }
      // Concrete schedule events.
      for (const event of schedule.events) {
        const date = String(event.start).slice(0, 10)
        if (/^\d{4}-\d{2}-\d{2}$/.test(date) === false) continue
        if (date < startIso || date > endIso) continue
        const row: StudyDashboardCalendarEvent = {
          id: event.id,
          title: event.title,
          projectId: project.project_id,
          projectTitle: project.title,
          scheduleId: schedule.schedule_id,
          scheduleTitle: schedule.title,
          type: event.type,
          status: event.status,
          start: event.start,
          end: event.end,
        }
        dayFor(date).events.push(row)
      }
    }
  }

  // Fold review counts into their days.
  for (const [date, count] of dueDates) {
    if (date < startIso || date > endIso) continue
    dayFor(date).dueReviewCount += count
  }

  const days: StudyDashboardCalendarDay[] = []
  for (const day of byDate.values()) {
    if (day.events.length === 0 && day.milestones.length === 0 && day.dueReviewCount === 0) continue
    day.events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
    day.milestones.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    days.push(day)
  }
  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

  return { start: startIso, end: endIso, days }
}

/**
 * Build the current panel projection without storing derived state.
 * @param agent - agent whose Session selects the workspace Vault.
 * @param fallbackVaultPath - deployment fallback for Sessions without a workspace.
 * @param now - clock used to determine due reviews.
 * @returns current projects and due-review summary for the workspace.
 */
export function buildStudyDashboardOverview(
  agent: Agent,
  fallbackVaultPath?: string,
  now: () => Date = () => new Date(),
): StudyDashboardOverview {
  const vaultPath = dashboardVault(agent, fallbackVaultPath)
  const workspace = new StudyWorkspace({ vault: vaultPath, source: 'dsh-workspace' })
  const activeProjectId = workspace.activeProjectId() ?? undefined
  const projects = workspace.listProjects().map(project => projectRow(workspace, project))
  const review = dueReviews(vaultPath, now)
  return {
    vaultPath,
    ...activeProjectId === undefined ? {} : { activeProjectId },
    projects,
    dueReviewCount: review.count,
    dueReviews: review.rows,
    calendar: buildCalendar(workspace, now(), vaultPath),
  }
}
