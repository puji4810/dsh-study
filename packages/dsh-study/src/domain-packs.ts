/**
 * Discoverable domain policy for StudyOS: the four built-in Domain Packs and their
 * resolution registry. Text and defaults mirror the original domain-packs package
 * verbatim; resolution follows the same `domain_pack`-over-`domain` precedence.
 * @module @puji4810/dsh-study/domain-packs
 */

import { PROJECT_SCHEMA_VERSION_V2 } from './constants.ts'
import {
  ActivityAdapter,
  EngineeringActivityAdapter,
  GeneralActivityAdapter,
  ResearchActivityAdapter,
} from './activities.ts'
import type { StudyData, StudyProject } from './types.ts'

/** The pack resolved when no more specific pack applies. */
const FALLBACK_PACK_ID = 'general.v1'

/** All domain-specific policy consumed by the shared StudyOS runtime. */
export interface DomainPack {
  readonly id: string
  readonly activityAdapter: ActivityAdapter
  readonly promptSkill: string | null
  readonly interventionDuration: number
  readonly projectDefaults: Readonly<Record<string, unknown>>
  readonly scheduleTemplate: (project: StudyProject) => Record<string, unknown>
}

/** Domain-neutral StudyOS policy. */
const GENERAL_PROJECT_DEFAULTS: Record<string, unknown> = {
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
}

/** Return a domain-neutral starter plan grounded in one reusable concept. */
function generalScheduleTemplate(project: StudyProject): Record<string, unknown> {
  const projectId = project.project_id
  const rawGroups = project.schema_version === PROJECT_SCHEMA_VERSION_V2 ? project['tracks'] : project['subjects']
  const groups = Array.isArray(rawGroups) ? rawGroups : []
  const subjectId = typeof groups[0]?.id === 'string' ? groups[0].id : 'learning'
  return {
    schema_version: 'study_schedule.v1',
    schedule_id: `${projectId}-master-plan`,
    project_id: projectId,
    title: `${project.title} 学习计划`,
    timezone: project.timezone,
    range: { start: '2026-07-01', end: '2026-07-31' },
    phases: [
      {
        id: project.phase,
        title: 'Discovery',
        start: '2026-07-01',
        end: '2026-09-30',
        goal: 'Map one concrete learning objective to lightweight notes and source anchors',
      },
    ],
    events: [
      {
        id: 'evt-20260701-learning-scout',
        title: 'Scout one concept and source anchor',
        subject_id: subjectId,
        type: 'learning',
        start: '2026-07-01T19:00:00+08:00',
        end: '2026-07-01T20:00:00+08:00',
        duration_minutes: 60,
        goals: ['Create or update one lightweight concept note only if it will be reused'],
        source_curriculum: 'project-roadmap',
        status: 'planned',
      },
    ],
  }
}

/** 考研 learning policy and starter plan. */
const KAOYAN_PROJECT_DEFAULTS: Record<string, unknown> = {
  project_id: 'kaoyan-2027',
  title: '2027 考研学习计划',
  domain: 'kaoyan',
  exam_type: '考研',
  exam_date: '2027-12-20',
  phase: 'foundation',
  domain_pack: 'kaoyan.v1',
  workspace_type: 'exam-vault',
  artifact_policy: 'lightweight',
  subjects: [
    { id: 'math', label: '数学', target_score: 120 },
    { id: 'english', label: '英语一', target_score: 75 },
    { id: 'politics', label: '政治', target_score: 75 },
  ],
}

/** Return the kaoyan exam-oriented starter plan. */
function kaoyanScheduleTemplate(project: StudyProject): Record<string, unknown> {
  const projectId = project.project_id
  return {
    schema_version: 'study_schedule.v1',
    schedule_id: `${projectId}-master-plan`,
    project_id: projectId,
    title: `${project.title} 学习计划`,
    timezone: project.timezone,
    range: { start: '2026-07-01', end: '2026-07-31' },
    phases: [
      {
        id: project.phase,
        title: '基础阶段',
        start: '2026-07-01',
        end: '2026-09-30',
        goal: '完成核心考点覆盖',
      },
    ],
    events: [
      {
        id: 'evt-20260701-math-derivative',
        title: '数学：导数定义整理',
        subject_id: 'math',
        type: 'learning',
        start: '2026-07-01T19:00:00+08:00',
        end: '2026-07-01T21:00:00+08:00',
        duration_minutes: 120,
        goals: ['整理导数定义例题'],
        source_curriculum: '一元函数微分学',
        status: 'planned',
      },
    ],
  }
}

interface PackSpec {
  id: string
  activityAdapter: ActivityAdapter
  promptSkill: string | null
  interventionDuration: number
  projectDefaults: Record<string, unknown>
  scheduleTemplate: (project: StudyProject) => Record<string, unknown>
}

/** Build a pack with frozen defaults from its spec. */
function makePack(spec: PackSpec): DomainPack {
  return {
    id: spec.id,
    activityAdapter: spec.activityAdapter,
    promptSkill: spec.promptSkill,
    interventionDuration: spec.interventionDuration,
    projectDefaults: Object.freeze({ ...spec.projectDefaults }),
    scheduleTemplate: spec.scheduleTemplate,
  }
}

/** The four built-in packs, built once on first registry request. */
function builtInPacks(): readonly DomainPack[] {
  return [
    makePack({
      id: 'general.v1',
      activityAdapter: new GeneralActivityAdapter(),
      promptSkill: null,
      interventionDuration: 30,
      projectDefaults: GENERAL_PROJECT_DEFAULTS,
      scheduleTemplate: generalScheduleTemplate,
    }),
    makePack({
      id: 'engineering.v1',
      activityAdapter: new EngineeringActivityAdapter(),
      promptSkill: 'study-engineering',
      interventionDuration: 45,
      projectDefaults: { ...GENERAL_PROJECT_DEFAULTS, domain_pack: 'engineering.v1' },
      scheduleTemplate: generalScheduleTemplate,
    }),
    makePack({
      id: 'kaoyan.v1',
      activityAdapter: new GeneralActivityAdapter(),
      promptSkill: 'study-kaoyan',
      interventionDuration: 30,
      projectDefaults: KAOYAN_PROJECT_DEFAULTS,
      scheduleTemplate: kaoyanScheduleTemplate,
    }),
    makePack({
      id: 'research.v1',
      activityAdapter: new ResearchActivityAdapter(),
      promptSkill: 'study-research',
      interventionDuration: 60,
      projectDefaults: { ...GENERAL_PROJECT_DEFAULTS, domain_pack: 'research.v1' },
      scheduleTemplate: generalScheduleTemplate,
    }),
  ]
}

let cache: Readonly<Record<string, DomainPack>> | undefined

/**
 * The registry of installed packs, cached at module level. The four built-in packs are
 * unique and always include `general.v1`, so the registry never duplicates an id nor
 * misses its fallback.
 * @returns the id-to-pack mapping.
 */
export function domainPackRegistry(): Readonly<Record<string, DomainPack>> {
  if (cache !== undefined) return cache
  const registry: Record<string, DomainPack> = {}
  for (const pack of builtInPacks()) {
    registry[pack.id] = pack
  }
  cache = Object.freeze(registry)
  return cache
}

/** Resolve the family (the ``<domain>`` prefix) of an id or requested value. */
function familyOf(value: string): string {
  return value.split('.', 1)[0] as string
}

/** Normalize an unknown record value to a trimmed lowercase string, empty when absent. */
function toTrimmedLower(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/** Match a value by unique family within a registry; null when 0 or many match. */
function familyMatch(value: string, registry: Readonly<Record<string, DomainPack>>): DomainPack | null {
  const family = familyOf(value)
  const matches = Object.entries(registry)
    .filter(([packId]) => familyOf(packId) === family)
    .map(([, pack]) => pack)
  return matches.length === 1 ? matches[0] as DomainPack : null
}

/**
 * Resolve a pack, with `domain_pack` authoritative over `domain`. A string selector is
 * treated as the requested pack id; null/undefined fall back to `general.v1`.
 * @param selector - a project record, a requested pack id, or nothing.
 * @returns the resolved domain pack.
 */
export function domainPackFor(selector: StudyData | string | null | undefined): DomainPack {
  const registry = domainPackRegistry()
  let requested: string
  let domain: string
  if (typeof selector === 'string' || selector === null || selector === undefined) {
    requested = (selector ?? '').trim().toLowerCase()
    domain = ''
  } else {
    requested = toTrimmedLower(selector['domain_pack'])
    domain = toTrimmedLower(selector['domain'])
  }
  if (requested) {
    return registry[requested] ?? familyMatch(requested, registry) ?? registry[FALLBACK_PACK_ID] as DomainPack
  }
  if (domain) {
    return registry[domain] ?? familyMatch(domain, registry) ?? registry[FALLBACK_PACK_ID] as DomainPack
  }
  return registry[FALLBACK_PACK_ID] as DomainPack
}
