import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { err, ok, toLosslessJson } from '../../src/errors.ts'
import { handleStudyReview } from '../../src/handlers/review.ts'
import { env, exampleNoteBody, tempVault, writeNote } from '../helpers.ts'

const dirs: string[] = []
function mkVault(): string {
  const dir = tempVault()
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const d of dirs.splice(0)) void d })

/** Deep-scan for `undefined` leaves, which the tool layer rejects as lossy. */
function findsUndefined(value: unknown): boolean {
  if (value === undefined) return true
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(findsUndefined)
  return Object.keys(value).some(key => findsUndefined((value as Record<string, unknown>)[key]))
}

/** DSH's own lossless-JSON round-trip predicate (mirrors the tool boundary). */
function roundTripsLosslessly(value: unknown): boolean {
  if (findsUndefined(value)) return false
  try {
    const revived = JSON.parse(JSON.stringify(value))
    return JSON.stringify(revived) === JSON.stringify(value)
  } catch {
    return false
  }
}

describe('lossless envelope boundary (tool-layer round trip)', () => {
  it('normalizes undefined payload fields to null instead of losing them', () => {
    expect(toLosslessJson(undefined)).toBe(null)
    expect(toLosslessJson({ difficulty: undefined, tags: ['a'], n: 1 })).toEqual({
      difficulty: null,
      tags: ['a'],
      n: 1,
    })
    expect(toLosslessJson([undefined, { x: undefined }])).toEqual([null, { x: null }])
  })

  it('accepts every scalar and plain structure a JSON round trip preserves', () => {
    const value = { s: 'text', b: false, n: 0, neg: -3, f: 1.5, nil: null, arr: [1, 'two', null], obj: { deep: [true] } }
    expect(toLosslessJson(value)).toEqual(value)
  })

  it('rejects values a JSON round trip cannot preserve, naming the path', () => {
    expect(() => toLosslessJson(NaN)).toThrow(/not lossless JSON/)
    expect(() => toLosslessJson(Infinity)).toThrow(/not lossless JSON/)
    expect(() => toLosslessJson(-0)).toThrow(/not lossless JSON/)
    expect(() => toLosslessJson(10n)).toThrow(/bigint/)
    expect(() => toLosslessJson(() => 1)).toThrow(/function/)
    expect(() => toLosslessJson(new Date('2026-01-01'))).toThrow(/not a plain object/)
    expect(() => toLosslessJson(new Map())).toThrow(/not a plain object/)
    expect(() => toLosslessJson({ a: { b: NaN } })).toThrow(/\.a\.b/)
    // eslint-disable-next-line no-sparse-arrays
    expect(() => toLosslessJson([1, , 3])).toThrow(/sparse array/)
  })

  it('rejects circular references', () => {
    const value: Record<string, unknown> = { name: 'x' }
    value.self = value
    expect(() => toLosslessJson(value)).toThrow(/circular/)
  })

  it('builds ok/err envelopes that always survive the round trip', () => {
    const item = { path: 'math/examples/a.md', difficulty: undefined, tags: ['a'] }
    expect(roundTripsLosslessly(ok({ item }))).toBe(true)
    expect(roundTripsLosslessly(err('X', 'msg', { note: undefined, list: [1] }))).toBe(true)
  })
})

describe('review.due lossless regression (notes without a difficulty field)', () => {
  it('returns due rows with null difficulty instead of an undefined leak', () => {
    const vault = mkVault()
    // No `difficulty` frontmatter anywhere in the first note.
    writeNote(vault, 'math/examples/a.md', exampleNoteBody({
      title: 'A',
      reviewCount: 1,
      nextReviewAt: '2026-01-01',
      concepts: ['代数'],
    }))
    writeNote(vault, 'math/examples/b.md', exampleNoteBody({ title: 'B', difficulty: 'easy', nextReviewAt: '2025-01-01' }))

    const result = handleStudyReview({ action: 'due', limit: 10 }, env(vault))
    if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`)
    expect(roundTripsLosslessly(result)).toBe(true)

    const rows = result.data.due as Array<Record<string, unknown>>
    const a = rows.find(row => String(row.path).endsWith('a.md'))
    const b = rows.find(row => String(row.path).endsWith('b.md'))
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a?.['difficulty']).toBeNull()
    expect(b?.['difficulty']).toBe('easy')
  })
})