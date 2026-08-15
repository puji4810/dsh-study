import { describe, expect, it } from 'vitest'
import { domainPackFor, domainPackRegistry, type DomainPack } from '../src/domain-packs.ts'
import {
  EngineeringActivityAdapter,
  GeneralActivityAdapter,
  ResearchActivityAdapter,
} from '../src/activities.ts'
import type { StudyProject } from '../src/types.ts'

function pack(): Record<string, DomainPack> {
  return { ...domainPackRegistry() }
}

function project(overrides: Record<string, unknown> = {}): StudyProject {
  return {
    schema_version: 'study_project.v2',
    project_id: 'demo-project',
    title: 'Demo',
    domain: 'general',
    timezone: 'Asia/Shanghai',
    phase: 'foundation',
    domain_pack: 'general.v1',
    workspace_type: 'skill-vault',
    artifact_policy: 'lightweight',
    tracks: [{ id: 't1', label: 'Track' }],
    objectives: [],
    prompt_policy: {
      base_max_chars: 2000,
      intent_max_chars: 2500,
      domain_max_chars: 2000,
      project_summary_max_chars: 1200,
      total_max_chars: 6000,
      updates_apply: 'next_session' as const,
    },
    created_at: '2026-07-01T10:00:00Z',
    updated_at: '2026-07-01T10:00:00Z',
    ...overrides,
  } as unknown as StudyProject
}

describe('domainPackRegistry', () => {
  it('registers exactly the four built-in packs', () => {
    const registry = pack()
    expect(Object.keys(registry).sort()).toEqual(['engineering.v1', 'general.v1', 'kaoyan.v1', 'research.v1'])
  })

  it('reports correct per-pack metadata', () => {
    const registry = pack()
    expect(registry['general.v1']?.promptSkill).toBeNull()
    expect(registry['general.v1']?.interventionDuration).toBe(30)
    expect(registry['general.v1']?.activityAdapter).toBeInstanceOf(GeneralActivityAdapter)

    expect(registry['engineering.v1']?.promptSkill).toBe('study-engineering')
    expect(registry['engineering.v1']?.interventionDuration).toBe(45)
    expect(registry['engineering.v1']?.activityAdapter).toBeInstanceOf(EngineeringActivityAdapter)

    expect(registry['kaoyan.v1']?.promptSkill).toBe('study-kaoyan')
    expect(registry['kaoyan.v1']?.interventionDuration).toBe(30)
    expect(registry['kaoyan.v1']?.activityAdapter).toBeInstanceOf(GeneralActivityAdapter)

    expect(registry['research.v1']?.promptSkill).toBe('study-research')
    expect(registry['research.v1']?.interventionDuration).toBe(60)
    expect(registry['research.v1']?.activityAdapter).toBeInstanceOf(ResearchActivityAdapter)
  })

  it('returns the same cached registry object twice', () => {
    expect(domainPackRegistry()).toBe(domainPackRegistry())
  })

  it('exposes general and kaoyan defaults verbatim', () => {
    const registry = pack()
    expect(registry['general.v1']?.projectDefaults).toMatchObject({
      project_id: 'general-learning',
      title: 'General Learning Project',
      domain: 'general',
      exam_type: 'none',
      exam_date: '2099-12-31',
      phase: 'discovery',
      domain_pack: 'general.v1',
      workspace_type: 'skill-vault',
      artifact_policy: 'lightweight',
      subjects: [{ id: 'learning', label: 'Learning' }],
    })
    expect(registry['kaoyan.v1']?.projectDefaults).toMatchObject({
      project_id: 'kaoyan-2027',
      title: '2027 考研学习计划',
      domain: 'kaoyan',
      exam_type: '考研',
      exam_date: '2027-12-20',
      phase: 'foundation',
      domain_pack: 'kaoyan.v1',
      workspace_type: 'exam-vault',
      artifact_policy: 'lightweight',
    })
  })

  it('derives engineering/research defaults from general', () => {
    const registry = pack()
    expect(registry['engineering.v1']?.projectDefaults['domain_pack']).toBe('engineering.v1')
    expect(registry['engineering.v1']?.projectDefaults['project_id']).toBe('general-learning')
    expect(registry['research.v1']?.projectDefaults['domain_pack']).toBe('research.v1')
  })
})

describe('domainPackFor', () => {
  it('resolves to general.v1 for a null/undefined/empty selector', () => {
    expect(domainPackFor(null).id).toBe('general.v1')
    expect(domainPackFor(undefined).id).toBe('general.v1')
    expect(domainPackFor('').id).toBe('general.v1')
  })

  it('resolves a requested pack id string', () => {
    expect(domainPackFor('engineering.v1').id).toBe('engineering.v1')
    expect(domainPackFor('research.v1').id).toBe('research.v1')
  })

  it('prefers domain_pack over domain', () => {
    const p = project({ domain_pack: 'research.v1', domain: 'engineering' })
    expect(domainPackFor(p).id).toBe('research.v1')
  })

  it('uses domain when domain_pack is absent', () => {
    const p = project({ domain_pack: undefined, domain: 'engineering' })
    expect(domainPackFor(p).id).toBe('engineering.v1')
  })

  it('falls back to general.v1 for an unknown id or domain', () => {
    expect(domainPackFor('no-such.v9').id).toBe('general.v1')
    expect(domainPackFor(project({ domain_pack: 'missing.v1' })).id).toBe('general.v1')
    expect(domainPackFor(project({ domain_pack: undefined, domain: 'unknown' })).id).toBe('general.v1')
  })

  it('resolves a bare family when exactly one version exists', () => {
    expect(domainPackFor('engineering').id).toBe('engineering.v1')
    expect(domainPackFor('kaoyan').id).toBe('kaoyan.v1')
  })

  it('resolves a project with only a domain', () => {
    expect(domainPackFor({ domain: 'kaoyan' }).id).toBe('kaoyan.v1')
  })
})

describe('scheduleTemplate', () => {
  it('general produces the domain-neutral plan for v2 tracks', () => {
    const packObj = pack()['general.v1']!
    const schedule = packObj.scheduleTemplate(project({ tracks: [{ id: 'math', label: 'Math' }], title: 'My Plan' }))
    expect(schedule).toMatchObject({
      schema_version: 'study_schedule.v1',
      schedule_id: 'demo-project-master-plan',
      project_id: 'demo-project',
      title: 'My Plan 学习计划',
      timezone: 'Asia/Shanghai',
      range: { start: '2026-07-01', end: '2026-07-31' },
    })
    const event = (schedule['events'] as unknown[])[0] as Record<string, unknown>
    expect(event['subject_id']).toBe('math')
    expect(event['id']).toBe('evt-20260701-learning-scout')
  })

  it('general falls back to subjects for a v1 project with a default subject', () => {
    const packObj = pack()['general.v1']!
    const v1 = project({
      schema_version: 'study_project.v1',
      tracks: undefined,
      subjects: [{ id: 'learning', label: 'Learning' }],
      title: 'V1 Plan',
    })
    const schedule = packObj.scheduleTemplate(v1)
    const event = (schedule['events'] as unknown[])[0] as Record<string, unknown>
    expect(event['subject_id']).toBe('learning')
  })

  it('general defaults the subject id when no groups are present', () => {
    const packObj = pack()['general.v1']!
    const bare = project({ tracks: undefined, subjects: undefined })
    const schedule = packObj.scheduleTemplate(bare)
    const event = (schedule['events'] as unknown[])[0] as Record<string, unknown>
    expect(event['subject_id']).toBe('learning')
  })

  it('kaoyan produces the exam-oriented starter plan', () => {
    const packObj = pack()['kaoyan.v1']!
    const schedule = packObj.scheduleTemplate(project({ project_id: 'kaoyan-2027', title: '2027 考研学习计划', phase: 'foundation' }))
    expect(schedule).toMatchObject({
      schedule_id: 'kaoyan-2027-master-plan',
      title: '2027 考研学习计划 学习计划',
    })
    const phase = (schedule['phases'] as unknown[])[0] as Record<string, unknown>
    expect(phase['title']).toBe('基础阶段')
    const event = (schedule['events'] as unknown[])[0] as Record<string, unknown>
    expect(event['id']).toBe('evt-20260701-math-derivative')
    expect(event['title']).toBe('数学：导数定义整理')
  })

  it('engineering and research reuse the general schedule template', () => {
    const engineering = pack()['engineering.v1']!
    const research = pack()['research.v1']!
    const schedule = engineering.scheduleTemplate(project())
    expect((schedule['events'] as unknown[])[0]).toMatchObject({ id: 'evt-20260701-learning-scout' })
    expect(research.scheduleTemplate(project())['schema_version']).toBe('study_schedule.v1')
  })
})
