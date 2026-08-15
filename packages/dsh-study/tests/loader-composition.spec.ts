// Proves the StudyOS plugin boots through the real Loader: the cordis.yml entry
// composes the two tools, binds a tool call to its Session workspace, and keeps
// an explicit fallback available for callers without a workspace.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as StudyOS from '@puji4810/dsh-study'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function agent(ctx: Context, cwd?: string): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId('studyos-loader-agent')
  const session = Session.create(
    id,
    undefined,
    cwd === undefined ? undefined : { version: 0, id, createdAt: Date.now(), cwd },
  )
  const value: Agent = {
    id, options: {}, session, inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

/**
 * Boot a cordis.yml carrying a studyos vaultPath pointing at `<root>/vault`.
 * @param mode - whether the fallback Vault exists, is missing, or is omitted.
 * @returns the booted context.
 */
async function boot(mode: 'present' | 'missing' | 'omitted'): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-studyos-loader-'))
  if (mode === 'present') await mkdir(join(root, 'vault'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@puji4810/dsh-study'",
    ...mode === 'omitted' ? [] : ['  config:', `    vaultPath: ${JSON.stringify(join(root, 'vault'))}`],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@puji4810/dsh-study', StudyOS],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('studyos real Loader composition through cordis.yml', () => {
  it('registers both tools and writes a project manifest through the Vault', async () => {
    const ctx = await boot('present')
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toEqual(expect.arrayContaining(['study_activity', 'study_coach']))

    const owner = agent(ctx, join(root!, 'vault'))
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('studyos-loader'),
      name: 'study_activity',
      arguments: {
        resource: 'project',
        action: 'init',
        data: { project_id: 'loader-learning', title: 'Loader Learning', timezone: 'UTC', domain_pack: 'general.v1' },
      },
      agent: owner,
    })
    expect(result.isError).toBe(false)
    const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
    expect(text).toContain('"ok":true')
    expect(text).toContain('loader-learning')
  }, 30_000)

  it('fails the load when vaultPath names a missing directory', async () => {
    await expect(boot('missing')).rejects.toThrow()
  }, 30_000)

  it('uses the Session workspace when vaultPath is omitted', async () => {
    const ctx = await boot('omitted')
    await mkdir(join(root!, 'workspace'))
    const owner = agent(ctx, join(root!, 'workspace'))
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('studyos-workspace-vault'),
      name: 'study_activity',
      arguments: {
        resource: 'project',
        action: 'init',
        data: { project_id: 'workspace-learning', title: 'Workspace Learning', timezone: 'UTC', domain_pack: 'general.v1' },
      },
      agent: owner,
    })
    expect(result.isError).toBe(false)
    expect(await readFile(
      join(root!, 'workspace', '.StudyOS', 'projects', 'workspace-learning', 'manifest.json'),
      'utf8',
    )).toContain('workspace-learning')
  }, 30_000)
})
