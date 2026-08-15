import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { handleStudyCurriculum } from '../../src/handlers/curriculum.ts'
import { env, tempVault } from '../helpers.ts'

const dirs: string[] = []
function mkVault(): string {
  const dir = tempVault()
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const d of dirs.splice(0)) void d })

const VALID = {
  version: '1',
  meta: { topic: '代数', textbook: '教材', exercise_book: '练习册', created_at: '' },
  sections: [{ title: '第一章', kaodian: [{ name: '考点1' }] }],
}

describe('handleStudyCurriculum create', () => {
  it('returns a template when data is absent', () => {
    const vault = mkVault()
    const result = handleStudyCurriculum({ action: 'create' }, env(vault))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const template = result.data.template as Record<string, unknown>
    expect(template.version).toBe('1')
    expect(template.meta).toBeTruthy()
    expect(template.sections).toEqual([])
  })

  it('writes a valid curriculum', () => {
    const vault = mkVault()
    const result = handleStudyCurriculum({ action: 'create', data: VALID }, env(vault))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.topic).toBe('代数')
    expect(result.data.sections).toBe(1)
    expect(result.data.kaodian).toBe(1)
    expect(existsSync(join(vault, '.StudyOS', 'curricula', '代数.json'))).toBe(true)
  })

  it('rejects non-object data', () => {
    const vault = mkVault()
    const result = handleStudyCurriculum({ action: 'create', data: 'bad' }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_DATA')
  })

  it('rejects missing meta.topic', () => {
    const vault = mkVault()
    const result = handleStudyCurriculum({ action: 'create', data: { meta: { textbook: 'x' }, sections: [] } }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('rejects missing sections titles', () => {
    const vault = mkVault()
    const result = handleStudyCurriculum({ action: 'create', data: { meta: { topic: 't', textbook: 'x' }, sections: [{}] } }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('sections[0].title is required')
  })

  it('rejects missing kaodian names', () => {
    const vault = mkVault()
    const result = handleStudyCurriculum({
      action: 'create', data: { meta: { topic: 't', textbook: 'x' }, sections: [{ title: 's', kaodian: [{}] }] },
    }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('sections[0].kaodian[0].name is required')
  })

  it('rejects a non-object meta', () => {
    const vault = mkVault()
    const result = handleStudyCurriculum({
      action: 'create', data: { meta: 'not-an-object', sections: [] },
    }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('meta is required')
  })

  it('rejects a missing meta.textbook', () => {
    const vault = mkVault()
    const result = handleStudyCurriculum({
      action: 'create', data: { meta: { topic: 't' }, sections: [] },
    }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('meta.textbook is required')
  })

  it('rejects non-array sections', () => {
    const vault = mkVault()
    const result = handleStudyCurriculum({
      action: 'create', data: { meta: { topic: 't', textbook: 'x' }, sections: 'not-a-list' },
    }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('sections must be a list')
  })

  it('stamps the default version when omitted', () => {
    const vault = mkVault()
    const result = handleStudyCurriculum({
      action: 'create', data: { meta: { topic: 't', textbook: 'x' }, sections: [] },
    }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    const text = readFileSync(join(vault, '.StudyOS', 'curricula', 't.json'), 'utf8')
    expect(JSON.parse(text).version).toBe('1')
  })

  it('maps vault failure to CREATE_CURRICULUM_FAILED', () => {
    const result = handleStudyCurriculum({ action: 'create', data: VALID }, { now: () => new Date(), vaultPath: '/nonexistent' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('CREATE_CURRICULUM_FAILED')
  })

  it('rejects an empty action', () => {
    const result = handleStudyCurriculum({}, env(mkVault()))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_ACTION')
  })
})

describe('handleStudyCurriculum list', () => {
  it('lists curricula summaries', () => {
    const vault = mkVault()
    handleStudyCurriculum({ action: 'create', data: VALID }, env(vault))
    const result = handleStudyCurriculum({ action: 'list' }, env(vault))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.curricula).toHaveLength(1)
  })

  it('filters by topic', () => {
    const vault = mkVault()
    handleStudyCurriculum({ action: 'create', data: VALID }, env(vault))
    const result = handleStudyCurriculum({ action: 'list', topic: 'other' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.curricula).toHaveLength(0)
  })

  it('skips malformed curricula', () => {
    const vault = mkVault()
    handleStudyCurriculum({ action: 'create', data: VALID }, env(vault))
    writeFileSync(join(vault, '.StudyOS', 'curricula', 'broken.json'), 'not json', 'utf8')
    const result = handleStudyCurriculum({ action: 'list' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.curricula).toHaveLength(1)
  })

  it('tolerates hand-written curricula with non-array sections and sparse meta', () => {
    const vault = mkVault()
    mkdirSync(join(vault, '.StudyOS', 'curricula'), { recursive: true })
    writeFileSync(join(vault, '.StudyOS', 'curricula', 'sparse.json'),
      JSON.stringify({ meta: { topic: 'sparse' }, sections: 'not-a-list' }), 'utf8')
    const result = handleStudyCurriculum({ action: 'list' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    const curricula = result.data.curricula as Array<Record<string, unknown>>
    expect(curricula).toHaveLength(1)
    expect(curricula[0]!.textbook).toBe('')
    expect(curricula[0]!.exercise_book).toBe('')
    expect(curricula[0]!.sections).toBe(0)
  })

  it('tolerates hand-written curricula with primitive sections', () => {
    const vault = mkVault()
    mkdirSync(join(vault, '.StudyOS', 'curricula'), { recursive: true })
    writeFileSync(join(vault, '.StudyOS', 'curricula', 'prim.json'),
      JSON.stringify({ meta: { topic: 'prim', textbook: 'b' }, sections: [123, { title: 's' }] }), 'utf8')
    const result = handleStudyCurriculum({ action: 'list' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect((result.data.curricula as unknown[])).toHaveLength(1)
  })

  it('maps vault failure to LIST_CURRICULA_FAILED', () => {
    const result = handleStudyCurriculum({ action: 'list' }, { now: () => new Date(), vaultPath: '/nonexistent' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('LIST_CURRICULA_FAILED')
  })
})

describe('handleStudyCurriculum import_plan', () => {
  it('lists available tidan when none specified', () => {
    const vault = mkVault()
    const result = handleStudyCurriculum({ action: 'import_plan' }, env(vault))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Array.isArray(result.data.available_tidan)).toBe(true)
  })

  it('reports a missing tidan', () => {
    const vault = mkVault()
    const result = handleStudyCurriculum({ action: 'import_plan', tidan: 'review/nope.md' }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('TIDAN_NOT_FOUND')
  })

  it('parses a tidan into a learning plan', () => {
    const vault = mkVault()
    mkdirSync(join(vault, 'review'), { recursive: true })
    writeFileSync(join(vault, 'review', 'tidan.md'), [
      '# 代数复习',
      '',
      '## 考点树状图',
      '```',
      '一、函数',
      '考点 1：定义（10 题）',
      '```',
      '',
      '## 练习计划',
      '**1** **2**',
      '',
      '## 模块完成标志',
      '- [x] done',
      '',
      '## 附录',
      'extra',
      '',
    ].join('\n'), 'utf8')
    const result = handleStudyCurriculum({ action: 'import_plan', tidan: 'review/tidan.md' }, env(vault))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.data.plan as Record<string, unknown>).topic).toBe('代数复习')
    expect(existsSync(join(vault, '.StudyOS', 'learning_plans', '代数复习.json'))).toBe(true)
  })

  it('lists available tidan files under review/', () => {
    const vault = mkVault()
    mkdirSync(join(vault, 'review'), { recursive: true })
    writeFileSync(join(vault, 'review', 'one.md'), '# One\n', 'utf8')
    const result = handleStudyCurriculum({ action: 'import_plan' }, env(vault))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.available_tidan).toEqual(['review/one.md'])
  })

  it('falls back to the stem when a tidan lacks an H1 title', () => {
    const vault = mkVault()
    mkdirSync(join(vault, 'review'), { recursive: true })
    writeFileSync(join(vault, 'review', 'plan.md'), '- [ ] anything\n', 'utf8')
    const result = handleStudyCurriculum({ action: 'import_plan', tidan: 'review/plan.md' }, env(vault))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.data.plan as Record<string, unknown>).topic).toBe('plan')
  })

  it('uses a dotless tidan filename as the stem', () => {
    const vault = mkVault()
    mkdirSync(join(vault, 'review'), { recursive: true })
    writeFileSync(join(vault, 'review', 'plan'), '- [ ] anything\n', 'utf8')
    const result = handleStudyCurriculum({ action: 'import_plan', tidan: 'review/plan' }, env(vault))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.data.plan as Record<string, unknown>).topic).toBe('plan')
  })

  it('handles a kaodian listed before any section heading', () => {
    const vault = mkVault()
    mkdirSync(join(vault, 'review'), { recursive: true })
    writeFileSync(join(vault, 'review', 'bare.md'), [
      '# 无题数',
      '## 考点树状图',
      '```',
      '考点 9：孤考点（3 题）',
      '一、函数',
      '考点 1：定义（10 题）',
      '## 练习计划',
      '- [ ] x',
      '## 结束',
      '```',
    ].join('\n'), 'utf8')
    const result = handleStudyCurriculum({ action: 'import_plan', tidan: 'review/bare.md' }, env(vault))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.data.plan as Record<string, unknown>).topic).toBe('无题数')
  })

  it('maps vault failure to IMPORT_PLAN_FAILED', () => {
    const result = handleStudyCurriculum({ action: 'import_plan', tidan: 'review/x.md' }, { now: () => new Date(), vaultPath: '/nonexistent' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('IMPORT_PLAN_FAILED')
  })
})

describe('handleStudyCurriculum progress', () => {
  it('summarizes plan progress', () => {
    const vault = mkVault()
    mkdirSync(join(vault, '.StudyOS', 'learning_plans'), { recursive: true })
    writeFileSync(join(vault, '.StudyOS', 'learning_plans', '代数.json'), JSON.stringify({
      topic: '代数', source: 'review/x.md', total_kaodian: 4, total_problems: 10,
      completed_kaodian: [1, 2], checklist: ['- [x] a', '- [ ] b'],
    }), 'utf8')
    const result = handleStudyCurriculum({ action: 'progress' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    const plans = result.data.plans as Array<Record<string, unknown>>
    expect(plans).toHaveLength(1)
    expect(plans[0]!.progress_pct).toBe(50)
    expect(plans[0]!.checklist_done).toBe(1)
  })

  it('filters progress by topic', () => {
    const vault = mkVault()
    mkdirSync(join(vault, '.StudyOS', 'learning_plans'), { recursive: true })
    writeFileSync(join(vault, '.StudyOS', 'learning_plans', '代数.json'), JSON.stringify({ topic: '代数', total_kaodian: 0 }), 'utf8')
    const result = handleStudyCurriculum({ action: 'progress', topic: 'nothing' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.plans).toHaveLength(0)
  })

  it('defaults missing progress fields to empty values', () => {
    const vault = mkVault()
    mkdirSync(join(vault, '.StudyOS', 'learning_plans'), { recursive: true })
    writeFileSync(join(vault, '.StudyOS', 'learning_plans', '代数.json'), JSON.stringify({ topic: '代数' }), 'utf8')
    const result = handleStudyCurriculum({ action: 'progress' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    const plans = result.data.plans as Array<Record<string, unknown>>
    expect(plans).toHaveLength(1)
    expect(plans[0]!.progress_pct).toBe(0)
    expect(plans[0]!.source).toBe('')
    expect(plans[0]!.completed_kaodian).toBe(0)
    expect(plans[0]!.total_problems).toBe(0)
    expect(plans[0]!.checklist_total).toBe(0)
  })

  it('skips malformed learning plan files', () => {
    const vault = mkVault()
    mkdirSync(join(vault, '.StudyOS', 'learning_plans'), { recursive: true })
    writeFileSync(join(vault, '.StudyOS', 'learning_plans', 'bad.json'), 'not json', 'utf8')
    const result = handleStudyCurriculum({ action: 'progress' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.plans).toEqual([])
  })

  it('maps vault failure to PLAN_PROGRESS_FAILED', () => {
    const result = handleStudyCurriculum({ action: 'progress' }, { now: () => new Date(), vaultPath: '/nonexistent' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('PLAN_PROGRESS_FAILED')
  })
})

describe('handleStudyCurriculum invalid action', () => {
  it('rejects unknown actions', () => {
    const result = handleStudyCurriculum({ action: 'bogus' }, env(mkVault()))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_ACTION')
  })
})
