/** StudyOS panel's injected Host operations. */

import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { StudyDashboardOverview } from '@puji4810/dsh-study/types'

/** Operations passed into the sidebar panel. */
export interface StudyOSPanelFace {
  /** Load the current dashboard for one Session workspace. */
  load(sessionId: SessionId): Promise<StudyDashboardOverview>
  /** Select a project in one Session workspace and return its refreshed dashboard. */
  selectProject(sessionId: SessionId, projectId: string): Promise<StudyDashboardOverview>
}
