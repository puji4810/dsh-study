import { describe, expect, it } from 'vitest'

import { handleStudyPromptContext } from '../../src/handlers/prompt-context.ts'
import { env, tempVault, writeProject } from '../helpers.ts'

const iso = '2026-01-15T08:00:00Z'

describe('handleStudyPromptContext', () => {
  it('rejects an invalid intent', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handleStudyPromptContext({ project_id: 'demo-project', intent: 'nope' }, env(vault, iso))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_INTENT')
  })

  it('loads base and intent fragments for a valid intent', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handleStudyPromptContext({ project_id: 'demo-project', intent: 'planning' }, env(vault, iso))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data['intent']).toBe('planning')
      expect(result.data['fragments']).toHaveLength(2)
      const kinds = (result.data['fragments'] as Array<Record<string, unknown>>).map(f => f['kind'])
      expect(kinds).toEqual(['base', 'intent'])
      const budget = result.data['budget'] as Record<string, unknown>
      expect(budget['pool_tokens']).toBe(1800)
      expect(budget['total_max_chars']).toBe(6000)
      expect(result.data['operation_guide']).toBeDefined()
    }
  })

  it('includes a project summary fragment when the summary file exists', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const { writeText } = requireWrite()
    const path = require('node:path').join(vault, '.StudyOS', 'projects', 'demo-project', 'prompt_summary.md')
    writeText(path, 'A project summary.')
    const result = handleStudyPromptContext({ project_id: 'demo-project', intent: 'planning' }, env(vault, iso))
    expect(result.ok).toBe(true)
    if (result.ok) {
      const kinds = (result.data['fragments'] as Array<Record<string, unknown>>).map(f => f['kind'])
      expect(kinds).toContain('project_summary')
    }
  })

  it('routes the domain fragment for a pack with a prompt skill', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    // Re-point the manifest to a kaoyan pack which has a prompt skill.
    const { readFileSync, writeFileSync } = require('node:fs')
    const manifestPath = require('node:path').join(vault, '.StudyOS', 'projects', 'demo-project', 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.domain_pack = 'kaoyan.v1'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const result = handleStudyPromptContext({ project_id: 'demo-project', intent: 'assessment' }, env(vault, iso))
    expect(result.ok).toBe(true)
    if (result.ok) {
      const kinds = (result.data['fragments'] as Array<Record<string, unknown>>).map(f => f['kind'])
      expect(kinds).toContain('domain')
    }
  })

  it('reports a too-small token pool as PROMPT_CONTEXT_TOO_LARGE', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    patchPolicy(vault, { total_max_tokens: 1 })
    const result = handleStudyPromptContext({ project_id: 'demo-project', intent: 'planning' }, env(vault, iso))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('PROMPT_CONTEXT_TOO_LARGE')
  })

  it('maps a non-StudyOS throw to STUDY_PROMPT_CONTEXT_FAILED', () => {
    const vault = tempVault()
    const result = handleStudyPromptContext({ project_id: 'demo-project', intent: 'planning' }, env(require('node:path').join(vault, 'missing')))
    expect(result.ok).toBe(false)
  })
})

function requireWrite(): { writeText: (path: string, content: string) => void } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return { writeText: (p: string, c: string) => require('node:fs').writeFileSync(p, c) }
}

function patchPolicy(vault: string, overrides: Record<string, unknown>): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync, writeFileSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join } = require('node:path')
  const path = join(vault, '.StudyOS', 'projects', 'demo-project', 'manifest.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  manifest.prompt_policy = { ...manifest.prompt_policy, ...overrides }
  writeFileSync(path, JSON.stringify(manifest))
}
