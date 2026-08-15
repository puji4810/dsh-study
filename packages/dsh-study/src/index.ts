/**
 * The StudyOS plugin: registers the `study_activity` and `study_coach` tools on
 * `ctx.tools`, the eleven routed skills on `ctx.skills` when that service is
 * composed, and injects the active learning-session context after session
 * lifecycle calls. Each agent's dsh workspace is its default Vault; optional
 * `vaultPath` and per-call `vault_path` values serve non-workspace callers and
 * one-off overrides.
 * @module @puji4810/dsh-study
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool, type InferArgs, type InferValue, type ParameterSchemaSpec, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-skill'
import { renderActiveSessionContext } from './context.ts'
import {
  buildStudyDashboardOverview,
  dashboardVault,
} from './dashboard.ts'
import { handleStudyCoach } from './handlers/coach.ts'
import { dispatchStudyActivity, type HandlerEnv } from './handlers/dispatch.ts'
import { STUDY_SKILLS } from './skills.ts'
import { resolveVaultPath, StudyWorkspace } from './vault.ts'
import type { LearningSession, StudyDashboardOverview } from './types.ts'

/** Deployment configuration for the StudyOS plugin. */
export interface Config {
  /** Absolute or `~`-prefixed fallback Vault for calls without a dsh workspace. */
  vaultPath?: string
}

/** Schemastery schema for the StudyOS plugin config. */
export const Config: z<Config> = z.object({
  vaultPath: z.string(),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** StudyOS tools and workspace-scoped dashboard projection. */
    studyos: StudyOSService
  }
}

const RESOURCES = [
  'attempt',
  'pattern_proposal',
  'plan_proposal',
  'project',
  'schedule',
  'note',
  'review',
  'error',
  'concept',
  'curriculum',
  'learning_record',
  'decision',
  'lesson',
  'prompt_context',
  'session',
  'memory',
] as const

const COACH_ACTIONS = [
  'start',
  'advance',
  'snapshot',
  'finish',
  'diagnose',
  'summarize',
  'recommend',
  'prioritize',
  'propose_plan',
  'evaluate_interventions',
  'evaluate_adherence',
  'generate_probe',
  'propose_pattern',
] as const

const STUDY_ACTIVITY_DESCRIPTION =
  'StudyOS state interface. Start a workflow with project.status, then '
  + 'prompt_context.load(intent) for its operation guide. Select an operation '
  + 'with resource and action; put its payload in data. Canonical save actions '
  + 'validate before writing. review.submit owns both evidence and spacing.'

const STUDY_COACH_DESCRIPTION =
  'StudyOS evidence projection and Session runtime. Load the workflow guide '
  + 'before use. start creates no evidence and generates all created_at timestamps; '
  + 'callers must not send created_at. advance requires an evaluated '
  + 'observation and returns continuation; finish may leave dimensions '
  + 'unverified. Analysis and proposal actions do not mutate Schedules.'

const ENVELOPE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    data: { type: 'json', description: 'Operation payload.' },
    warnings: { type: 'array', required: true, items: { type: 'string' } },
    error: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: 'string', required: true },
        message: { type: 'string', required: true },
        details: { type: 'json' },
      },
    },
  },
} as const

const STUDY_ACTIVITY_PARAMETERS = {
  resource: {
    type: 'string',
    required: true,
    enum: [...RESOURCES],
    description: 'The StudyOS resource this operation addresses.',
  },
  action: {
    type: 'string',
    required: true,
    description: 'Action from the loaded operation guide.',
  },
  vault_path: {
    type: 'string',
    description: 'Vault directory override; defaults to the current dsh workspace.',
  },
  project_id: { type: 'string', description: 'Project id; defaults to the active project.' },
  data: {
    type: 'json',
    description: 'Operation payload from the loaded guide or returned template.',
  },
} satisfies ParameterSchemaSpec

const STUDY_COACH_PARAMETERS = {
  action: {
    type: 'string',
    required: true,
    enum: [...COACH_ACTIONS],
    description: 'Action from the loaded operation guide.',
  },
  scope: {
    type: 'string',
    enum: ['session', 'concept', 'week', 'project'],
    description: 'Evidence scope for analysis actions; defaults to project.',
  },
  vault_path: {
    type: 'string',
    description: 'Vault directory override; defaults to the current dsh workspace.',
  },
  project_id: { type: 'string', description: 'Project id; defaults to the active project.' },
  data: {
    type: 'json',
    description: 'Action payload from the loaded operation guide.',
  },
} satisfies ParameterSchemaSpec

/** Build a handler environment from a tool run, binding the calling conversation when present. */
function toolEnv(fallbackVaultPath: string | undefined, exec: ToolRunContext): HandlerEnv {
  const vaultPath = exec.agent?.session.header.cwd ?? fallbackVaultPath
  const env: HandlerEnv = { now: () => new Date(), ...vaultPath === undefined ? {} : { vaultPath } }
  if (exec.agent !== undefined) env.conversationId = String(exec.agent.id)
  return env
}

/**
 * Resolve the configured Vault once at load; a missing or unreadable directory
 * fails the plugin load instead of failing the first tool call.
 * @param configured - the raw config value.
 * @returns the resolved absolute Vault path.
 */
function resolveVaultAtLoad(configured: string | undefined): string | undefined {
  if (configured === undefined) return undefined
  if (!configured.trim()) {
    throw new Error('studyos vaultPath must be a non-empty directory path')
  }
  return resolveVaultPath(configured, configured)
}

/**
 * Inject the active learning-session context for the next request after a
 * session lifecycle call, guarded against a disposed agent.
 * @param agent - the owning agent, when one exists.
 * @param session - the updated learning session.
 */
function injectSessionContext(agent: Agent | undefined, session: unknown): void {
  if (agent === undefined || session === null || typeof session !== 'object') return
  try {
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: renderActiveSessionContext(session as LearningSession) }],
      source: { kind: 'plugin', plugin: 'studyos' },
    }))
  } catch {
    // A disposed agent cannot receive context; the tool result already landed.
  }
}

/** StudyOS tools, workspace-scoped Vault resolution, and dashboard Remote API. */
export class StudyOSService extends TypertRemoteService {
  static inject = ['tools', 'agents']
  static Config = Config

  private readonly fallbackVaultPath: string | undefined

  /**
   * @param ctx - registrant context carrying the tool and agent registries.
   * @param config - optional fallback Vault for calls without a workspace.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'studyos')
    this.fallbackVaultPath = resolveVaultAtLoad(config.vaultPath)

    ctx.inject(['skills'], (skillsCtx) => {
      for (const skill of STUDY_SKILLS) {
        skillsCtx.skills.register({
          name: skill.name,
          description: skill.description,
          content: skill.content,
          source: 'runtime',
        })
      }
    })

    ctx.tools.register(defineTool({
      name: 'study_activity',
      description: STUDY_ACTIVITY_DESCRIPTION,
      parameters: STUDY_ACTIVITY_PARAMETERS,
      output: {
        schema: ENVELOPE_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args: InferArgs<typeof STUDY_ACTIVITY_PARAMETERS>, exec: ToolRunContext) => {
        const env = toolEnv(this.fallbackVaultPath, exec)
        const envelope = dispatchStudyActivity(
          { resource: args.resource, action: args.action, vault_path: args.vault_path, project_id: args.project_id, data: args.data },
          env,
        )
        // Wire-boundary cast: handler data is JSON-safe by construction, but the
        // envelope types it as an untyped record while the tool schema declares json.
        return envelope as unknown as InferValue<typeof ENVELOPE_SCHEMA>
      },
      presentCall: args => ({
        card: 'generic',
        title: `StudyOS ${args.resource}.${args.action}`,
        kind: 'other',
        rawInput: { resource: args.resource, action: args.action, project_id: args.project_id, data: args.data },
      }),
    }))

    ctx.tools.register(defineTool({
      name: 'study_coach',
      description: STUDY_COACH_DESCRIPTION,
      parameters: STUDY_COACH_PARAMETERS,
      output: {
        schema: ENVELOPE_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args: InferArgs<typeof STUDY_COACH_PARAMETERS>, exec: ToolRunContext) => {
        const env = toolEnv(this.fallbackVaultPath, exec)
        const envelope = handleStudyCoach(
          { action: args.action, scope: args.scope, vault_path: args.vault_path, project_id: args.project_id, data: args.data },
          env,
        )
        if (envelope.ok && (args.action === 'start' || args.action === 'advance')) {
          injectSessionContext(exec.agent, envelope.data.session)
        }
        // Wire-boundary cast: handler data is JSON-safe by construction, but the
        // envelope types it as an untyped record while the tool schema declares json.
        return envelope as unknown as InferValue<typeof ENVELOPE_SCHEMA>
      },
      presentCall: args => ({
        card: 'generic',
        title: `StudyOS coach ${args.action}`,
        kind: 'other',
        rawInput: { action: args.action, scope: args.scope, project_id: args.project_id },
      }),
    }))
  }

  /**
   * Read the StudyOS dashboard for the calling Session's workspace Vault.
   * @param agent - calling agent resolved by the Remote bridge.
   * @returns current projects and due reviews for that workspace.
   */
  @Remote('overview')
  overview(agent: Agent): StudyDashboardOverview {
    return buildStudyDashboardOverview(agent, this.fallbackVaultPath)
  }

  /**
   * Select a project in the calling Session's workspace Vault.
   * @param agent - calling agent resolved by the Remote bridge.
   * @param projectId - project to make active inside the workspace Vault.
   * @returns refreshed workspace dashboard.
   */
  @Remote('selectProject')
  selectProject(agent: Agent, projectId: string): StudyDashboardOverview {
    const vaultPath = dashboardVault(agent, this.fallbackVaultPath)
    new StudyWorkspace({ vault: vaultPath, source: 'dsh-workspace' }).selectProject(projectId)
    return buildStudyDashboardOverview(agent, this.fallbackVaultPath)
  }
}

export type { StudyEnvelope } from './errors.ts'
export type { StudyDashboardOverview, StudyDashboardProject, StudyDashboardReview } from './types.ts'
export default StudyOSService
