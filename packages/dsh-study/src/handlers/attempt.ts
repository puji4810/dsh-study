/**
 * StudyOS attempt handler: record / list / read. Mirrors the Python `learning.py`
 * `_record_attempt`, `_filtered_attempts`, and `_attempt_activity` verbatim so attempts and
 * model-facing values stay identical.
 * @module @puji4810/dsh-study/handlers/attempt
 */

import { randomUUID } from 'node:crypto'
import { ATTEMPT_SCHEMA_VERSION, DEFAULT_ATTEMPT_SCORES } from '../constants.ts'
import { err, errFrom, ok, StudyOSError, type StudyEnvelope } from '../errors.ts'
import type { StudyAttempt, StudyData } from '../types.ts'
import { boundedLimit } from '../util.ts'
import { validateStudyAttempt } from '../validate.ts'
import {
  allAttempts,
  appendAttemptFile,
  resolveVaultPath,
  readProjectManifest,
} from '../vault.ts'
import { nowIso, type HandlerEnv } from './dispatch.ts'

/** Strip a trailing `\.\d{3}Z` millisecond component from an ISO timestamp. */
function stripMillis(value: string): string {
  return value.replace(/\.\d{3}Z$/, 'Z')
}

/** Render a JSON scalar with a fallback, never producing `[object Object]`. */
function stringify(value: unknown, fallback: string): string {
  const resolved = value || fallback
  if (typeof resolved === 'string') return resolved
  if (typeof resolved === 'number' || typeof resolved === 'boolean') return String(resolved)
  return ''
}

/** Render an unknown thrown value as a message string. */
function messageOf(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
}

/**
 * Filter attempts the Python `_filtered_attempts` way by concept, pattern, result, item,
 * session, attempt ids, and an inclusive date range.
 * @param vault - the resolved vault path.
 * @param projectId - the project id.
 * @param filters - the filter record.
 * @returns the matching attempts in vault order.
 */
export function filteredAttempts(vault: string, projectId: string, filters: StudyData): StudyAttempt[] {
  const concept = stringify(filters['concept'], '').toLocaleLowerCase('en-US')
  const pattern = stringify(filters['pattern'], '').toLocaleLowerCase('en-US')
  const result = stringify(filters['result'], '')
  const itemId = stringify(filters['item_id'], '')
  const sessionId = stringify(filters['session_id'], '')
  const attemptIds = Array.isArray(filters['attempt_ids'])
    ? new Set(filters['attempt_ids'].map(String))
    : new Set<string>()
  const start = stringify(filters['start_date'], '')
  const end = stringify(filters['end_date'], '')

  const matches = (attempt: StudyAttempt): boolean => {
    const occurred = attempt.occurred_at.slice(0, 10)
    return !(
      (concept && !(attempt.concepts ?? []).some(value => value.toLocaleLowerCase('en-US') === concept))
      || (pattern && !(attempt.patterns ?? []).some(value => value.toLocaleLowerCase('en-US') === pattern))
      || (result && attempt.result !== result)
      || (itemId && attempt.item_id !== itemId)
      || (sessionId && attempt.session_id !== sessionId)
      || (attemptIds.size > 0 && !attemptIds.has(attempt.attempt_id))
      || (start && occurred < start)
      || (end && occurred > end)
    )
  }
  return allAttempts(vault, projectId).filter(matches)
}

/**
 * Record one immutable attempt into its monthly file.
 * @param args - the attempt payload.
 * @param env - the handler environment.
 * @returns the record envelope.
 */
export function recordAttempt(args: StudyData, env: HandlerEnv): StudyEnvelope {
  try {
    const vault = resolveVaultPath(args['vault_path'], env.vaultPath)
    const project = readProjectManifest(vault, args['project_id'])
    const result = stringify(args['result'], '').trim()
    const defaultScore = DEFAULT_ATTEMPT_SCORES[result as keyof typeof DEFAULT_ATTEMPT_SCORES]
    let score: unknown = args['score']
    if (score === null || score === undefined) score = defaultScore
    const occurredAt = stripMillis(stringify(args['occurred_at'], nowIso(env)))
    const attempt: Record<string, unknown> = {
      schema_version: ATTEMPT_SCHEMA_VERSION,
      attempt_id: stringify(args['attempt_id'], `att-${randomUUID().replace(/-/g, '').slice(0, 16)}`).trim(),
      project_id: project.project_id,
      item_id: stringify(args['item_id'], '').trim(),
      occurred_at: occurredAt,
      response: stringify(args['response'], '').trim(),
      result,
      score,
      duration_seconds: args['duration_seconds'],
      hints_used: args['hints_used'] ?? 0,
      evaluator_confidence: args['evaluator_confidence'],
      evaluator: args['evaluator'],
      assistance: args['assistance'],
      transfer_level: args['transfer_level'],
      concepts: args['concepts'] ?? [],
      patterns: args['patterns'] ?? [],
      objective_ids: args['objective_ids'] ?? [],
      diagnoses: args['diagnoses'] ?? [],
      source_anchors: args['source_anchors'],
      artifact_refs: args['artifact_refs'],
      activity_kind: args['activity_kind'],
      source: args['source'],
      session_id: args['session_id'],
      revision_of: args['revision_of'],
    }
    const trimmed = Object.fromEntries(
      Object.entries(attempt).filter(([, value]) => value !== null && value !== undefined),
    )
    const validated = validateStudyAttempt(trimmed)
    if (!validated.ok) {
      return err('VALIDATION_FAILED', validated.errors.join('; '), { errors: validated.errors })
    }
    const record = validated.value as unknown as StudyAttempt
    if (allAttempts(vault, project.project_id).some(item => item.attempt_id === record.attempt_id)) {
      return err('ATTEMPT_EXISTS', `Attempt already exists: ${record.attempt_id}`)
    }
    const path = appendAttemptFile(vault, project.project_id, record, occurredAt)
    return ok({ attempt: record, path })
  } catch (error) {
    if (error instanceof StudyOSError) return errFrom(error)
    return err('STUDY_ACTIVITY_FAILED', messageOf(error))
  }
}

/**
 * Handle an attempt action.
 * @param action - the attempt action.
 * @param args - the payload.
 * @param env - the handler environment.
 * @returns the action envelope.
 */
export function handleAttemptActivity(action: string, args: StudyData, env: HandlerEnv): StudyEnvelope {
  try {
    if (action === 'record') return recordAttempt(args, env)
    const vault = resolveVaultPath(args['vault_path'], env.vaultPath)
    const project = readProjectManifest(vault, args['project_id'])
    if (action === 'list') {
      const limit = boundedLimit(args['limit'], 100, 500)
      const attempts = filteredAttempts(vault, project.project_id, args)
      return ok({
        project_id: project.project_id,
        count: attempts.length,
        attempts: attempts.slice(-limit),
      })
    }
    if (action === 'read') {
      const attemptId = stringify(args['attempt_id'], '').trim()
      for (const attempt of allAttempts(vault, project.project_id)) {
        if (attempt.attempt_id === attemptId) return ok({ attempt })
      }
      return err('ATTEMPT_NOT_FOUND', `Attempt not found: ${attemptId}`)
    }
    return err('INVALID_ACTION', `Unsupported attempt action: ${action}`)
  } catch (error) {
    if (error instanceof StudyOSError) return errFrom(error)
    return err('STUDY_ACTIVITY_FAILED', messageOf(error))
  }
}
