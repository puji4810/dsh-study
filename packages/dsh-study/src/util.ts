/**
 * Small pure helpers shared across StudyOS modules: dedupe, slugify, and sha256 digests.
 * @module @puji4810/dsh-study/util
 */

import { createHash } from 'node:crypto'

/**
 * Deduplicate strings in order, dropping empty values.
 * @param values - the candidate values.
 * @returns unique non-empty strings in first-seen order.
 */
export function unique(values: readonly unknown[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const text = typeof value === 'string' ? value.trim() : ''
    if (text && !seen.has(text)) {
      seen.add(text)
      result.push(text)
    }
  }
  return result
}

/**
 * Slugify a label the way StudyOS names pattern proposals: lowercase alphanumerics
 * joined by `-`, trimmed to 60 characters.
 * @param value - the raw label.
 * @param fallback - used when nothing survives.
 * @returns the slug.
 */
export function slugify(value: unknown, fallback: string): string {
  const slug = (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || fallback
}

/**
 * SHA-256 hex digest of a value serialized with sorted keys — the same canonical
 * digest the original orchestrator uses for intervention and proposal fingerprints.
 * @param value - any JSON-serializable value.
 * @returns 64-character lowercase hex digest.
 */
export function digest(value: unknown): string {
  const payload = JSON.stringify(sortKeys(value))
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

/** Deep-copy then sort object keys recursively for canonical serialization. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) sorted[key] = sortKeys(record[key])
    return sorted
  }
  return value
}

/**
 * Clamp an integer into an inclusive range the way the original `_limit_from` bounds
 * list sizes.
 * @param value - the raw value.
 * @param fallback - used when the value is not a finite number.
 * @param max - inclusive ceiling.
 * @returns the bounded integer, at least 1.
 */
export function boundedLimit(value: unknown, fallback: number, max: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.max(1, Math.min(numeric, max))
}

/**
 * Strip a wikilink decoration the way StudyOS normalizes concepts: `[[a|b]]`, `[[a#h]]`.
 * @param value - the raw concept reference.
 * @returns the bare target name.
 */
export function stripWikilink(value: string): string {
  let text = value.trim()
  if (text.startsWith('[[') && text.endsWith(']]')) text = text.slice(2, -2)
  if (text.includes('|')) text = text.split('|', 1)[0] ?? ''
  if (text.includes('#')) text = text.split('#', 1)[0] ?? ''
  return text.trim()
}

/** The median of a non-empty number list. */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const value = sorted[middle]
  if (value === undefined) return 0
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? value) + value) / 2 : value
}

/**
 * Round to a multiple of a step size.
 * @param value - the raw number.
 * @param step - the grid size.
 * @returns the stepped value.
 */
export function roundToStep(value: number, step: number): number {
  return Math.round(value / step) * step
}
