import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { handleStudyError, handleStudyLogSession, handleStudySyncMemory } from '../../src/handlers/misc.ts'
import { env, exampleNoteBody, tempVault, writeNote } from '../helpers.ts'

const dirs: string[] = []

function mkVault(): string {
  const dir = tempVault()
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) void dir
})

describe('handleStudyError', () => {
  it('appends an error record with defaults', () => {
    const vault = mkVault()
    const result = handleStudyError({ title: 'Mistake' }, env(vault))
    expect(result.ok).toBe(true)
    const path = join(vault, '.StudyOS', 'errors', '2026-01.md')
    expect(existsSync(path)).toBe(true)
    const text = readFileSync(path, 'utf8')
    expect(text).toContain('# Study OS Error Log 2026-01')
    expect(text).toContain('### 2026-01-15 Mistake')
    expect(text).toContain('- Source: -')
    expect(text).toContain('- Subject: -')
    expect(text).toContain('- Concepts: -')
    expect(text).toContain('- Cause: 未分类')
    expect(text).toContain('- Severity: medium')
    expect(text).toContain('（未填写细节）')
  })

  it('renders fields and wikilink concepts', () => {
    const vault = mkVault()
    const result = handleStudyError({
      title: 'T', source_note: 'src.md', subject: 'Math', concepts: ['[[A]]', 'B'],
      patterns: ['P'], cause: 'x', severity: 'high', next_action: 'redo', detail: 'detail text', occurred_on: '2026-02-03',
    }, env(vault))
    expect(result.ok).toBe(true)
    const text = readFileSync(join(vault, '.StudyOS', 'errors', '2026-02.md'), 'utf8')
    expect(text).toContain('- Concepts: [[A]], [[B]]')
    expect(text).toContain('- Patterns: [[P]]')
    expect(text).toContain('- Cause: x')
  })

  it('defaults the title to source_note then 学习错误', () => {
    const vault = mkVault()
    handleStudyError({ }, env(vault))
    expect(readFileSync(join(vault, '.StudyOS', 'errors', '2026-01.md'), 'utf8')).toContain('学习错误')
  })

  it('maps a vault resolution failure to LOG_ERROR_FAILED', () => {
    const result = handleStudyError({}, { now: () => new Date(), vaultPath: '/nonexistent-vault' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('LOG_ERROR_FAILED')
  })

  it('coerces a non-string concepts value through asList', () => {
    const vault = mkVault()
    const result = handleStudyError({ title: 'T', concepts: 42 }, env(vault))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const text = readFileSync(join(vault, '.StudyOS', 'errors', '2026-01.md'), 'utf8')
    expect(text).toContain('- Concepts: [[42]]')
  })

  it('treats an empty-string concepts value as empty', () => {
    const vault = mkVault()
    const result = handleStudyError({ title: 'T', concepts: '' }, env(vault))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const text = readFileSync(join(vault, '.StudyOS', 'errors', '2026-01.md'), 'utf8')
    expect(text).toContain('- Concepts: -')
  })
})

describe('handleStudyLogSession', () => {
  it('writes a new session log', () => {
    const vault = mkVault()
    const result = handleStudyLogSession({
      occurred_on: '2026-03-04', duration_minutes: 45, topics: ['a'], notes_created: ['n.md'],
      examples_attempted: ['e1', 'e2'], examples_passed: ['e1'], examples_failed: ['e2'], note: 'goals',
    }, env(vault))
    expect(result.ok).toBe(true)
    const text = readFileSync(join(vault, '.StudyOS', 'sessions', '2026-03-04.md'), 'utf8')
    expect(text).toContain('# Study Session 2026-03-04')
    expect(text).toContain('- Duration: 45 min')
    expect(text).toContain('- Topics: a')
    expect(text).toContain('- Examples attempted: 2')
    expect(text).toContain('  - Attempted: e1, e2')
    expect(text).toContain('  - Passed: e1')
    expect(text).toContain('  - Failed: e2')
    expect(text).toContain('goals')
  })

  it('appends to an existing session log', () => {
    const vault = mkVault()
    handleStudyLogSession({ occurred_on: '2026-03-04' }, env(vault))
    handleStudyLogSession({ occurred_on: '2026-03-04', topics: ['second'] }, env(vault))
    const text = readFileSync(join(vault, '.StudyOS', 'sessions', '2026-03-04.md'), 'utf8')
    expect(text.split('# Study Session 2026-03-04').length - 1).toBe(2)
  })

  it('omits optional sections when absent', () => {
    const vault = mkVault()
    handleStudyLogSession({ occurred_on: '2026-03-04' }, env(vault))
    const text = readFileSync(join(vault, '.StudyOS', 'sessions', '2026-03-04.md'), 'utf8')
    expect(text).not.toContain('- Duration')
    expect(text).not.toContain('- Topics')
  })

  it('maps a vault failure to LOG_SESSION_FAILED', () => {
    const result = handleStudyLogSession({}, { now: () => new Date(), vaultPath: '/nonexistent-vault' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('LOG_SESSION_FAILED')
  })
})

describe('handleStudySyncMemory', () => {
  it('builds memory entries with due counts and no weak concepts', () => {
    const vault = mkVault()
    writeNote(vault, 'math/examples/a.md', exampleNoteBody({ title: 'A', reviewCount: 0 }))
    const result = handleStudySyncMemory({}, env(vault))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.due_count).toBe(1)
    expect(result.data.total_examples).toBe(1)
    const entries = result.data.memory_entries as Array<Record<string, string>>
    expect(entries.length).toBe(2)
    expect(entries[0]!.old_text).toBe('StudyOS Math: 当前')
    expect(entries[0]!.content).toContain('当前 1/1 道例题待复习')
    expect(entries[1]!.old_text).toBe('StudyOS Math: 上次同步')
  })

  it('adds weak-concept entries when errors are present', () => {
    const vault = mkVault()
    writeNote(vault, 'math/examples/a.md', exampleNoteBody({ title: 'A', reviewCount: 0 }))
    handleStudyError({ title: 'err', concepts: ['[[weak1]]', 'weak2'], occurred_on: '2026-01-10' }, env(vault))
    const result = handleStudySyncMemory({}, env(vault))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const entries = result.data.memory_entries as Array<Record<string, string>>
    expect(entries.some(entry => entry.content?.includes('最薄弱的概念'))).toBe(true)
    expect(entries.some(entry => entry.content?.includes('最弱概念 [[weak'))).toBe(true)
    const weak = result.data.weak_concepts as Array<{ concept: string; error_count: number }>
    expect(weak.some(item => item.concept === 'weak1')).toBe(true)
  })

  it('ignores non-example notes in due counts', () => {
    const vault = mkVault()
    writeNote(vault, 'Box/a.md', '---\ntype: concept\n---\n# A\nconcepts: [[A]]\n')
    const result = handleStudySyncMemory({}, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.total_examples).toBe(0)
    expect(result.data.due_count).toBe(0)
  })

  it('maps a vault failure to SYNC_MEMORY_FAILED', () => {
    const result = handleStudySyncMemory({}, { now: () => new Date(), vaultPath: '/nonexistent-vault' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('SYNC_MEMORY_FAILED')
  })

  it('counts only due examples', () => {
    const vault = mkVault()
    writeNote(vault, 'math/examples/a.md', exampleNoteBody({ title: 'Due', reviewCount: 0 }))
    writeNote(vault, 'math/examples/b.md', exampleNoteBody({ title: 'NotDue', reviewCount: 3, nextReviewAt: '2099-01-01' }))
    const result = handleStudySyncMemory({}, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.total_examples).toBe(2)
    expect(result.data.due_count).toBe(1)
  })

  it('ignores future-dated error records and concept-less records', () => {
    const vault = mkVault()
    const errorsDir = join(vault, '.StudyOS', 'errors')
    mkdirSync(errorsDir, { recursive: true })
    // Future error (after today) exercises the value <= end branch.
    writeFileSync(join(errorsDir, '2026-01.md'), [
      '### 2026-02-01 Future',
      '- Concepts: [[fut]]',
      '',
      '### 2026-01-10 NoConcepts',
      '- Cause: x',
      '',
    ].join('\n'), 'utf8')
    const result = handleStudySyncMemory({}, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.weak_concepts).toEqual([])
  })

  it('falls back to today for a malformed occurred_on', () => {
    const vault = mkVault()
    const result = handleStudyError({ title: 'T', occurred_on: 'not-a-date' }, env(vault))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(existsSync(join(vault, '.StudyOS', 'errors', '2026-01.md'))).toBe(true)
  })

  it('accepts a non-empty string concepts value', () => {
    const vault = mkVault()
    const result = handleStudyError({ title: 'T', concepts: 'single' }, env(vault))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const text = readFileSync(join(vault, '.StudyOS', 'errors', '2026-01.md'), 'utf8')
    expect(text).toContain('- Concepts: [[single]]')
  })

  it('drops empty-string items inside a concepts array', () => {
    const vault = mkVault()
    const result = handleStudyError({ title: 'T', concepts: ['', '  ', 'real'] }, env(vault))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const text = readFileSync(join(vault, '.StudyOS', 'errors', '2026-01.md'), 'utf8')
    expect(text).toContain('- Concepts: [[real]]')
  })

  it('ignores an error file with no headings', () => {
    const vault = mkVault()
    const errorsDir = join(vault, '.StudyOS', 'errors')
    mkdirSync(errorsDir, { recursive: true })
    writeFileSync(join(errorsDir, '2026-01.md'), 'just some text without headings\n', 'utf8')
    const result = handleStudySyncMemory({}, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.weak_concepts).toEqual([])
  })

  it('ignores error records outside the window and non-md files', () => {
    const vault = mkVault()
    const errorsDir = join(vault, '.StudyOS', 'errors')
    mkdirSync(errorsDir, { recursive: true })
    // Old error outside the 30-day window.
    writeFileSync(join(errorsDir, '2025-01.md'), '### 2025-01-05 Old\n- Cause: x\n\n', 'utf8')
    // A non-md file that listErrorFiles skips.
    writeFileSync(join(errorsDir, 'note.txt'), 'junk', 'utf8')
    const result = handleStudySyncMemory({}, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.weak_concepts).toEqual([])
  })

  it('collects multiple error records from one file', () => {
    const vault = mkVault()
    const errorsDir = join(vault, '.StudyOS', 'errors')
    mkdirSync(errorsDir, { recursive: true })
    writeFileSync(join(errorsDir, '2026-01.md'), [
      '### 2026-01-10 First',
      '- Concepts: [[a]]',
      '- Cause: x',
      '',
      '### 2026-01-14 Second',
      '- Concepts: [[b]]',
      '- Cause: y',
      '',
    ].join('\n'), 'utf8')
    const result = handleStudySyncMemory({}, env(vault))
    if (!result.ok) throw new Error('expected ok')
    const weak = result.data.weak_concepts as Array<{ concept: string }>
    expect(weak.some(item => item.concept === 'a')).toBe(true)
    expect(weak.some(item => item.concept === 'b')).toBe(true)
  })
})
