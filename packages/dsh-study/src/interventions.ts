/**
 * StudyOS intervention orchestration: derive a bounded next-action queue from
 * evidence, then project it into a day plan and a reviewable proposal. Mirrors
 * the Python plugin's `interventions.py` rule for rule; persistence and
 * Schedule mutation stay outside this module.
 * @module @puji4810/dsh-study/interventions
 */

import {
  EVIDENCE_DIMENSIONS,
  INTERVENTION_POLICY_VERSION,
  INTERVENTION_QUEUE_SCHEMA_VERSION,
  PLAN_PROPOSAL_SCHEMA_VERSION,
  PROJECT_SCHEMA_VERSION_V2,
} from './constants.ts'
import type {
  AssistanceLevel,
  DeadlineBand,
  EvidenceAgeBand,
  InterventionKind,
  VerificationStatus,
} from './constants.ts'
import { localDateString, parseDate, parseOffsetDateTime, toIsoSeconds } from './datetime.ts'
import { digest, unique } from './util.ts'
import { buildDayPlan } from './day-plan.ts'
import { calibratedDuration, capacityFactor, outcomeAdjustment } from './calibration.ts'
import type {
  DayPlan,
  Diagnosis,
  DiagnosisCluster,
  InterventionItem,
  InterventionQueue,
  PlanProposal,
  StudyAttempt,
  StudyData,
  StudyObjective,
  StudyProject,
} from './types.ts'

type DiagnosisBuilder = (attempts: StudyAttempt[]) => Diagnosis

/** Freshness thresholds in days, per evidence dimension. */
const FRESHNESS_DAYS: Record<string, number> = {
  recall: 14,
  recognition: 21,
  execution: 30,
  explanation: 30,
  near_transfer: 45,
  far_transfer: 60,
}

const STATUS_BASE_SCORE: Record<string, number> = {
  unobserved: 70,
  developing: 76,
  supported: 60,
  independent: 42,
}

const DEADLINE_BOOST: Record<string, number> = {
  none: 0,
  distant: 0,
  approaching: 6,
  near: 12,
  critical: 18,
  overdue: 20,
}

const AGE_BOOST: Record<string, number> = {
  unobserved: 0,
  fresh: 0,
  aging: 4,
  stale: 10,
}

/** Domain Pack stated intervention durations, mirrored from domain_packs. */
const DOMAIN_PACK_DURATIONS: Record<string, number> = {
  'general.v1': 30,
  'kaoyan.v1': 30,
  'engineering.v1': 45,
  'research.v1': 60,
}

/** The fallback Domain Pack when no pack or family matches. */
const FALLBACK_DOMAIN_PACK = 'general.v1'

function familyMatchDuration(value: string): number | null {
  const family = value.split('.', 1)[0] ?? ''
  const matches = Object.keys(DOMAIN_PACK_DURATIONS).filter(id => id.split('.', 1)[0] === family)
  if (matches.length !== 1) return null
  const pack = matches[0]
  if (pack === undefined) return null
  return DOMAIN_PACK_DURATIONS[pack] ?? null
}

/** The Domain Pack stated duration for a project, with unknown-id fallback. */
function domainPackDuration(project: StudyProject): number {
  const fallback = DOMAIN_PACK_DURATIONS[FALLBACK_DOMAIN_PACK] ?? 0
  const requested = project.domain_pack.trim().toLowerCase()
  const domainValue = project.domain.trim().toLowerCase()
  if (requested) {
    return DOMAIN_PACK_DURATIONS[requested] ?? familyMatchDuration(requested) ?? fallback
  }
  if (domainValue) {
    return DOMAIN_PACK_DURATIONS[domainValue] ?? familyMatchDuration(domainValue) ?? fallback
  }
  return fallback
}

/**
 * Resolve the orchestration clock from a candidate value.
 * @param value - an ISO datetime with a timezone offset, or nothing for "now".
 * @returns the resolved instant.
 * @throws Error when the value is not a valid offset-carrying ISO datetime.
 */
export function parseAsOf(value?: unknown): Date {
  if (value === undefined || value === null) return new Date()
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('as_of must be an ISO datetime with timezone offset')
  }
  const text = value.trim()
  const parsed = parseOffsetDateTime(text)
  if (parsed !== null) return parsed
  if (isNaiveIsoDatetime(text)) {
    throw new Error('as_of must include a timezone offset')
  }
  throw new Error('as_of must be a valid ISO datetime with timezone offset')
}

/** True when a value parses as a naive (offset-less) ISO datetime. */
function isNaiveIsoDatetime(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value)) return false
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime())
}

/** The attempt id, trimmed, or empty string. */
function attemptId(attempt: StudyAttempt): string {
  return attempt.attempt_id.trim()
}

/** The local date string for a validated timezone, whose null case cannot arise. */
function localDate(date: Date, timeZone: string): string {
  const value = localDateString(date, timeZone)
  /* v8 ignore next -- the timezone is validated by `projectTimezone` before any caller runs, so null is unreachable */
  if (value === null) throw new Error('invalid timezone')
  return value
}

/** The project deadline as an ISO date string, or null. */
function deadline(project: StudyProject): string | null {
  const record = project as unknown as Record<string, unknown>
  const raw = (record['deadline'] ?? record['exam_date'])
  if (typeof raw !== 'string' || raw === '') return null
  if (parseDate(raw) === null) return null
  return raw
}

/** Days to deadline and its band. */
function deadlineState(project: StudyProject, asOf: Date, timeZone: string): { days: number | null; band: string } {
  const limit = deadline(project)
  if (limit === null) return { days: null, band: 'none' }
  const asOfLocal = localDate(asOf, timeZone)
  const limitMs = new Date(`${limit}T00:00:00Z`).getTime()
  const asOfMs = new Date(`${asOfLocal}T00:00:00Z`).getTime()
  const days = Math.round((limitMs - asOfMs) / 86_400_000)
  if (days < 0) return { days, band: 'overdue' }
  if (days <= 7) return { days, band: 'critical' }
  if (days <= 30) return { days, band: 'near' }
  if (days <= 90) return { days, band: 'approaching' }
  return { days, band: 'distant' }
}

/** Age of a dimension's latest evidence plus its band and raw timestamp. */
function ageState(
  attempts: StudyAttempt[],
  asOf: Date,
  threshold: number,
  timeZone: string,
): { age: number | null; band: string; latest: string | null } {
  let latest: Date | null = null
  let latestRaw: string | null = null
  for (const attempt of attempts) {
    const value = attempt.occurred_at
    const moment = parseOffsetDateTime(value)
    if (moment === null) continue
    if (latest === null || moment.getTime() > latest.getTime()) {
      latest = moment
      latestRaw = value
    }
  }
  if (latest === null) return { age: null, band: 'unobserved', latest: null }
  const asOfLocal = localDate(asOf, timeZone)
  const latestLocal = localDate(latest, timeZone)
  const age = Math.max(0, Math.round((new Date(`${asOfLocal}T00:00:00Z`).getTime() - new Date(`${latestLocal}T00:00:00Z`).getTime()) / 86_400_000))
  let band: string
  if (age <= Math.floor(threshold / 2)) band = 'fresh'
  else if (age <= threshold) band = 'aging'
  else band = 'stale'
  return { age, band, latest: latestRaw }
}

/** Priority band for a score. */
function priorityBand(score: number): 'high' | 'medium' | 'low' {
  if (score >= 80) return 'high'
  if (score >= 55) return 'medium'
  return 'low'
}

/** Assistance level for a kind. */
function assistanceFor(kind: string): string {
  if (['independence_probe', 'near_transfer_probe', 'far_transfer_probe', 'retention_probe'].includes(kind)) {
    return 'independent'
  }
  if (['guided_repair', 'prerequisite_repair'].includes(kind)) return 'guided'
  return 'hints_only'
}

/** Which Intervention kind an evidence state maps to. */
function kindFor(
  verificationStatus: string,
  target: string,
  repeatedCluster: DiagnosisCluster | null,
): string {
  if (verificationStatus === 'independent') return 'retention_probe'
  if (verificationStatus === 'supported') return 'independence_probe'
  if (verificationStatus === 'developing') {
    if (repeatedCluster !== null) {
      return repeatedCluster.kind === 'concept_confusion' ? 'prerequisite_repair' : 'misconception_probe'
    }
    return 'guided_repair'
  }
  if (target === 'near_transfer') return 'near_transfer_probe'
  if (target === 'far_transfer') return 'far_transfer_probe'
  return 'evidence_probe'
}

/** The activation date of an objective, or null. */
function activatesOn(objective: Record<string, unknown>): string | null {
  const raw = objective['activates_on']
  if (typeof raw !== 'string' || raw === '') return null
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null
}

/** The project timezone, raising the Python `ValueError` when invalid. */
function projectTimezone(project: StudyProject): string {
  const timeZone = project.timezone
  if (timeZone.trim() === '' || localDateString(new Date(0), timeZone) === null) {
    throw new Error(`project timezone is not a valid IANA timezone: ${timeZone}`)
  }
  return timeZone
}

/** Split evidence per objective, holding back not-yet-in-scope objectives. */
function objectiveViews(
  project: StudyProject,
  attempts: StudyAttempt[],
  asOfDate: string | null,
): { views: Array<{ objective: StudyObjective; scoped: StudyAttempt[] }>; unscoped: string[]; deferred: string[] } {
  if (project.schema_version !== PROJECT_SCHEMA_VERSION_V2) {
    const synthetic: StudyObjective = {
      objective_id: 'project-readiness',
      capability: `Demonstrate readiness for ${project.title}.`,
      success_criteria: ['Produce evaluator-provenanced evidence without hidden assistance.'],
      evidence_targets: [...EVIDENCE_DIMENSIONS],
      source_anchors: [],
    }
    return { views: [{ objective: synthetic, scoped: attempts }], unscoped: [], deferred: [] }
  }

  const rawObjectives = project.objectives as unknown as Array<Record<string, unknown>>
  const views: Array<{ objective: StudyObjective; scoped: StudyAttempt[] }> = []
  const deferred: string[] = []
  const scopedIds = new Set<string>()
  for (const raw of rawObjectives) {
    const objective = raw as unknown as StudyObjective
    const objectiveId = String(raw['objective_id'])
    const scoped = attempts.filter(attempt =>
      (attempt.objective_ids ?? []).some(id => id === objectiveId),
    )
    for (const attempt of scoped) scopedIds.add(attemptId(attempt))
    const activate = activatesOn(raw)
    if (asOfDate !== null && activate !== null && asOfDate < activate) {
      deferred.push(`${objectiveId} until ${activate}`)
      continue
    }
    views.push({ objective, scoped })
  }
  // An attempt is unscoped iff no declared Objective attributed it. Scoping only
  // ever matches declared objectives, so the Python "scoped to an unknown id"
  // complement (known_ids.intersection) is provably empty and omitted.
  const unscoped = unique(
    attempts
      .filter((attempt) => {
        const id = attemptId(attempt)
        if (!id) return false
        return !scopedIds.has(id)
      })
      .map(attemptId),
  )
  return { views, unscoped, deferred }
}

/** Duration for a kind, corrected by observed evidence. */
function durationFor(project: StudyProject, attempts: StudyAttempt[], kind: string): Record<string, unknown> {
  return calibratedDuration({
    attempts,
    kind,
    defaultMinutes: domainPackDuration(project),
  })
}

/**
 * Turn evidence into one bounded Intervention per active Objective.
 *
 * @param project - the project manifest.
 * @param diagnosisBuilder - derives a {@link Diagnosis} from a scoped attempt list.
 */
export class InterventionOrchestrator {
  private readonly project: StudyProject
  private readonly diagnosisBuilder: DiagnosisBuilder

  /**
   * @param options.project - the project manifest.
   * @param options.diagnosisBuilder - derives a {@link Diagnosis} from attempts.
   */
  constructor(options: { project: StudyProject; diagnosisBuilder: DiagnosisBuilder }) {
    this.project = options.project
    this.diagnosisBuilder = options.diagnosisBuilder
  }

  /**
   * Derive the queue, optionally corrected by its own measured history.
   * @param options.attempts - the immutable attempt history.
   * @param options.asOf - the orchestration clock.
   * @param options.maxItems - queue item cap, 1..20 (default 5).
   * @param options.schedules - loaded Schedules for the day projection.
   * @param options.outcomes - the recommender's own outcome record.
   * @param options.adherence - the recommender's own adherence record.
   * @returns queue, day plan, and a reviewable proposal.
   */
  build(options: {
    attempts: StudyAttempt[]
    asOf: Date
    maxItems?: number
    schedules?: StudyData[] | null
    outcomes?: Record<string, unknown> | null
    adherence?: Record<string, unknown> | null
  }): { queue: InterventionQueue; dayPlan: DayPlan | null; proposal: PlanProposal | null } {
    const { attempts, asOf } = options
    const maxItems = options.maxItems ?? 5
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 20) {
      throw new Error('max_items must be an integer from 1 to 20')
    }
    const timeZone = projectTimezone(this.project)
    const asOfDate = localDate(asOf, timeZone)

    const deadlineInfo = deadlineState(this.project, asOf, timeZone)
    const { views, unscoped, deferred } = objectiveViews(this.project, attempts, asOfDate)
    const candidates: Array<{ objectiveIndex: number; targetIndex: number; item: InterventionItem }> = []
    const consideredEvidence: string[] = []

    for (let objectiveIndex = 0; objectiveIndex < views.length; objectiveIndex += 1) {
      const view = views[objectiveIndex]
      if (view === undefined) continue
      const { objective, scoped } = view
      for (const attempt of scoped) consideredEvidence.push(attemptId(attempt))
      const diagnosis = this.diagnosisBuilder(scoped)
      const targetCandidates: Array<{ targetIndex: number; item: InterventionItem }> = []
      const declaredTargets = new Set(objective.evidence_targets)
      const targets = EVIDENCE_DIMENSIONS.filter(dimension => declaredTargets.has(dimension))

      for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
        const target = targets[targetIndex]
        if (target === undefined) continue
        const projection = (diagnosis.evidence_dimensions[target] ?? {}) as unknown as Record<string, unknown>
        const rawStatus = projection['verification_status']
        const verificationStatus = typeof rawStatus === 'string' && rawStatus !== '' ? rawStatus : 'unobserved'
        const rawEvidenceIds = projection['evidence_attempt_ids']
        const targetEvidenceIds = unique(Array.isArray(rawEvidenceIds) ? rawEvidenceIds : [])
        const targetEvidenceIdSet = new Set(targetEvidenceIds)
        const targetAttempts = scoped.filter(attempt => targetEvidenceIdSet.has(attemptId(attempt)))
        const threshold = FRESHNESS_DAYS[target] ?? 0
        const age = ageState(targetAttempts, asOf, threshold, timeZone)
        if (verificationStatus === 'independent' && age.band !== 'stale') continue

        let repeatedCluster: DiagnosisCluster | null = null
        if (verificationStatus === 'developing') {
          repeatedCluster =
            diagnosis.diagnosis_clusters.find(cluster => cluster.count >= 2) ?? null
        }
        const kind = kindFor(verificationStatus, target, repeatedCluster)
        let evidenceIds = [...targetEvidenceIds]
        if (repeatedCluster !== null && verificationStatus === 'developing') {
          evidenceIds = unique([
            ...evidenceIds,
            ...repeatedCluster.evidence_attempt_ids.map(value => value),
          ])
        }

        let score = STATUS_BASE_SCORE[verificationStatus] ?? 0
        score += DEADLINE_BOOST[deadlineInfo.band] ?? 0
        score += AGE_BOOST[age.band] ?? 0
        const repeatedCount = repeatedCluster !== null ? repeatedCluster.count : 0
        if (verificationStatus === 'developing' && repeatedCount > 0) {
          score += Math.min(12, repeatedCount * 3)
        }
        const adjustment = outcomeAdjustment({
          byKind: (options.outcomes?.['by_kind'] as Array<Record<string, unknown>> | undefined) ?? null,
          kind,
        })
        score += Number(adjustment['delta'])
        score = Math.max(0, Math.min(100, score))
        const duration = durationFor(this.project, attempts, kind)

        const reasons = this.reasons({
          verificationStatus,
          target,
          ageDays: age.age,
          threshold,
          deadlineBand: deadlineInfo.band,
          daysToDeadline: deadlineInfo.days,
          repeatedCluster,
        })
        const delta = Number(adjustment['delta'])
        if (delta !== 0) {
          const rate = Number(adjustment['improvement_rate'])
          const sampleSize = Number(adjustment['sample_size'])
          reasons.push(
            `${kind.replace(/_/g, ' ')} has improved this project's evidence in ${Math.round(rate * 100)}% of the ${sampleSize} times it was acted on.`,
          )
        }

        const item: InterventionItem = {
          intervention_id: `iv-${digest({
            project_id: this.project.project_id,
            objective_id: objective.objective_id,
            target,
            kind,
            verification_status: verificationStatus,
            evidence_age_band: age.band,
            deadline_band: deadlineInfo.band,
            evidence_attempt_ids: evidenceIds,
          }).slice(0, 16)}`,
          objective_id: objective.objective_id,
          capability: objective.capability,
          kind: kind as InterventionKind,
          evidence_dimension: target,
          priority_score: score,
          priority_band: priorityBand(score),
          reasons,
          reason_factors: {
            verification_status: verificationStatus as VerificationStatus,
            evidence_age_days: age.age,
            evidence_age_band: age.band as EvidenceAgeBand,
            freshness_threshold_days: threshold,
            days_to_deadline: deadlineInfo.days,
            deadline_band: deadlineInfo.band as DeadlineBand,
            repeated_diagnosis_count: repeatedCount,
            outcome_adjustment: delta,
            outcome_improvement_rate:
              adjustment['improvement_rate'] === null ? null : Number(adjustment['improvement_rate']),
            outcome_sample_size: Number(adjustment['sample_size']),
            outcome_source: String(adjustment['source']),
          },
          latest_evidence_at: age.latest,
          evidence_attempt_ids: evidenceIds,
          recommended_activity: {
            activity_kind: kind as InterventionKind,
            evidence_target: target,
            assistance_level: assistanceFor(kind) as AssistanceLevel,
            duration_minutes: Number(duration['minutes']),
            duration_source: String(duration['source']),
            duration_sample_size: Number(duration['sample_size']),
            requires_evaluator: true,
            success_criteria: [...objective.success_criteria],
            source_anchors: [...(objective.source_anchors ?? [])],
          },
        }
        targetCandidates.push({ targetIndex, item })

        // Once a required dimension is not independently verified, later
        // dimensions must wait.
        if (verificationStatus !== 'independent') break
      }

      if (targetCandidates.length > 0) {
        targetCandidates.sort((a, b) => {
          if (a.item.priority_score !== b.item.priority_score) {
            return b.item.priority_score - a.item.priority_score
          }
          return a.targetIndex - b.targetIndex
        })
        const selected = targetCandidates[0]
        if (selected !== undefined) {
          candidates.push({ objectiveIndex, targetIndex: selected.targetIndex, item: selected.item })
        }
      }
    }

    candidates.sort((a, b) => {
      if (a.item.priority_score !== b.item.priority_score) return b.item.priority_score - a.item.priority_score
      return a.objectiveIndex - b.objectiveIndex
    })
    const items = candidates.slice(0, maxItems).map(candidate => candidate.item)
    const generatedAt = toIsoSeconds(asOf)
    const queue: InterventionQueue = {
      schema_version: INTERVENTION_QUEUE_SCHEMA_VERSION,
      project_id: this.project.project_id,
      policy_version: INTERVENTION_POLICY_VERSION,
      generated_at: generatedAt,
      as_of: generatedAt,
      deadline: deadline(this.project),
      days_to_deadline: deadlineInfo.days,
      items,
      evidence_attempt_ids: unique(consideredEvidence),
      unscoped_attempt_ids: unscoped,
      deferred_objectives: deferred,
      warnings: [
        ...(unscoped.length > 0
          ? ['Some attempts were not attributed to a declared Objective and did not affect priority.']
          : []),
        ...(deferred.length > 0
          ? [`Objectives not yet in scope were held back: ${deferred.join('; ')}`]
          : []),
      ],
    }

    const dayPlan =
      items.length > 0
        ? buildDayPlan({
          queueItems: items,
          schedules: options.schedules ?? [],
          attempts,
          project: this.project,
          target: asOfDate,
          timeZone,
          now: asOf,
          capacity: capacityFactor(options.adherence ?? null),
        })
        : null
    return {
      queue,
      dayPlan,
      proposal: items.length > 0 ? this.proposal(queue, dayPlan) : null,
    }
  }

  /**
   * Hash only semantic fields, excluding clocks and explanatory prose.
   * @param options.project - the project manifest.
   * @param options.items - the queue items.
   * @param options.dayPlan - the day plan, when one placed something.
   * @returns the 64-character hex fingerprint.
   */
  static fingerprint(options: {
    project: StudyProject
    items: InterventionItem[]
    dayPlan?: DayPlan | null
  }): string {
    const { project, items, dayPlan } = options
    const semanticItems = items.map(item => ({
      objective_id: item.objective_id,
      capability: item.capability,
      evidence_dimension: item.evidence_dimension,
      kind: item.kind,
      verification_status: item.reason_factors.verification_status,
      evidence_age_band: item.reason_factors.evidence_age_band,
      deadline_band: item.reason_factors.deadline_band,
      repeated_diagnosis_count: item.reason_factors.repeated_diagnosis_count,
      evidence_attempt_ids: item.evidence_attempt_ids,
      recommended_activity: item.recommended_activity,
    }))
    const placed: Array<Record<string, unknown>> = []
    for (const entry of dayPlan?.schedules ?? []) {
      for (const event of entry.events) {
        placed.push({
          id: event.id,
          start: event.start,
          end: event.end,
          source_intervention_id: event.source_intervention_id,
        })
      }
    }
    return digest({
      policy_version: INTERVENTION_POLICY_VERSION,
      project_id: project.project_id,
      project_title: project.title,
      items: semanticItems,
      day_plan: placed.length > 0 ? { target_date: dayPlan?.target_date, events: placed } : null,
    })
  }

  /** The human-readable reasons for one Intervention. */
  private reasons(options: {
    verificationStatus: string
    target: string
    ageDays: number | null
    threshold: number
    deadlineBand: string
    daysToDeadline: number | null
    repeatedCluster: DiagnosisCluster | null
  }): string[] {
    const { verificationStatus, target, ageDays, threshold, deadlineBand, daysToDeadline, repeatedCluster } = options
    let reasons: string[]
    if (verificationStatus === 'unobserved') {
      reasons = [`No evaluator-provenanced ${target} evidence has been recorded.`]
    } else if (verificationStatus === 'developing') {
      reasons = [`Observed ${target} evidence does not yet meet the success threshold.`]
    } else if (verificationStatus === 'supported') {
      reasons = [`Successful ${target} evidence is not independently verified.`]
    } else {
      reasons = [
        `Independent ${target} evidence is ${ageDays} days old, beyond the ${threshold}-day freshness threshold.`,
      ]
    }
    if (repeatedCluster !== null) {
      reasons.push(`${repeatedCluster.kind} repeated ${repeatedCluster.count} times.`)
    }
    if (deadlineBand === 'near' || deadlineBand === 'critical' || deadlineBand === 'overdue') {
      reasons.push(
        deadlineBand === 'overdue'
          ? 'The project deadline is overdue.'
          : `Only ${daysToDeadline} days remain before the project deadline.`,
      )
    }
    return reasons
  }

  /** Build the reviewable proposal from a queue and its day plan. */
  private proposal(queue: InterventionQueue, dayPlan: DayPlan | null): PlanProposal {
    const itemEvidence = unique(
      queue.items.flatMap(item => item.evidence_attempt_ids),
    )
    const fingerprint = InterventionOrchestrator.fingerprint({
      project: this.project,
      items: queue.items,
      dayPlan,
    })
    const title = `Next learning plan for ${this.project.title}`
    return {
      schema_version: PLAN_PROPOSAL_SCHEMA_VERSION,
      proposal_id: `plan-${fingerprint.slice(0, 20)}`,
      project_id: this.project.project_id,
      policy_version: INTERVENTION_POLICY_VERSION,
      generation_fingerprint: fingerprint,
      title,
      status: 'proposed',
      rationale:
        'Derived from evidence gaps, independent verification, evidence freshness, and deadline; no Schedule change has been applied.',
      created_at: queue.generated_at,
      as_of: queue.as_of,
      items: clone(queue.items),
      day_plan: clone(dayPlan),
      evidence_attempt_ids: itemEvidence,
      schedule_change: { state: 'not_applied', requires_explicit_save: true },
    }
  }
}

/** Deep-copy a JSON-structured value. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
