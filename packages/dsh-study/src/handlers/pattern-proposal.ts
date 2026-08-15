/**
 * StudyOS pattern-proposal handler: save / list / read. Mirrors the Python `learning.py`
 * `_proposal_activity` verbatim so candidate pattern changes and their model-facing values
 * stay identical.
 * @module @puji4810/dsh-study/handlers/pattern-proposal
 */

import { existsSync, readdirSync } from 'node:fs'
import { PATTERN_PROPOSAL_SCHEMA_VERSION } from '../constants.ts'
import { err, errFrom, ok, StudyOSError, type StudyEnvelope } from '../errors.ts'
import type { StudyData } from '../types.ts'
import { validatePatternProposal } from '../validate.ts'
import {
  allAttempts,
  patternProposalDir,
  readJsonFile,
  readProjectManifest,
  resolveVaultPath,
  validateScheduleId,
  writeText,
} from '../vault.ts'
import { nowIso, type HandlerEnv } from './dispatch.ts'

/** True for a non-null, non-array object — Python `isinstance(value, dict)`. */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Render an unknown thrown value as a message string. */
function messageOf(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
}

/**
 * Handle a pattern_proposal action.
 * @param action - the proposal action.
 * @param args - the payload.
 * @param env - the handler environment.
 * @returns the action envelope.
 */
export function handlePatternProposalActivity(action: string, args: StudyData, env: HandlerEnv): StudyEnvelope {
  try {
    const vault = resolveVaultPath(args['vault_path'], env.vaultPath)
    const project = readProjectManifest(vault, args['project_id'])
    const root = patternProposalDir(vault, project.project_id)
    if (action === 'save') {
      const proposalValue = args['proposal']
      const proposal: StudyData = isObject(proposalValue) ? { ...proposalValue } : {}
      if (proposal['schema_version'] === undefined) proposal['schema_version'] = PATTERN_PROPOSAL_SCHEMA_VERSION
      if (proposal['project_id'] === undefined) proposal['project_id'] = project.project_id
      if (proposal['status'] === undefined) proposal['status'] = 'candidate'
      if (proposal['created_at'] === undefined) proposal['created_at'] = nowIso(env)
      const validated = validatePatternProposal(proposal)
      if (!validated.ok) {
        return err('VALIDATION_FAILED', validated.errors.join('; '), { errors: validated.errors })
      }
      if (!isObject(validated.value)) {
        return err('VALIDATION_FAILED', 'Pattern proposal validator returned invalid data')
      }
      const knownIds = new Set(allAttempts(vault, project.project_id).map(item => item.attempt_id))
      const missing = (validated.value['evidence_attempt_ids'] as unknown[]).map(String)
        .filter(id => !knownIds.has(id))
      if (missing.length > 0) {
        return err('EVIDENCE_NOT_FOUND', 'Proposal references unknown attempts', { attempt_ids: missing })
      }
      const proposalId = validateScheduleId(validated.value['proposal_id'])
      const path = `${root}/${proposalId}.json`
      if (existsSync(path)) {
        return err('PROPOSAL_EXISTS', `Pattern proposal already exists: ${proposalId}`)
      }
      writeText(path, `${JSON.stringify(validated.value, null, 2)}\n`)
      return ok({ proposal: validated.value, path: path.slice(vault.length + 1) })
    }
    if (action === 'list') {
      const proposals: Record<string, unknown>[] = []
      for (const file of sortedJsonFiles(root)) {
        proposals.push(readJsonFile(`${root}/${file}`))
      }
      return ok({ project_id: project.project_id, proposals })
    }
    if (action === 'read') {
      const proposalId = validateScheduleId(args['proposal_id'])
      const path = `${root}/${proposalId}.json`
      if (!existsSync(path)) {
        return err('PROPOSAL_NOT_FOUND', `Pattern proposal not found: ${proposalId}`)
      }
      return ok({ proposal: readJsonFile(path) })
    }
    return err('INVALID_ACTION', `Unsupported pattern_proposal action: ${action}`)
  } catch (error) {
    if (error instanceof StudyOSError) return errFrom(error)
    return err('STUDY_ACTIVITY_FAILED', messageOf(error))
  }
}

/** Sorted `.json` file names inside a directory, or empty when missing. */
function sortedJsonFiles(root: string): string[] {
  try {
    return readdirSync(root).filter(name => name.endsWith('.json')).sort()
  } catch {
    return []
  }
}
