/**
 * StudyOS curriculum resource handlers: create, list, import a problem checklist
 * (题单), and track plan progress. Mirrors the original `handle_study_create_curriculum`,
 * `handle_study_list_curricula`,
 * `handle_study_import_plan`, and `handle_study_plan_progress`.
 * @module @puji4810/dsh-study/handlers/curriculum
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'

import { err, ok, type StudyEnvelope } from '../errors.ts'
import type { StudyData } from '../types.ts'
import { resolveVaultPath, studyDir } from '../vault.ts'
import type { HandlerEnv } from './dispatch.ts'

/** The curriculum schema version the original plugin stamps. */
const CURRICULUM_VERSION = '1'

/** The empty curriculum template returned when no data is supplied. */
const CURRICULUM_TEMPLATE: Record<string, unknown> = {
  version: CURRICULUM_VERSION,
  meta: { topic: '', textbook: '', exercise_book: '', created_at: '' },
  sections: [],
}

/** The curricula directory inside the StudyOS state dir. */
function curriculaDir(vault: string): string {
  const dir = `${studyDir(vault)}/curricula`
  mkdirRecursive(dir)
  return dir
}

/** The learning-plans directory inside the StudyOS state dir. */
function plansDir(vault: string): string {
  const dir = `${studyDir(vault)}/learning_plans`
  mkdirRecursive(dir)
  return dir
}

/** A vault-relative slash path. */
function relativeToVault(vault: string, path: string): string {
  return path.slice(vault.length + 1)
}

/** Deep-copy a JSON value by round-tripping through JSON. */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Today's ISO timestamp (seconds precision) for `created_at`. */
function nowIso(env: HandlerEnv): string {
  return env.now().toISOString()
}

/**
 * Create, list, import, or track a curriculum or learning plan.
 * @param args - the payload with `action` plus action-specific fields.
 * @param env - the handler environment.
 * @returns the curriculum envelope.
 */
export function handleStudyCurriculum(args: StudyData, env: HandlerEnv): StudyEnvelope {
  const action = String(args.action || '').trim()
  if (action === 'create') return createCurriculum(args, env)
  if (action === 'list') return listCurricula(args, env)
  if (action === 'import_plan') return importPlan(args, env)
  if (action === 'progress') return planProgress(args, env)
  return err('INVALID_ACTION', `Unsupported study_curriculum action: ${action}`)
}

/** Validate a curriculum object; returns normalized errors (empty when valid). */
function validateCurriculum(data: StudyData): string[] {
  const errors: string[] = []
  const meta = isObject(data.meta) ? data.meta : null
  if (meta === null) {
    errors.push('meta is required')
  } else {
    if (!meta.topic) errors.push('meta.topic is required')
    if (!meta.textbook) errors.push('meta.textbook is required')
  }
  if (!Array.isArray(data.sections)) {
    errors.push('sections must be a list')
  } else {
    data.sections.forEach((section, i) => {
      if (typeof (section as StudyData)?.title !== 'string' || !String((section as StudyData).title).trim()) {
        errors.push(`sections[${i}].title is required`)
      }
      const kaodian = (section as StudyData)?.kaodian
      if (Array.isArray(kaodian)) {
        kaodian.forEach((kd, j) => {
          if (typeof (kd as StudyData)?.name !== 'string' || !String((kd as StudyData).name).trim()) {
            errors.push(`sections[${i}].kaodian[${j}].name is required`)
          }
        })
      }
    })
  }
  return errors
}

/** The `create` action: write a curriculum, or return a template when data is absent. */
function createCurriculum(args: StudyData, env: HandlerEnv): StudyEnvelope {
  try {
    const vault = resolveVaultPath(args.vault_path, env.vaultPath)
    const data = args.data
    if (data === undefined || data === null) {
      const template = deepClone(CURRICULUM_TEMPLATE)
      ;(template.meta as Record<string, unknown>).created_at = nowIso(env)
      return ok({ template })
    }
    if (!isObject(data)) {
      return err('INVALID_DATA', 'data must be a JSON object')
    }
    const errors = validateCurriculum(data)
    if (errors.length > 0) {
      return err('VALIDATION_FAILED', errors.join('; '))
    }
    const topic = String((data.meta as StudyData).topic).trim()
    const meta = data.meta as StudyData
    data.version = data.version || CURRICULUM_VERSION
    meta.created_at = meta.created_at || nowIso(env)
    const outPath = `${curriculaDir(vault)}/${topic}.json`
    writeFileSync(outPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    const sections = data.sections as unknown[]
    const kaodian = sections.reduce<number>((sum, section) => sum + sectionKaodianCount(section), 0)
    return ok({
      path: relativeToVault(vault, outPath),
      topic,
      sections: sections.length,
      kaodian,
    })
  } catch (error) {
    return err('CREATE_CURRICULUM_FAILED', errorMessage(error))
  }
}

/** The `list` action: enumerate curricula with per-curriculum summaries. */
function listCurricula(args: StudyData, env: HandlerEnv): StudyEnvelope {
  try {
    const vault = resolveVaultPath(args.vault_path, env.vaultPath)
    const topic = String(args.topic || '').trim()
    const curricula: Array<Record<string, unknown>> = []
    for (const path of sortedJsonFiles(curriculaDir(vault))) {
      try {
        const content = JSON.parse(readFileSync(path, 'utf8')) as StudyData
        if (topic && (content.meta as StudyData)?.topic !== topic) continue
        const meta = content.meta as StudyData
        const sections = Array.isArray(content.sections) ? content.sections : []
        curricula.push({
          topic: meta.topic,
          textbook: meta.textbook ?? '',
          exercise_book: meta.exercise_book ?? '',
          sections: sections.length,
          kaodian: sections.reduce((sum, section) => sum + sectionKaodianCount(section), 0),
          file: relativeToVault(vault, path),
        })
      } catch {
        // Malformed curricula are skipped, matching the original list behavior.
      }
    }
    return ok({ curricula })
  } catch (error) {
    return err('LIST_CURRICULA_FAILED', errorMessage(error))
  }
}

/** The `import_plan` action: parse a 题单 markdown into a learning plan JSON. */
function importPlan(args: StudyData, env: HandlerEnv): StudyEnvelope {
  try {
    const vault = resolveVaultPath(args.vault_path, env.vaultPath)
    const tidanRef = String(args.tidan || '').trim()
    if (!tidanRef) {
      const reviewDir = `${vault}/review`
      let available: string[] = []
      try {
        available = readdirSync(reviewDir)
          .filter(name => name.endsWith('.md'))
          .map(name => relativeToVault(vault, `${reviewDir}/${name}`))
          .sort()
      } catch {
        available = []
      }
      return ok({ available_tidan: available })
    }
    const tidanPath = `${vault}/${tidanRef}`
    if (!existsSync(tidanPath)) {
      return err('TIDAN_NOT_FOUND', tidanPath)
    }
    const plan = parseTidan(vault, tidanPath, env.now().toISOString())
    const topic = String(plan.topic || '').trim() || stemOf(tidanPath)
    plan.topic = topic
    const outPath = `${plansDir(vault)}/${topic}.json`
    writeFileSync(outPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
    return ok({ path: relativeToVault(vault, outPath), plan })
  } catch (error) {
    return err('IMPORT_PLAN_FAILED', errorMessage(error))
  }
}

/** The `progress` action: summarize per-plan completion across learning_plans. */
function planProgress(args: StudyData, env: HandlerEnv): StudyEnvelope {
  try {
    const vault = resolveVaultPath(args.vault_path, env.vaultPath)
    const topic = String(args.topic || '').trim()
    const allPlans: Array<StudyData & { _file: string }> = []
    for (const path of sortedJsonFiles(plansDir(vault))) {
      try {
        const plan = JSON.parse(readFileSync(path, 'utf8')) as StudyData & { _file: string }
        plan._file = relativeToVault(vault, path)
        allPlans.push(plan)
      } catch {
        continue
      }
    }
    const filtered = topic ? allPlans.filter(plan => plan.topic === topic) : allPlans
    const summaries = filtered.map(plan => {
      const completed = Array.isArray(plan.completed_kaodian) ? plan.completed_kaodian.length : 0
      const total = Number(plan.total_kaodian ?? 0)
      const checklist = Array.isArray(plan.checklist) ? plan.checklist : []
      return {
        topic: plan.topic,
        source: plan.source ?? '',
        progress_pct: total ? Math.round((completed / total) * 1000) / 10 : 0,
        completed_kaodian: completed,
        total_kaodian: total,
        total_problems: Number(plan.total_problems ?? 0),
        checklist_total: checklist.length,
        checklist_done: checklist.filter(item => String(item).startsWith('- [x]')).length,
        file: plan._file,
      }
    })
    return ok({ plans: summaries })
  } catch (error) {
    return err('PLAN_PROGRESS_FAILED', errorMessage(error))
  }
}

// ---- 题单 (problem-checklist) markdown parser ----

const H1_RE = /^#\s+(.+)$/
const SECTION_RE = /^[│\s├└─]*([一二三四五六七八九十]+)、(.+?)(?:（考点\s*[\d\-,]+)?(?:[，,]\s*(\d+)\s*题)?(?:）)?$/
const TREE_KAODIAN_RE = /考点\s*(\d+)[：:]\s*(.+?)(?:（(\d+)\s*题）)/
const TABLE_ID_RE = /\*\*(\d+)\*\*/

/**
 * Parse a 题单 markdown file into a structured learning plan.
 * @param vault - the resolved vault path.
 * @param tidanPath - the absolute 题单 file path.
 * @param importedAt - the ISO timestamp to stamp as `imported_at`.
 * @returns the parsed plan record.
 */
function parseTidan(vault: string, tidanPath: string, importedAt: string): Record<string, unknown> {
  const raw = readFileSync(tidanPath, 'utf8')
  const lines = raw.split(/\r?\n/)
  let topic = ''
  const kaodian: Array<Record<string, unknown>> = []
  const sections: Array<Record<string, unknown>> = []
  const problemIds = new Set<number>()
  const checklist: string[] = []
  let inTree = false
  let inPractice = false
  let inChecklist = false
  let currentSection: Record<string, unknown> | null = null
  let waitingForTree = false

  for (const line of lines) {
    const h1 = H1_RE.exec(line)
    if (h1) {
      topic = h1[1]!.trim().replace(/^#+/, '').trim()
      continue
    }
    const stripped = line.trim()

    if (waitingForTree && stripped === '```') {
      inTree = true
      waitingForTree = false
      continue
    }
    if (inTree && stripped === '```') {
      inTree = false
      continue
    }
    if (stripped.includes('考点树状图')) {
      waitingForTree = true
      continue
    }
    if (inTree) {
      const sm = SECTION_RE.exec(line.trim())
      if (sm) {
        currentSection = { name: `${sm[1]}、${sm[2]}`, kaodian: [] as Array<Record<string, unknown>> }
        sections.push(currentSection)
        continue
      }
      const km = TREE_KAODIAN_RE.exec(line)
      if (km && currentSection !== null) {
        const kd = {
          id: Number(km[1]),
          name: km[2]!.trim(),
          problem_count: Number(km[3]),
        }
        ;(currentSection.kaodian as Array<Record<string, unknown>>).push(kd)
        kaodian.push(kd)
        continue
      }
    }
    if (line.includes('## 练习计划')) {
      inPractice = true
      inChecklist = false
      continue
    }
    if (line.includes('## 模块完成标志')) {
      inChecklist = true
      inPractice = false
      continue
    }
    if (line.startsWith('## ') && (inPractice || inChecklist)) {
      inPractice = false
      inChecklist = false
      continue
    }
    if (inChecklist && line.startsWith('- [')) {
      checklist.push(line.trim())
      continue
    }
    for (const match of line.matchAll(new RegExp(TABLE_ID_RE.source, 'g'))) {
      problemIds.add(Number(match[1]))
    }
  }

  return {
    topic,
    source: relativeToVault(vault, tidanPath),
    sections,
    kaodian,
    total_kaodian: kaodian.length,
    total_problems: problemIds.size,
    problem_ids: [...problemIds].sort((a, b) => a - b),
    checklist,
    imported_at: importedAt,
    completed_kaodian: [],
  }
}

// ---- small helpers ----

function isObject(value: unknown): value is StudyData {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The length of a section's `kaodian` array, or zero when absent. */
function sectionKaodianCount(section: unknown): number {
  if (!isObject(section)) return 0
  return Array.isArray(section.kaodian) ? (section.kaodian as unknown[]).length : 0
}

function mkdirRecursive(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

function sortedJsonFiles(root: string): string[] {
  return readdirSync(root)
    .filter(name => name.endsWith('.json'))
    .map(name => `${root}/${name}`)
    .sort()
}

function stemOf(path: string): string {
  const base = path.split('/').pop()!
  return base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base
}

function errorMessage(error: unknown): string {
  return (error as Error).message
}
