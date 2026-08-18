/**
 * StudyOS spaced-repetition and concept-graph projections, mirroring the Python
 * plugin's `reviews.py` rule-for-rule so vaults and model-facing values stay
 * identical. Pure module: time injection arrives through parameters.
 * @module @puji4810/dsh-study/reviews
 */

import type { ReviewState, StudyNote } from './types.ts'

/** Ebbinghaus interval ladder in days; index is the current review count. */
export const EBBINGHAUS_BASE: readonly number[] = [1, 2, 4, 7, 15, 30, 60, 120]

/** Review-level multiplier into the Ebbinghaus interval. */
export const REVIEW_LEVEL_WEIGHT: Readonly<Record<number, number>> = {
  0: 0.5,
  1: 0.7,
  2: 1.0,
  3: 1.3,
  4: 1.6,
  5: 2.5,
}

/** Ordered learning-state labels, weakest first. */
export const LEARNING_STATES: readonly string[] = ['未开始', '学习中', '已理解', '已掌握']

/** The minimal note fields the review projections read. */
interface NoteLike {
  path: string
  title: string
  layer?: string
  frontmatter?: Record<string, unknown>
  tags?: string[]
  concepts?: string[]
  patterns?: string[]
}

/** A concept dependency graph over the notes in one vault. */
export interface ConceptGraph {
  prerequisites: Record<string, string[]>
  dependents: Record<string, string[]>
  exercised_by: Record<string, string[]>
  review_levels: Record<string, { min: number; avg: number; max: number; count: number }>
  note_count: Record<string, number>
}

/**
 * Derive the semantic review level from an observed review result.
 * @param currentLevel - the note's current review level.
 * @param result - one of `incorrect`, `partial`, `correct`.
 * @returns the next review level.
 */
export function automaticReviewLevel(currentLevel: number, result: string): number {
  if (result === 'incorrect') return 1
  if (result === 'partial') return 2
  if (result === 'correct') return Math.min(5, Math.max(3, currentLevel + 1))
  throw new Error(`Unsupported review result: ${result}`)
}

/** Parse an ISO date string, returning null when malformed (never throws). */
function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    return null
  }
  return parsed
}

/**
 * Compute the next review count and due date from a review outcome.
 * @param options - review count, semantic level, pass flag, and today's ISO date.
 * @returns the next `{ reviewCount, nextReviewAt }` pair.
 */
export function calculateNextReview(options: {
  reviewCount: number
  reviewLevel: number
  passed: boolean
  today: string
}): { reviewCount: number; nextReviewAt: string } {
  const today = parseIsoDate(options.today)
  const base = today ?? new Date(Date.UTC(2000, 0, 1))
  if (!options.passed) {
    const next = new Date(base.getTime() + 86_400_000)
    return { reviewCount: 0, nextReviewAt: next.toISOString().slice(0, 10) }
  }
  const newCount = Math.min(options.reviewCount + 1, EBBINGHAUS_BASE.length - 1)
  const baseInterval = options.reviewCount < EBBINGHAUS_BASE.length
    ? EBBINGHAUS_BASE[options.reviewCount]!
    : EBBINGHAUS_BASE[EBBINGHAUS_BASE.length - 1]!
  const weight = REVIEW_LEVEL_WEIGHT[options.reviewLevel] ?? 1.0
  const interval = Math.max(1, Math.trunc(baseInterval * weight))
  const next = new Date(base.getTime() + interval * 86_400_000)
  return { reviewCount: newCount, nextReviewAt: next.toISOString().slice(0, 10) }
}

/**
 * Read the spaced-repetition state stored in a note's frontmatter.
 * @param note - a parsed study note.
 * @returns `{ review_count, last_reviewed_at, next_review_at }`.
 */
export function readReviewState(note: NoteLike): ReviewState {
  const frontmatter = (note.frontmatter ?? {})
  const count = frontmatter.review_count
  return {
    review_count: Number.isFinite(Number(count)) ? Math.trunc(Number(count)) : 0,
    last_reviewed_at: String(frontmatter.last_reviewed_at ?? ''),
    next_review_at: String(frontmatter.next_review_at ?? ''),
  }
}

/**
 * Decide whether an example note is due for review on a given day.
 * @param note - a parsed study note.
 * @param today - the ISO date to compare against.
 * @returns true when the note is an example and its next review is not in the future.
 */
export function isDue(note: NoteLike, today: string): boolean {
  if (note.layer !== 'example') return false
  const nextAt = readReviewState(note).next_review_at
  if (!nextAt) return true
  const nextDate = parseIsoDate(nextAt)
  const todayDate = parseIsoDate(today)
  if (nextDate === null || todayDate === null) return true
  return nextDate <= todayDate
}

/**
 * The learning-state label of a concept or pattern note.
 * @param note - a parsed study note.
 * @returns a valid learning state, defaulting to `未开始`.
 */
export function conceptLearningState(note: NoteLike): string {
  const frontmatter = (note.frontmatter ?? {})
  const state = String(frontmatter.learning_state ?? '未开始').trim()
  return (LEARNING_STATES).includes(state) ? state : '未开始'
}

/**
 * Build the concept dependency graph across notes.
 *
 * For concept/pattern notes, every other listed concept is a prerequisite of
 * each concept. `review_level` contributes to per-concept statistics only when
 * it is a finite number.
 * @param notes - the parsed notes to project.
 * @returns the `ConceptGraph`.
 */
export function buildConceptGraph(notes: StudyNote[]): ConceptGraph {
  const prerequisites: Record<string, Set<string>> = {}
  const exercisedBy: Record<string, string[]> = {}
  const reviewByConcept: Record<string, number[]> = {}

  for (const note of notes) {
    const concepts = note.concepts.map(stripWikilink)
    if (concepts.length === 0) continue
    for (const concept of concepts) {
      const bucket = (exercisedBy[concept] ??= [])
      bucket.push(note.path)
      const reviewLevel = note.frontmatter.review_level
      if (typeof reviewLevel === 'number' && Number.isFinite(reviewLevel)) {
        ;(reviewByConcept[concept] ??= []).push(Math.trunc(reviewLevel))
      }
    }
    if (note.layer === 'concept' || note.layer === 'pattern') {
      for (const concept of concepts) {
        const dependencies = concepts.filter(item => item !== concept)
        if (dependencies.length === 0) continue
        const bucket = (prerequisites[concept] ??= new Set())
        for (const dependency of dependencies) bucket.add(dependency)
      }
    }
  }

  const dependents: Record<string, Set<string>> = {}
  for (const [concept, dependencies] of Object.entries(prerequisites)) {
    for (const dependency of dependencies) {
      ;(dependents[dependency] ??= new Set()).add(concept)
    }
  }

  const reviewLevels: ConceptGraph['review_levels'] = {}
  for (const [concept, levels] of Object.entries(reviewByConcept)) {
    reviewLevels[concept] = {
      min: Math.min(...levels),
      avg: Math.round((levels.reduce((a, b) => a + b, 0) / levels.length) * 10) / 10,
      max: Math.max(...levels),
      count: levels.length,
    }
  }

  const noteCount: Record<string, number> = {}
  for (const [concept, paths] of Object.entries(exercisedBy)) {
    noteCount[concept] = paths.length
  }

  return {
    prerequisites: sortRecord(prerequisites),
    dependents: sortRecord(dependents),
    exercised_by: exercisedBy,
    review_levels: reviewLevels,
    note_count: noteCount,
  }
}

/** Sort each set-valued map into a sorted string array. */
function sortRecord(record: Record<string, Set<string>>): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  for (const [key, values] of Object.entries(record)) {
    result[key] = [...values].sort()
  }
  return result
}

/**
 * Compute every prerequisite chain rooted at a concept, with cycle markers.
 * @param concept - the starting concept.
 * @param graph - the concept graph.
 * @param maxDepth - chain depth limit (default 5).
 * @returns a list of ancestor chains, each beginning with `concept`.
 */
export function conceptAncestors(concept: string, graph: ConceptGraph, maxDepth = 5): string[][] {
  const prerequisites = graph.prerequisites
  const chains: string[][] = []

  const walk = (current: string, path: string[], depth: number): void => {
    if (depth > maxDepth) return
    const dependencies = prerequisites[current] ?? []
    if (dependencies.length === 0) {
      chains.push([...path, current])
      return
    }
    for (const dependency of dependencies) {
      if (path.includes(dependency)) {
        chains.push([...path, current, `(cycle→${dependency})`])
      } else {
        walk(dependency, [...path, current], depth + 1)
      }
    }
  }

  walk(concept, [], 0)
  return chains
}

/**
 * Compute every dependent chain rooted at a concept, with cycle markers.
 * @param concept - the starting concept.
 * @param graph - the concept graph.
 * @param maxDepth - chain depth limit (default 5).
 * @returns a list of descendant chains, each beginning with `concept`.
 */
export function conceptDescendants(concept: string, graph: ConceptGraph, maxDepth = 5): string[][] {
  const dependents = graph.dependents
  const chains: string[][] = []

  const walk = (current: string, path: string[], depth: number): void => {
    if (depth > maxDepth) return
    const children = dependents[current] ?? []
    if (children.length === 0) {
      chains.push([...path, current])
      return
    }
    for (const child of children) {
      if (path.includes(child)) {
        chains.push([...path, current, `(cycle→${child})`])
      } else {
        walk(child, [...path, current], depth + 1)
      }
    }
  }

  walk(concept, [], 0)
  return chains
}

/**
 * Gate topological sort of the concepts reachable from the given roots.
 * @param concepts - the root concepts to close under prerequisites.
 * @param graph - the concept graph.
 * @returns a topologically ordered list of reachable concept names.
 */
export function topologicalOrder(concepts: string[], graph: ConceptGraph): string[] {
  const prerequisites = graph.prerequisites
  const relevant = new Set<string>()

  const collect = (concept: string): void => {
    if (relevant.has(concept)) return
    relevant.add(concept)
    for (const dependency of prerequisites[concept] ?? []) collect(dependency)
  }

  for (const concept of concepts) collect(concept)

  const inDegree: Record<string, number> = {}
  const adjacent: Record<string, string[]> = {}
  for (const concept of relevant) {
    inDegree[concept] = 0
    adjacent[concept] = []
  }
  for (const concept of relevant) {
    for (const dependency of prerequisites[concept] ?? []) {
      if (relevant.has(dependency) && concept !== dependency) {
        adjacent[dependency]!.push(concept)
        inDegree[concept] = inDegree[concept]! + 1
      }
    }
  }

  const queue = [...relevant].filter(concept => inDegree[concept] === 0)
  const order: string[] = []
  while (queue.length > 0) {
    const node = queue.shift()!
    order.push(node)
    for (const child of adjacent[node]!) {
      inDegree[child] = inDegree[child]! - 1
      if (inDegree[child] === 0) queue.push(child)
    }
  }
  return order
}

/**
 * Build the spacing-coverage statistics across example notes.
 * @param notes - the parsed notes to aggregate.
 * @param options - `today` (ISO date) and `builtAtIso` (timestamp to embed).
 * @returns the `spacing_coverage.v1` statistics record.
 */
export function buildReviewStats(
  notes: StudyNote[],
  options: { today: string; builtAtIso: string },
): Record<string, unknown> {
  const today = parseIsoDate(options.today) ?? new Date(Date.UTC(2000, 0, 1))
  const todayKey = options.today.slice(0, 10)
  let total = 0
  const byLevel = new Map<number, number>()
  const conceptLevels: Record<string, number[]> = {}
  const conceptDue: Record<string, number> = {}
  const lastReviewed: Date[] = []
  let reviewedCount = 0
  let dueCount = 0

  for (const note of notes) {
    if (note.layer !== 'example') continue
    total += 1
    const frontmatter = note.frontmatter
    const levelRaw = frontmatter.review_level
    const level = Number.isFinite(Number(levelRaw)) ? Math.trunc(Number(levelRaw)) : 0
    byLevel.set(level, (byLevel.get(level) ?? 0) + 1)
    const reviewCountRaw = frontmatter.review_count
    if ((Number.isFinite(Number(reviewCountRaw)) ? Math.trunc(Number(reviewCountRaw)) : 0) > 0) {
      reviewedCount += 1
    }
    const lastReviewedAt = frontmatter.last_reviewed_at
    if (lastReviewedAt) {
      const parsed = parseIsoDate(String(lastReviewedAt))
      if (parsed !== null) lastReviewed.push(parsed)
    }
    for (const conceptRaw of note.concepts) {
      const name = stripWikilink(conceptRaw)
      ;(conceptLevels[name] ??= []).push(level)
    }
    if (isDue(note, todayKey)) {
      dueCount += 1
      for (const conceptRaw of note.concepts) {
        const name = stripWikilink(conceptRaw)
        conceptDue[name] = (conceptDue[name] ?? 0) + 1
      }
    }
  }

  const coverage = total > 0 ? Math.round((reviewedCount / total) * 1000) / 10 : 0.0
  const conceptStats: Record<string, Record<string, number>> = {}
  for (const [concept, levels] of Object.entries(conceptLevels)) {
    conceptStats[concept] = {
      avg: Math.round((levels.reduce((a, b) => a + b, 0) / levels.length) * 10) / 10,
      min: Math.min(...levels),
      max: Math.max(...levels),
      count: levels.length,
      due: conceptDue[concept] ?? 0,
    }
  }

  const byReviewLevel: Record<string, number> = {}
  for (const [level, count] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) {
    byReviewLevel[String(level)] = count
  }

  const streak = computeStreak(lastReviewed, today)

  return {
    semantics: 'spacing_coverage.v1',
    built_at: options.builtAtIso,
    total_examples: total,
    by_review_level: byReviewLevel,
    reviewed_examples: reviewedCount,
    spacing_coverage_pct: coverage,
    progress_pct: coverage,
    due_today: dueCount,
    review_streak_days: streak,
    concepts: conceptStats,
  }
}

/** Compute the longest unbroken streak of review days ending at or before today. */
function computeStreak(lastReviewedDates: Date[], today: Date): number {
  if (lastReviewedDates.length === 0) return 0
  let streak = 0
  let check = today
  const uniqueDays = [...new Set(lastReviewedDates.map(date => date.getTime()))]
    .map(time => new Date(time))
    .sort((a, b) => b.getTime() - a.getTime())
  for (const reviewedOn of uniqueDays) {
    const dayBefore = new Date(check.getTime() - 86_400_000)
    if (reviewedOn.getTime() === check.getTime() || reviewedOn.getTime() === dayBefore.getTime()) {
      if (reviewedOn.getTime() === dayBefore.getTime()) check = reviewedOn
      streak += 1
    } else if (reviewedOn.getTime() < dayBefore.getTime()) {
      break
    }
  }
  return streak
}

/** Sort key set used by the `due` view. */
interface DueEntry {
  reviewLevel: number
  lastReviewedAt: string
  path: string
}

/**
 * A read model over the review views for one vault, recomputed from a note
 * supplier on every call (no disk cache; callers own persistence).
 */
export class StudyReviewReadModel {
  private readonly noteSupplier: () => StudyNote[]

  /**
   * @param options - `notes` supplies the current parsed notes.
   */
  constructor(options: { notes: () => StudyNote[] }) {
    this.noteSupplier = options.notes
  }

  private get notes(): StudyNote[] {
    return this.noteSupplier()
  }

  /**
   * List example notes due for review.
   * @param options - `asOf` date, optional subject/tag/concept filter, level filter, and limit.
   * @returns the due view.
   */
  due(options: {
    asOf?: string
    subject?: string
    level?: number | null
    limit?: number
  } = {}): Record<string, unknown> {
    const asOf = options.asOf ?? ''
    const today = asOf || todayIsoKey()
    const boundedLimit = Math.max(1, Math.min(Math.trunc(options.limit ?? 20), 500))
    const subjectQuery = (options.subject ?? '').trim().toLowerCase()
    const dueEntries: DueEntry[] = []
    const duePayload: Array<Record<string, unknown>> = []
    const subjects = new Set<string>()

    for (const note of this.notes) {
      if (note.layer !== 'example' || !isDue(note, today)) continue
      const noteSubject = noteSubjectOf(note)
      if (noteSubject) subjects.add(noteSubject)
      if (subjectQuery) {
        const tags = new Set(note.tags.map(tag => String(tag).replace(/^#/, '').toLowerCase()))
        const concepts = note.concepts.map(concept => String(concept).toLowerCase())
        const matched = subjectQuery === (noteSubject ?? '').toLowerCase()
          || tags.has(subjectQuery)
          || concepts.some(concept => concept.includes(subjectQuery))
        if (!matched) continue
      }
      const frontmatter = note.frontmatter
      const levelRaw = frontmatter.review_level
      const reviewLevel = Number.isFinite(Number(levelRaw)) ? Math.trunc(Number(levelRaw)) : 0
      if (options.level !== null && options.level !== undefined && reviewLevel !== Math.trunc(options.level)) {
        continue
      }
      const state = readReviewState(note)
      const entry: Record<string, unknown> = {
        path: note.path,
        title: note.title,
        review_level: reviewLevel,
        review_count: state.review_count,
        last_reviewed_at: state.last_reviewed_at || null,
        next_review_at: state.next_review_at || null,
        concepts: note.concepts,
        tags: note.tags,
        difficulty: frontmatter.difficulty ?? null,
        subject: noteSubject,
      }
      dueEntries.push({ reviewLevel, lastReviewedAt: state.last_reviewed_at || '0000-00-00', path: note.path })
      duePayload.push(entry)
    }

    const byIndex: Array<{ entry: DueEntry; payload: Record<string, unknown> }> = []
    for (let index = 0; index < dueEntries.length; index += 1) {
      byIndex.push({ entry: dueEntries[index]!, payload: duePayload[index]! })
    }

    byIndex.sort((a, b) => {
      if (a.entry.reviewLevel !== b.entry.reviewLevel) return a.entry.reviewLevel - b.entry.reviewLevel
      if (a.entry.lastReviewedAt !== b.entry.lastReviewedAt) {
        return a.entry.lastReviewedAt < b.entry.lastReviewedAt ? -1 : 1
      }
      return a.entry.path < b.entry.path ? -1 : 1
    })

    const selected = byIndex.slice(0, boundedLimit).map(item => item.payload)
    return {
      vault_path: '',
      date: today,
      count: selected.length,
      subjects: [...subjects].sort(),
      due: selected,
    }
  }

  /**
   * Render the spacing statistics into the model-facing `stats` view.
   * @returns the stats view.
   */
  stats(): Record<string, unknown> {
    const stats = buildReviewStats(this.notes, { today: todayIsoKey(), builtAtIso: builtNowIso() })
    const byLevel: Record<number, number> = {}
    for (const [key, value] of Object.entries(stats.by_review_level as Record<string, unknown>)) {
      byLevel[Number(key)] = value as number
    }
    return {
      vault_path: '',
      total: stats.total_examples,
      by_level: byLevel,
      spacing_coverage: stats.spacing_coverage_pct,
      reviewed_count: stats.reviewed_examples,
      progress: stats.progress_pct,
      concept_stats: stats.concepts,
      review_streak: stats.review_streak_days,
      due_count: stats.due_today,
      cached: false,
    }
  }

  /**
   * List learnable concepts and new examples.
   * @param options - optional learning-state filter and limit.
   * @returns the queue view.
   */
  queue(options: { state?: string; limit?: number } = {}): Record<string, unknown> {
    const graph = buildConceptGraph(this.notes)
    const stateFilter = (options.state ?? '').trim()
    const boundedLimit = Math.max(1, Math.min(Math.trunc(options.limit ?? 30), 500))
    const newConcepts: Array<Record<string, unknown>> = []
    const newExamples: Array<Record<string, unknown>> = []

    for (const note of this.notes) {
      const layer = note.layer
      const frontmatter = note.frontmatter
      if (layer === 'concept' || layer === 'pattern') {
        const learningState = conceptLearningState(note)
        if ((stateFilter && learningState !== stateFilter) || learningState === '已掌握') continue
        newConcepts.push({
          path: note.path,
          title: note.title,
          learning_state: learningState,
          prerequisites: graph.prerequisites[stripWikilink(note.title)] ?? [],
          tags: note.tags,
        })
      } else if (layer === 'example') {
        const reviewCountRaw = frontmatter.review_count
        const reviewCount = Number.isFinite(Number(reviewCountRaw)) ? Math.trunc(Number(reviewCountRaw)) : 0
        if (reviewCount > 0) continue
        const levelRaw = frontmatter.review_level
        const reviewLevel = Number.isFinite(Number(levelRaw)) ? Math.trunc(Number(levelRaw)) : 0
        if (stateFilter) {
          if (stateFilter === '学习中' && reviewLevel !== 0) continue
          if (stateFilter === '已理解' && reviewLevel === 0) continue
        }
        newExamples.push({
          path: note.path,
          title: note.title,
          review_level: reviewLevel,
          difficulty: frontmatter.difficulty ?? null,
          concepts: note.concepts,
          tags: note.tags,
          source: frontmatter.source ?? null,
        })
      }
    }

    newExamples.sort((a, b) => {
      const aDifficulty = { easy: 1, medium: 2, hard: 3 }[String(a.difficulty ?? '').toLowerCase()] ?? 2
      const bDifficulty = { easy: 1, medium: 2, hard: 3 }[String(b.difficulty ?? '').toLowerCase()] ?? 2
      if (aDifficulty !== bDifficulty) return aDifficulty - bDifficulty
      return String(a.title) < String(b.title) ? -1 : 1
    })

    newConcepts.sort((a, b) => {
      const aChain = maxChainLength(conceptAncestors(String(a.title), graph))
      const bChain = maxChainLength(conceptAncestors(String(b.title), graph))
      if (aChain !== bChain) return aChain - bChain
      return String(a.title) < String(b.title) ? -1 : 1
    })

    return {
      vault_path: '',
      new_concepts: newConcepts.slice(0, boundedLimit),
      new_concepts_total: newConcepts.length,
      new_examples: newExamples.slice(0, boundedLimit),
      new_examples_total: newExamples.length,
    }
  }

  /**
   * Aggregate concept names with their learning state and review averages.
   * @returns the concepts view.
   */
  concepts(): Record<string, unknown> {
    const graph = buildConceptGraph(this.notes)
    const names = [
      ...new Set([
        ...Object.keys(graph.prerequisites),
        ...Object.keys(graph.dependents),
        ...Object.keys(graph.exercised_by),
      ]),
    ].sort()

    const states: Record<string, string> = {}
    for (const note of this.notes) {
      if (note.layer === 'concept' || note.layer === 'pattern') {
        states[String(note.title)] = conceptLearningState(note)
      }
    }

    const concepts = names.map((name) => {
      const reviewInfo: { min?: number; avg?: number; max?: number; count?: number } = graph.review_levels[name] ?? {}
      return {
        title: name,
        learning_state: states[name] ?? '未开始',
        prerequisites: graph.prerequisites[name] ?? [],
        example_count: graph.note_count[name]!,
        avg_level: reviewInfo.avg,
      }
    })

    return { vault_path: '', concepts }
  }
}

/** Strip wikilink decoration to the bare concept name. */
function stripWikilink(value: string): string {
  let text = value.trim()
  if (text.startsWith('[[') && text.endsWith(']]')) text = text.slice(2, -2)
  if (text.includes('|')) text = text.split('|', 1)[0]!
  if (text.includes('#')) text = text.split('#', 1)[0]!
  return text.trim()
}

/** The top-level subject folder of a note's path, when present. */
function noteSubjectOf(note: NoteLike): string | null {
  const parts = String(note.path).split('/')
  if (parts.length < 2 || parts[0]!.startsWith('.')) return null
  return parts[0]!
}

/** Today's date key in ISO form (derived from system clock for defaults only). */
function todayIsoKey(): string {
  return new Date().toISOString().slice(0, 10)
}

/** A current UTC timestamp in ISO seconds for default `built_at`. */
function builtNowIso(): string {
  return new Date(Math.floor(Date.now() / 1000) * 1000).toISOString()
}

/** Length of the longest chain in a list of chains. */
function maxChainLength(chains: string[][]): number {
  let max = 0
  for (const chain of chains) if (chain.length > max) max = chain.length
  return max
}
