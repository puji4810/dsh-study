/**
 * Domain adapters that turn a learning objective into grounded activities, and judge
 * whether an observation carries the grounding evidence each domain demands. Every
 * field and message mirror the original activities module verbatim.
 * @module @puji4810/dsh-study/activities
 */

import { domainPackFor } from './domain-packs.ts'
import type { LearningContract, Recommendation, StudyProject, StudySourceAnchor } from './types.ts'

/** Evidence targets whose applied evidence must cite reproducible artifacts. */
export const APPLIED_EVIDENCE_TARGETS: ReadonlySet<string> = new Set(['execution', 'near_transfer', 'far_transfer'])

/** A stable grounding failure returned before evidence persistence. */
export interface EvidenceIssue {
  code: string
  message: string
}

/** The caller-owned facts an adapter needs to shape one activity. */
export interface ActivityContext {
  project: StudyProject
  contract: LearningContract
  evidence_target: string
  recommendation: Recommendation | null
  success_criteria: string[]
  source_anchors: StudySourceAnchor[]
}

/** The activity record an adapter receives for validation. */
export type StudyActivityRecord = Record<string, unknown>

/** A single observed attempt, as the runtime hands it to an adapter. */
export type StudyObservationRecord = Record<string, unknown>

/** A string value of an unknown, empty when absent or non-string. */
function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** A domain boundary for activity shape and acceptable evidence. */
export abstract class ActivityAdapter {
  readonly name: string = 'general.v1'

  /**
   * Return domain-specific activity fields merged onto the base activity.
   * @param context - the caller-owned activity context.
   * @returns fields to merge onto the activity record.
   */
  abstract build(context: ActivityContext): Record<string, unknown>

  /**
   * Return unmet domain evidence requirements before persistence.
   * @param _activity - the current activity record.
   * @param _observation - the candidate observation.
   * @returns the grounding issues, empty when the observation is acceptable.
   */
  validateObservation(_activity: StudyActivityRecord, _observation: StudyObservationRecord): EvidenceIssue[] {
    return []
  }
}

/** Default adapter for exam study and domain-neutral learning. */
export class GeneralActivityAdapter extends ActivityAdapter {
  override readonly name = 'general.v1'

  /** @inheritdoc */
  override build(context: ActivityContext): Record<string, unknown> {
    const target = context.evidence_target
    const recommendation = (context.recommendation ?? {}) as Record<string, unknown>
    return {
      activity_adapter: this.name,
      kind: stringValue(recommendation['intervention']) || 'evidence_probe',
      instructions: `Produce learner-authored ${target} evidence for: ${context.contract['objective']}`,
      response_policy: 'Collect the learner\'s response before feedback or evaluator judgment.',
      rubric_requirements: context.success_criteria.length > 0
        ? context.success_criteria
        : ['valid result', 'reasoning made explicit', 'independent contribution identified'],
      evidence_requirements: ['evaluator'],
    }
  }
}

/** The target-to-kind mapping for engineering groundings. */
const ENGINEERING_KINDS: Record<string, string> = {
  recall: 'engineering_retrieval',
  recognition: 'engineering_source_trace',
  execution: 'engineering_execution',
  explanation: 'engineering_invariant_explanation',
  near_transfer: 'engineering_near_transfer',
  far_transfer: 'engineering_design_transfer',
}

/** Ground engineering learning in real source, commands, and artifacts. */
export class EngineeringActivityAdapter extends ActivityAdapter {
  override readonly name = 'engineering.v1'

  /** @inheritdoc */
  override build(context: ActivityContext): Record<string, unknown> {
    const target = context.evidence_target
    const instructionsFor: Record<string, string> = {
      execution: (
        'Work in the real engineering workspace: run, trace, reproduce, or implement the smallest '
        + `observable task that demonstrates ${context.contract['objective']}.`
      ),
      explanation: (
        'Inspect the anchored implementation or command output, then explain the controlling invariant, '
        + `boundary, and one failure mode for ${context.contract['objective']}.`
      ),
      near_transfer: (
        'Change one implementation condition while preserving the core invariant; predict the result, '
        + 'execute it, and compare prediction with observed output.'
      ),
      far_transfer: (
        'Apply the demonstrated engineering principle in a materially different component or design, '
        + 'and justify which constraints still hold.'
      ),
    }
    const instructions = instructionsFor[target]
      ?? 'Retrieve the engineering concept from the actual source and identify where it controls runtime behavior.'
    const requirements = ['evaluator', 'source_anchors']
    if (APPLIED_EVIDENCE_TARGETS.has(target)) requirements.push('artifact_refs')
    return {
      activity_adapter: this.name,
      kind: ENGINEERING_KINDS[target] ?? 'engineering_source_trace',
      instructions,
      response_policy: 'Require a prediction or explanation before feedback; distinguish inspected facts from inference.',
      rubric_requirements: context.success_criteria.length > 0
        ? context.success_criteria
        : [
          'source file, symbol, command, or benchmark identified',
          'observable result recorded',
          'controlling invariant explained',
          'verification or failure condition stated',
        ],
      evidence_requirements: requirements,
    }
  }

  /** @inheritdoc */
  override validateObservation(activity: StudyActivityRecord, observation: StudyObservationRecord): EvidenceIssue[] {
    return groundingIssues(activity, observation)
  }
}

/** The target-to-kind mapping for research groundings. */
const RESEARCH_KINDS: Record<string, string> = {
  recall: 'research_claim_retrieval',
  recognition: 'research_source_grounding',
  execution: 'research_replication',
  explanation: 'research_mechanism_explanation',
  near_transfer: 'research_boundary_replication',
  far_transfer: 'research_hypothesis_transfer',
}

/** Ground research learning in claims, source locations, and replication artifacts. */
export class ResearchActivityAdapter extends ActivityAdapter {
  override readonly name = 'research.v1'

  /** @inheritdoc */
  override build(context: ActivityContext): Record<string, unknown> {
    const target = context.evidence_target
    const instructionsFor: Record<string, string> = {
      execution: (
        'Reproduce the smallest source-anchored result relevant to the objective. Record method, '
        + 'environment, observed result, and any divergence from the cited claim.'
      ),
      explanation: (
        'Explain the source-anchored claim in your own causal or mathematical terms, then state one '
        + 'assumption and one limitation that the evidence does not remove.'
      ),
      near_transfer: (
        'Vary one assumption, dataset slice, seed, or parameter from the source method; predict the '
        + 'effect and compare the replicated result with that prediction.'
      ),
      far_transfer: (
        'Form a falsifiable extension of the source claim in a different setting and specify the '
        + 'experiment and evidence that would reject it.'
      ),
    }
    const instructions = instructionsFor[target]
      ?? 'Locate the exact source claim and retrieve its method, evidence, and stated boundary without cues.'
    const requirements = ['evaluator', 'source_anchors']
    if (APPLIED_EVIDENCE_TARGETS.has(target)) requirements.push('artifact_refs')
    return {
      activity_adapter: this.name,
      kind: RESEARCH_KINDS[target] ?? 'research_source_grounding',
      instructions,
      response_policy: "Separate the source's claim, the learner's inference, and the observed replication result.",
      rubric_requirements: context.success_criteria.length > 0
        ? context.success_criteria
        : [
          'claim and exact source location identified',
          'method and environment recorded',
          'observed result distinguished from interpretation',
          'uncertainty, assumption, or limitation stated',
        ],
      evidence_requirements: requirements,
    }
  }

  /** @inheritdoc */
  override validateObservation(activity: StudyActivityRecord, observation: StudyObservationRecord): EvidenceIssue[] {
    return groundingIssues(activity, observation)
  }
}

/** Compute the shared grounding issues for engineering and research activities. */
function groundingIssues(activity: StudyActivityRecord, observation: StudyObservationRecord): EvidenceIssue[] {
  const issues: EvidenceIssue[] = []
  const anchors = observation['source_anchors'] ?? activity['source_anchors'] ?? []
  const nonEmptyAnchor = Array.isArray(anchors)
    && anchors.some(anchor => typeof anchor === 'object' && anchor !== null
      && stringValue((anchor as Record<string, unknown>)['ref']).trim() !== '')
  if (!Array.isArray(anchors) || !nonEmptyAnchor) {
    issues.push({
      code: 'SOURCE_ANCHOR_REQUIRED',
      message: 'This activity requires a file, command, paper, dataset, or other source anchor.',
    })
  }
  if (APPLIED_EVIDENCE_TARGETS.has(String(activity['evidence_target']))) {
    const artifacts = observation['artifact_refs']
    const invalidArtifacts = !Array.isArray(artifacts)
      || artifacts.length === 0
      || artifacts.some(item => typeof item !== 'string' || !item.trim())
    if (invalidArtifacts) {
      issues.push({
        code: 'ARTIFACT_REFERENCE_REQUIRED',
        message: 'Applied evidence requires artifact_refs naming reproducible commands, outputs, files, or results.',
      })
    }
  }
  return issues
}

/**
 * Return the adapter owned by the project's resolved Domain Pack.
 * @param project - the validated project manifest.
 * @returns the domain adapter.
 */
export function activityAdapterFor(project: StudyProject): ActivityAdapter {
  return domainPackFor(project).activityAdapter
}
