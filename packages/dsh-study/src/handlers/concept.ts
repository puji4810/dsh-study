/**
 * StudyOS concept resource handlers: graph, queue, and learning-state update.
 * Mirrors the Python `tools.py` handlers `handle_study_concept_graph`,
 * `handle_study_learning_queue`, and `handle_study_update_concept_state`.
 * @module @puji4810/dsh-study/handlers/concept
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'

import { err, ok, StudyOSError, type StudyEnvelope } from '../errors.ts'
import { resolveNoteRef } from '../notes.ts'
import {
  buildConceptGraph,
  conceptAncestors,
  conceptDescendants,
  conceptLearningState,
  LEARNING_STATES,
  StudyReviewReadModel,
  topologicalOrder,
} from '../reviews.ts'
import type { StudyData, StudyNote } from '../types.ts'
import { stripWikilink } from '../util.ts'
import {
  listMarkdownNotes,
  resolveVaultPath,
  safeRelativePath,
  studyDir,
  upsertFrontmatterField,
} from '../vault.ts'
import type { HandlerEnv } from './dispatch.ts'

/** Cache TTL for the on-disk concept graph, in milliseconds. */
const GRAPH_CACHE_TTL_MS = 60 * 60 * 1000

/** The concept-graph cache file path. */
function graphCachePath(vault: string): string {
  return `${studyDir(vault)}/concept_graph.json`
}

/** Today's ISO date from the injected clock. */
function todayIso(env: HandlerEnv): string {
  return env.now().toISOString().slice(0, 10)
}

/**
 * Build or query the concept dependency graph with a one-hour disk cache.
 * @param args - the payload: optional `concept`, `weak_only`, `rebuild`.
 * @param env - the handler environment.
 * @returns the concept-graph envelope.
 */
export function handleStudyConcept(args: StudyData, env: HandlerEnv): StudyEnvelope {
  const action = String(args.action || 'graph').trim()
  if (action === 'graph') return conceptGraph(args, env)
  if (action === 'queue') return learningQueue(args, env)
  if (action === 'update_state') return updateState(args, env)
  return err('INVALID_ACTION', `Unsupported study_concept action: ${action}`)
}

/** The `graph` action: concept dependency graph, cached for one hour. */
function conceptGraph(args: StudyData, env: HandlerEnv): StudyEnvelope {
  try {
    const vault = resolveVaultPath(args.vault_path, env.vaultPath)
    const rebuild = Boolean(args.rebuild)
    const graph = loadOrBuildGraph(vault, env, rebuild)
    const target = stripWikilink(String(args.concept || '').trim())
    const weakOnly = Boolean(args.weak_only)

    if (target) {
      const ancestors = conceptAncestors(target, graph)
      const descendants = conceptDescendants(target, graph)
      const prereqs = graph.prerequisites[target] ?? []
      const deps = graph.dependents[target] ?? []
      const examples = graph.exercised_by[target] ?? []
      const reviewLevel = graph.review_levels[target]
      const order = topologicalOrder([target], graph)
      const affected: string[] = []
      for (const dependent of deps) affected.push(...graph.exercised_by[dependent]!)
      return ok({
        concept: target,
        direct_prerequisites: prereqs,
        direct_dependents: deps,
        ancestor_chains: ancestors,
        descendant_chains: descendants,
        exercised_in: examples.slice(0, 20),
        affected_examples: [...new Set(affected)].slice(0, 20),
        review_level: reviewLevel,
        note_count: graph.note_count[target] ?? 0,
        recommended_review_order: order,
      })
    }

    const allConcepts = [
      ...new Set([
        ...Object.keys(graph.prerequisites),
        ...Object.keys(graph.dependents),
        ...Object.keys(graph.exercised_by),
      ]),
    ].sort()

    const bottleneck = [...allConcepts]
      .map(concept => ({ concept, dependents: (graph.dependents[concept] ?? []).length }))
      .sort((a, b) => b.dependents - a.dependents)
      .slice(0, 15)

    const isolated = allConcepts.filter(concept =>
      (graph.prerequisites[concept] ?? []).length === 0 && (graph.dependents[concept] ?? []).length === 0)

    const result: Record<string, unknown> = {
      total_concepts: allConcepts.length,
      all_concepts: allConcepts,
      concepts_with_dependencies: Object.keys(graph.prerequisites).length,
      top_bottlenecks: bottleneck.filter(item => item.dependents > 0),
      isolated_concepts: isolated.length,
      isolated_concept_names: isolated,
      review_levels: graph.review_levels,
    }

    if (weakOnly) {
      const weakNames = new Set(recentWeakConcepts(vault, env).map(item => item.concept))
      result.weak_concepts = [...weakNames]
        .filter(concept => allConcepts.includes(concept))
        .map(concept => ({
          concept,
          prerequisites: graph.prerequisites[concept] ?? [],
          dependents: graph.dependents[concept] ?? [],
          review_level: graph.review_levels[concept],
          error_count: recentWeakConcepts(vault, env).find(item => item.concept === concept)!.error_count,
          recommended_review_order: topologicalOrder([concept], graph),
        }))
    }

    return ok(result)
  } catch (error) {
    return err('CONCEPT_GRAPH_FAILED', (error as Error).message)
  }
}

/** Build the concept graph, honouring the one-hour disk cache unless rebuilt. */
function loadOrBuildGraph(vault: string, env: HandlerEnv, rebuild: boolean) {
  const path = graphCachePath(vault)
  if (!rebuild && existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      const builtAt = String(parsed.built_at ?? '')
      const age = env.now().getTime() - new Date(builtAt).getTime()
      const graph = parsed.graph
      if (builtAt && age >= 0 && age <= GRAPH_CACHE_TTL_MS && typeof graph === 'object' && graph !== null) {
        return graph as ReturnType<typeof buildConceptGraph>
      }
    } catch {
      // Fall through to rebuild on any parse failure.
    }
  }
  const graph = buildConceptGraph(listMarkdownNotes(vault))
  writeFileSync(path, `${JSON.stringify({ built_at: env.now().toISOString(), graph })}\n`, 'utf8')
  return graph
}

/** The `queue` action: new concepts and examples via the review read model. */
function learningQueue(args: StudyData, env: HandlerEnv): StudyEnvelope {
  try {
    const vault = resolveVaultPath(args.vault_path, env.vaultPath)
    const model = new StudyReviewReadModel({ notes: () => listMarkdownNotes(vault) })
    const result = model.queue({
      state: String(args.state || ''),
      limit: boundedLimit(args.limit, 30),
    })
    return ok({ ...result, vault_path: vault })
  } catch (error) {
    return err('LEARNING_QUEUE_FAILED', (error as Error).message)
  }
}

/** The `update_state` action: change a concept/pattern note's learning state. */
function updateState(args: StudyData, env: HandlerEnv): StudyEnvelope {
  try {
    const vault = resolveVaultPath(args.vault_path, env.vaultPath)
    const noteRef = String(args.note || '').trim()
    const newState = String(args.learning_state || '').trim()
    if (!(LEARNING_STATES as readonly string[]).includes(newState)) {
      return err('INVALID_STATE', `learning_state must be one of: ${LEARNING_STATES.join(', ')}`)
    }
    const { note, warnings } = readOneNote(vault, noteRef)
    if (note === null) {
      return err('NOTE_NOT_FOUND', `Note not found: ${noteRef}`)
    }
    if (note.layer !== 'concept' && note.layer !== 'pattern') {
      return err('NOT_CONCEPT', 'learning_state only applies to concept/pattern notes')
    }
    const oldState = conceptLearningState(note)
    const path = safeRelativePath(vault, note.path)
    upsertFrontmatterField(path, 'learning_state', newState)
    if (newState === '已掌握') upsertFrontmatterField(path, 'mastered_at', todayIso(env))
    return ok({
      path: note.path,
      title: note.title,
      learning_state: { old: oldState, new: newState },
    }, warnings)
  } catch (error) {
    return err('UPDATE_CONCEPT_STATE_FAILED', (error as Error).message)
  }
}

/** Resolve one note by reference, mapping ambiguity onto a domain error. */
function readOneNote(vault: string, ref: string): { note: StudyNote | null; warnings: string[] } {
  const { note, matches } = resolveNoteRef(listMarkdownNotes(vault), ref)
  if (note === null && matches.length > 0) {
    throw new StudyOSError('NOTE_AMBIGUOUS', `More than one note matched ${JSON.stringify(ref)}`)
  }
  return { note, warnings: [] }
}

/** Concepts with the most recent errors, for the `weak_only` projection. */
function recentWeakConcepts(vault: string, env: HandlerEnv): Array<{ concept: string; error_count: number }> {
  const today = todayIso(env)
  const start = shiftDate(today, -30)
  const counts = new Map<string, number>()
  for (const record of collectErrorRecords(vault, start, today)) {
    const names = record.concepts!
      .replace(/\[\[/g, '').replace(/\]\]/g, '')
      .split(',').map(item => item.trim()).filter(Boolean)
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([concept, error_count]) => ({ concept, error_count }))
    .sort((a, b) => b.error_count - a.error_count)
}

/** Clamp a list limit into `[1, 500]`. */
function boundedLimit(value: unknown, def: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : def
  return Math.max(1, Math.min(numeric, 500))
}

/** Shift a `YYYY-MM-DD` string by whole days. */
function shiftDate(value: string, days: number): string {
  const parsed = new Date(`${value}T00:00:00Z`)
  return new Date(parsed.getTime() + days * 86_400_000).toISOString().slice(0, 10)
}

/** Collect error records in an inclusive date range. */
function collectErrorRecords(vault: string, start: string, end: string): Array<Record<string, string>> {
  const records: Array<Record<string, string>> = []
  const root = `${studyDir(vault)}/errors`
  let files: string[] = []
  try {
    files = readdirSync(root).filter(name => name.endsWith('.md')).sort()
  } catch {
    return []
  }
  for (const name of files) {
    const text = readFileSync(`${root}/${name}`, 'utf8')
    let current: Record<string, string> | null = null
    for (const line of text.split(/\r?\n/)) {
      const heading = /^###\s+(\d{4}-\d{2}-\d{2})\s+(.+)$/.exec(line)
      if (heading) {
        if (current) records.push(current)
        current = { date: heading[1]!, title: heading[2]!.trim() }
        continue
      }
      if (current && line.startsWith('- ') && line.includes(':')) {
        const key = line.slice(2).split(':', 1)[0]!
        current[key.trim().toLowerCase()] = line.slice(2 + key.length + 2).trim()
      }
    }
    if (current) records.push(current)
  }
  return records.filter(record => start <= record.date! && record.date! <= end)
}
