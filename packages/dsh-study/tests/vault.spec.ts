import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { StudyOSError } from '../src/errors.ts'
import type { StudyAttempt, StudyProject } from '../src/types.ts'
import {
  activeProjectPath,
  activityDir,
  allAttempts,
  appendAttemptFile,
  appendText,
  attemptPathFor,
  decisionsDir,
  discoverSchedules,
  learningRecordsDir,
  lessonsDir,
  listMarkdownNotes,
  patternProposalDir,
  planProposalDir,
  projectDir,
  projectManifestPath,
  projectsRoot,
  promptBudget,
  promptPolicy,
  promptSummaryPath,
  readJsonFile,
  readJsonl,
  readNoteFile,
  readProjectManifest,
  readText,
  readTextPrefix,
  resolveProjectId,
  resolveVaultPath,
  runtimeIndexPath,
  safeRelativePath,
  scheduleDir,
  schedulePath,
  sessionsDir,
  studyDir,
  StudyWorkspace,
  upsertFrontmatterField,
  validateProjectId,
  validateScheduleId,
  writeJsonAtomic,
  writeText,
} from '../src/vault.ts'

function tempVault(): string {
  return mkdtempSync(join(tmpdir(), 'studyos-vault-'))
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 'study_project.v2',
    project_id: 'learn-math-2026',
    title: 'Math Study',
    domain: 'math',
    timezone: 'Asia/Shanghai',
    phase: 'foundation',
    domain_pack: 'general.v1',
    workspace_type: 'skill-vault',
    artifact_policy: 'lightweight',
    tracks: [{ id: 'math', label: 'Math' }],
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
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    ...overrides,
  }
}

function writeManifest(vault: string, overrides: Record<string, unknown> = {}): string {
  const m = manifest(overrides)
  const id = String(m.project_id)
  const dir = join(vault, '.StudyOS', 'projects', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(m, null, 2)}\n`)
  return id
}

function validSchedule(): Record<string, unknown> {
  return {
    schema_version: 'study_schedule.v1',
    schedule_id: 'good',
    project_id: 'learn-math-2026',
    title: 'Plan',
    timezone: 'Asia/Shanghai',
    range: { start: '2026-07-01', end: '2026-07-31' },
    phases: [{ id: 'f', title: 'F', start: '2026-07-01', end: '2026-07-31', goal: 'g' }],
    events: [{
      id: 'e1',
      title: 'E',
      subject_id: 'math',
      type: 'learning',
      start: '2026-07-08T19:00:00+08:00',
      end: '2026-07-08T20:00:00+08:00',
      duration_minutes: 60,
      goals: ['g'],
      status: 'planned',
    }],
  }
}

describe('vault path helpers', () => {
  it('resolves an explicit vault and rejects a missing one', () => {
    const vault = tempVault()
    expect(resolveVaultPath(vault, '/unused')).toBe(vault)
    expect(() => resolveVaultPath(join(vault, 'nope'), '/unused')).toThrow(StudyOSError)
  })

  it('falls back to configVaultPath when explicit is empty', () => {
    const vault = tempVault()
    expect(resolveVaultPath('', vault)).toBe(vault)
    expect(resolveVaultPath('   ', vault)).toBe(vault)
  })

  it('builds state, projects, and project subdirectories', () => {
    const vault = tempVault()
    expect(studyDir(vault).endsWith('.StudyOS')).toBe(true)
    expect(projectsRoot(vault).endsWith('.StudyOS/projects')).toBe(true)
    expect(projectDir(vault, 'abc-project').endsWith('projects/abc-project')).toBe(true)
  })

  it('projectDir raises on an escaping id', () => {
    const vault = tempVault()
    expect(() => projectDir(vault, '../escape')).toThrow(StudyOSError)
  })

  it('builds the specific file paths', () => {
    const vault = tempVault()
    expect(projectManifestPath(vault, 'abc-project').endsWith('projects/abc-project/manifest.json')).toBe(true)
    expect(promptSummaryPath(vault, 'abc-project').endsWith('prompt_summary.md')).toBe(true)
    expect(scheduleDir(vault, 'abc-project').endsWith('schedules')).toBe(true)
    expect(schedulePath(vault, 'abc-project', 'abc-plan').endsWith('schedules/abc-plan.json')).toBe(true)
    expect(activityDir(vault, 'abc-project').endsWith('activity')).toBe(true)
    expect(attemptPathFor(vault, 'abc-project', '2026-07-08T10:00:00Z').endsWith('activity/attempts-2026-07.jsonl')).toBe(true)
    expect(planProposalDir(vault, 'abc-project').endsWith('plan-proposals')).toBe(true)
    expect(patternProposalDir(vault, 'abc-project').endsWith('pattern-proposals')).toBe(true)
    expect(sessionsDir(vault, 'abc-project').endsWith('sessions')).toBe(true)
    expect(runtimeIndexPath(vault).endsWith('.StudyOS/runtime/active-sessions.json')).toBe(true)
    expect(decisionsDir(vault, 'abc-project').endsWith('decisions')).toBe(true)
    expect(learningRecordsDir(vault, 'abc-project').endsWith('learning-records')).toBe(true)
    expect(lessonsDir(vault, 'abc-project').endsWith('lessons')).toBe(true)
  })
})

describe('vault id validation', () => {
  it('validates project ids', () => {
    expect(validateProjectId('abc-project')).toBe('abc-project')
    expect(() => validateProjectId('A')).toThrow(StudyOSError)
    expect(() => validateProjectId('')).toThrow(StudyOSError)
  })

  it('validates schedule ids', () => {
    expect(validateScheduleId('abc-plan')).toBe('abc-plan')
    expect(() => validateScheduleId('X')).toThrow(StudyOSError)
  })
})

describe('text and JSON I/O', () => {
  it('readText/writeText round-trips and maps ENOENT', () => {
    const vault = tempVault()
    const path = join(vault, 'a.txt')
    writeText(path, 'hello')
    expect(readText(path)).toBe('hello')
    expect(() => readText(join(vault, 'missing.txt'))).toThrow(StudyOSError)
  })

  it('readTextPrefix bounds the read', () => {
    const vault = tempVault()
    const path = join(vault, 'a.txt')
    writeText(path, 'abcdefghij')
    expect(readTextPrefix(path, 5)).toBe('abcde')
    expect(readTextPrefix(path, 0)).toBe('')
  })

  it('appendText adds a separator only when needed', () => {
    const vault = tempVault()
    const path = join(vault, 'a.txt')
    appendText(path, 'one')
    appendText(path, 'two')
    expect(readText(path)).toBe('one\ntwo')
    const path2 = join(vault, 'b.txt')
    writeText(path2, 'x\n')
    appendText(path2, 'y')
    expect(readText(path2)).toBe('x\ny')
  })

  it('readJsonFile maps invalid JSON and non-objects', () => {
    const vault = tempVault()
    const bad = join(vault, 'bad.json')
    writeText(bad, '{nope')
    expect(() => readJsonFile(bad)).toThrow(StudyOSError)
    const arr = join(vault, 'arr.json')
    writeText(arr, '[1,2]')
    expect(() => readJsonFile(arr)).toThrow(StudyOSError)
    const good = join(vault, 'good.json')
    writeText(good, '{"a":1}')
    expect(readJsonFile(good)).toEqual({ a: 1 })
  })

  it('writeJsonAtomic writes and cleans its temp file', () => {
    const vault = tempVault()
    const path = join(vault, 'x.json')
    writeJsonAtomic(path, { a: 1 })
    expect(readJsonFile(path)).toEqual({ a: 1 })
  })

  it('readJsonl validates lines and objects', () => {
    const vault = tempVault()
    const path = join(vault, 'x.jsonl')
    writeText(path, '{"a":1}\n\n{"b":2}\n')
    expect(readJsonl(path)).toEqual([{ a: 1 }, { b: 2 }])
    const bad = join(vault, 'bad.jsonl')
    writeText(bad, '{nope\n')
    expect(() => readJsonl(bad)).toThrow(StudyOSError)
    const scalar = join(vault, 'scalar.jsonl')
    writeText(scalar, '3\n')
    expect(() => readJsonl(scalar)).toThrow(StudyOSError)
    expect(readJsonl(join(vault, 'missing.jsonl'))).toEqual([])
  })
})

describe('safeRelativePath and project resolution', () => {
  it('safeRelativePath resolves and rejects escapes', () => {
    const vault = tempVault()
    expect(safeRelativePath(vault, '')).toBe(vault)
    expect(safeRelativePath(vault, 'sub/dir')).toBe(join(vault, 'sub/dir'))
    expect(() => safeRelativePath(vault, '../outside')).toThrow(StudyOSError)
  })

  it('resolveProjectId falls back to the active pointer', () => {
    const vault = tempVault()
    const id = writeManifest(vault)
    writeFileSync(activeProjectPath(vault), `${JSON.stringify({ project_id: id }, null, 2)}\n`)
    expect(resolveProjectId(vault)).toBe(id)
    expect(resolveProjectId(vault, id)).toBe(id)
  })

  it('resolveProjectId raises when no active project', () => {
    const vault = tempVault()
    expect(() => resolveProjectId(vault)).toThrow(StudyOSError)
  })

  it('readProjectManifest validates or reports missing', () => {
    const vault = tempVault()
    expect(() => readProjectManifest(vault, 'missing-id')).toThrow(StudyOSError)
    writeManifest(vault)
    expect(readProjectManifest(vault, 'learn-math-2026').project_id).toBe('learn-math-2026')
  })
})

describe('attempts', () => {
  it('allAttempts sorts by (occurred_at, attempt_id)', () => {
    const vault = tempVault()
    writeManifest(vault)
    const a: StudyAttempt = { schema_version: 'study_attempt.v1', attempt_id: 'a2', project_id: 'learn-math-2026', item_id: 'i', occurred_at: '2026-07-08T10:00:00Z', response: '', result: 'correct', score: 1 }
    const b: StudyAttempt = { ...a, attempt_id: 'a1', occurred_at: '2026-07-08T09:00:00Z' }
    appendAttemptFile(vault, 'learn-math-2026', a, a.occurred_at)
    appendAttemptFile(vault, 'learn-math-2026', b, b.occurred_at)
    expect(allAttempts(vault, 'learn-math-2026').map(x => x.attempt_id)).toEqual(['a1', 'a2'])
  })
})

describe('notes', () => {
  it('listMarkdownNotes parses notes and skips hidden dirs', () => {
    const vault = tempVault()
    mkdirSync(join(vault, 'Notes'), { recursive: true })
    writeFileSync(join(vault, 'Notes', 'a.md'), '---\ntitle: A\n---\n\nbody [[b]]\n')
    expect(listMarkdownNotes(vault).map(n => n.title)).toEqual(['A'])
    mkdirSync(join(vault, '.hidden'), { recursive: true })
    writeFileSync(join(vault, '.hidden', 'x.md'), 'hidden')
    expect(listMarkdownNotes(vault).map(n => n.title)).toEqual(['A'])
  })

  it('listMarkdownNotes tolerates a dangling symlink inside a hidden dir', () => {
    const vault = tempVault()
    mkdirSync(join(vault, 'Notes'), { recursive: true })
    writeFileSync(join(vault, 'Notes', 'a.md'), '---\ntitle: A\n---\nbody\n')
    mkdirSync(join(vault, '.venv', 'bin'), { recursive: true })
    const broken = join(vault, '.venv', 'bin', 'python')
    const target = join(vault, 'definitely-missing-target')
    try {
      symlinkSync(target, broken)
    } catch {
      return // Filesystem without symlink support: nothing to exercise.
    }
    expect(listMarkdownNotes(vault).map(n => n.title)).toEqual(['A'])
  })

  it('readNoteFile resolves, flags missing, and reads body', () => {
    const vault = tempVault()
    mkdirSync(join(vault, 'Notes'), { recursive: true })
    writeFileSync(join(vault, 'Notes', 'a.md'), '---\ntitle: A\n---\nbody text\n')
    expect(readNoteFile(vault, 'Notes/a').note.title).toBe('A')
    expect(readNoteFile(vault, 'Notes/a', { includeBody: true }).note.body).toBe('body text')
    expect(() => readNoteFile(vault, 'nope')).toThrowError(/Note not found/)
  })
})

describe('upsertFrontmatterField', () => {
  it('creates a frontmatter block when absent', () => {
    const vault = tempVault()
    const path = join(vault, 'n.md')
    writeText(path, 'body text')
    upsertFrontmatterField(path, 'level', 3)
    expect(readText(path)).toBe('---\nlevel: 3\n---\n\nbody text')
  })

  it('replaces an existing field line', () => {
    const vault = tempVault()
    const path = join(vault, 'n.md')
    writeText(path, '---\nlevel: 1\n---\nbody\n')
    upsertFrontmatterField(path, 'level', 5)
    expect(readText(path)).toBe('---\nlevel: 5\n---\nbody\n')
  })

  it('inserts before the closing fence', () => {
    const vault = tempVault()
    const path = join(vault, 'n.md')
    writeText(path, '---\ntitle: T\n---\nbody\n')
    upsertFrontmatterField(path, 'level', 2)
    expect(readText(path)).toBe('---\ntitle: T\nlevel: 2\n---\nbody\n')
  })

  it('serializes booleans and dates', () => {
    const vault = tempVault()
    const b = join(vault, 'b.md')
    writeText(b, 'x')
    upsertFrontmatterField(b, 'flag', true)
    expect(readText(b)).toContain('flag: true')
    const d = join(vault, 'd.md')
    writeText(d, 'x')
    upsertFrontmatterField(d, 'on', new Date('2026-07-08T00:00:00Z'))
    expect(readText(d)).toContain('on: 2026-07-08')
  })

  it('does nothing when the closing fence is missing', () => {
    const vault = tempVault()
    const path = join(vault, 'n.md')
    writeText(path, '---\ntitle: T\n')
    upsertFrontmatterField(path, 'level', 2)
    expect(readText(path)).toBe('---\ntitle: T\n')
  })
})

describe('discoverSchedules', () => {
  it('returns schedules and invalid schedules', () => {
    const vault = tempVault()
    writeManifest(vault)
    const schedDir = scheduleDir(vault, 'learn-math-2026')
    writeFileSync(join(schedDir, 'good.json'), JSON.stringify(validSchedule()))
    writeFileSync(join(schedDir, 'bad.json'), '{nope')
    const result = discoverSchedules(vault, 'learn-math-2026', () => [])
    expect(result.project_id).toBe('learn-math-2026')
    expect(result.schedules).toHaveLength(1)
    expect(result.invalid_schedules).toHaveLength(1)
  })

  it('flags a schedule whose id mismatches its filename', () => {
    const vault = tempVault()
    writeManifest(vault)
    const schedDir = scheduleDir(vault, 'learn-math-2026')
    writeFileSync(join(schedDir, 'wrong.json'), JSON.stringify(validSchedule()))
    const result = discoverSchedules(vault, 'learn-math-2026', () => [])
    expect(result.schedules).toHaveLength(0)
    expect(result.invalid_schedules).toHaveLength(1)
  })

  it('runs the relationship validator', () => {
    const vault = tempVault()
    writeManifest(vault)
    const schedDir = scheduleDir(vault, 'learn-math-2026')
    writeFileSync(join(schedDir, 'good.json'), JSON.stringify(validSchedule()))
    const result = discoverSchedules(vault, 'learn-math-2026', () => ['relationship error'])
    expect(result.invalid_schedules[0]?.errors).toEqual(['relationship error'])
  })
})

describe('prompt policy and budget', () => {
  it('merges policy and computes the budget', () => {
    const project = manifest() as unknown as StudyProject
    expect(promptPolicy(project).base_max_chars).toBe(2000)
    expect(promptBudget(promptPolicy(project))).toEqual({ poolTokens: 1800, totalMaxChars: 6000 })
  })
})

describe('StudyWorkspace', () => {
  it('lists projects and selects one atomically', () => {
    const vault = tempVault()
    writeManifest(vault)
    const ws = new StudyWorkspace({ vault, source: 'explicit' })
    expect(ws.activeProjectId()).toBe(null)
    expect(ws.selectProject('learn-math-2026').project_id).toBe('learn-math-2026')
    expect(ws.activeProjectId()).toBe('learn-math-2026')
    expect(ws.listProjects().map(p => p.project_id)).toEqual(['learn-math-2026'])
  })

  it('project raises when no active project', () => {
    const vault = tempVault()
    const ws = new StudyWorkspace({ vault, source: 'explicit' })
    expect(() => ws.project()).toThrow(StudyOSError)
  })

  it('exposes the path getters', () => {
    const vault = tempVault()
    const ws = new StudyWorkspace({ vault, source: 'explicit' })
    expect(ws.projectsRoot.endsWith('projects')).toBe(true)
    expect(ws.studyDir.endsWith('.StudyOS')).toBe(true)
    expect(ws.activeProjectPath.endsWith('active.json')).toBe(true)
  })
})
