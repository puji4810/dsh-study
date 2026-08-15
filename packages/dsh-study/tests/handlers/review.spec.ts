import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { handleStudyError } from '../../src/handlers/misc.ts'
import { handleStudyReview, handleStudyReviewDetail } from '../../src/handlers/review.ts'
import { env, exampleNoteBody, tempVault, writeNote, writeProject } from '../helpers.ts'

const dirs: string[] = []
function mkVault(): string {
  const dir = tempVault()
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const d of dirs.splice(0)) void d })

function example(vault: string, rel: string, overrides: Record<string, unknown> = {}): void {
  writeNote(vault, rel, exampleNoteBody({ title: rel.split('/').pop()!.replace('.md', ''), ...overrides }))
}

describe('handleStudyReview detail', () => {
  it('splits a prompt from an answer heading', () => {
    const vault = mkVault()
    example(vault, 'math/examples/a.md', { title: 'A' })
    const result = handleStudyReviewDetail({ note: 'math/examples/a.md' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.has_answer).toBe(true)
    expect((result.data.prompt_markdown as string)).not.toContain('Answer body')
    expect((result.data.answer_markdown as string)).toContain('Answer body')
  })

  it('reports a missing note', () => {
    const vault = mkVault()
    const result = handleStudyReviewDetail({ note: 'nope.md' }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('NOTE_NOT_FOUND')
  })

  it('rejects non-example notes', () => {
    const vault = mkVault()
    writeNote(vault, 'Box/a.md', '---\ntype: concept\n---\n# A\n')
    const result = handleStudyReviewDetail({ note: 'Box/a.md' }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('NOT_REVIEW_ITEM')
  })

  it('handles an answerless note', () => {
    const vault = mkVault()
    writeNote(vault, 'math/examples/a.md', '---\ntype: example\n---\n# A\n\njust prompt\n')
    const result = handleStudyReviewDetail({ note: 'math/examples/a.md' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.has_answer).toBe(false)
    expect(result.data.prompt_markdown).toContain('just prompt')
  })
})

describe('handleStudyReview due', () => {
  it('lists due examples in priority order', () => {
    const vault = mkVault()
    example(vault, 'math/examples/a.md', { title: 'A', reviewLevel: 2, reviewCount: 1, nextReviewAt: '2026-01-01' })
    example(vault, 'math/examples/b.md', { title: 'B', reviewLevel: 1, reviewCount: 1, nextReviewAt: '2026-01-01' })
    const result = handleStudyReview({ action: 'due' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.count).toBe(2)
    const due = result.data.due as Array<{ path: string }>
    expect(due.map(item => item.path)).toEqual(['math/examples/b.md', 'math/examples/a.md'])
  })

  it('filters by subjects, tags, concepts, difficulties, review_levels', () => {
    const vault = mkVault()
    example(vault, 'math/examples/a.md', { title: 'A', concepts: ['concept1'], difficulty: 'easy', reviewLevel: 1, nextReviewAt: '2026-01-01' })
    example(vault, 'math/examples/b.md', { title: 'B', concepts: ['concept2'], difficulty: 'hard', reviewLevel: 3, nextReviewAt: '2026-01-01' })

    const bySubject = handleStudyReview({ action: 'due', subjects: ['math'] }, env(vault))
    if (!bySubject.ok) throw new Error('expected ok')
    expect(bySubject.data.count).toBe(2)

    const byConcept = handleStudyReview({ action: 'due', concepts: ['concept1'] }, env(vault))
    if (!byConcept.ok) throw new Error('expected ok')
    expect(byConcept.data.count).toBe(1)

    const byDiff = handleStudyReview({ action: 'due', difficulties: ['easy'] }, env(vault))
    if (!byDiff.ok) throw new Error('expected ok')
    expect(byDiff.data.count).toBe(1)

    const byLevel = handleStudyReview({ action: 'due', review_levels: [3] }, env(vault))
    if (!byLevel.ok) throw new Error('expected ok')
    expect(byLevel.data.count).toBe(1)
  })

  it('supports review_state and sort options', () => {
    const vault = mkVault()
    example(vault, 'math/examples/a.md', { title: 'A', reviewCount: 0, reviewLevel: 0, nextReviewAt: '2099-01-01' })
    const all = handleStudyReview({ action: 'due', review_state: 'all' }, env(vault))
    if (!all.ok) throw new Error('expected ok')
    expect(all.data.count).toBe(1)
    const byTitle = handleStudyReview({ action: 'due', review_state: 'all', sort: 'title' }, env(vault))
    if (!byTitle.ok) throw new Error('expected ok')
    expect(byTitle.data.count).toBe(1)
  })

  it('rejects invalid selectors', () => {
    const vault = mkVault()
    const badMatch = handleStudyReview({ action: 'due', match: 'bogus' }, env(vault))
    expect(badMatch.ok).toBe(false)
    if (!badMatch.ok) expect(badMatch.error.code).toBe('DUE_REVIEWS_FAILED')
    const badState = handleStudyReview({ action: 'due', review_state: 'bogus' }, env(vault))
    expect(badState.ok).toBe(false)
    const badSort = handleStudyReview({ action: 'due', sort: 'bogus' }, env(vault))
    expect(badSort.ok).toBe(false)
  })
})

describe('handleStudyReview record', () => {
  it('records a correct review and advances state', () => {
    const vault = mkVault()
    example(vault, 'math/examples/a.md', { title: 'A', reviewCount: 0, reviewLevel: 0 })
    const result = handleStudyReview({ action: 'record', note: 'math/examples/a.md', result: 'correct' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.passed).toBe(true)
    expect((result.data.review_level as Record<string, unknown>).new).toBe(3)
    expect((result.data.review_count as Record<string, unknown>).new).toBe(1)
    const text = readFileSync(join(vault, 'math', 'examples', 'a.md'), 'utf8')
    expect(text).toContain('review_count: 1')
    expect(text).toContain('last_reviewed_at: 2026-01-15')
  })

  it('derives result from passed flag', () => {
    const vault = mkVault()
    example(vault, 'math/examples/a.md', { title: 'A' })
    const result = handleStudyReview({ action: 'record', note: 'math/examples/a.md', passed: false }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.passed).toBe(false)
    expect((result.data.review_level as Record<string, unknown>).new).toBe(1)
    expect((result.data.review_count as Record<string, unknown>).new).toBe(0)
  })

  it('logs an error when log_error is set on failure', () => {
    const vault = mkVault()
    example(vault, 'math/examples/a.md', { title: 'A' })
    const result = handleStudyReview({ action: 'record', note: 'math/examples/a.md', result: 'incorrect', log_error: true, concepts: ['[[C]]'] }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.error_logged).toBeTruthy()
    expect(existsSync(join(vault, '.StudyOS', 'errors', '2026-01.md'))).toBe(true)
  })

  it('rejects invalid results', () => {
    const vault = mkVault()
    example(vault, 'math/examples/a.md', { title: 'A' })
    const result = handleStudyReview({ action: 'record', note: 'math/examples/a.md', result: 'bogus' }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED')
  })

  it('requires a note', () => {
    const vault = mkVault()
    const result = handleStudyReview({ action: 'record' }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('MISSING_NOTE')
  })

  it('reports a missing note', () => {
    const vault = mkVault()
    const result = handleStudyReview({ action: 'record', note: 'nope.md' }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('NOTE_NOT_FOUND')
  })
})

describe('handleStudyReview submit', () => {
  it('records an attempt and a review', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    example(vault, 'math/examples/a.md', { title: 'A' })
    const result = handleStudyReview({
      action: 'submit', project_id: 'proj-1', note: 'math/examples/a.md',
      result: 'correct', duration_seconds: 30, response: 'my answer',
    }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.completed_today_increment).toBe(1)
    expect(result.data.attempt).toBeTruthy()
    expect(result.data.review).toBeTruthy()
  })

  it('requires exactly one note', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    const none = handleStudyReview({ action: 'submit', project_id: 'proj-1' }, env(vault))
    expect(none.ok).toBe(false)
    if (!none.ok) expect(none.error.code).toBe('VALIDATION_FAILED')
    const many = handleStudyReview({ action: 'submit', project_id: 'proj-1', notes: ['a.md', 'b.md'] }, env(vault))
    expect(many.ok).toBe(false)
  })

  it('rejects a bad result and bad duration', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    example(vault, 'math/examples/a.md', { title: 'A' })
    const badResult = handleStudyReview({ action: 'submit', project_id: 'proj-1', note: 'math/examples/a.md', result: 'bogus', duration_seconds: 1 }, env(vault))
    expect(badResult.ok).toBe(false)
    const badDuration = handleStudyReview({ action: 'submit', project_id: 'proj-1', note: 'math/examples/a.md', result: 'correct', duration_seconds: -1 }, env(vault))
    expect(badDuration.ok).toBe(false)
  })
})

describe('handleStudyReview create_task', () => {
  it('appends a review task line', () => {
    const vault = mkVault()
    const result = handleStudyReview({ action: 'create_task', title: 'T', due_date: '2026-02-01', review_level: 2, concepts: ['a'], reason: 'why' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    const text = readFileSync(join(vault, '.StudyOS', 'review_tasks.md'), 'utf8')
    expect(text).toContain('- [ ] T due:2026-02-01 priority:medium status:todo review_level:2 source:- concepts:a patterns:- reason:why')
  })
})

describe('handleStudyReview stats', () => {
  it('builds and caches stats', () => {
    const vault = mkVault()
    example(vault, 'math/examples/a.md', { title: 'A', reviewCount: 1, lastReviewedAt: '2026-01-15' })
    const result = handleStudyReview({ action: 'stats' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.cached).toBe(false)
    expect(result.data.total_examples).toBe(1)
    expect(existsSync(join(vault, '.StudyOS', 'review_stats.json'))).toBe(true)
    // Second call reuses the cache.
    const cached = handleStudyReview({ action: 'stats' }, env(vault))
    if (!cached.ok) throw new Error('expected ok')
    expect(cached.data.cached).toBe(true)
  })

  it('rebuilds when rebuild is set', () => {
    const vault = mkVault()
    example(vault, 'math/examples/a.md', { title: 'A' })
    handleStudyReview({ action: 'stats' }, env(vault))
    const result = handleStudyReview({ action: 'stats', rebuild: true }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.cached).toBe(false)
  })
})

describe('handleStudyReview weekly_report', () => {
  it('generates a report with clustering', () => {
    const vault = mkVault()
    handleStudyError({ title: 'e1', concepts: ['[[C]]'], cause: 'x', occurred_on: '2026-01-13' }, env(vault))
    handleStudyError({ title: 'e2', concepts: ['[[C]]'], cause: 'x', occurred_on: '2026-01-14' }, env(vault))
    handleStudyError({ title: 'e3', concepts: ['[[C]]'], cause: 'x', occurred_on: '2026-01-15' }, env(vault))
    const result = handleStudyReview({ action: 'weekly_report', start_date: '2026-01-12', end_date: '2026-01-18' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.error_count).toBe(3)
    expect(existsSync(join(vault, '.StudyOS', 'reports', '2026-W03.md'))).toBe(true)
    const text = readFileSync(join(vault, '.StudyOS', 'reports', '2026-W03.md'), 'utf8')
    expect(text).toContain('Repeated Patterns')
  })

  it('rejects an invalid date range', () => {
    const vault = mkVault()
    const result = handleStudyReview({ action: 'weekly_report', start_date: '2026-01-20', end_date: '2026-01-10' }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_DATE_RANGE')
  })
})

describe('handleStudyReview export_anki', () => {
  it('exports anki candidates with blocks', () => {
    const vault = mkVault()
    example(vault, 'math/examples/a.md', { title: 'A', concepts: ['c1'] })
    const result = handleStudyReview({ action: 'export_anki' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.count).toBe(1)
    const text = readFileSync(join(vault, '.StudyOS', 'anki_candidates', '2026-01-15.md'), 'utf8')
    expect(text).toContain('START')
    expect(text).toContain('问答题')
    expect(text).toContain('正面: A 的核心辨析点是什么？')
    expect(text).toContain('END')
  })
})

describe('handleStudyReview invalid action', () => {
  it('rejects unknown actions', () => {
    const result = handleStudyReview({ action: 'bogus' }, env(mkVault()))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_ACTION')
  })
})

describe('handleStudyReview due sorts and match modes', () => {
  function seed(vault: string): void {
    example(vault, 'math/examples/a.md', { title: 'Alpha', reviewLevel: 2, reviewCount: 1, nextReviewAt: '2026-01-10', lastReviewedAt: '2026-01-10', difficulty: 'easy' })
    example(vault, 'math/examples/b.md', { title: 'beta', reviewLevel: 1, reviewCount: 1, nextReviewAt: '2026-01-10', lastReviewedAt: '2026-01-11', difficulty: 'hard' })
    example(vault, 'math/examples/c.md', { title: 'Gamma', reviewLevel: 3, reviewCount: 1, nextReviewAt: '2026-01-10', lastReviewedAt: '2026-01-09', difficulty: 'medium' })
  }
  it('sorts by oldest', () => {
    const vault = mkVault(); seed(vault)
    const r = handleStudyReview({ action: 'due', sort: 'oldest' }, env(vault))
    if (!r.ok) throw new Error('expected ok')
    const paths = (r.data.due as Array<{ path: string }>).map(i => i.path)
    expect(paths[0]).toBe('math/examples/c.md')
  })
  it('sorts by newest', () => {
    const vault = mkVault(); seed(vault)
    const r = handleStudyReview({ action: 'due', sort: 'newest' }, env(vault))
    if (!r.ok) throw new Error('expected ok')
    const paths = (r.data.due as Array<{ path: string }>).map(i => i.path)
    expect(paths[0]).toBe('math/examples/b.md')
  })
  it('sorts by difficulty ascending and descending', () => {
    const vault = mkVault(); seed(vault)
    const asc = handleStudyReview({ action: 'due', sort: 'difficulty_asc' }, env(vault))
    if (!asc.ok) throw new Error('expected ok')
    const ascPaths = (asc.data.due as Array<{ path: string }>).map(i => i.path)
    expect(ascPaths[0]).toBe('math/examples/a.md') // easy
    const desc = handleStudyReview({ action: 'due', sort: 'difficulty_desc' }, env(vault))
    if (!desc.ok) throw new Error('expected ok')
    const descPaths = (desc.data.due as Array<{ path: string }>).map(i => i.path)
    expect(descPaths[0]).toBe('math/examples/b.md') // hard
  })
  it('sorts by title case-insensitively', () => {
    const vault = mkVault(); seed(vault)
    const r = handleStudyReview({ action: 'due', sort: 'title' }, env(vault))
    if (!r.ok) throw new Error('expected ok')
    const paths = (r.data.due as Array<{ path: string }>).map(i => i.path)
    expect(paths[0]).toBe('math/examples/a.md') // Alpha < beta < Gamma (casefolded)
  })
  it('applies match=all for subjects and tags', () => {
    const vault = mkVault()
    writeNote(vault, 'math/examples/a.md', '---\ntype: example\nreview_count: 1\nnext_review_at: 2026-01-10\ntags:\n  - x\n  - y\n---\n# A\n')
    const all = handleStudyReview({ action: 'due', match: 'all', subjects: ['math', 'extra'], review_state: 'all' }, env(vault))
    if (!all.ok) throw new Error('expected ok')
    expect(all.data.count).toBe(0)
    const tagsAll = handleStudyReview({ action: 'due', match: 'all', tags: ['x', 'y'], review_state: 'all' }, env(vault))
    if (!tagsAll.ok) throw new Error('expected ok')
    expect(tagsAll.data.count).toBe(1)
  })
})

describe('handleStudyReview due selectors', () => {
  it('filters by subject (single), notes, paths, and excludes', () => {
    const vault = mkVault()
    example(vault, 'math/examples/a.md', { title: 'A', nextReviewAt: '2026-01-10' })
    example(vault, 'os/examples/b.md', { title: 'B', nextReviewAt: '2026-01-10' })
    const bySubject = handleStudyReview({ action: 'due', subject: 'os' }, env(vault))
    if (!bySubject.ok) throw new Error('expected ok')
    expect(bySubject.data.count).toBe(1)
    const byNotes = handleStudyReview({ action: 'due', notes: ['math/examples/a.md'] }, env(vault))
    if (!byNotes.ok) throw new Error('expected ok')
    expect(byNotes.data.count).toBe(1)
    const byPaths = handleStudyReview({ action: 'due', paths: ['math/examples/a.md'] }, env(vault))
    if (!byPaths.ok) throw new Error('expected ok')
    expect(byPaths.data.count).toBe(1)
    const excluded = handleStudyReview({ action: 'due', exclude_paths: ['math'] }, env(vault))
    if (!excluded.ok) throw new Error('expected ok')
    expect(excluded.data.count).toBe(1)
    expect((excluded.data.due as Array<{ path: string }>)[0]!.path).toBe('os/examples/b.md')
  })

  it('applies min/max review level bounds', () => {
    const vault = mkVault()
    example(vault, 'math/examples/a.md', { title: 'A', reviewLevel: 1, nextReviewAt: '2026-01-10' })
    example(vault, 'math/examples/b.md', { title: 'B', reviewLevel: 4, nextReviewAt: '2026-01-10' })
    const min = handleStudyReview({ action: 'due', min_review_level: 4 }, env(vault))
    if (!min.ok) throw new Error('expected ok')
    expect(min.data.count).toBe(1)
    const max = handleStudyReview({ action: 'due', max_review_level: 1 }, env(vault))
    if (!max.ok) throw new Error('expected ok')
    expect(max.data.count).toBe(1)
  })

  it('supports review_state new and reviewed', () => {
    const vault = mkVault()
    example(vault, 'math/examples/a.md', { title: 'A', reviewCount: 0, reviewLevel: 0, nextReviewAt: '2099-01-01' })
    example(vault, 'math/examples/b.md', { title: 'B', reviewCount: 3, reviewLevel: 2, nextReviewAt: '2026-01-10' })
    const fresh = handleStudyReview({ action: 'due', review_state: 'new' }, env(vault))
    if (!fresh.ok) throw new Error('expected ok')
    expect(fresh.data.count).toBe(1)
    const reviewed = handleStudyReview({ action: 'due', review_state: 'reviewed' }, env(vault))
    if (!reviewed.ok) throw new Error('expected ok')
    expect(reviewed.data.count).toBe(1)
  })

  it('records the folder selector in selection', () => {
    const vault = mkVault()
    example(vault, 'math/examples/a.md', { title: 'A', nextReviewAt: '2026-01-10' })
    example(vault, 'os/examples/b.md', { title: 'B', nextReviewAt: '2026-01-10' })
    const r = handleStudyReview({ action: 'due', folder: 'os' }, env(vault))
    if (!r.ok) throw new Error('expected ok')
    expect((r.data.selection as { folder: string }).folder).toBe('os')
  })

  it('rejects invalid min>max, levels, and ints', () => {
    const vault = mkVault()
    const minMax = handleStudyReview({ action: 'due', min_review_level: 5, max_review_level: 1 }, env(vault))
    expect(minMax.ok).toBe(false)
    const badMin = handleStudyReview({ action: 'due', min_review_level: 9 }, env(vault))
    expect(badMin.ok).toBe(false)
    const badMax = handleStudyReview({ action: 'due', max_review_level: 'x' }, env(vault))
    expect(badMax.ok).toBe(false)
    const badLevels = handleStudyReview({ action: 'due', review_levels: [9] }, env(vault))
    expect(badLevels.ok).toBe(false)
    const badLevelsType = handleStudyReview({ action: 'due', review_levels: 'x' }, env(vault))
    expect(badLevelsType.ok).toBe(false)
    const badExclude = handleStudyReview({ action: 'due', exclude_paths: ['..'] }, env(vault))
    expect(badExclude.ok).toBe(false)
  })
})

describe('handleStudyReview record variants', () => {
  it('records a partial result', () => {
    const vault = mkVault()
    example(vault, 'math/examples/a.md', { title: 'A', reviewCount: 2, reviewLevel: 2 })
    const result = handleStudyReview({ action: 'record', note: 'math/examples/a.md', result: 'partial' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.passed).toBe(false)
    expect((result.data.review_level as Record<string, unknown>).new).toBe(2)
    expect((result.data.review_count as Record<string, unknown>).new).toBe(0)
  })

  it('logs an error with detail, severity, and occurred_on', () => {
    const vault = mkVault()
    example(vault, 'math/examples/a.md', { title: 'A' })
    const result = handleStudyReview({ action: 'record', note: 'math/examples/a.md', result: 'incorrect', log_error: true, cause: 'calc', severity: 'high', detail: 'oops', occurred_on: '2026-02-03', concepts: ['[[C]]'] }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.error_logged).toEqual({ path: '.StudyOS/errors/2026-02.md' })
    const text = readFileSync(join(vault, '.StudyOS', 'errors', '2026-02.md'), 'utf8')
    expect(text).toContain('复习错误')
    expect(text).toContain('Cause: calc')
  })

  it('reports NOTE_AMBIGUOUS for a shared title', () => {
    const vault = mkVault()
    writeNote(vault, 'math/examples/a.md', '---\ntype: example\ntitle: Dup\n---\n# A\n')
    writeNote(vault, 'math/examples/b.md', '---\ntype: example\ntitle: Dup\n---\n# B\n')
    const result = handleStudyReview({ action: 'record', note: 'Dup' }, env(vault))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('NOTE_AMBIGUOUS')
  })
})

describe('handleStudyReviewDetail variants', () => {
  it('reports NOTE_AMBIGUOUS and REVIEW_DETAIL_FAILED', () => {
    const vault = mkVault()
    writeNote(vault, 'math/examples/a.md', '---\ntype: example\ntitle: Dup\n---\n# A\n')
    writeNote(vault, 'math/examples/b.md', '---\ntype: example\ntitle: Dup\n---\n# B\n')
    const amb = handleStudyReviewDetail({ note: 'Dup' }, env(vault))
    expect(amb.ok).toBe(false)
    if (!amb.ok) expect(amb.error.code).toBe('NOTE_AMBIGUOUS')
    const missing = handleStudyReviewDetail({ note: 'a.md', vault_path: 'definitely-not-a-vault' }, env(vault))
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('REVIEW_DETAIL_FAILED')
  })
})

describe('handleStudyReview submit variants', () => {
  it('accepts item_id and notes references', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    example(vault, 'math/examples/a.md', { title: 'A' })
    const byItemId = handleStudyReview({ action: 'submit', project_id: 'proj-1', item_id: 'math/examples/a.md', result: 'correct', duration_seconds: 1, response: 'x' }, env(vault))
    if (!byItemId.ok) throw new Error('expected ok')
    expect(byItemId.data.completed_today).toBe(1)
    const byNotes = handleStudyReview({ action: 'submit', project_id: 'proj-1', notes: ['math/examples/a.md'], result: 'correct', duration_seconds: 1, attempt_id: 'att-2', response: 'x' }, env(vault))
    if (!byNotes.ok) throw new Error('expected ok')
    expect(byNotes.data.completed_today).toBe(2)
  })

  it('rejects non-example and missing notes', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    writeNote(vault, 'Box/a.md', '---\ntype: concept\n---\n# A\n')
    const notExample = handleStudyReview({ action: 'submit', project_id: 'proj-1', note: 'Box/a.md', result: 'correct', duration_seconds: 1 }, env(vault))
    expect(notExample.ok).toBe(false)
    if (!notExample.ok) expect(notExample.error.code).toBe('NOT_REVIEW_ITEM')
    const missing = handleStudyReview({ action: 'submit', project_id: 'proj-1', note: 'nope.md', result: 'correct', duration_seconds: 1 }, env(vault))
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.code).toBe('NOTE_NOT_FOUND')
  })

  it('propagates an attempt failure (duplicate attempt id)', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    example(vault, 'math/examples/a.md', { title: 'A' })
    const first = handleStudyReview({ action: 'submit', project_id: 'proj-1', note: 'math/examples/a.md', attempt_id: 'att-dup', result: 'correct', duration_seconds: 1, response: 'x' }, env(vault))
    if (!first.ok) throw new Error('expected ok')
    const dup = handleStudyReview({ action: 'submit', project_id: 'proj-1', note: 'math/examples/a.md', attempt_id: 'att-dup', result: 'correct', duration_seconds: 1, response: 'x' }, env(vault))
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.error.code).toBe('ATTEMPT_EXISTS')
  })

  it('skips non-review attempts when counting completed today', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    example(vault, 'math/examples/a.md', { title: 'A' })
    // Seed a non-review attempt and one with a malformed occurred_at.
    mkdirSync(join(vault, '.StudyOS', 'projects', 'proj-1', 'activity'), { recursive: true })
    writeFileSync(join(vault, '.StudyOS', 'projects', 'proj-1', 'activity', 'attempts-2026-01.jsonl'), [
      JSON.stringify({ attempt_id: 'seed-1', project_id: 'proj-1', item_id: 'x', occurred_at: '2026-01-15T08:00:00Z', response: 'r', result: 'correct', score: 1, activity_kind: 'practice', duration_seconds: 1 }),
      JSON.stringify({ attempt_id: 'seed-2', project_id: 'proj-1', item_id: 'x', occurred_at: 'garbage', response: 'r', result: 'correct', score: 1, activity_kind: 'review', duration_seconds: 1 }),
    ].join('\n') + '\n', 'utf8')
    const result = handleStudyReview({ action: 'submit', project_id: 'proj-1', note: 'math/examples/a.md', result: 'correct', duration_seconds: 1, occurred_at: '2026-01-15T08:00:00Z', response: 'x' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.completed_today).toBe(1)
  })
})

describe('handleStudyReview create_task defaults', () => {
  it('defaults due date to tomorrow, title, and empty review level', () => {
    const vault = mkVault()
    const result = handleStudyReview({ action: 'create_task', due_date: undefined, patterns: ['p1'] }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.due_date).toBe('2026-01-16')
    const text = readFileSync(join(vault, '.StudyOS', 'review_tasks.md'), 'utf8')
    expect(text).toContain('复习任务')
    expect(text).toContain('review_level:-')
    expect(text).toContain('patterns:p1')
    void result
  })
})

describe('handleStudyReview stats invalid cache', () => {
  it('rebuilds when the cache is malformed', () => {
    const vault = mkVault()
    example(vault, 'math/examples/a.md', { title: 'A', reviewCount: 1 })
    mkdirSync(join(vault, '.StudyOS'), { recursive: true })
    writeFileSync(join(vault, '.StudyOS', 'review_stats.json'), '{not json', 'utf8')
    const result = handleStudyReview({ action: 'stats' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.cached).toBe(false)
    const wrongSemantics = handleStudyReview({ action: 'stats' }, env(vault))
    if (!wrongSemantics.ok) throw new Error('expected ok')
    expect(wrongSemantics.data.cached).toBe(true)
  })
})

describe('handleStudyReview weekly_report clustering', () => {
  it('reports deep confusion, severities, and review tasks, plus empty ranges', () => {
    const vault = mkVault()
    handleStudyError({ title: 'e1', concepts: ['[[C]]'], cause: 'x', severity: 'high', occurred_on: '2026-01-13' }, env(vault))
    handleStudyError({ title: 'e2', concepts: ['[[C]]'], cause: 'y', severity: 'low', occurred_on: '2026-01-14' }, env(vault))
    handleStudyReview({ action: 'create_task', title: 'T', due_date: '2026-01-14' }, env(vault))
    const result = handleStudyReview({ action: 'weekly_report', start_date: '2026-01-12', end_date: '2026-01-18' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    const text = readFileSync(join(vault, '.StudyOS', 'reports', '2026-W03.md'), 'utf8')
    expect(text).toContain('Deep Confusion')
    expect(text).toContain('Severity')
    expect(text).toContain('high: 1')
    expect(text).toContain('T')
    // Now an empty range produces the no-data branches.
    const empty = handleStudyReview({ action: 'weekly_report', start_date: '2026-02-01', end_date: '2026-02-07' }, env(vault))
    if (!empty.ok) throw new Error('expected ok')
    const emptyText = readFileSync(join(vault, '.StudyOS', 'reports', '2026-W05.md'), 'utf8')
    expect(emptyText).toContain('- No errors logged.')
    expect(emptyText).toContain('- No clustered errors.')
    expect(emptyText).toContain('- No severity data.')
    expect(emptyText).toContain('- No error records in this range.')
    expect(emptyText).toContain('- No review tasks in this range.')
  })
})

describe('handleStudyReview export_anki variants', () => {
  it('exports error records as candidates', () => {
    const vault = mkVault()
    handleStudyError({ title: 'mistake', cause: 'calc', next_action: 'redo', occurred_on: '2026-01-10' }, env(vault))
    const result = handleStudyReview({ action: 'export_anki', include_errors: true, start_date: '2026-01-01', end_date: '2026-01-20' }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.count).toBe(1)
    const text = readFileSync(join(vault, '.StudyOS', 'anki_candidates', '2026-01-15.md'), 'utf8')
    expect(text).toContain('错因复盘')
    expect(text).toContain('StudyOS 错题')
  })

  it('skips errors when include_errors is false', () => {
    const vault = mkVault()
    example(vault, 'math/examples/a.md', { title: 'A' })
    handleStudyError({ title: 'e', cause: 'x', occurred_on: '2026-01-10' }, env(vault))
    const result = handleStudyReview({ action: 'export_anki', include_errors: false }, env(vault))
    if (!result.ok) throw new Error('expected ok')
    expect(result.data.count).toBe(1)
  })

  it('applies query/tag/layer filters and limit', () => {
    const vault = mkVault()
    example(vault, 'math/examples/a.md', { title: 'A', concepts: ['c1'] })
    example(vault, 'math/examples/b.md', { title: 'B' })
    const query = handleStudyReview({ action: 'export_anki', query: 'nothing-matches' }, env(vault))
    if (!query.ok) throw new Error('expected ok')
    expect(query.data.count).toBe(0)
    const limited = handleStudyReview({ action: 'export_anki', limit: 1 }, env(vault))
    if (!limited.ok) throw new Error('expected ok')
    expect(limited.data.count).toBe(1)
  })
})

describe('handleStudyReview asList and selector edge cases', () => {
  it('handles string and scalar concepts in create_task and record', () => {
    const vault = mkVault()
    const task = handleStudyReview({ action: 'create_task', title: 'T', concepts: 'solo', patterns: 'p', due_date: '2026-02-01' }, env(vault))
    if (!task.ok) throw new Error('expected ok')
    const text = readFileSync(join(vault, '.StudyOS', 'review_tasks.md'), 'utf8')
    expect(text).toContain('concepts:solo')
    example(vault, 'math/examples/a.md', { title: 'A' })
    const rec = handleStudyReview({ action: 'record', note: 'math/examples/a.md', result: 'incorrect', log_error: true, concepts: 42 }, env(vault))
    if (!rec.ok) throw new Error('expected ok')
    expect(rec.data.error_logged).toBeTruthy()
  })

  it('rejects a non-list subject selector', () => {
    const vault = mkVault()
    const r = handleStudyReview({ action: 'due', subjects: 42 }, env(vault))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('DUE_REVIEWS_FAILED')
    const nullLevels = handleStudyReview({ action: 'due', review_levels: null }, env(vault))
    if (!nullLevels.ok) throw new Error('expected ok')
    const singleLevel = handleStudyReview({ action: 'due', review_levels: 3 }, env(vault))
    if (!singleLevel.ok) throw new Error('expected ok')
  })

  it('defaults to due when no action is given', () => {
    const vault = mkVault()
    const r = handleStudyReview({}, env(vault))
    if (!r.ok) throw new Error('expected ok')
    expect(r.data.count).toBe(0)
  })

  it('falls back to the default due date on a malformed due_date', () => {
    const vault = mkVault()
    const r = handleStudyReview({ action: 'create_task', title: 'T', due_date: 'garbage', concepts: '  ' }, env(vault))
    if (!r.ok) throw new Error('expected ok')
    expect(r.data.due_date).toBe('2026-01-16')
  })

  it('matches subjects via a concept substring', () => {
    const vault = mkVault()
    example(vault, 'math/examples/a.md', { title: 'A', concepts: ['derivative'] })
    const r = handleStudyReview({ action: 'due', subjects: ['deriv'], review_state: 'all' }, env(vault))
    if (!r.ok) throw new Error('expected ok')
    expect(r.data.count).toBe(1)
  })

  it('applies tags match any and all', () => {
    const vault = mkVault()
    writeNote(vault, 'math/examples/a.md', '---\ntype: example\nreview_count: 1\nnext_review_at: 2026-01-10\ntags: [x, y]\n---\n# A\n')
    const any = handleStudyReview({ action: 'due', tags: ['x', 'z'], review_state: 'all' }, env(vault))
    if (!any.ok) throw new Error('expected ok')
    expect(any.data.count).toBe(1)
    const all = handleStudyReview({ action: 'due', match: 'all', tags: ['x', 'z'], review_state: 'all' }, env(vault))
    if (!all.ok) throw new Error('expected ok')
    expect(all.data.count).toBe(0)
  })

  it('skips non-example and not-yet-due notes', () => {
    const vault = mkVault()
    writeNote(vault, 'Box/a.md', '---\ntype: concept\n---\n# A\n')
    example(vault, 'math/examples/a.md', { title: 'A', nextReviewAt: '2099-01-01' })
    const r = handleStudyReview({ action: 'due' }, env(vault))
    if (!r.ok) throw new Error('expected ok')
    expect(r.data.count).toBe(0)
  })

  it('notes a root-level note has no subject', () => {
    const vault = mkVault()
    writeNote(vault, 'a.md', '# A\n')
    const r = handleStudyReview({ action: 'due', review_state: 'all' }, env(vault))
    if (!r.ok) throw new Error('expected ok')
    expect(r.data.subjects).toEqual([])
  })
})

describe('handleStudyReview sort tie-breaks', () => {
  it('breaks priority ties on last_reviewed_at', () => {
    const vault = mkVault()
    example(vault, 'math/examples/a.md', { title: 'A', reviewLevel: 1, reviewCount: 1, nextReviewAt: '2026-01-10', lastReviewedAt: '2026-01-09' })
    example(vault, 'math/examples/b.md', { title: 'B', reviewLevel: 1, reviewCount: 1, nextReviewAt: '2026-01-10', lastReviewedAt: '2026-01-10' })
    const r = handleStudyReview({ action: 'due', sort: 'priority' }, env(vault))
    if (!r.ok) throw new Error('expected ok')
    const paths = (r.data.due as Array<{ path: string }>).map(i => i.path)
    expect(paths[0]).toBe('math/examples/a.md')
  })

  it('breaks oldest/newest ties on path', () => {
    const vault = mkVault()
    example(vault, 'math/examples/a.md', { title: 'A', reviewCount: 1, nextReviewAt: '2026-01-10', lastReviewedAt: '2026-01-10' })
    example(vault, 'math/examples/b.md', { title: 'B', reviewCount: 1, nextReviewAt: '2026-01-10', lastReviewedAt: '2026-01-10' })
    const oldest = handleStudyReview({ action: 'due', sort: 'oldest' }, env(vault))
    if (!oldest.ok) throw new Error('expected ok')
    expect((oldest.data.due as Array<{ path: string }>)[0]!.path).toBe('math/examples/a.md')
  })

  it('breaks difficulty ties on path', () => {
    const vault = mkVault()
    example(vault, 'math/examples/a.md', { title: 'A', difficulty: 'easy', nextReviewAt: '2026-01-10' })
    example(vault, 'math/examples/b.md', { title: 'B', difficulty: 'easy', nextReviewAt: '2026-01-10' })
    const r = handleStudyReview({ action: 'due', sort: 'difficulty_asc' }, env(vault))
    if (!r.ok) throw new Error('expected ok')
    expect((r.data.due as Array<{ path: string }>)[0]!.path).toBe('math/examples/a.md')
  })

  it('breaks title ties on path', () => {
    const vault = mkVault()
    example(vault, 'math/examples/a.md', { title: 'Same' })
    example(vault, 'math/examples/b.md', { title: 'Same' })
    const r = handleStudyReview({ action: 'due', sort: 'title', review_state: 'all' }, env(vault))
    if (!r.ok) throw new Error('expected ok')
    expect((r.data.due as Array<{ path: string }>)[0]!.path).toBe('math/examples/a.md')
  })

  it('exercises comparator both directions with three examples', () => {
    const vault = mkVault()
    example(vault, 'math/examples/a.md', { title: 'C', reviewLevel: 2, reviewCount: 1, nextReviewAt: '2026-01-10', lastReviewedAt: '2026-01-10', difficulty: 'medium' })
    example(vault, 'math/examples/b.md', { title: 'A', reviewLevel: 0, reviewCount: 1, nextReviewAt: '2026-01-10', lastReviewedAt: '2026-01-08', difficulty: 'easy' })
    example(vault, 'math/examples/c.md', { title: 'B', reviewLevel: 1, reviewCount: 1, nextReviewAt: '2026-01-10', lastReviewedAt: '2026-01-09', difficulty: 'hard' })
    for (const sort of ['priority', 'oldest', 'newest', 'difficulty_asc', 'difficulty_desc', 'title'] as const) {
      const r = handleStudyReview({ action: 'due', sort }, env(vault))
      if (!r.ok) throw new Error('expected ok')
      expect((r.data.due as unknown[]).length).toBe(3)
    }
  })
})

describe('handleStudyReview error paths', () => {
  it('reports RECORD_REVIEW_FAILED and CREATE_REVIEW_TASK_FAILED for a missing vault', () => {
    const vault = mkVault()
    const rec = handleStudyReview({ action: 'record', note: 'x', vault_path: 'definitely-not-a-vault' }, env(vault))
    expect(rec.ok).toBe(false)
    if (!rec.ok) expect(rec.error.code).toBe('RECORD_REVIEW_FAILED')
    const task = handleStudyReview({ action: 'create_task', vault_path: 'definitely-not-a-vault' }, env(vault))
    expect(task.ok).toBe(false)
    if (!task.ok) expect(task.error.code).toBe('CREATE_REVIEW_TASK_FAILED')
  })

  it('reports stats/weekly/anki failures for a missing vault', () => {
    const vault = mkVault()
    for (const action of ['stats', 'weekly_report', 'export_anki'] as const) {
      const r = handleStudyReview({ action, vault_path: 'definitely-not-a-vault' }, env(vault))
      expect(r.ok).toBe(false)
    }
  })

  it('reports NOTE_AMBIGUOUS on submit with shared titles', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1')
    writeNote(vault, 'math/examples/a.md', '---\ntype: example\ntitle: Dup\n---\n# A\n')
    writeNote(vault, 'math/examples/b.md', '---\ntype: example\ntitle: Dup\n---\n# B\n')
    const r = handleStudyReview({ action: 'submit', project_id: 'proj-1', note: 'Dup', result: 'correct', duration_seconds: 1 }, env(vault))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('NOTE_AMBIGUOUS')
  })

  it('rolls back the note when completed-today computation fails on a bad timezone', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1', 'NOT_A_REAL_ZONE')
    example(vault, 'math/examples/a.md', { title: 'A' })
    const original = readFileSync(join(vault, 'math', 'examples', 'a.md'), 'utf8')
    const r = handleStudyReview({ action: 'submit', project_id: 'proj-1', note: 'math/examples/a.md', result: 'correct', duration_seconds: 1, response: 'x', attempt_id: 'att-z' }, env(vault))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('REVIEW_SUBMISSION_FAILED')
    expect(readFileSync(join(vault, 'math', 'examples', 'a.md'), 'utf8')).toBe(original)
  })
})

describe('handleStudyReview export anki limit on errors', () => {
  it('truncates error candidates at the limit', () => {
    const vault = mkVault()
    handleStudyError({ title: 'e1', cause: 'x', occurred_on: '2026-01-10' }, env(vault))
    handleStudyError({ title: 'e2', cause: 'y', occurred_on: '2026-01-11' }, env(vault))
    const r = handleStudyReview({ action: 'export_anki', limit: 1, include_errors: true, start_date: '2026-01-01', end_date: '2026-01-20' }, env(vault))
    if (!r.ok) throw new Error('expected ok')
    expect(r.data.count).toBe(1)
  })

  it('filters notes by tag and layer during export', () => {
    const vault = mkVault()
    writeNote(vault, 'math/examples/a.md', '---\ntype: example\ntags: [watch]\n---\n# A\n')
    writeNote(vault, 'math/examples/b.md', '---\ntype: example\n---\n# B\n')
    const byTag = handleStudyReview({ action: 'export_anki', tag: 'watch' }, env(vault))
    if (!byTag.ok) throw new Error('expected ok')
    expect(byTag.data.count).toBe(1)
    const mismatch = handleStudyReview({ action: 'export_anki', tag: 'watch', layer: 'concept' }, env(vault))
    if (!mismatch.ok) throw new Error('expected ok')
    expect(mismatch.data.count).toBe(0)
  })
})

describe('handleStudyReview submit rollback keeps other attempts', () => {
  it('removes only the rolled-back attempt from a shared jsonl', () => {
    const vault = mkVault()
    writeProject(vault, 'proj-1', 'NOT_A_REAL_ZONE')
    example(vault, 'math/examples/a.md', { title: 'A' })
    mkdirSync(join(vault, '.StudyOS', 'projects', 'proj-1', 'activity'), { recursive: true })
    writeFileSync(join(vault, '.StudyOS', 'projects', 'proj-1', 'activity', 'attempts-2026-01.jsonl'),
      JSON.stringify({ schema_version: 'study_attempt.v1', attempt_id: 'att-preexisting', project_id: 'proj-1', item_id: 'x', occurred_at: '2026-01-15T08:00:00Z', response: 'r', result: 'correct', score: 1 }) + '\n', 'utf8')
    const r = handleStudyReview({ action: 'submit', project_id: 'proj-1', note: 'math/examples/a.md', result: 'correct', duration_seconds: 1, response: 'x', attempt_id: 'att-z' }, env(vault))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('REVIEW_SUBMISSION_FAILED')
    const kept = readFileSync(join(vault, '.StudyOS', 'projects', 'proj-1', 'activity', 'attempts-2026-01.jsonl'), 'utf8')
    expect(kept).toContain('att-preexisting')
    expect(kept).not.toContain('att-z')
  })
})
