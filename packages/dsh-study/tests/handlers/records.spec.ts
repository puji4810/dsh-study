import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { handleStudyDecision, handleStudyLearningRecord, handleStudyLesson } from '../../src/handlers/records.ts'
import { env, tempVault, writeProject } from '../helpers.ts'

const dirs: string[] = []
function mkVault(): string {
  const dir = tempVault()
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const d of dirs.splice(0)) void d })

describe('handleStudyLearningRecord', () => {
  it('creates a learning record with frontmatter', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    const result = handleStudyLearningRecord({
      action: 'create', project_id: 'proj-1', title: 'T', summary: 'S', evidence: 'E',
      implications: 'I', linked_concepts: ['a', 'b'],
    }, env(vault))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const record = result.data.record as Record<string, unknown>
    expect(record.record_id).toBe('0001-t')
    expect(record.project_id).toBe('proj-1')
    const path = join(vault, '.StudyOS', 'projects', 'proj-1', 'learning-records', '0001-t.md')
    expect(existsSync(path)).toBe(true)
    const text = readFileSync(path, 'utf8')
    expect(text).toContain('schema_version: learning_record.v1')
    expect(text).toContain('## Evidence')
  })

  it('requires title, summary, and evidence', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    const result = handleStudyLearningRecord({ action: 'create', project_id: 'proj-1' }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('lists records with summaries', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    handleStudyLearningRecord({ action: 'create', project_id: 'proj-1', title: 'T', summary: 'S', evidence: 'E' }, env(vault))
    const result = handleStudyLearningRecord({ action: 'list', project_id: 'proj-1' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.records).toHaveLength(1)
  })

  it('reads a record and reports a missing one', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    handleStudyLearningRecord({ action: 'create', project_id: 'proj-1', title: 'T', summary: 'S', evidence: 'E', record_id: 'rec-1' }, env(vault))
    const read = handleStudyLearningRecord({ action: 'read', project_id: 'proj-1', record_id: 'rec-1' }, env(vault))
    if (!read.ok) throw new Error('expected ok')
    expect(read.data.content).toContain('# T')

    const missing = handleStudyLearningRecord({ action: 'read', project_id: 'proj-1', record_id: 'nope-1' }, env(vault))
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('LEARNING_RECORD_NOT_FOUND')
  })

  it('reports an existing record on create collision', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    handleStudyLearningRecord({ action: 'create', project_id: 'proj-1', title: 'T', summary: 'S', evidence: 'E', record_id: 'rec-1' }, env(vault))
    const dup = handleStudyLearningRecord({ action: 'create', project_id: 'proj-1', title: 'T', summary: 'S', evidence: 'E', record_id: 'rec-1' }, env(vault))
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.error.code).toBe('LEARNING_RECORD_EXISTS')
  })

  it('rejects unknown actions', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    const result = handleStudyLearningRecord({ action: 'bogus', project_id: 'proj-1' }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_ACTION')
  })

  it('renders - None bullets for empty linked fields', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    handleStudyLearningRecord({ action: 'create', project_id: 'proj-1', title: 'T', summary: 'S', evidence: 'E' }, env(vault))
    const text = readFileSync(join(vault, '.StudyOS', 'projects', 'proj-1', 'learning-records', '0001-t.md'), 'utf8')
    expect(text).toContain('- None')
  })

  it('maps a missing project to PROJECT_NOT_FOUND', () => {
    const vault = mkVault()
    const result = handleStudyLearningRecord({ action: 'list', project_id: 'nope-1' }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('PROJECT_NOT_FOUND')
  })
})

describe('handleStudyDecision', () => {
  it('creates a decision with all sections', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    const result = handleStudyDecision({
      action: 'create', project_id: 'proj-1', title: 'D', decision: 'do it', context: 'ctx',
      options_considered: ['o1'], consequences: 'c', linked_sessions: ['s1'],
    }, env(vault))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const decision = result.data.decision as Record<string, unknown>
    expect(decision.decision_id).toBe('0001-d')
    const text = readFileSync(join(vault, '.StudyOS', 'projects', 'proj-1', 'decisions', '0001-d.md'), 'utf8')
    expect(text).toContain('schema_version: learning_decision_record.v1')
    expect(text).toContain('## Options Considered')
    expect(text).toContain('- o1')
    expect(text).toContain('## Linked Sessions')
  })

  it('requires title and decision', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    const result = handleStudyDecision({ action: 'create', project_id: 'proj-1' }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('lists and reads decisions', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    handleStudyDecision({ action: 'create', project_id: 'proj-1', title: 'D', decision: 'do it', decision_id: 'dec-1' }, env(vault))
    const list = handleStudyDecision({ action: 'list', project_id: 'proj-1' }, env(vault))
    if (!list.ok) throw new Error('expected ok')
    expect(list.data.decisions).toHaveLength(1)
    const read = handleStudyDecision({ action: 'read', project_id: 'proj-1', decision_id: 'dec-1' }, env(vault))
    if (!read.ok) throw new Error('expected ok')
    expect(read.data.content).toContain('# D')
  })

  it('reports missing decisions', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    const result = handleStudyDecision({ action: 'read', project_id: 'proj-1', decision_id: 'nope-1' }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('DECISION_NOT_FOUND')
  })

  it('reports DECISION_EXISTS on collision and INVALID_ACTION', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    handleStudyDecision({ action: 'create', project_id: 'proj-1', title: 'D', decision: 'do it', decision_id: 'dec-1' }, env(vault))
    const dup = handleStudyDecision({ action: 'create', project_id: 'proj-1', title: 'D', decision: 'do it', decision_id: 'dec-1' }, env(vault))
    if (!dup.ok) expect(dup.error.code).toBe('DECISION_EXISTS')
    const bad = handleStudyDecision({ action: 'bogus', project_id: 'proj-1' }, env(vault))
    if (!bad.ok) expect(bad.error.code).toBe('INVALID_ACTION')
  })
})

describe('handleStudyLesson', () => {
  const html = '<html><head><title>Lesson</title></head><body><h1>H</h1></body></html>'

  it('creates a lesson with html and metadata', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    const result = handleStudyLesson({ action: 'create', project_id: 'proj-1', title: 'L', html, rationale: 'why' }, env(vault))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const lesson = result.data.lesson as Record<string, unknown>
    expect(lesson.lesson_id).toBe('0001-l')
    const metaPath = join(vault, '.StudyOS', 'projects', 'proj-1', 'lessons', '0001-l.json')
    expect(existsSync(metaPath)).toBe(true)
  })

  it('requires title, html, and rationale', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    const result = handleStudyLesson({ action: 'create', project_id: 'proj-1' }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('rejects incomplete html', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    const result = handleStudyLesson({ action: 'create', project_id: 'proj-1', title: 'L', html: '<p>x</p>', rationale: 'why' }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('complete HTML document')
  })

  it('lists lesson summaries', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    handleStudyLesson({ action: 'create', project_id: 'proj-1', title: 'L', html, rationale: 'why' }, env(vault))
    const list = handleStudyLesson({ action: 'list', project_id: 'proj-1' }, env(vault))
    if (!list.ok) throw new Error('expected ok')
    expect(list.data.lessons).toHaveLength(1)
    const summary = (list.data.lessons as Array<Record<string, unknown>>)[0]!
    expect(summary.title).toBe('Lesson')
  })

  it('reads a lesson and reports a missing one', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    handleStudyLesson({ action: 'create', project_id: 'proj-1', title: 'L', html, rationale: 'why', lesson_id: 'les-1' }, env(vault))
    const read = handleStudyLesson({ action: 'read', project_id: 'proj-1', lesson_id: 'les-1' }, env(vault))
    if (!read.ok) throw new Error('expected ok')
    expect(read.data.html).toContain('<html')
    const missing = handleStudyLesson({ action: 'read', project_id: 'proj-1', lesson_id: 'nope-1' }, env(vault))
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('LESSON_NOT_FOUND')
  })

  it('reports LESSON_EXISTS on collision', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    handleStudyLesson({ action: 'create', project_id: 'proj-1', title: 'L', html, rationale: 'why', lesson_id: 'les-1' }, env(vault))
    const dup = handleStudyLesson({ action: 'create', project_id: 'proj-1', title: 'L', html, rationale: 'why', lesson_id: 'les-1' }, env(vault))
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.error.code).toBe('LESSON_EXISTS')
  })
})

describe('records helper edge cases', () => {
  it('accepts a bare string and a number for linked_concepts', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    handleStudyLearningRecord({ action: 'create', project_id: 'proj-1', title: 'T', summary: 'S', evidence: 'E', linked_concepts: 'single' }, env(vault))
    handleStudyLearningRecord({ action: 'create', project_id: 'proj-1', title: 'T2', summary: 'S', evidence: 'E', linked_concepts: 42 }, env(vault))
    const list = handleStudyLearningRecord({ action: 'list', project_id: 'proj-1' }, env(vault))
    if (!list.ok) throw new Error('expected ok')
    expect((list.data.records as unknown[])).toHaveLength(2)
  })

  it('summarizes a record without frontmatter or a title heading', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    const dir = join(vault, '.StudyOS', 'projects', 'proj-1', 'learning-records')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '0001-plain.md'), 'just a body with no heading\n', 'utf8')
    const list = handleStudyLearningRecord({ action: 'list', project_id: 'proj-1' }, env(vault))
    if (!list.ok) throw new Error('expected ok')
    const records = list.data.records as Array<Record<string, unknown>>
    expect(records).toHaveLength(1)
    expect(records[0]!.record_id).toBe('0001-plain')
    expect(records[0]!.title).toBe('0001-plain')
  })

  it('maps an invalid schedule id to VALIDATION_FAILED', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    const result = handleStudyLearningRecord({ action: 'read', project_id: 'proj-1', record_id: 'INVALID ID' }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('maps a vault failure to the generic failure code', () => {
    const result = handleStudyDecision({ action: 'list' }, { now: () => new Date(), vaultPath: '/nonexistent' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('STUDY_DECISION_FAILED')
  })

  it('summarizes a lesson without a title or h1 tag', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    const dir = join(vault, '.StudyOS', 'projects', 'proj-1', 'lessons')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'plain.html'), '<div>no title</div>\n', 'utf8')
    const list = handleStudyLesson({ action: 'list', project_id: 'proj-1' }, env(vault))
    if (!list.ok) throw new Error('expected ok')
    const lessons = list.data.lessons as Array<Record<string, unknown>>
    expect(lessons).toHaveLength(1)
    expect(lessons[0]!.title).toBe('plain')
  })

  it('summarizes a lesson with an h1 but no title tag', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    const dir = join(vault, '.StudyOS', 'projects', 'proj-1', 'lessons')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'h1.html'), '<html><body><h1>Only H1</h1></body></html>\n', 'utf8')
    const list = handleStudyLesson({ action: 'list', project_id: 'proj-1' }, env(vault))
    if (!list.ok) throw new Error('expected ok')
    expect((list.data.lessons as Array<Record<string, unknown>>)[0]!.title).toBe('Only H1')
  })

  it('reads a lesson without a metadata json', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    const dir = join(vault, '.StudyOS', 'projects', 'proj-1', 'lessons')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'les-1.html'), '<html>hi</html>\n', 'utf8')
    const read = handleStudyLesson({ action: 'read', project_id: 'proj-1', lesson_id: 'les-1' }, env(vault))
    if (!read.ok) throw new Error('expected ok')
    expect(read.data.metadata).toEqual({})
  })

  it('defaults action to list for all three handlers', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    const lr = handleStudyLearningRecord({ project_id: 'proj-1' }, env(vault))
    if (!lr.ok) throw new Error('expected ok')
    expect(Array.isArray(lr.data.records)).toBe(true)
    const dec = handleStudyDecision({ project_id: 'proj-1' }, env(vault))
    if (!dec.ok) throw new Error('expected ok')
    expect(Array.isArray(dec.data.decisions)).toBe(true)
    const les = handleStudyLesson({ project_id: 'proj-1' }, env(vault))
    if (!les.ok) throw new Error('expected ok')
    expect(Array.isArray(les.data.lessons)).toBe(true)
  })

  it('parses a record file with an unterminated frontmatter block', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    const dir = join(vault, '.StudyOS', 'projects', 'proj-1', 'learning-records')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '0001-unt.md'), '---\nrecord_id: rec-1\nproject_id: proj-1\nstatus: active\nno closing delimiter\n', 'utf8')
    const list = handleStudyLearningRecord({ action: 'list', project_id: 'proj-1' }, env(vault))
    if (!list.ok) throw new Error('expected ok')
    expect((list.data.records as unknown[])).toHaveLength(1)
  })

  it('coerces an empty-string linked_concepts to an empty list', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    const result = handleStudyLearningRecord({ action: 'create', project_id: 'proj-1', title: 'T', summary: 'S', evidence: 'E', linked_concepts: '' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    const text = readFileSync(join(vault, '.StudyOS', 'projects', 'proj-1', 'learning-records', '0001-t.md'), 'utf8')
    expect(text).toContain('- None')
  })

  it('rejects an unknown lesson action and maps a lesson vault failure', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    const bad = handleStudyLesson({ action: 'bogus', project_id: 'proj-1' }, env(vault))
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.code).toBe('INVALID_ACTION')
    const missing = handleStudyLesson({ action: 'list' }, { now: () => new Date(), vaultPath: '/nonexistent' })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('STUDY_LESSON_FAILED')
  })
})
