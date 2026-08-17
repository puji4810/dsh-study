/**
 * Shared test harness for the StudyOS resource-handler specs: a throwaway vault
 * under the platform temp directory, an injected HandlerEnv clock, and helpers
 * to seed a project manifest.
 * @module @puji4810/dsh-study/tests/helpers
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { StudyNote, StudySchedule } from '../src/types.ts'
import type { HandlerEnv } from '../src/handlers/dispatch.ts'

/** A fresh temp vault directory. */
export function tempVault(): string {
  return mkdtempSync(join(tmpdir(), 'studyos-handlers-'))
}

/** A HandlerEnv over a vault, with a fixed injected clock. */
export function env(vault: string, iso = '2026-01-15T08:00:00.000Z'): HandlerEnv {
  return { now: () => new Date(iso), vaultPath: vault }
}

/** Write a valid project manifest (plus the active pointer) into the vault. */
export function writeProject(vault: string, projectId: string, timezone = 'UTC'): void {
  const projectDir = join(vault, '.StudyOS', 'projects', projectId)
  mkdirSync(projectDir, { recursive: true })
  const manifest = {
    schema_version: 'study_project.v2',
    project_id: projectId,
    title: 'Demo Project',
    domain: 'general',
    timezone,
    phase: 'foundation',
    domain_pack: 'general.v1',
    workspace_type: 'skill-vault',
    artifact_policy: 'lightweight',
    tracks: [{ id: 't1', label: 'Track One' }],
    objectives: [{
      objective_id: 'obj-1',
      capability: 'Derive',
      success_criteria: ['correct'],
      evidence_targets: ['recall'],
    }],
    prompt_policy: {
      base_max_chars: 2000,
      intent_max_chars: 2500,
      domain_max_chars: 2000,
      project_summary_max_chars: 1200,
      total_max_chars: 6000,
      total_max_tokens: 1800,
      updates_apply: 'next_session',
    },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }
  writeFileSync(join(projectDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(vault, '.StudyOS', 'projects', 'active.json'), `${JSON.stringify({ project_id: projectId }, null, 2)}\n`)
}

/** Write a markdown note file into the vault. */
export function writeNote(vault: string, relativePath: string, content: string): string {
  const path = join(vault, relativePath)
  const parent = relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : ''
  if (parent) mkdirSync(join(vault, parent), { recursive: true })
  writeFileSync(path, content, 'utf8')
  return relativePath
}

/** Write a study_schedule.v1 file under a project's schedules directory. */
export function writeSchedule(vault: string, projectId: string, schedule: StudySchedule): void {
  const dir = join(vault, '.StudyOS', 'projects', projectId, 'schedules')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${schedule.schedule_id}.json`), `${JSON.stringify(schedule, null, 2)}\n`)
}

/** A minimal scheduled-event row for a study_schedule fixture. */
export function scheduledEvent(overrides: Partial<StudySchedule['events'][number]> & { start: string }): StudySchedule['events'][number] {
  return {
    id: overrides.id ?? `ev-${overrides.start}`,
    title: overrides.title ?? 'Study session',
    subject_id: overrides.subject_id ?? 't1',
    type: overrides.type ?? 'practice',
    start: overrides.start,
    end: overrides.end ?? overrides.start,
    duration_minutes: overrides.duration_minutes ?? 60,
    goals: overrides.goals ?? ['produce evidence'],
    status: overrides.status ?? 'planned',
    ...(overrides.source_curriculum !== undefined ? { source_curriculum: overrides.source_curriculum } : {}),
  }
}

/** A minimal example-note markdown body with review frontmatter. */
export function exampleNoteBody(options: {
  title?: string
  reviewCount?: number
  reviewLevel?: number
  nextReviewAt?: string
  lastReviewedAt?: string
  difficulty?: string
  concepts?: string[]
}): string {
  const lines = ['---']
  if (options.title !== undefined) lines.push(`title: ${options.title}`)
  if (options.reviewCount !== undefined) lines.push(`review_count: ${options.reviewCount}`)
  if (options.reviewLevel !== undefined) lines.push(`review_level: ${options.reviewLevel}`)
  if (options.nextReviewAt !== undefined) lines.push(`next_review_at: ${options.nextReviewAt}`)
  if (options.lastReviewedAt !== undefined) lines.push(`last_reviewed_at: ${options.lastReviewedAt}`)
  if (options.difficulty !== undefined) lines.push(`difficulty: ${options.difficulty}`)
  if (options.concepts !== undefined && options.concepts.length > 0) lines.push(`concepts:\n${options.concepts.map(c => `  - ${c}`).join('\n')}`)
  lines.push('---', '', `# ${options.title ?? 'Example'}`, '', 'Problem body', '', '## 答案', '', 'Answer body', '')
  return lines.join('\n')
}

/** Whether a path exists, kept for symmetry with the handler shims. */
export function fileExists(path: string): boolean {
  return existsSync(path)
}

/** A minimal parsed StudyNote for use in unit assertions. */
export function note(overrides: Partial<StudyNote> & { path: string; title: string }): StudyNote {
  return {
    basename: overrides.path.split('/').pop() ?? '',
    layer: 'example',
    frontmatter: {},
    tags: [],
    concepts: [],
    patterns: [],
    aliases: [],
    headings: [],
    wikilinks: [],
    excerpt: '',
    size: 0,
    modified: '',
    ...overrides,
  }
}
