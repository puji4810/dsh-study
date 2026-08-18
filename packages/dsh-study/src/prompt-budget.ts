/**
 * Pure prompt-budget arithmetic for StudyOS fragments: CJK-aware token
 * estimation, boundary-preferring truncation, and the priority degrade ladder.
 * No I/O, no state, no dependencies. Mirrors the original
 * prompt-budget module bit-for-bit.
 * @module @puji4810/dsh-study/prompt-budget
 */

import type { StudyData } from './types.ts'

/** Region markers that bound a prompt-visible fragment. */
export const FRAGMENT_BEGIN_MARKER = '<!-- prompt-context:begin -->'
export const FRAGMENT_END_MARKER = '<!-- prompt-context:end -->'
export const FRAGMENT_JOINER = '\n\n'
export const ELLIPSIS = '…'
export const MIN_BOUNDARY_RETENTION_RATIO = 0.6
export const MIN_VIABLE_TOKENS = 2

/** Boundary patterns preferred, in order, when choosing a truncation cut. */
export const SECTION_PATTERNS = ['\n## ', '\n### ']
export const PARAGRAPH_PATTERN = '\n\n'
export const LINE_PATTERN = '\n'

/** The four reserve kinds, in priority order. */
export const RESERVE_KINDS = ['base', 'intent', 'domain', 'project_summary'] as const

/** Closed Unicode ranges counted at one token each. */
export const CJK_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x11ff], // Hangul Jamo
  [0x3000, 0x303f], // CJK Symbols and Punctuation
  [0x3040, 0x309f], // Hiragana
  [0x30a0, 0x30ff], // Katakana
  [0x3130, 0x318f], // Hangul Compatibility Jamo
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xac00, 0xd7af], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xff00, 0xffef], // Halfwidth and Fullwidth Forms
]

/** One budget allocation request, in priority order (highest first). */
export interface AllocateRequest {
  kind: string
  size: number
  reserve: number
}

/**
 * Whether a codepoint is CJK (counted at one token by the estimator).
 * @param codepoint - the Unicode codepoint.
 * @returns true when in one of {@link CJK_RANGES}.
 */
export function isCjk(codepoint: number): boolean {
  for (const [low, high] of CJK_RANGES) {
    if (codepoint >= low && codepoint <= high) return true
  }
  return false
}

/**
 * Estimate the token cost of text: CJK at one token each, the rest `ceil(n/4)`.
 * @param text - the text to measure.
 * @returns the estimated token count.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjkCount = 0
  for (const char of text) {
    if (isCjk(char.codePointAt(0) ?? 0)) cjkCount += 1
  }
  const otherCount = text.length - cjkCount
  return cjkCount + ((otherCount + 3) >> 2)
}

/** Running CJK count per prefix: `counts[i]` is the CJK count in `text[:i]`. */
function cjkPrefixCounts(text: string): number[] {
  const counts = new Array<number>(text.length + 1).fill(0)
  let running = 0
  for (let index = 0; index < text.length; index += 1) {
    if (isCjk(text.charCodeAt(index))) running += 1
    counts[index + 1] = running
  }
  return counts
}

/** O(1) token estimate of the prefix `text[:index]` from precomputed counts. */
function estimatePrefix(counts: number[], index: number): number {
  const cjkCount = counts[index] ?? 0
  return cjkCount + ((index - cjkCount + 3) >> 2)
}

/** Choose a preferred boundary cut at or below `hard`, honoring the floor. */
function boundaryCut(text: string, hard: number): number {
  const floorIndex = Math.trunc(hard * MIN_BOUNDARY_RETENTION_RATIO)
  const patternGroups: string[][] = [SECTION_PATTERNS, [PARAGRAPH_PATTERN], [LINE_PATTERN]]
  for (const patterns of patternGroups) {
    let candidate = -1
    for (const pattern of patterns) {
      const found = text.lastIndexOf(pattern, hard - 1)
      if (found > candidate) candidate = found
    }
    if (candidate > 0 && candidate >= floorIndex) return candidate
  }
  return hard
}

/** Append the ellipsis to a truncated body. */
function finishTruncation(text: string, cut: number): { text: string; truncated: boolean } {
  const body = text.slice(0, cut).replace(/\s+$/, '')
  if (!body) return { text: '', truncated: true }
  return { text: body + ELLIPSIS, truncated: true }
}

/**
 * Truncate text to a token budget, reserving one token for the ellipsis.
 * @param text - the text to truncate.
 * @param maxTokens - the upper token bound.
 * @returns the truncated text (byte-identical when it already fits) and a flag.
 */
export function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (maxTokens <= 0) return { text: '', truncated: text !== '' }
  if (estimateTokens(text) <= maxTokens) return { text, truncated: false }
  const bodyBudget = maxTokens - estimateTokens(ELLIPSIS)
  const counts = cjkPrefixCounts(text)
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2)
    if (estimatePrefix(counts, mid) <= bodyBudget) {
      low = mid
    } else {
      high = mid - 1
    }
  }
  return finishTruncation(text, boundaryCut(text, low))
}

/**
 * Truncate text to a character budget, reserving one character for the ellipsis.
 * @param text - the text to truncate.
 * @param maxChars - the upper character bound.
 * @returns the truncated text and a flag.
 */
export function truncateToChars(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (maxChars <= 0) return { text: '', truncated: text !== '' }
  if (text.length <= maxChars) return { text, truncated: false }
  return finishTruncation(text, boundaryCut(text, maxChars - 1))
}

/**
 * Convert a legacy `*_max_chars` cap into a token reserve: `ceil(chars / 4)`.
 * @param maxChars - the character cap.
 * @returns the token reserve.
 */
export function charsToReserveTokens(maxChars: number): number {
  return (Math.max(0, Math.trunc(maxChars)) + 3) >> 2
}

/**
 * Resolve the four per-kind token reserves from a merged policy record.
 * @param policy - a merged prompt policy; `{kind}_reserve_tokens` wins, else `{kind}_max_chars`.
 * @returns a reserve for each kind in {@link RESERVE_KINDS}.
 */
export function resolveReserves(policy: StudyData): Record<string, number> {
  const reserves: Record<string, number> = {}
  for (const kind of RESERVE_KINDS) {
    const override = policy[`${kind}_reserve_tokens`]
    if (override !== null && override !== undefined) {
      reserves[kind] = Math.max(0, Number.isFinite(Number(override)) ? Math.trunc(Number(override)) : 0)
      continue
    }
    const chars = policy[`${kind}_max_chars`]
    reserves[kind] = charsToReserveTokens(Number.isFinite(Number(chars)) ? Number(chars) : 0)
  }
  return reserves
}

/**
 * Extract the prompt-visible fragment between the begin/end markers.
 * @param text - the source document.
 * @param source - a label used in warnings.
 * @returns the joined fragment and an optional unterminated-marker warning.
 */
export function extractPromptFragment(text: string, source: string): { content: string; warning: string | null } {
  if (!text.includes(FRAGMENT_BEGIN_MARKER)) return { content: text, warning: null }
  const regions: string[] = []
  let warning: string | null = null
  let cursor = 0
  while (true) {
    const begin = text.indexOf(FRAGMENT_BEGIN_MARKER, cursor)
    if (begin < 0) break
    const start = begin + FRAGMENT_BEGIN_MARKER.length
    const end = text.indexOf(FRAGMENT_END_MARKER, start)
    if (end < 0) {
      regions.push(text.slice(start))
      const label = source || 'prompt source'
      warning = `${label} has an unterminated ${FRAGMENT_BEGIN_MARKER} marker; used the remainder of the document`
      break
    }
    regions.push(text.slice(start, end))
    cursor = end + FRAGMENT_END_MARKER.length
  }
  const fragment = regions
    .map(region => region.trim())
    .filter(region => region !== '')
    .join(FRAGMENT_JOINER)
  return { content: fragment.trim(), warning }
}

/** Seed and proportionally split a small pool among protected kinds. */
function shortfallSplit(
  pool: number,
  kinds: string[],
  floors: Record<string, number>,
  measure: ((kind: string, grant: number) => number) | undefined,
): Record<string, number> {
  const result: Record<string, number> = {}
  for (const kind of kinds) result[kind] = 0
  if (pool <= 0 || kinds.length === 0) return result
  if (pool >= MIN_VIABLE_TOKENS * kinds.length) {
    for (const kind of kinds) {
      result[kind] = Math.min(floors[kind] ?? 0, MIN_VIABLE_TOKENS)
    }
  }
  const remaining = pool - Object.values(result).reduce((a, b) => a + b, 0)
  const total = kinds.reduce((sum, kind) => sum + (floors[kind] ?? 0), 0)
  if (remaining > 0 && total > 0) {
    let leftover = remaining
    for (const kind of kinds) {
      const share = Math.min(Math.trunc(remaining * (floors[kind] ?? 0) / total), (floors[kind] ?? 0) - (result[kind] ?? 0), leftover)
      result[kind] = (result[kind] ?? 0) + share
      leftover -= share
    }
    for (const kind of kinds) {
      if (leftover <= 0) break
      if ((result[kind] ?? 0) < (floors[kind] ?? 0)) {
        result[kind] = (result[kind] ?? 0) + 1
        leftover -= 1
      }
    }
  }
  if (measure === undefined) return result
  let slack = 0
  for (const kind of kinds) {
    if ((result[kind] ?? 0) <= 0) continue
    const bonus = Math.min(slack, (floors[kind] ?? 0) - (result[kind] ?? 0))
    result[kind] = (result[kind] ?? 0) + bonus
    slack -= bonus
    const grant = result[kind] ?? 0
    slack += grant - Math.min(grant, Math.max(0, Math.trunc(measure(kind, grant))))
  }
  return result
}

/**
 * Split a token pool across priority-ordered fragment requests.
 *
 * Requests must already be in priority order (highest first). `protected`
 * kinds reserve their floor from higher-priority kinds and are never dropped;
 * `drop_below_reserve` kinds are dropped when they cannot reach their floor.
 * Once any kind is dropped, every lower-priority kind is dropped too. The
 * optional `measure` hook reports a grant's real consumption and passes slack
 * downward without resurrecting dropped kinds.
 * @param pool - the total token pool.
 * @param requests - the priority-ordered requests.
 * @param options - `protected` and `drop_below_reserve` kind sets plus `measure`.
 * @returns per-kind grant; a dropped kind is 0.
 */
export function allocate(
  pool: number,
  requests: AllocateRequest[],
  options: {
    protected: readonly string[]
    dropBelowReserve: readonly string[]
    measure?: (kind: string, grant: number) => number
  },
): Record<string, number> {
  const allocations: Record<string, number> = {}
  const order: Array<{ kind: string; wanted: number; reserve: number }> = []
  for (const request of requests) {
    const kind = request.kind
    if (allocations[kind] !== undefined) {
      throw new Error(`duplicate prompt fragment kind: ${kind}`)
    }
    allocations[kind] = 0
    order.push({
      kind,
      wanted: Math.max(0, Math.trunc(request.size)),
      reserve: Math.max(0, Math.trunc(request.reserve)),
    })
  }
  const poolValue = Math.max(0, pool)
  const floors: Record<string, number> = {}
  for (const { kind, wanted, reserve } of order) floors[kind] = Math.min(wanted, reserve)
  const protectedKinds = new Set(options.protected)
  const atomicKinds = new Set(options.dropBelowReserve)
  const measure = options.measure

  // Suffix sums of protected floors: what must stay unspent at each index.
  const reserved = new Array<number>(order.length + 1).fill(0)
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const kind = order[index]?.kind
    reserved[index] = (reserved[index + 1] ?? 0) + (kind !== undefined && protectedKinds.has(kind) ? (floors[kind] ?? 0) : 0)
  }

  if (poolValue < (reserved[0] ?? 0)) {
    const protectedOrder = order.filter(({ kind }) => protectedKinds.has(kind)).map(({ kind }) => kind)
    Object.assign(allocations, shortfallSplit(poolValue, protectedOrder, floors, measure))
    return allocations
  }

  let remaining = poolValue
  let reclaimed = 0
  for (let index = 0; index < order.length; index += 1) {
    const entry = order[index]
    if (entry === undefined) continue
    const { kind, wanted } = entry
    if (wanted <= 0) continue
    const threshold = (protectedKinds.has(kind) || atomicKinds.has(kind))
      ? (floors[kind] ?? 0)
      : Math.min(wanted, MIN_VIABLE_TOKENS)
    const available = remaining - (reserved[index + 1] ?? 0)
    if (available < threshold) break
    let grant = Math.min(wanted, available)
    remaining -= grant
    const bonus = Math.min(reclaimed, wanted - grant)
    grant += bonus
    reclaimed -= bonus
    allocations[kind] = grant
    if (measure !== undefined) {
      reclaimed += grant - Math.min(grant, Math.max(0, Math.trunc(measure(kind, grant))))
    }
  }
  return allocations
}
