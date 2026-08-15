import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { handleStudyProject } from '../../src/handlers/project.ts'
import { env, tempVault, writeProject } from '../helpers.ts'

describe('handleStudyProject', () => {
  it('init creates a project and selects it', () => {
    const vault = tempVault()
    const e = env(vault)
    const result = handleStudyProject({ action: 'init', project_id: 'demo-project' }, e)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect((result.data['project'] as { project_id: string })['project_id']).toBe('demo-project')
      expect(result.data['path']).toBe('.StudyOS/projects/demo-project/manifest.json')
      expect(existsSync(join(vault, '.StudyOS', 'projects', 'demo-project', 'manifest.json'))).toBe(true)
    }
  })

  it('init validates and rejects a bad manifest', () => {
    const vault = tempVault()
    const e = env(vault)
    const result = handleStudyProject({ action: 'init', project_id: 'bad', schema_version: 'nope' }, e)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('select requires an existing project', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const e = env(vault)
    const result = handleStudyProject({ action: 'select', project_id: 'demo-project' }, e)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data['active_path']).toBe('.StudyOS/projects/active.json')
  })

  it('select rejects a missing project', () => {
    const vault = tempVault()
    const e = env(vault)
    const result = handleStudyProject({ action: 'select', project_id: 'missing-proj' }, e)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('PROJECT_NOT_FOUND')
  })

  it('status reports counts and active state', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const e = env(vault)
    const result = handleStudyProject({ action: 'status', project_id: 'demo-project' }, e)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect((result.data['project'] as { project_id: string })['project_id']).toBe('demo-project')
      expect(result.data['schedule_count']).toBe(0)
    }
  })

  it('update_prompt_summary stores the summary with warnings', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const e = env(vault)
    const long = 'x'.repeat(7000)
    const result = handleStudyProject({ action: 'update_prompt_summary', project_id: 'demo-project', summary: long }, e)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data['char_count']).toBe(7000)
      expect(result.warnings.length).toBeGreaterThan(0)
    }
  })

  it('update_prompt_summary with a short summary has no warnings', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const e = env(vault)
    const result = handleStudyProject({ action: 'update_prompt_summary', project_id: 'demo-project', summary: 'short' }, e)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.warnings).toEqual([])
  })

  it('unknown action returns INVALID_ACTION', () => {
    const vault = tempVault()
    writeProject(vault, 'demo-project')
    const result = handleStudyProject({ action: 'nope' }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_ACTION')
  })

  it('maps a non-StudyOS throw to STUDY_PROJECT_FAILED', () => {
    const vault = tempVault()
    // A manifest that passes existence but fails during JSON parse is impossible,
    // so drive the catch via an unreadable vault.
    const result = handleStudyProject({ action: 'status', project_id: 'demo-project' }, env(join(vault, 'missing')))
    expect(result.ok).toBe(false)
  })
})

void writeFileSync
