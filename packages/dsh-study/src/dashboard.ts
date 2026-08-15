/** Read-only StudyOS dashboard projection for one dsh workspace Vault. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { handleStudyReview } from './handlers/review.ts'
import type { HandlerEnv } from './handlers/dispatch.ts'
import { allAttempts, StudyWorkspace } from './vault.ts'
import type {
  StudyDashboardOverview,
  StudyDashboardProject,
  StudyDashboardReview,
  StudyProject,
} from './types.ts'

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
  const schedules = workspace.discoverSchedules(project.project_id)
  return {
    projectId: project.project_id,
    title: project.title,
    domain: project.domain,
    phase: project.phase,
    ...project.schema_version === 'study_project.v2' && project.deadline !== undefined
      ? { deadline: project.deadline }
      : {},
    scheduleCount: schedules.schedules.length,
    attemptCount: allAttempts(workspace.vault, project.project_id).length,
  }
}

function dueReviews(vaultPath: string, now: () => Date): { count: number; rows: StudyDashboardReview[] } {
  const env: HandlerEnv = { now, vaultPath }
  const result = handleStudyReview({ action: 'due', limit: 10 }, env)
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
  }
}
