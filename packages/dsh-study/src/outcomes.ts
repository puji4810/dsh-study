/**
 * StudyOS intervention outcomes: compare each accepted Intervention's baseline
 * verification status against the evidence that arrived after its decision.
 * Mirrors the Python plugin's `outcomes.py` rule for rule.
 * @module @puji4810/dsh-study/outcomes
 */

import { OUTCOME_SCHEMA_VERSION } from './constants.ts'
import { parseOffsetDateTime, toIsoSeconds } from './datetime.ts'
import type { Diagnosis, StudyAttempt, StudyData } from './types.ts'

/** Fewer decisions than this cannot distinguish a working recommendation from a lucky one. */
const MIN_OUTCOME_SAMPLE = 5

/** Ordered weakest to strongest; comparison is by position, never by name. */
const STATUS_RANK = ['unobserved', 'developing', 'supported', 'independent'] as const

const OUTCOMES = ['improved', 'unchanged', 'regressed', 'not_attempted'] as const

/** Coerce an unknown record field to a string, empty when it is not one. */
function fieldString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Python `round` at a fixed decimal scale (half to even). */
function pyRoundN(value: number, digits: number): number {
  const factor = 10 ** digits
  const scaled = value * factor
  const floor = Math.floor(scaled)
  const diff = scaled - floor
  if (diff < 0.5) return floor / factor
  if (diff > 0.5) return (floor + 1) / factor
  // Half-to-even for an exact .5 (Python `round`). An integer-ratio rate only
  // lands here at a >= 2000-denominator sample, so the branch mirrors Python's
  // banker's rounding without being reachable from ordinary decision counts.
  /* v8 ignore next */
  return (floor % 2 === 0 ? floor : floor + 1) / factor
}

/** Rank of a verification status, 0 for anything unknown. */
function statusRank(status: unknown): number {
  const index = STATUS_RANK.indexOf(String(status) as (typeof STATUS_RANK)[number])
  return index === -1 ? 0 : index
}

/** Parse a timezone-aware ISO timestamp, or null. */
function moment(value: unknown): Date | null {
  return parseOffsetDateTime(value)
}

/** Attempts for one objective/dimension strictly after a decision. */
function attemptsFor(
  attempts: StudyAttempt[],
  proposalId: string,
  interventionId: string,
  objectiveId: string,
  dimension: string,
  after: Date,
): StudyAttempt[] {
  const selected: StudyAttempt[] = []
  for (const attempt of attempts) {
    if ((attempt.source_plan_proposal_id ?? '') !== proposalId) continue
    if ((attempt.source_intervention_id ?? '') !== interventionId) continue
    if ((attempt.transfer_level ?? '') !== dimension) continue
    if (!(attempt.objective_ids ?? []).includes(objectiveId)) continue
    const occurred = parseOffsetDateTime(attempt.occurred_at)
    if (occurred === null || occurred.getTime() <= after.getTime()) continue
    selected.push(attempt)
  }
  return selected
}

/** Classify a baseline-to-current move given how much evidence arrived since. */
function classify(baseline: string, current: string, evidenceSince: number): string {
  if (evidenceSince === 0) return 'not_attempted'
  const difference = statusRank(current) - statusRank(baseline)
  if (difference > 0) return 'improved'
  if (difference < 0) return 'regressed'
  return 'unchanged'
}

/** Per-kind aggregate from a flattened outcome list. */
function aggregate(outcomes: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const grouped = new Map<string, Array<Record<string, unknown>>>()
  for (const outcome of outcomes) {
    const kind = String(outcome['kind'])
    const items = grouped.get(kind) ?? []
    items.push(outcome)
    grouped.set(kind, items)
  }
  const rows: Array<Record<string, unknown>> = []
  for (const kind of [...grouped.keys()].sort()) {
    const items = grouped.get(kind)
    if (items === undefined) continue
    const counts: Record<string, number> = {}
    for (const name of OUTCOMES) {
      counts[name] = items.filter(item => item['outcome'] === name).length
    }
    const acted = items.length - (counts['not_attempted'] ?? 0)
    const improved = counts['improved'] ?? 0
    const unchanged = counts['unchanged'] ?? 0
    const regressed = counts['regressed'] ?? 0
    const notAttempted = counts['not_attempted'] ?? 0
    const row: Record<string, unknown> = {
      kind,
      decided: items.length,
      acted_on: acted,
      improved,
      unchanged,
      regressed,
      not_attempted: notAttempted,
      adherence_rate: pyRoundN(acted / items.length, 3),
    }
    if (acted >= MIN_OUTCOME_SAMPLE) {
      row['improvement_rate'] = pyRoundN(improved / acted, 3)
      row['verdict'] = 'measured'
    } else {
      row['improvement_rate'] = null
      row['verdict'] = 'insufficient_evidence'
      row['needed_for_signal'] = MIN_OUTCOME_SAMPLE - acted
    }
    rows.push(row)
  }
  return rows
}

/** Totals over a flattened outcome list. */
function tally(outcomes: Array<Record<string, unknown>>): Record<string, unknown> {
  const counts: Record<string, unknown> = {}
  for (const name of OUTCOMES) counts[name] = 0
  for (const outcome of outcomes) {
    const value = String(outcome['outcome'])
    counts[value] = (counts[value] as number) + 1
  }
  counts['decided'] = outcomes.length
  return counts
}

/**
 * Compare each accepted Intervention's baseline against evidence since its
 * decision, deriving outcomes rather than storing them.
 * @param options.proposals - the Plan Proposals to measure (accepted only).
 * @param options.attempts - the full attempt history.
 * @param options.diagnosisBuilder - derives a {@link Diagnosis} from attempts.
 * @param options.asOf - the measurement clock.
 * @returns schema_version/as_of/outcomes/by_kind/totals.
 */
export function buildInterventionOutcomes(options: {
  proposals: StudyData[]
  attempts: StudyAttempt[]
  diagnosisBuilder: (attempts: StudyAttempt[]) => Diagnosis
  asOf: Date
}): Record<string, unknown> {
  const { proposals, attempts, diagnosisBuilder, asOf } = options

  const outcomes: Array<Record<string, unknown>> = []
  for (const proposal of proposals) {
    if (proposal.status !== 'accepted') continue
    const decision = (proposal.decision ?? {}) as Record<string, unknown>
    const decidedAt = moment(decision.decided_at)
    if (decidedAt === null) continue
    const items = proposal.items
    if (!Array.isArray(items)) continue
    for (const rawItem of items) {
      const item = rawItem as Record<string, unknown>
      const objectiveId = fieldString(item.objective_id)
      const dimension = fieldString(item.evidence_dimension)
      if (!objectiveId || !dimension) continue
      const reasonFactors = (item.reason_factors ?? {}) as Record<string, unknown>
      const baseline = typeof reasonFactors.verification_status === 'string' && reasonFactors.verification_status !== ''
        ? reasonFactors.verification_status
        : 'unobserved'
      const proposalId = fieldString(proposal.proposal_id)
      const interventionId = fieldString(item.intervention_id)
      const since = attemptsFor(attempts, proposalId, interventionId, objectiveId, dimension, decidedAt)
      const baselineIds = new Set(
        Array.isArray(item.evidence_attempt_ids) ? item.evidence_attempt_ids.map(String) : [],
      )
      const sinceIds = new Set(since.map(attempt => attempt.attempt_id))
      const attributable = attempts.filter(attempt => baselineIds.has(attempt.attempt_id) || sinceIds.has(attempt.attempt_id))
      const dimensions = diagnosisBuilder(attributable).evidence_dimensions ?? {}
      const projection = (dimensions[dimension] ?? {}) as unknown as Record<string, unknown>
      const current = typeof projection.verification_status === 'string' && projection.verification_status !== ''
        ? projection.verification_status
        : 'unobserved'
      outcomes.push({
        proposal_id: proposalId,
        intervention_id: interventionId,
        objective_id: objectiveId,
        evidence_dimension: dimension,
        kind: fieldString(item.kind),
        decided_at: toIsoSeconds(decidedAt),
        days_since_decision: Math.floor((asOf.getTime() - decidedAt.getTime()) / 86_400_000),
        verification_status_at_decision: baseline,
        verification_status_now: current,
        evidence_attempt_ids_since: since.map(attempt => attempt.attempt_id),
        outcome: classify(baseline, current, since.length),
      })
    }
  }

  outcomes.sort((a, b) => {
    const aKey = String(a.decided_at)
    const bKey = String(b.decided_at)
    if (aKey !== bKey) return aKey < bKey ? -1 : 1
    return String(a.intervention_id) < String(b.intervention_id) ? -1 : 1
  })
  return {
    schema_version: OUTCOME_SCHEMA_VERSION,
    as_of: toIsoSeconds(asOf),
    outcomes,
    by_kind: aggregate(outcomes),
    totals: tally(outcomes),
  }
}
