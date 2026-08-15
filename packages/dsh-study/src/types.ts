/**
 * StudyOS domain types. These describe the validated on-disk and in-memory records;
 * the validators in {@link ./validate.ts} produce them from untyped input.
 * @module @puji4810/dsh-study/types
 */

import type {
  AttemptResult,
  AssistanceLevel,
  DeadlineBand,
  EvidenceAgeBand,
  EvidenceDimension,
  EvaluatorKind,
  InterventionKind,
  LearningMode,
  PlanProposalStatus,
  SourceAnchorKind,
  VerificationStatus,
} from './constants.ts'

/** An untyped study record: validated JSON before narrowing. */
export type StudyData = Record<string, unknown>

/** One project row shown by the StudyOS panel. */
export interface StudyDashboardProject {
  projectId: string
  title: string
  domain: string
  phase: string
  deadline?: string
  scheduleCount: number
  attemptCount: number
}

/** One due-review row shown by the StudyOS panel. */
export interface StudyDashboardReview {
  path: string
  title: string
  reviewLevel: number
  reviewCount: number
  nextReviewAt?: string
  concepts: string[]
}

/** Complete read model for the StudyOS sidebar panel. */
export interface StudyDashboardOverview {
  vaultPath: string
  activeProjectId?: string
  projects: StudyDashboardProject[]
  dueReviewCount: number
  dueReviews: StudyDashboardReview[]
}

/** Version-aware reference to the exact source location supporting an activity or claim. */
export interface StudySourceAnchor {
  kind: SourceAnchorKind
  ref: string
  version?: string
  locator?: string
}

/** An observable capability the learner intends to demonstrate (study_project.v2). */
export interface StudyObjective {
  objective_id: string
  capability: string
  success_criteria: string[]
  evidence_targets: EvidenceDimension[]
  source_anchors?: StudySourceAnchor[]
  activates_on?: string
}

/** A subject track shared by v1 `subjects` and v2 `tracks`. */
export interface StudySubject {
  id: string
  label: string
  target_score?: number
}

/** Per-turn prompt injection budget declared by a project manifest. */
export interface StudyPromptPolicy {
  base_max_chars: number
  intent_max_chars: number
  domain_max_chars: number
  project_summary_max_chars: number
  total_max_chars: number
  updates_apply: 'next_session'
  total_max_tokens?: number
  base_reserve_tokens?: number
  intent_reserve_tokens?: number
  domain_reserve_tokens?: number
  project_summary_reserve_tokens?: number
}

/** study_project.v1: the exam-oriented legacy manifest. */
export interface StudyProjectV1 extends StudyData {
  schema_version: 'study_project.v1'
  project_id: string
  title: string
  domain: string
  exam_type: string
  exam_date: string
  timezone: string
  phase: string
  domain_pack: string
  subjects: StudySubject[]
  prompt_policy: StudyPromptPolicy
  created_at: string
  updated_at: string
}

/** study_project.v2: the objective-driven manifest. */
export interface StudyProjectV2 extends StudyData {
  schema_version: 'study_project.v2'
  project_id: string
  title: string
  domain: string
  timezone: string
  phase: string
  domain_pack: string
  workspace_type: string
  artifact_policy: string
  deadline?: string
  tracks: StudySubject[]
  objectives: StudyObjective[]
  prompt_policy: StudyPromptPolicy
  created_at: string
  updated_at: string
}

/** A validated project manifest of either version. */
export type StudyProject = StudyProjectV1 | StudyProjectV2

export interface StudyScheduleRange {
  start: string
  end: string
}

export interface StudySchedulePhase {
  id: string
  title: string
  start: string
  end: string
  goal: string
  effort_minutes?: number
  goals?: string[]
  source_curricula?: string[]
  status?: string
}

export interface StudyScheduleEvent {
  id: string
  title: string
  subject_id: string
  type: string
  start: string
  end: string
  duration_minutes: number
  goals: string[]
  source_curriculum?: string
  status: string
  // Written by plan_proposal.apply; its presence makes the event measurable.
  source_plan_proposal_id?: string
  source_intervention_id?: string
  source_objective_id?: string
  evidence_dimension?: string
}

export interface StudySchedule {
  schema_version: 'study_schedule.v1'
  schedule_id: string
  project_id: string
  title: string
  timezone: string
  range: StudyScheduleRange
  phases: StudySchedulePhase[]
  events: StudyScheduleEvent[]
}

export interface StudyEvaluator {
  kind: EvaluatorKind
  confidence?: number
  id?: string
}

export interface StudyAssistance {
  level: AssistanceLevel
  hints_used?: number
}

export interface StudyDiagnosisRecord {
  kind: string
  evidence: string
  concept?: string
}

/** One immutable observation of learner performance. */
export interface StudyAttempt {
  schema_version: 'study_attempt.v1'
  attempt_id: string
  project_id: string
  item_id: string
  occurred_at: string
  response: string
  result: AttemptResult
  score: number
  duration_seconds?: number
  hints_used?: number
  self_confidence?: number
  evaluator_confidence?: number
  evaluator?: StudyEvaluator
  assistance?: StudyAssistance
  transfer_level?: EvidenceDimension
  concepts?: string[]
  patterns?: string[]
  objective_ids?: string[]
  diagnoses?: StudyDiagnosisRecord[]
  source_anchors?: StudySourceAnchor[]
  artifact_refs?: string[]
  activity_kind?: string
  source?: string
  session_id?: string
  revision_of?: string
}

/** The explicit agreement for one learning Session. */
export interface LearningContract {
  schema_version: 'learning_contract.v1'
  contract_id: string
  project_id: string
  objective: string
  mode: LearningMode
  assistance_level: AssistanceLevel
  time_budget_minutes: number
  objective_ids?: string[]
  evidence_targets: EvidenceDimension[]
  created_at: string
}

/** A domain-shaped activity offered to the learner. */
export interface ActivitySpec extends StudyData {
  schema_version: 'study_activity_spec.v1'
  activity_id: string
  session_id: string
  project_id: string
  kind: string
  objective: string
  objective_ids: string[]
  evidence_target: EvidenceDimension
  assistance_level: AssistanceLevel
  instructions: string
  response_policy: string
  rubric_requirements: string[]
  source_anchors: StudySourceAnchor[]
  evidence_requirements: string[]
  reason: string
  status: string
  created_at: string
}

/** An ordered, resumable sequence of activities governed by one contract. */
export interface LearningSession {
  schema_version: 'learning_session.v1'
  session_id: string
  project_id: string
  contract: LearningContract
  status: 'active' | 'completed'
  started_at: string
  updated_at: string
  completed_at?: string
  evidence_ids: string[]
  activity_history: Array<ActivitySpec & { status: string; completed_at: string; evidence_attempt_id?: string }>
  current_activity?: ActivitySpec
  conversation_session_id?: string
}

/** One evidence-dimension projection inside a diagnosis. */
export interface DimensionProjection {
  status: 'observed' | 'unobserved'
  verification_status: VerificationStatus
  attempt_count: number
  average_score: number | null
  evidence_attempt_ids: string[]
  independently_verified_attempt_ids: string[]
  assistance_provenance: Record<string, number>
  evaluator_provenance: Record<string, number>
}

export interface ConceptProjection {
  concept: string
  attempt_count: number
  average_score: number
  evidence_attempt_ids: string[]
}

export interface DiagnosisCluster {
  kind: string
  concept: string
  count: number
  evidence_attempt_ids: string[]
}

/** The derived, revisable competency projection from a set of attempts. */
export interface Diagnosis {
  attempt_count: number
  average_score: number
  concepts: ConceptProjection[]
  diagnosis_clusters: DiagnosisCluster[]
  transfer_evidence: Record<string, number>
  evidence_dimensions: Record<string, DimensionProjection>
  score_delta_earlier_to_later: number | null
}

export interface CompetencySnapshot {
  schema_version: 'competency_snapshot.v1'
  project_id: string
  objective_ids: string[]
  built_at: string
  evidence_count: number
  evidence_attempt_ids: string[]
  dimensions: Record<string, DimensionProjection>
  concepts: ConceptProjection[]
  diagnosis_clusters: DiagnosisCluster[]
  score_delta_earlier_to_later: number | null
  evaluator_provenance: Record<string, number>
  unverified_dimensions: string[]
}

export interface ContinuationState {
  state: 'continue' | 'ready_to_finish'
  reason: 'time_budget_reached' | 'contract_evidence_observed' | 'contract_evidence_pending'
  observed_evidence_targets: string[]
  pending_evidence_targets: string[]
  elapsed_activity_seconds: number
  time_budget_seconds: number
  learner_controls_follow_up: boolean
}

/** One evidence-backed recommendation inside an Intervention Queue item. */
export interface RecommendedActivity {
  activity_kind: InterventionKind
  evidence_target: EvidenceDimension
  assistance_level: AssistanceLevel
  duration_minutes: number
  duration_source: string
  duration_sample_size: number
  requires_evaluator: boolean
  success_criteria: string[]
  source_anchors: StudySourceAnchor[]
}

export interface InterventionItem {
  intervention_id: string
  objective_id: string
  capability: string
  kind: InterventionKind
  evidence_dimension: EvidenceDimension
  priority_score: number
  priority_band: 'high' | 'medium' | 'low'
  reasons: string[]
  reason_factors: {
    verification_status: VerificationStatus
    evidence_age_days: number | null
    evidence_age_band: EvidenceAgeBand
    freshness_threshold_days: number
    days_to_deadline: number | null
    deadline_band: DeadlineBand
    repeated_diagnosis_count: number
    outcome_adjustment: number
    outcome_improvement_rate: number | null
    outcome_sample_size: number
    outcome_source: string
  }
  latest_evidence_at: string | null
  evidence_attempt_ids: string[]
  recommended_activity: RecommendedActivity
}

export interface InterventionQueue {
  schema_version: 'study_intervention_queue.v1'
  project_id: string
  policy_version: 'study_intervention_policy.v1'
  generated_at: string
  as_of: string
  deadline: string | null
  days_to_deadline: number | null
  items: InterventionItem[]
  evidence_attempt_ids: string[]
  unscoped_attempt_ids: string[]
  deferred_objectives: string[]
  warnings: string[]
}

export interface DayPlanEvent {
  id: string
  title: string
  subject_id: string
  type: string
  start: string
  end: string
  duration_minutes: number
  goals: string[]
  status: 'planned'
  source_intervention_id: string
  source_objective_id: string
  evidence_dimension: string
  routing: string
}

export interface DayPlanScheduleEntry {
  schedule_id: string
  schedule_title: string
  phase_id: string
  phase_goal: string
  minutes_budget: number
  minutes_budget_nominal: number
  minutes_planned: number
  events: DayPlanEvent[]
}

export interface DayPlan {
  schema_version: 'study_day_plan.v1'
  target_date: string
  timezone: string
  study_window: {
    start_hour: number
    end_hour: number
    source: string
    sample_size: number
    coverage: number | null
  }
  capacity: Record<string, unknown> | null
  minutes_budget: number
  minutes_budget_nominal: number
  minutes_planned: number
  schedules: DayPlanScheduleEntry[]
  unplaced: Array<{ intervention_id: string; reason: string }>
}

/** A durable candidate derived from an Intervention Queue, decided then optionally applied. */
export interface PlanProposal {
  schema_version: 'study_plan_proposal.v1'
  proposal_id: string
  project_id: string
  policy_version: 'study_intervention_policy.v1'
  generation_fingerprint: string
  title: string
  status: PlanProposalStatus
  rationale: string
  created_at: string
  as_of: string
  items: InterventionItem[]
  day_plan: DayPlan | null
  evidence_attempt_ids: string[]
  schedule_change: { state: 'not_applied'; requires_explicit_save: true }
  decision?: {
    outcome: 'accepted' | 'rejected'
    decided_at: string
    note?: string
  }
}

/** A candidate problem-pattern change derived from repeated diagnoses. */
export interface PatternProposal {
  schema_version: 'study_pattern_proposal.v1'
  proposal_id: string
  project_id: string
  title: string
  change_type: 'create' | 'supplement' | 'split' | 'merge' | 'demote'
  status: 'candidate' | 'accepted' | 'rejected'
  rationale: string
  evidence_attempt_ids: string[]
  suggested_change?: Record<string, unknown>
  created_at: string
}

/** A parsed vault note. */
export interface StudyNote {
  path: string
  basename: string
  title: string
  layer: string
  frontmatter: Record<string, unknown>
  tags: string[]
  concepts: string[]
  patterns: string[]
  aliases: string[]
  headings: Array<{ level: number; text: string }>
  wikilinks: string[]
  excerpt: string
  size: number
  modified: string
  body?: string
}

/** Spaced-repetition state read from a note's frontmatter. */
export interface ReviewState {
  review_count: number
  last_reviewed_at: string
  next_review_at: string
}

/** One evidence-backed next-action suggestion derived from a diagnosis. */
export interface Recommendation {
  priority: string
  intervention: string
  concept?: string
  reason: string
  evidence_attempt_ids: string[]
  evidence_dimension?: string
}
