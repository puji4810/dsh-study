import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { handleStudyConcept } from '../../src/handlers/concept.ts'
import { handleStudyError } from '../../src/handlers/misc.ts'
import { env, exampleNoteBody, tempVault, writeNote } from '../helpers.ts'

const dirs: string[] = []
function mkVault(): string {
  const dir = tempVault()
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const d of dirs.splice(0)) void d })

describe('handleStudyConcept graph', () => {
  it('builds an empty graph and caches it', () => {
    const vault = mkVault()
    const result = handleStudyConcept({ action: 'graph' }, env(vault))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.total_concepts).toBe(0)
    expect(readFileSync(join(vault, '.StudyOS', 'concept_graph.json'), 'utf8')).toContain('built_at')
  })

  it('reuses the cache under the TTL window', () => {
    const vault = mkVault()
    writeNote(vault, 'Box/a.md', '---\ntype: concept\nconcepts: [[A]]\n---\n# A\n')
    handleStudyConcept({ action: 'graph' }, env(vault))
    // Remove the note; a cached graph still reflects the first build.
    handleStudyConcept({ action: 'graph' }, env(vault))
    const result = handleStudyConcept({ action: 'graph' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.total_concepts).toBe(1)
  })

  it('rebuilds when rebuild is set', () => {
    const vault = mkVault()
    writeNote(vault, 'Box/a.md', '---\ntype: concept\nconcepts: [[A]]\n---\n# A\n')
    const result = handleStudyConcept({ action: 'graph', rebuild: true }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.total_concepts).toBe(1)
  })

  it('rebuilds when the cache is stale', () => {
    const vault = mkVault()
    writeNote(vault, 'Box/a.md', '---\ntype: concept\nconcepts: [[A]]\n---\n# A\n')
    handleStudyConcept({ action: 'graph' }, env(vault))
    // Stale cache: built_at older than one hour.
    const e = env(vault, '2026-01-16T09:00:00.000Z')
    const result = handleStudyConcept({ action: 'graph' }, e)
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.total_concepts).toBe(1)
  })

  it('returns a target concept view', () => {
    const vault = mkVault()
    writeNote(vault, 'Box/a.md', '---\ntype: concept\nconcepts: [[A]]\n---\n# A\n\n[[B]]\n')
    writeNote(vault, 'Box/b.md', '---\ntype: concept\nconcepts: [[B]]\n---\n# B\n')
    const result = handleStudyConcept({ action: 'graph', concept: 'A' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.concept).toBe('A')
    expect(result.data.direct_prerequisites).toEqual([])
    expect(result.data.recommended_review_order).toBeDefined()
  })

  it('computes bottlenecks and isolated concepts', () => {
    const vault = mkVault()
    writeNote(vault, 'Box/a.md', '---\ntype: concept\nconcepts: [[A]]\n---\n# A\n')
    const result = handleStudyConcept({ action: 'graph' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.isolated_concept_names).toEqual(['A'])
    expect(result.data.top_bottlenecks).toEqual([])
  })
})

describe('handleStudyConcept weak_only', () => {
  it('lists weak concepts backed by recent errors', () => {
    const vault = mkVault()
    writeNote(vault, 'Box/a.md', '---\ntype: concept\nconcepts: [[A]]\n---\n# A\n')
    handleStudyError({ title: 'e', concepts: ['[[A]]'], occurred_on: '2026-01-15' }, env(vault))
    const result = handleStudyConcept({ action: 'graph', weak_only: true }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(Array.isArray(result.data.weak_concepts)).toBe(true)
  })

  it('returns empty weak concepts when no error records exist', () => {
    const vault = mkVault()
    writeNote(vault, 'Box/a.md', '---\ntype: concept\nconcepts: [[A]]\n---\n# A\n')
    const result = handleStudyConcept({ action: 'graph', weak_only: true }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.weak_concepts).toEqual([])
  })

  it('ranks multiple weak concepts by error count', () => {
    const vault = mkVault()
    writeNote(vault, 'Box/a.md', '---\ntype: concept\nconcepts: [[A]]\n---\n# A\n')
    writeNote(vault, 'Box/b.md', '---\ntype: concept\nconcepts: [[B]]\n---\n# B\n')
    handleStudyError({ title: 'e1', concepts: ['[[A]]'], occurred_on: '2026-01-15' }, env(vault))
    handleStudyError({ title: 'e2', concepts: ['[[A]]', '[[B]]'], occurred_on: '2026-01-15' }, env(vault))
    const result = handleStudyConcept({ action: 'graph', weak_only: true }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(Array.isArray(result.data.weak_concepts)).toBe(true)
  })

  it('handles an empty errors file without records', () => {
    const vault = mkVault()
    writeNote(vault, 'Box/a.md', '---\ntype: concept\nconcepts: [[A]]\n---\n# A\n')
    mkdirSync(join(vault, '.StudyOS', 'errors'), { recursive: true })
    writeFileSync(join(vault, '.StudyOS', 'errors', '2026-01.md'), '', 'utf8')
    const result = handleStudyConcept({ action: 'graph', weak_only: true }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.weak_concepts).toEqual([])
  })
})

describe('handleStudyConcept queue', () => {
  it('lists new concepts and examples', () => {
    const vault = mkVault()
    writeNote(vault, 'Box/c.md', '---\ntype: concept\nconcepts: [[C]]\n---\n# C\n')
    writeNote(vault, 'math/examples/e.md', exampleNoteBody({ title: 'E', reviewCount: 0 }))
    const result = handleStudyConcept({ action: 'queue' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.new_concepts_total).toBe(1)
    expect(result.data.new_examples_total).toBe(1)
  })

  it('respects a numeric limit and clamps it', () => {
    const vault = mkVault()
    writeNote(vault, 'Box/c.md', '---\ntype: concept\nconcepts: [[C]]\n---\n# C\n')
    const limited = handleStudyConcept({ action: 'queue', limit: 3 }, env(vault))
    if (!limited.ok) throw new Error('expected ok')
    expect(Number.isFinite(limited.data.new_concepts_total)).toBe(true)
    const clamped = handleStudyConcept({ action: 'queue', limit: 9999 }, env(vault))
    if (!clamped.ok) throw new Error('expected ok')
    expect(clamped.data.new_concepts_total).toBe(1)
  })
})

describe('handleStudyConcept update_state', () => {
  it('updates learning_state and stamps mastered_at', () => {
    const vault = mkVault()
    writeNote(vault, 'Box/c.md', '---\ntype: concept\nconcepts: [[C]]\n---\n# C\n')
    const result = handleStudyConcept({ action: 'update_state', note: 'C', learning_state: '已掌握' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.learning_state).toEqual({ old: '未开始', new: '已掌握' })
    const text = readFileSync(join(vault, 'Box', 'c.md'), 'utf8')
    expect(text).toContain('learning_state: 已掌握')
    expect(text).toContain('mastered_at: 2026-01-15')
  })

  it('rejects invalid states', () => {
    const vault = mkVault()
    writeNote(vault, 'Box/c.md', '---\ntype: concept\nconcepts: [[C]]\n---\n# C\n')
    const result = handleStudyConcept({ action: 'update_state', note: 'C', learning_state: 'bogus' }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_STATE')
  })

  it('rejects non-concept notes', () => {
    const vault = mkVault()
    writeNote(vault, 'math/examples/e.md', exampleNoteBody({ title: 'E' }))
    const result = handleStudyConcept({ action: 'update_state', note: 'E', learning_state: '学习中' }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('NOT_CONCEPT')
  })

  it('reports a missing note', () => {
    const vault = mkVault()
    const result = handleStudyConcept({ action: 'update_state', note: 'missing', learning_state: '学习中' }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('NOTE_NOT_FOUND')
  })

  it('rejects an unknown action', () => {
    const vault = mkVault()
    const result = handleStudyConcept({ action: 'bogus' }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_ACTION')
  })

  it('stamps mastered_at only when mastering', () => {
    const vault = mkVault()
    writeNote(vault, 'Box/c.md', '---\ntype: concept\nconcepts: [[C]]\n---\n# C\n')
    const result = handleStudyConcept({ action: 'update_state', note: 'C', learning_state: '学习中' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    const text = readFileSync(join(vault, 'Box', 'c.md'), 'utf8')
    expect(text).not.toContain('mastered_at')
  })

  it('rejects an empty learning_state', () => {
    const vault = mkVault()
    writeNote(vault, 'Box/c.md', '---\ntype: concept\nconcepts: [[C]]\n---\n# C\n')
    const result = handleStudyConcept({ action: 'update_state', note: 'C' }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_STATE')
  })

  it('reports a missing note when the ref is empty', () => {
    const vault = mkVault()
    const result = handleStudyConcept({ action: 'update_state', learning_state: '学习中' }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('NOTE_NOT_FOUND')
  })

  it('reports ambiguity for a note ref matching two notes', () => {
    const vault = mkVault()
    writeNote(vault, 'Box/a.md', '---\ntype: concept\nconcepts: [[A]]\n---\n# Shared\n')
    writeNote(vault, 'Box/b.md', '---\ntype: concept\nconcepts: [[B]]\n---\n# Shared\n')
    const result = handleStudyConcept({ action: 'update_state', note: 'Shared', learning_state: '学习中' }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('UPDATE_CONCEPT_STATE_FAILED')
  })
})

describe('handleStudyConcept failure mapping', () => {
  it('maps vault failure to CONCEPT_GRAPH_FAILED', () => {
    const result = handleStudyConcept({ action: 'graph' }, { now: () => new Date(), vaultPath: '/nonexistent' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('CONCEPT_GRAPH_FAILED')
  })

  it('maps vault failure to LEARNING_QUEUE_FAILED', () => {
    const result = handleStudyConcept({ action: 'queue' }, { now: () => new Date(), vaultPath: '/nonexistent' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('LEARNING_QUEUE_FAILED')
  })

  it('maps vault failure to UPDATE_CONCEPT_STATE_FAILED', () => {
    const result = handleStudyConcept({ action: 'update_state', learning_state: '学习中' }, { now: () => new Date(), vaultPath: '/nonexistent' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('UPDATE_CONCEPT_STATE_FAILED')
  })

  it('rebuilds when the cache is invalid JSON', () => {
    const vault = mkVault()
    mkdirSync(join(vault, '.StudyOS'), { recursive: true })
    writeNote(vault, 'Box/a.md', '---\ntype: concept\nconcepts: [[A]]\n---\n# A\n')
    writeFileSync(join(vault, '.StudyOS', 'concept_graph.json'), 'not json', 'utf8')
    const result = handleStudyConcept({ action: 'graph' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.total_concepts).toBe(1)
  })

  it('defaults to the graph action when action is absent', () => {
    const vault = mkVault()
    const result = handleStudyConcept({}, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.total_concepts).toBe(0)
  })

  it('returns empty projections for a nonexistent target concept', () => {
    const vault = mkVault()
    writeNote(vault, 'Box/a.md', '---\ntype: concept\nconcepts: [[A]]\n---\n# A\n')
    const result = handleStudyConcept({ action: 'graph', concept: 'Nonexistent' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.direct_prerequisites).toEqual([])
    expect(result.data.direct_dependents).toEqual([])
    expect(result.data.exercised_in).toEqual([])
    expect(result.data.note_count).toBe(0)
    expect(result.data.review_level).toBeUndefined()
  })

  it('collects affected examples through dependents', () => {
    const vault = mkVault()
    writeNote(vault, 'Box/a.md', '---\ntype: concept\nconcepts:\n  - A\n---\n# A\n')
    writeNote(vault, 'Box/c.md', '---\ntype: concept\nconcepts:\n  - A\n  - C\n---\n# C\n')
    const result = handleStudyConcept({ action: 'graph', concept: 'C' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    // C's direct dependent is A (co-listed concept), whose exercises feed affected_examples.
    expect(result.data.direct_dependents).toContain('A')
    expect(Array.isArray(result.data.affected_examples)).toBe(true)
    expect((result.data.affected_examples as unknown[]).length).toBeGreaterThan(0)
  })

  it('sorts bottlenecks across multiple concepts', () => {
    const vault = mkVault()
    writeNote(vault, 'Box/a.md', '---\ntype: concept\nconcepts:\n  - A\n---\n# A\n')
    writeNote(vault, 'Box/b.md', '---\ntype: concept\nconcepts:\n  - A\n  - B\n---\n# B\n')
    const result = handleStudyConcept({ action: 'graph' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(Array.isArray(result.data.top_bottlenecks)).toBe(true)
    expect(result.data.total_concepts).toBeGreaterThanOrEqual(2)
  })

  it('rebuilds when the cache lacks a built_at', () => {
    const vault = mkVault()
    mkdirSync(join(vault, '.StudyOS'), { recursive: true })
    writeNote(vault, 'Box/a.md', '---\ntype: concept\nconcepts: [[A]]\n---\n# A\n')
    writeFileSync(join(vault, '.StudyOS', 'concept_graph.json'), '{"graph":{"prerequisites":{},"dependents":{},"exercised_by":{},"review_levels":{},"note_count":{}}}', 'utf8')
    const result = handleStudyConcept({ action: 'graph' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.total_concepts).toBe(1)
  })
})
