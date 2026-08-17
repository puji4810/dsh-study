/** StudyOS panel's injected Host operations. */

import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  PlanProposal,
  StudyDashboardOverview,
  StudyDashboardPlanApplyRequest,
  StudyDashboardPlanApplyResult,
  StudyDashboardPlanDecisionRequest,
  StudyDashboardPlanDecisionResult,
  StudyDashboardPlanPreview,
  StudyDashboardPlanRequest,
  StudyDashboardPlanSaveRequest,
  StudyDashboardPlanSaveResult,
} from '@puji4810/dsh-study/types'

/** Operations passed into the sidebar panel. */
export interface StudyOSPanelFace {
  /** Load the current dashboard for one Session workspace. */
  load(sessionId: SessionId): Promise<StudyDashboardOverview>
  /** Select a project in one Session workspace and return its refreshed dashboard. */
  selectProject(sessionId: SessionId, projectId: string): Promise<StudyDashboardOverview>
  /** Preview an evidence-derived plan with optional scheduling preferences. */
  previewPlan(sessionId: SessionId, request: StudyDashboardPlanRequest): Promise<StudyDashboardPlanPreview>
  /** Load the newest durable proposal for one project. */
  latestPlan(sessionId: SessionId, projectId: string): Promise<PlanProposal | null>
  /** Persist one previewed proposal. */
  savePlan(sessionId: SessionId, request: StudyDashboardPlanSaveRequest): Promise<StudyDashboardPlanSaveResult>
  /** Record an explicit accept/reject decision. */
  decidePlan(sessionId: SessionId, request: StudyDashboardPlanDecisionRequest): Promise<StudyDashboardPlanDecisionResult>
  /** Apply accepted events after a fresh conflict check. */
  applyPlan(sessionId: SessionId, request: StudyDashboardPlanApplyRequest): Promise<StudyDashboardPlanApplyResult>
}
