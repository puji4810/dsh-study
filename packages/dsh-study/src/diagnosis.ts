/**
 * Evidence diagnosis: turn a set of immutable attempts into a revisable competency
 * projection, then derive recommendations, pattern proposals, and a probe blueprint.
 * Every computation mirrors the Python `learning.py` functions verbatim so vaults
 * and model-facing values stay compatible.
 * @module @puji4810/dsh-study/diagnosis
 */

import { EVIDENCE_DIMENSIONS, PATTERN_PROPOSAL_SCHEMA_VERSION } from './constants.ts'
import { slugify } from './util.ts'
import type {
  Diagnosis,
  DiagnosisCluster,
  DimensionProjection,
  PatternProposal,
  Recommendation,
  StudyAttempt,
} from './types.ts'

/**
 * One unaided success is a fluke; a dimension is independent only after it has been
 * demonstrated more than once AND the latest evidence still shows it.
 */
export const MIN_INDEPENDENT_ATTEMPTS = 2

/** Numeric score of an attempt, 0.0 when absent or non-numeric. */
function attemptScore(attempt: StudyAttempt): number {
  const score = attempt.score
  return typeof score === 'number' ? score : 0.0
}

/** Assistance level provenance, `unrecorded` when absent. */
function assistanceLevel(attempt: StudyAttempt): string {
  const assistance = attempt.assistance
  return assistance !== undefined ? assistance.level : 'unrecorded'
}

/** Evaluator kind provenance, `unprovenanced` when absent. */
function evaluatorKind(attempt: StudyAttempt): string {
  const evaluator = attempt.evaluator
  return evaluator !== undefined ? evaluator.kind : 'unprovenanced'
}

/**
 * Whether a single attempt is independently verified: a credible evaluator, a score
 * of at least 0.8, independent assistance, and a confidence of at least 0.5 (when set).
 * @param attempt - the attempt to judge.
 * @returns true when the attempt independently demonstrates a dimension.
 */
export function independentlyVerified(attempt: StudyAttempt): boolean {
  const evaluator = attempt.evaluator
  if (evaluator === undefined || !['agent', 'program', 'human'].includes(evaluator.kind)) {
    return false
  }
  const confidence = evaluator.confidence
  const evaluatorIsCredible =
    confidence === undefined
    || (typeof confidence === 'number' && !Number.isNaN(confidence) && confidence >= 0.5)
  return attemptScore(attempt) >= 0.8 && assistanceLevel(attempt) === 'independent' && evaluatorIsCredible
}

/** The latest attempt by its own timestamp, then attempt id — never list order. */
function latestAttempt(items: StudyAttempt[]): StudyAttempt {
  return items.reduce((latest, item) => {
    const latestKey = `${latest.occurred_at}\u0000${latest.attempt_id}`
    const itemKey = `${item.occurred_at}\u0000${item.attempt_id}`
    return itemKey > latestKey ? item : latest
  })
}

/** Sort ascending by occurrence timestamp, then attempt id, for the score-delta halves. */
function sortByTime(items: StudyAttempt[]): StudyAttempt[] {
  return [...items].sort((a, b) => {
    const aKey = `${a.occurred_at}\u0000${a.attempt_id}`
    const bKey = `${b.occurred_at}\u0000${b.attempt_id}`
    if (aKey < bKey) return -1
    if (aKey > bKey) return 1
    return 0
  })
}

/** Round to three decimal places the way Python's `round(value, 3)` behaves. */
function round3(value: number): number {
  return Number(value.toFixed(3))
}

/** Ascending string comparison; callers pass unique keys, so the tie is unreachable. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1
  /* v8 ignore next -- provenance keys (assistance levels, evaluator kinds) are unique per dimension */
  return a > b ? 1 : 0
}

/**
 * Derive the competency diagnosis from a set of attempts.
 * @param attempts - the immutable attempts (any order).
 * @returns the diagnosis, with concepts sorted by `(average asc, -count, concept)`
 *   and clusters by `(-count, concept, kind)`.
 */
export function diagnoseAttempts(attempts: StudyAttempt[]): Diagnosis {
  const diagnosisGroups = new Map<string, string[]>()
  const conceptAttempts = new Map<string, StudyAttempt[]>()
  const transfer = new Map<string, number>()
  const dimensionAttempts = new Map<string, StudyAttempt[]>()
  for (const attempt of attempts) {
    const attemptId = attempt.attempt_id
    if (attempt.transfer_level) {
      const dimension = attempt.transfer_level
      transfer.set(dimension, (transfer.get(dimension) ?? 0) + 1)
      const bucket = dimensionAttempts.get(dimension) ?? []
      bucket.push(attempt)
      dimensionAttempts.set(dimension, bucket)
    }
    for (const concept of attempt.concepts ?? []) {
      const bucket = conceptAttempts.get(concept) ?? []
      bucket.push(attempt)
      conceptAttempts.set(concept, bucket)
    }
    for (const item of attempt.diagnoses ?? []) {
      const concept = item.concept || 'unscoped'
      const kind = item.kind || 'unclassified'
      const key = `${kind}\u0000${concept}`
      const bucket = diagnosisGroups.get(key) ?? []
      bucket.push(attemptId)
      diagnosisGroups.set(key, bucket)
    }
  }

  const concepts = [...conceptAttempts.entries()].map(([concept, items]) => ({
    concept,
    attempt_count: items.length,
    average_score: round3(items.reduce((sum, item) => sum + attemptScore(item), 0) / items.length),
    evidence_attempt_ids: items.map(item => item.attempt_id),
  }))
  concepts.sort((a, b) => {
    if (a.average_score !== b.average_score) return a.average_score - b.average_score
    if (a.attempt_count !== b.attempt_count) return b.attempt_count - a.attempt_count
    if (a.concept < b.concept) return -1
    /* v8 ignore next -- concepts are unique Map keys, so the tie branch is unreachable */
    return a.concept > b.concept ? 1 : 0
  })

  const clusters: DiagnosisCluster[] = [...diagnosisGroups.entries()].map(([key, ids]) => {
    const [kind = 'unclassified', concept = 'unscoped'] = key.split('\u0000')
    return { kind, concept, count: ids.length, evidence_attempt_ids: ids }
  })
  clusters.sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count
    if (a.concept < b.concept) return -1
    if (a.concept > b.concept) return 1
    if (a.kind < b.kind) return -1
    /* v8 ignore next -- `(kind, concept)` pairs are unique Map keys, so this tie branch is unreachable */
    return a.kind > b.kind ? 1 : 0
  })

  const dimensions: Record<string, DimensionProjection> = {}
  for (const dimension of EVIDENCE_DIMENSIONS) {
    const items = dimensionAttempts.get(dimension) ?? []
    const successful = items.filter(item => attemptScore(item) >= 0.8)
    const independent = items.filter(item => independentlyVerified(item))
    let verificationStatus: DimensionProjection['verification_status']
    if (independent.length >= MIN_INDEPENDENT_ATTEMPTS && independentlyVerified(latestAttempt(items))) {
      verificationStatus = 'independent'
    } else if (successful.length > 0) {
      verificationStatus = 'supported'
    } else if (items.length > 0) {
      verificationStatus = 'developing'
    } else {
      verificationStatus = 'unobserved'
    }
    const assistanceProvenance = new Map<string, number>()
    for (const item of items) {
      const level = assistanceLevel(item)
      assistanceProvenance.set(level, (assistanceProvenance.get(level) ?? 0) + 1)
    }
    const evaluatorProvenance = new Map<string, number>()
    for (const item of items) {
      const kind = evaluatorKind(item)
      evaluatorProvenance.set(kind, (evaluatorProvenance.get(kind) ?? 0) + 1)
    }
    dimensions[dimension] = {
      status: items.length > 0 ? 'observed' : 'unobserved',
      verification_status: verificationStatus,
      attempt_count: items.length,
      average_score: items.length > 0
        ? round3(items.reduce((sum, item) => sum + attemptScore(item), 0) / items.length)
        : null,
      evidence_attempt_ids: items.map(item => item.attempt_id),
      independently_verified_attempt_ids: independent.map(item => item.attempt_id),
      assistance_provenance: Object.fromEntries([...assistanceProvenance.entries()].sort(([a], [b]) => compareStrings(a, b))),
      evaluator_provenance: Object.fromEntries([...evaluatorProvenance.entries()].sort(([a], [b]) => compareStrings(a, b))),
    }
  }

  const ordered = sortByTime(attempts)
  const midpoint = Math.floor(ordered.length / 2)
  let scoreDelta: number | null = null
  if (midpoint > 0) {
    const earlier = ordered.slice(0, midpoint)
    const later = ordered.slice(midpoint)
    const earlyAverage = earlier.reduce((sum, item) => sum + attemptScore(item), 0) / earlier.length
    const lateAverage = later.reduce((sum, item) => sum + attemptScore(item), 0) / later.length
    scoreDelta = round3(lateAverage - earlyAverage)
  }

  return {
    attempt_count: attempts.length,
    average_score: attempts.length > 0
      ? round3(attempts.reduce((sum, item) => sum + attemptScore(item), 0) / attempts.length)
      : 0.0,
    concepts,
    diagnosis_clusters: clusters,
    transfer_evidence: Object.fromEntries(transfer),
    evidence_dimensions: dimensions,
    score_delta_earlier_to_later: scoreDelta,
  }
}

/**
 * Derive ordered intervention recommendations from a diagnosis.
 * @param diagnosis - the competency diagnosis.
 * @returns the recommendations in priority order.
 */
export function recommendations(diagnosis: Diagnosis): Recommendation[] {
  const result: Recommendation[] = []
  for (const cluster of diagnosis.diagnosis_clusters.slice(0, 3)) {
    if (cluster.count < 2) continue
    result.push({
      priority: 'high',
      intervention: cluster.kind === 'concept_confusion' ? 'prerequisite_repair' : 'misconception_probe',
      concept: cluster.concept,
      reason: `${cluster.kind} repeated ${cluster.count} times`,
      evidence_attempt_ids: cluster.evidence_attempt_ids,
    })
  }
  const supported: [string, DimensionProjection][] = []
  for (const [dimension, projection] of Object.entries(diagnosis.evidence_dimensions)) {
    if (projection.verification_status !== 'supported') continue
    if (supported.length === 0) supported.push([dimension, projection])
  }
  if (supported.length > 0) {
    const [dimension, projection] = supported[0] as [string, DimensionProjection]
    result.push({
      priority: 'medium',
      intervention: 'independence_probe',
      evidence_dimension: dimension,
      reason: `${dimension} has successful but not independently verified evidence`,
      evidence_attempt_ids: projection.evidence_attempt_ids,
    })
  }
  const transferVerified = (['near_transfer', 'far_transfer'] as const).some(
    dimension => diagnosis.evidence_dimensions[dimension]?.verification_status === 'independent',
  )
  if (diagnosis.attempt_count > 0 && !transferVerified) {
    result.push({
      priority: 'medium',
      intervention: 'near_transfer_probe',
      reason: 'No independently verified transfer evidence has been recorded yet',
      evidence_attempt_ids: [],
    })
  }
  if (result.length === 0 && diagnosis.attempt_count > 0) {
    result.push({
      priority: 'medium',
      intervention: 'retention_probe',
      reason: 'No repeated gap dominates; verify retention after spacing',
      evidence_attempt_ids: [],
    })
  }
  return result
}

/**
 * Derive pattern-proposal candidates from a diagnosis.
 * @param projectId - the owning project id.
 * @param diagnosis - the competency diagnosis.
 * @param createdAtIso - the creation timestamp, replacing Python's `datetime.now()`.
 * @returns the proposals for repeated diagnosis clusters.
 */
export function patternProposals(
  projectId: string,
  diagnosis: Diagnosis,
  createdAtIso: string,
): PatternProposal[] {
  const proposals: PatternProposal[] = []
  const datePart = createdAtIso.split('T', 1)[0] as string
  let index = 0
  for (const cluster of diagnosis.diagnosis_clusters) {
    if (cluster.count < 2) continue
    index += 1
    const conceptSlug = slugify(cluster.concept, 'unscoped')
    const kindSlug = slugify(cluster.kind, 'gap')
    proposals.push({
      schema_version: PATTERN_PROPOSAL_SCHEMA_VERSION,
      proposal_id: `proposal-${datePart}-${conceptSlug}-${kindSlug}-${index}`,
      project_id: projectId,
      title: `补充 ${cluster.concept} 的 ${cluster.kind} 失败路径`,
      change_type: 'supplement',
      status: 'candidate',
      rationale: `The same diagnosis appeared in ${cluster.count} attempts; keep it a candidate until a transfer probe validates the change.`,
      evidence_attempt_ids: cluster.evidence_attempt_ids,
      suggested_change: {
        recognition_signal: cluster.concept,
        failure_path: cluster.kind,
        validation_needed: 'near_transfer',
      },
      created_at: createdAtIso,
    })
  }
  return proposals
}

/**
 * Derive a single probe blueprint from a diagnosis, or null when no attempts exist.
 * @param diagnosis - the competency diagnosis.
 * @returns the probe blueprint, or null for an empty diagnosis.
 */
export function probeBlueprint(diagnosis: Diagnosis): Record<string, unknown> | null {
  if (diagnosis.attempt_count === 0) return null
  const recs = recommendations(diagnosis)
  /* v8 ignore next -- recommendations is never empty when attempt_count > 0 (see _recommendations);
   * this default mirrors Python's defensive `else` */
  const selected: Recommendation = recs[0] ?? {
    priority: 'medium',
    intervention: 'retention_probe',
    reason: 'Verify retained understanding',
    evidence_attempt_ids: [],
  }
  const weakest = diagnosis.concepts.length > 0 ? diagnosis.concepts[0] : undefined
  const purpose = selected.intervention
  const variationFor: Record<string, string> = {
    prerequisite_repair: 'isolate the prerequisite before the original procedure',
    misconception_probe: 'change the condition that distinguishes the observed wrong rule from the correct rule',
    near_transfer_probe: 'change surface details while preserving the solution invariant',
    independence_probe: 'repeat the demonstrated capability without hints or guided steps',
    retention_probe: 'use delayed free retrieval without cues',
  }
  /* v8 ignore next -- every recommendation intervention maps to a known variation, so the default is Python's defensive fallback */
  const variation = variationFor[purpose] ?? 'test the targeted gap with one controlled variation'
  const evidenceIds = [...new Set([
    ...selected.evidence_attempt_ids,
    ...(weakest?.evidence_attempt_ids ?? []),
  ])]
  return {
    purpose,
    target_concept: weakest?.concept ?? null,
    variation_instruction: variation,
    difficulty_policy: 'change one diagnostic variable at a time',
    response_policy: "ask for the learner's answer before revealing feedback",
    rubric_requirements: ['correct outcome', 'valid reasoning', 'conditions checked', 'independent completion'],
    evidence_attempt_ids: evidenceIds,
    reason: selected.reason,
  }
}
