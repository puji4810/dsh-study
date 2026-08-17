/** Register the workspace-scoped StudyOS panel in the sidebar footer. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import studyosRemote from '@puji4810/dsh-study/remote'
import type {
  PlanProposal,
  StudyDashboardOverview,
  StudyDashboardPlanApplyResult,
  StudyDashboardPlanDecisionResult,
  StudyDashboardPlanPreview,
  StudyDashboardPlanSaveResult,
} from '@puji4810/dsh-study/types'
import type { StudyOSPanelFace } from './slots.ts'
import { StudyOSPanel } from './StudyOSPanel.tsx'
import { en, NS, zh } from './locales.ts'

export type { StudyOSPanelFace } from './slots.ts'
export type { StudyOSKey } from './locales.ts'

/** Service required to mount the generated StudyOS Remote contribution. */
export const inject = ['remote']

const PANEL_INJECT = ['slots', 'sessions', 'remote', 'remote.studyos', 'locale']

/** Register the footer action after its generated Remote namespace exists. */
function registerPanel(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-studyos: dictionaries')
  const unwrap = (result: Awaited<ReturnType<typeof ctx.remote.studyos.overview>>): StudyDashboardOverview => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value
  }
  const unwrapValue = <T,>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value
  }
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'studyos-panel',
    order: 20,
    locale: NS,
    inject: (): StudyOSPanelFace => ({
      load: async sessionId => unwrap(await ctx.remote.studyos.overview(sessionId)),
      selectProject: async (sessionId, projectId) =>
        unwrap(await ctx.remote.studyos.selectProject(sessionId, projectId)),
      previewPlan: async (sessionId, request): Promise<StudyDashboardPlanPreview> =>
        unwrapValue(await ctx.remote.studyos.previewPlan(sessionId, request)),
      latestPlan: async (sessionId, projectId): Promise<PlanProposal | null> =>
        unwrapValue(await ctx.remote.studyos.latestPlan(sessionId, projectId)),
      savePlan: async (sessionId, request): Promise<StudyDashboardPlanSaveResult> =>
        unwrapValue(await ctx.remote.studyos.savePlan(sessionId, request)),
      decidePlan: async (sessionId, request): Promise<StudyDashboardPlanDecisionResult> =>
        unwrapValue(await ctx.remote.studyos.decidePlan(sessionId, request)),
      applyPlan: async (sessionId, request): Promise<StudyDashboardPlanApplyResult> =>
        unwrapValue(await ctx.remote.studyos.applyPlan(sessionId, request)),
    }),
  }, StudyOSPanel))
}

/**
 * Mount the StudyOS Remote namespace, then activate its dependent panel fiber.
 * @param ctx - client root carrying the Remote registry.
 * @returns disposer for the panel fiber and package-owned Remote namespace.
 */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(studyosRemote)
  const panelFiber = ctx.inject(PANEL_INJECT, panelCtx => {
    registerPanel(panelCtx as ClientContext)
  })
  try {
    await panelFiber
  } catch (error) {
    await disposeRemote()
    throw error
  }
  return async () => {
    await panelFiber.dispose()
    await disposeRemote()
  }
}
