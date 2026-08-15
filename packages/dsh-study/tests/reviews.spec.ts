import { describe, expect, it } from 'vitest'

import {
  automaticReviewLevel,
  buildConceptGraph,
  buildReviewStats,
  calculateNextReview,
  conceptAncestors,
  conceptDescendants,
  conceptLearningState,
  EBBINGHAUS_BASE,
  isDue,
  LEARNING_STATES,
  readReviewState,
  REVIEW_LEVEL_WEIGHT,
  StudyReviewReadModel,
  topologicalOrder,
} from '../src/reviews.ts'
import type { ConceptGraph } from '../src/reviews.ts'
import type { StudyNote } from '../src/types.ts'

function example(overrides: Partial<StudyNote> & { path: string; title: string }): StudyNote {
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

describe('spaced repetition constants', () => {
  it('exposes the Ebbinghaus ladder and weights', () => {
    expect(EBBINGHAUS_BASE).toEqual([1, 2, 4, 7, 15, 30, 60, 120])
    expect(REVIEW_LEVEL_WEIGHT[0]).toBe(0.5)
    expect(REVIEW_LEVEL_WEIGHT[2]).toBe(1.0)
    expect(REVIEW_LEVEL_WEIGHT[5]).toBe(2.5)
    expect(LEARNING_STATES).toEqual(['未开始', '学习中', '已理解', '已掌握'])
  })
})

describe('automaticReviewLevel', () => {
  it('maps incorrect and partial results directly', () => {
    expect(automaticReviewLevel(3, 'incorrect')).toBe(1)
    expect(automaticReviewLevel(5, 'partial')).toBe(2)
  })
  it('raises correct to max(3, level + 1), capped at 5', () => {
    expect(automaticReviewLevel(0, 'correct')).toBe(3)
    expect(automaticReviewLevel(2, 'correct')).toBe(3)
    expect(automaticReviewLevel(3, 'correct')).toBe(4)
    expect(automaticReviewLevel(4, 'correct')).toBe(5)
    expect(automaticReviewLevel(6, 'correct')).toBe(5)
  })
  it('throws on unsupported results', () => {
    expect(() => automaticReviewLevel(0, 'bogus')).toThrow('Unsupported review result: bogus')
  })
})

describe('calculateNextReview', () => {
  it('resets to tomorrow on failure', () => {
    expect(calculateNextReview({ reviewCount: 5, reviewLevel: 3, passed: false, today: '2026-01-10' }))
      .toEqual({ reviewCount: 0, nextReviewAt: '2026-01-11' })
  })
  it('uses the base interval at review count 0 offset by weight', () => {
    expect(calculateNextReview({ reviewCount: 0, reviewLevel: 2, passed: true, today: '2026-01-10' }))
      .toEqual({ reviewCount: 1, nextReviewAt: '2026-01-11' })
    expect(calculateNextReview({ reviewCount: 0, reviewLevel: 0, passed: true, today: '2026-01-10' }))
      .toEqual({ reviewCount: 1, nextReviewAt: '2026-01-11' })
  })
  it('caps review count at the last ladder index', () => {
    expect(calculateNextReview({ reviewCount: 7, reviewLevel: 0, passed: true, today: '2026-01-10' }))
      .toEqual({ reviewCount: 7, nextReviewAt: '2026-03-11' })
    expect(calculateNextReview({ reviewCount: 99, reviewLevel: 0, passed: true, today: '2026-01-10' }))
      .toEqual({ reviewCount: 7, nextReviewAt: '2026-03-11' })
  })
  it('applies the last-week weight for high levels with a floor of one day', () => {
    expect(calculateNextReview({ reviewCount: 7, reviewLevel: 5, passed: true, today: '2026-01-10' }))
      .toEqual({ reviewCount: 7, nextReviewAt: '2026-11-06' })
  })
  it('falls back to weight 1.0 for an unknown level', () => {
    expect(calculateNextReview({ reviewCount: 3, reviewLevel: 42, passed: true, today: '2026-01-10' }))
      .toEqual({ reviewCount: 4, nextReviewAt: '2026-01-17' })
  })
  it('uses a fallback base date for an invalid today', () => {
    expect(calculateNextReview({ reviewCount: 0, reviewLevel: 0, passed: false, today: 'garbage' }))
      .toEqual({ reviewCount: 0, nextReviewAt: '2000-01-02' })
  })
})

describe('readReviewState', () => {
  it('reads fields with defaults', () => {
    expect(readReviewState({ path: '', title: '', frontmatter: {} })).toEqual({
      review_count: 0,
      last_reviewed_at: '',
      next_review_at: '',
    })
  })
  it('reads populated fields', () => {
    expect(readReviewState({
      path: '',
      title: '',
      frontmatter: { review_count: 3, last_reviewed_at: '2026-01-01', next_review_at: '2026-01-02' },
    })).toEqual({ review_count: 3, last_reviewed_at: '2026-01-01', next_review_at: '2026-01-02' })
  })
  it('coerces non-numeric review counts to zero', () => {
    expect(readReviewState({ path: '', title: '', frontmatter: { review_count: 'x' } }).review_count).toBe(0)
  })
  it('defaults when frontmatter is absent', () => {
    expect(readReviewState({ path: '', title: '' })).toEqual({ review_count: 0, last_reviewed_at: '', next_review_at: '' })
  })
})

describe('isDue', () => {
  it('returns false for non-example layers', () => {
    expect(isDue(example({ path: 'a.md', title: 'A', layer: 'note' }), '2026-01-10')).toBe(false)
  })
  it('treats an empty review date as due', () => {
    expect(isDue(example({ path: 'a.md', title: 'A' }), '2026-01-10')).toBe(true)
  })
  it('compares due dates', () => {
    expect(isDue(example({ path: 'a.md', title: 'A', frontmatter: { next_review_at: '2026-01-09' } }), '2026-01-10')).toBe(true)
    expect(isDue(example({ path: 'a.md', title: 'A', frontmatter: { next_review_at: '2026-01-10' } }), '2026-01-10')).toBe(true)
    expect(isDue(example({ path: 'a.md', title: 'A', frontmatter: { next_review_at: '2026-01-11' } }), '2026-01-10')).toBe(false)
  })
  it('treats malformed dates as due', () => {
    expect(isDue(example({ path: 'a.md', title: 'A', frontmatter: { next_review_at: 'not-a-date' } }), '2026-01-10')).toBe(true)
    expect(isDue(example({ path: 'a.md', title: 'A', frontmatter: { next_review_at: '2026-13-40' } }), '2026-01-10')).toBe(true)
  })
  it('treats a malformed today as due', () => {
    expect(isDue(example({ path: 'a.md', title: 'A', frontmatter: { next_review_at: '2026-01-01' } }), 'bad')).toBe(true)
  })
  it('treats an empty today as due', () => {
    expect(isDue(example({ path: 'a.md', title: 'A', frontmatter: { next_review_at: '2026-01-01' } }), '')).toBe(true)
  })
})

describe('conceptLearningState', () => {
  it('defaults to 未开始', () => {
    expect(conceptLearningState({ path: '', title: '', frontmatter: {} })).toBe('未开始')
  })
  it('passes through valid states', () => {
    expect(conceptLearningState({ path: '', title: '', frontmatter: { learning_state: '已掌握' } })).toBe('已掌握')
  })
  it('falls back on invalid states', () => {
    expect(conceptLearningState({ path: '', title: '', frontmatter: { learning_state: 'nonsense' } })).toBe('未开始')
    expect(conceptLearningState({ path: '', title: '' })).toBe('未开始')
  })
})

describe('buildConceptGraph', () => {
  it('builds prerequisites from concept notes', () => {
    const notes: StudyNote[] = [
      example({ path: 'a.md', title: 'A', layer: 'concept', concepts: ['[[A]]', '[[B]]'] }),
    ]
    const graph = buildConceptGraph(notes as StudyNote[])
    expect(graph.prerequisites.A).toEqual(['B'])
    expect(graph.dependents.B).toEqual(['A'])
    expect(graph.exercised_by.A).toEqual(['a.md'])
  })
  it('ignores notes without concepts', () => {
    const graph = buildConceptGraph([example({ path: 'a.md', title: 'A', layer: 'concept', concepts: [] })])
    expect(graph.prerequisites).toEqual({})
    expect(graph.exercised_by).toEqual({})
  })
  it('records review levels only for numeric values', () => {
    const notes: StudyNote[] = [
      example({ path: 'a.md', title: 'A', concepts: ['A'], frontmatter: { review_level: 3 } }),
      example({ path: 'b.md', title: 'B', concepts: ['A'], frontmatter: { review_level: 'high' } }),
      example({ path: 'c.md', title: 'C', concepts: ['A'], frontmatter: { review_level: 5 } }),
    ]
    const graph = buildConceptGraph(notes as StudyNote[])
    expect(graph.review_levels.A).toEqual({ min: 3, avg: 4, max: 5, count: 2 })
    expect(graph.note_count.A).toBe(3)
  })
})

describe('concept traversal', () => {
  const graph: ConceptGraph = {
    prerequisites: { A: ['B'], B: ['C'], C: [] },
    dependents: { B: ['A'], C: ['B'], A: [] },
    exercised_by: { A: [], B: [], C: [] },
    review_levels: {},
    note_count: { A: 0, B: 0, C: 0 },
  }

  it('walks ancestors', () => {
    expect(conceptAncestors('A', graph)).toEqual([['A', 'B', 'C']])
  })
  it('walks descendants', () => {
    expect(conceptDescendants('C', graph)).toEqual([['C', 'B', 'A']])
  })
  it('marks cycles', () => {
    const cyclic: ConceptGraph = { ...graph, prerequisites: { A: ['B'], B: ['A'], C: [] }, dependents: { A: ['B'], B: ['A'], C: [] } }
    expect(conceptAncestors('A', cyclic)).toEqual([['A', 'B', '(cycle→A)']])
    expect(conceptDescendants('A', cyclic)).toEqual([['A', 'B', '(cycle→A)']])
  })
  it('respects max depth', () => {
    const deep: ConceptGraph = {
      prerequisites: { A: ['B'], B: ['C'], C: ['D'], D: [] },
      dependents: { D: ['C'], C: ['B'], B: ['A'], A: [] },
      exercised_by: {},
      review_levels: {},
      note_count: {},
    }
    expect(conceptAncestors('A', deep, 1)).toEqual([])
    expect(conceptDescendants('D', deep, 1)).toEqual([])
  })
  it('memoizes shared prerequisites in topological sort', () => {
    const shared: ConceptGraph = {
      prerequisites: { A: ['C'], B: ['C'], C: [] },
      dependents: { C: ['A', 'B'], A: [], B: [] },
      exercised_by: {},
      review_levels: {},
      note_count: {},
    }
    const order = topologicalOrder(['A', 'B'], shared)
    expect(order).toEqual(['C', 'A', 'B'])
  })
  it('orders topologically', () => {
    expect(topologicalOrder(['A'], graph)).toEqual(['C', 'B', 'A'])
  })
  it('handles concepts absent from the dependency maps', () => {
    expect(conceptAncestors('isolated', graph)).toEqual([['isolated']])
    expect(conceptDescendants('isolated', graph)).toEqual([['isolated']])
  })
  it('orders concepts with no prerequisites entry', () => {
    expect(topologicalOrder(['X'], { prerequisites: {}, dependents: {}, exercised_by: {}, review_levels: {}, note_count: {} })).toEqual(['X'])
  })
  it('ignores self loops and in-degree diamonds in topological order', () => {
    const diamond: ConceptGraph = {
      prerequisites: { A: ['B', 'C'], B: ['D'], C: ['D'], D: [] },
      dependents: {},
      exercised_by: {},
      review_levels: {},
      note_count: {},
    }
    expect(topologicalOrder(['A'], diamond)).toEqual(['D', 'B', 'C', 'A'])
    const selfLoop: ConceptGraph = {
      prerequisites: { A: ['A'] },
      dependents: {},
      exercised_by: {},
      review_levels: {},
      note_count: {},
    }
    expect(topologicalOrder(['A'], selfLoop)).toEqual(['A'])
  })
})

describe('buildReviewStats', () => {
  it('aggregates empty input', () => {
    const stats = buildReviewStats([], { today: '2026-01-10', builtAtIso: '2026-01-10T00:00:00Z' })
    expect(stats).toMatchObject({
      semantics: 'spacing_coverage.v1',
      total_examples: 0,
      reviewed_examples: 0,
      spacing_coverage_pct: 0,
      progress_pct: 0,
      due_today: 0,
      review_streak_days: 0,
    })
  })
  it('counts examples, levels, coverage, and due', () => {
    const notes: StudyNote[] = [
      example({ path: 'a/b.md', title: 'B', concepts: ['A'], frontmatter: { review_level: 1, review_count: 2, next_review_at: '2026-01-09' } }),
      example({ path: 'c/d.md', title: 'D', concepts: ['A'], frontmatter: { review_level: 3, review_count: 1, next_review_at: '2026-01-20' } }),
      example({ path: 'e/f.md', title: 'F', layer: 'note' }),
    ]
    const stats = buildReviewStats(notes as StudyNote[], { today: '2026-01-10', builtAtIso: 'X' })
    expect(stats.total_examples).toBe(2)
    expect(stats.by_review_level).toEqual({ 1: 1, 3: 1 })
    expect(stats.reviewed_examples).toBe(2)
    expect(stats.due_today).toBe(1)
    expect(stats.concepts).toMatchObject({ A: { min: 1, max: 3, count: 2, due: 1 } })
  })
  it('computes review streak from consecutive dates', () => {
    const notes: StudyNote[] = [
      example({ path: 'a.md', title: 'A', frontmatter: { review_count: 1, last_reviewed_at: '2026-01-10' } }),
      example({ path: 'b.md', title: 'B', frontmatter: { review_count: 1, last_reviewed_at: '2026-01-09' } }),
      example({ path: 'c.md', title: 'C', frontmatter: { review_count: 1, last_reviewed_at: '2026-01-07' } }),
      example({ path: 'd.md', title: 'D', frontmatter: { review_count: 1, last_reviewed_at: 'not-a-date' } }),
    ]
    const stats = buildReviewStats(notes as StudyNote[], { today: '2026-01-10', builtAtIso: 'X' })
    expect(stats.review_streak_days).toBe(2)
  })
  it('ignores future and duplicate review dates correctly', () => {
    const notes: StudyNote[] = [
      example({ path: 'a.md', title: 'A', frontmatter: { review_count: 1, last_reviewed_at: '2026-01-10' } }),
      example({ path: 'b.md', title: 'B', frontmatter: { review_count: 1, last_reviewed_at: '2026-01-10' } }),
    ]
    const stats = buildReviewStats(notes as StudyNote[], { today: '2026-01-10', builtAtIso: 'X' })
    expect(stats.review_streak_days).toBe(1)
  })
  it('breaks the streak on a far-past and a future review date', () => {
    const notes: StudyNote[] = [
      example({ path: 'a.md', title: 'A', frontmatter: { review_count: 1, last_reviewed_at: '2026-01-10' } }),
      example({ path: 'b.md', title: 'B', frontmatter: { review_count: 1, last_reviewed_at: '2026-01-05' } }),
      example({ path: 'c.md', title: 'C', frontmatter: { review_count: 1, last_reviewed_at: '2026-01-20' } }),
    ]
    const stats = buildReviewStats(notes as StudyNote[], { today: '2026-01-10', builtAtIso: 'X' })
    expect(stats.review_streak_days).toBe(1)
  })
  it('treats non-numeric review counts as zero and falls back on invalid today', () => {
    const notes: StudyNote[] = [
      example({ path: 'a.md', title: 'A', frontmatter: { review_count: 'many', review_level: 'high' } }),
    ]
    const stats = buildReviewStats(notes as StudyNote[], { today: 'bad-date', builtAtIso: 'X' })
    expect(stats.reviewed_examples).toBe(0)
    expect(stats.by_review_level).toEqual({ 0: 1 })
  })
})

describe('StudyReviewReadModel', () => {
  const notes: StudyNote[] = [
    example({ path: 'math/a.md', title: 'A', concepts: ['[[concept1|alias]]', 'concept2'], tags: ['#tag1'], frontmatter: { review_level: 2, review_count: 0, next_review_at: '2026-01-01', difficulty: 'easy', last_reviewed_at: '2026-01-01' } }),
    example({ path: 'math/b.md', title: 'B', concepts: ['concept2'], tags: ['#tag2'], frontmatter: { review_level: 1, review_count: 1, next_review_at: '2026-01-01', difficulty: 'hard', last_reviewed_at: '2026-01-02' } }),
    example({ path: 'math/c.md', title: 'C', concepts: ['concept3#section'], tags: [], frontmatter: { review_level: 1, review_count: 0, next_review_at: '2099-01-01', difficulty: 'medium', last_reviewed_at: '2025-12-01' } }),
    example({ path: 'math/d.md', title: 'D', concepts: [], tags: [], frontmatter: { review_level: 1, review_count: 0, next_review_at: '2026-01-01' } }),
    { path: 'math/e.md', basename: 'e.md', title: 'ConceptX', layer: 'concept', frontmatter: { learning_state: '学习中' }, tags: [], concepts: ['ConceptX'], patterns: [], aliases: [], headings: [], wikilinks: [], excerpt: '', size: 0, modified: '' },
    { path: 'math/f.md', basename: 'f.md', title: 'ConceptY', layer: 'concept', frontmatter: { learning_state: '未开始' }, tags: [], concepts: ['ConceptY', 'ConceptX'], patterns: [], aliases: [], headings: [], wikilinks: [], excerpt: '', size: 0, modified: '' },
    { path: 'math/g.md', basename: 'g.md', title: 'PatternZ', layer: 'pattern', frontmatter: { learning_state: '已掌握' }, tags: [], concepts: ['PatternZ'], patterns: [], aliases: [], headings: [], wikilinks: [], excerpt: '', size: 0, modified: '' },
    { path: 'math/h.md', basename: 'h.md', title: 'ConceptW', layer: 'concept', frontmatter: { learning_state: '已理解' }, tags: [], concepts: ['ConceptW'], patterns: [], aliases: [], headings: [], wikilinks: [], excerpt: '', size: 0, modified: '' },
  ]

  function model(overrides: StudyNote[] = notes): StudyReviewReadModel {
    return new StudyReviewReadModel({ notes: () => overrides })
  }

  it('lists due examples with sorting and subject/level filters', () => {
    const result = model().due({ asOf: '2026-01-10' })
    expect(result.count).toBe(3)
    expect(result.subjects).toEqual(['math'])
    const due = result.due as Array<{ path: string }>
    expect(due.map(item => item.path)).toEqual(['math/d.md', 'math/b.md', 'math/a.md'])

    const filtered = model().due({ asOf: '2026-01-10', subject: 'tag1' })
    expect((filtered.due as unknown[]).length).toBe(1)

    const leveled = model().due({ asOf: '2026-01-10', level: 1 })
    expect((leveled.due as unknown[]).length).toBe(2)

    const level0none = model().due({ asOf: '2026-01-10', level: 0 })
    expect((level0none.due as unknown[]).length).toBe(0)

    const bySubject = model().due({ asOf: '2026-01-10', subject: 'math' })
    expect(bySubject.count).toBe(3)

    const filterSubject = model().due({ asOf: '2026-01-10', subject: 'math', level: 2 })
    expect((filterSubject.due as unknown[]).length).toBe(1)
  })

  it('uses the system clock when no asOf given', () => {
    const result = model().due()
    expect(typeof result.date).toBe('string')
  })

  it('filters by concept substring', () => {
    const result = model().due({ asOf: '2026-01-10', subject: 'concept2' })
    expect((result.due as unknown[]).length).toBe(2)
  })

  it('respects the limit bound', () => {
    const result = model().due({ asOf: '2026-01-10', limit: 2 })
    expect(result.count).toBe(2)
    const zero = model().due({ asOf: '2026-01-10', limit: 0 })
    expect(zero.count).toBe(1)
  })

  it('renders stats', () => {
    const stats = model().stats()
    expect(stats.total).toBe(4)
    expect(stats.cached).toBe(false)
  })

  it('builds a queue with new concepts and examples, sorted by chain length', () => {
    const queue = model().queue()
    expect(queue.new_concepts_total).toBe(3)
    expect(queue.new_examples_total).toBe(3)
    const examples = queue.new_examples as Array<{ path: string }>
    expect(examples.map(item => item.path)).toEqual(['math/a.md', 'math/c.md', 'math/d.md'])
    const concepts = queue.new_concepts as Array<{ title: string }>
    expect(concepts.map(item => item.title)).toContain('ConceptY')
    expect(concepts.map(item => item.title)).toContain('ConceptX')
    expect(concepts.map(item => item.title)).toContain('ConceptW')
  })

  it('filters queue by learning state', () => {
    const queue = model().queue({ state: '学习中' })
    expect(queue.new_concepts_total).toBe(1)
    expect(queue.new_examples_total).toBe(0)
  })

  it('filters example queue by 已理解 state', () => {
    const withLevel0 = [
      example({ path: 'm.md', title: 'M', frontmatter: { review_level: 0, review_count: 0 } }),
      example({ path: 'n.md', title: 'N', frontmatter: { review_level: 1, review_count: 0 } }),
    ]
    expect(model(withLevel0).queue({ state: '已理解' }).new_examples_total).toBe(1)
    expect(model(withLevel0).queue({ state: '学习中' }).new_examples_total).toBe(1)
    expect(model(withLevel0).queue({ state: 'bogus' }).new_examples_total).toBe(2)
  })

  it('applies a null level filter as no filter', () => {
    const result = model().due({ asOf: '2026-01-10', level: null })
    expect(result.count).toBe(3)
  })

  it('sorts due by last review date and path as tie-breakers', () => {
    const ties = [
      example({ path: 'm/z.md', title: 'Z', frontmatter: { review_level: 0, next_review_at: '2026-01-01', last_reviewed_at: '2026-01-02' } }),
      example({ path: 'm/a.md', title: 'A', frontmatter: { review_level: 0, next_review_at: '2026-01-01', last_reviewed_at: '2026-01-02' } }),
    ]
    const result = model(ties).due({ asOf: '2026-01-10' })
    const due = result.due as Array<{ path: string }>
    expect(due.map(item => item.path)).toEqual(['m/a.md', 'm/z.md'])
  })

  it('excludes non-example layers from the queue and coerces review fields', () => {
    const mixed = [
      example({ path: 'x/one.md', title: 'One', layer: 'note', frontmatter: { review_level: 'high', review_count: 'many' } }),
      example({ path: 'x/two.md', title: 'Two', frontmatter: { review_level: 0, review_count: 0 } }),
    ]
    const queue = model(mixed).queue()
    expect(queue.new_examples_total).toBe(1)
  })

  it('sorts queue examples and concepts by title tie-breakers', () => {
    const many = [
      example({ path: 'q/b.md', title: 'B', frontmatter: { review_level: 0, review_count: 0, difficulty: 'easy' } }),
      example({ path: 'q/a.md', title: 'A', frontmatter: { review_level: 0, review_count: 0, difficulty: 'easy' } }),
      example({ path: 'q/c.md', title: 'C', frontmatter: { review_level: 0, review_count: 0, difficulty: 'hard' } }),
    ]
    const queue = model(many).queue()
    const examples = queue.new_examples as Array<{ path: string }>
    expect(examples.map(item => item.path)).toEqual(['q/a.md', 'q/b.md', 'q/c.md'])
  })

  it('lists a concept without numeric review levels', () => {
    const conceptOnly = [
      { path: 'c/a.md', basename: 'a.md', title: 'Solo', layer: 'concept', frontmatter: { review_level: 'high' }, tags: [], concepts: ['Solo'], patterns: [], aliases: [], headings: [], wikilinks: [], excerpt: '', size: 0, modified: '' },
    ]
    const result = model(conceptOnly).concepts()
    const concepts = result.concepts as Array<{ title: string; example_count: number; avg_level: unknown }>
    const solo = concepts.find(item => item.title === 'Solo')
    expect(solo?.avg_level).toBeUndefined()
  })

  it('sorts queue concepts with decreasing chain lengths', () => {
    const concepts = [
      { path: 'g/a.md', basename: 'a.md', title: 'A', layer: 'concept', frontmatter: {}, tags: [], concepts: ['A', 'B', 'C'], patterns: [], aliases: [], headings: [], wikilinks: [], excerpt: '', size: 0, modified: '' },
      { path: 'g/b.md', basename: 'b.md', title: 'B', layer: 'concept', frontmatter: {}, tags: [], concepts: ['B', 'E'], patterns: [], aliases: [], headings: [], wikilinks: [], excerpt: '', size: 0, modified: '' },
      { path: 'g/e.md', basename: 'e.md', title: 'E', layer: 'concept', frontmatter: {}, tags: [], concepts: ['E'], patterns: [], aliases: [], headings: [], wikilinks: [], excerpt: '', size: 0, modified: '' },
      { path: 'g/c.md', basename: 'c.md', title: 'C', layer: 'concept', frontmatter: {}, tags: [], concepts: ['C'], patterns: [], aliases: [], headings: [], wikilinks: [], excerpt: '', size: 0, modified: '' },
    ]
    const queue = model(concepts).queue()
    expect(queue.new_concepts_total).toBe(4)
  })

  it('coerces a non-numeric review level and missing last review date in due', () => {
    const withBad = [
      example({ path: 's/x.md', title: 'X', frontmatter: { review_level: 'high', next_review_at: '2026-01-01', review_count: 0 } }),
    ]
    const result = model(withBad).due({ asOf: '2026-01-10' })
    const due = result.due as Array<{ review_level: number; last_reviewed_at: unknown }>
    expect(due[0]?.review_level).toBe(0)
    expect(due[0]?.last_reviewed_at).toBeNull()
  })

  it('handles notes without a subject folder', () => {
    const single = [
      example({ path: 'lonely.md', title: 'L', frontmatter: { next_review_at: '2026-01-01', review_level: 0 } }),
      example({ path: '.hidden/x.md', title: 'X', frontmatter: { next_review_at: '2026-01-01', review_level: 0 } }),
    ]
    const result = model(single).due({ asOf: '2026-01-10', subject: 'nomatch' })
    expect(result.subjects).toEqual([])
    const unfiltered = model(single).due({ asOf: '2026-01-10' })
    expect((unfiltered.due as unknown[]).length).toBe(2)
  })

  it('lists concepts with learning states', () => {
    const result = model().concepts()
    const concepts = result.concepts as Array<{ title: string; learning_state: string }>
    const byTitle = Object.fromEntries(concepts.map(item => [item.title, item.learning_state]))
    expect(byTitle.ConceptX).toBe('学习中')
    expect(byTitle['未开始']).toBeUndefined()
  })
})
