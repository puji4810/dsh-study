/**
 * Shared StudyOS constants: schema versions, stable enums, and the default prompt policy.
 * Every value mirrors the original StudyOS plugin so vaults and model-facing values stay compatible.
 * @module @puji4810/dsh-study/constants
 */

/** Project manifest schema versions. */
export const PROJECT_SCHEMA_VERSION_V1 = 'study_project.v1'
export const PROJECT_SCHEMA_VERSION_V2 = 'study_project.v2'
export const SCHEDULE_SCHEMA_VERSION = 'study_schedule.v1'
export const ATTEMPT_SCHEMA_VERSION = 'study_attempt.v1'
export const PATTERN_PROPOSAL_SCHEMA_VERSION = 'study_pattern_proposal.v1'
export const LEARNING_CONTRACT_SCHEMA_VERSION = 'learning_contract.v1'
export const INTERVENTION_QUEUE_SCHEMA_VERSION = 'study_intervention_queue.v1'
export const PLAN_PROPOSAL_SCHEMA_VERSION = 'study_plan_proposal.v1'
export const INTERVENTION_POLICY_VERSION = 'study_intervention_policy.v1'
export const DAY_PLAN_SCHEMA_VERSION = 'study_day_plan.v1'
export const LEARNING_SESSION_SCHEMA_VERSION = 'learning_session.v1'
export const ACTIVITY_SPEC_SCHEMA_VERSION = 'study_activity_spec.v1'
export const COMPETENCY_SNAPSHOT_SCHEMA_VERSION = 'competency_snapshot.v1'
export const OUTCOME_SCHEMA_VERSION = 'intervention_outcomes.v1'
export const ADHERENCE_SCHEMA_VERSION = 'study_plan_adherence.v1'

/** Id and timestamp patterns shared by every durable StudyOS record. */
export const PROJECT_ID_PATTERN = '^[a-z0-9][a-z0-9-]{2,63}$'
export const SCHEDULE_ID_PATTERN = '^[a-z0-9][a-z0-9-]{2,79}$'
export const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$'
export const DATETIME_WITH_OFFSET_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:[+-]\\d{2}:\\d{2}|Z)$'
export const DOMAIN_PACK_ID_PATTERN = '^[a-z][a-z0-9_-]*\\.v[1-9][0-9]*$'

/** Observed attempt results. */
export const ATTEMPT_RESULTS = ['correct', 'partial', 'incorrect', 'abandoned'] as const
export type AttemptResult = (typeof ATTEMPT_RESULTS)[number]

/** The six evidence dimensions, weakest to strongest in canonical order. */
export const EVIDENCE_DIMENSIONS = [
  'recall',
  'recognition',
  'execution',
  'explanation',
  'near_transfer',
  'far_transfer',
] as const
export type EvidenceDimension = (typeof EVIDENCE_DIMENSIONS)[number]

export const LEARNING_MODES = ['execute', 'learn', 'assess', 'research'] as const
export type LearningMode = (typeof LEARNING_MODES)[number]

export const ASSISTANCE_LEVELS = ['direct', 'guided', 'hints_only', 'independent'] as const
export type AssistanceLevel = (typeof ASSISTANCE_LEVELS)[number]

export const EVALUATOR_KINDS = ['self', 'agent', 'program', 'human'] as const
export type EvaluatorKind = (typeof EVALUATOR_KINDS)[number]

export const SOURCE_ANCHOR_KINDS = [
  'file',
  'paper',
  'book',
  'web',
  'dataset',
  'command',
  'commit',
  'note',
  'other',
] as const
export type SourceAnchorKind = (typeof SOURCE_ANCHOR_KINDS)[number]

export const INTERVENTION_KINDS = [
  'evidence_probe',
  'guided_repair',
  'independence_probe',
  'misconception_probe',
  'prerequisite_repair',
  'near_transfer_probe',
  'far_transfer_probe',
  'retention_probe',
] as const
export type InterventionKind = (typeof INTERVENTION_KINDS)[number]

export const PLAN_PROPOSAL_STATUSES = ['proposed', 'accepted', 'rejected'] as const
export type PlanProposalStatus = (typeof PLAN_PROPOSAL_STATUSES)[number]

export const VERIFICATION_STATUSES = ['unobserved', 'developing', 'supported', 'independent'] as const
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number]

export const EVIDENCE_AGE_BANDS = ['unobserved', 'fresh', 'aging', 'stale'] as const
export type EvidenceAgeBand = (typeof EVIDENCE_AGE_BANDS)[number]

export const DEADLINE_BANDS = ['none', 'distant', 'approaching', 'near', 'critical', 'overdue'] as const
export type DeadlineBand = (typeof DEADLINE_BANDS)[number]

/** Pattern-proposal state values. */
export const PATTERN_PROPOSAL_STATUSES = ['candidate', 'accepted', 'rejected'] as const
export const PATTERN_PROPOSAL_CHANGE_TYPES = ['create', 'supplement', 'split', 'merge', 'demote'] as const

/** Default prompt policy; per-kind char fields are reserve floors, not hard caps. */
export const DEFAULT_PROMPT_POLICY = {
  base_max_chars: 2000,
  intent_max_chars: 2500,
  domain_max_chars: 2000,
  project_summary_max_chars: 1200,
  total_max_chars: 6000,
  total_max_tokens: 1800,
  updates_apply: 'next_session',
} as const

/** Default result scores recorded for an attempt without an explicit score. */
export const DEFAULT_ATTEMPT_SCORES: Record<AttemptResult, number> = {
  correct: 1.0,
  partial: 0.5,
  incorrect: 0.0,
  abandoned: 0.0,
}

/** Valid prompt_context intents and the routed skill behind each one. */
export const VALID_PROMPT_INTENTS = [
  'planning',
  'organizing',
  'reviewing',
  'teaching',
  'assessment',
  'error_analysis',
  'schedule_adjustment',
] as const
export type PromptIntent = (typeof VALID_PROMPT_INTENTS)[number]

export const INTENT_SKILL: Record<PromptIntent, string> = {
  planning: 'study-plan',
  schedule_adjustment: 'study-plan',
  organizing: 'study-organize',
  reviewing: 'study-review',
  teaching: 'study-teach',
  assessment: 'study-assessment',
  error_analysis: 'study-assessment',
}
