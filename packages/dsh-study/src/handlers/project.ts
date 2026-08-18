/**
 * StudyOS project handler: init / select / status / update_prompt_summary. Mirrors the
 * original `handle_study_project` plus `_default_project_manifest` and
 * `_summary_reach_warnings` verbatim so manifests and model-facing values stay identical.
 * @module @puji4810/dsh-study/handlers/project
 */

import { existsSync, readdirSync } from 'node:fs'
import { DEFAULT_PROMPT_POLICY, PROJECT_SCHEMA_VERSION_V1, PROJECT_SCHEMA_VERSION_V2 } from '../constants.ts'

import { err, errFrom, ok, StudyOSError, type StudyEnvelope } from '../errors.ts'
import { domainPackFor } from '../domain-packs.ts'
import { estimateTokens } from '../prompt-budget.ts'
import type { StudyData } from '../types.ts'
import { validateStudyProject } from '../validate.ts'
import {
  activeProjectPath,
  projectManifestPath,
  promptPolicy,
  promptSummaryPath,
  readProjectManifest,
  resolveVaultPath,
  scheduleDir,
  StudyWorkspace,
  validateProjectId,
  writeText,
} from '../vault.ts'
import { nowIso, type HandlerEnv } from './dispatch.ts'

/** Deep-copy a JSON-structured value. */
function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** True for a non-null, non-array object (plain-object check). */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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

/** Sorted `.json` names inside a directory, or empty when missing. */
function sortedJsonNames(root: string): string[] {
  try {
    return readdirSync(root).filter(name => name.endsWith('.json')).sort()
  } catch {
    return []
  }
}

/** The active pointer names the given project, or false when there is no active pointer. */
function activeIsProject(vault: string, projectId: string): boolean {
  if (!existsSync(activeProjectPath(vault))) return false
  try {
    return new StudyWorkspace({ vault, source: 'explicit' }).activeProjectId() === projectId
  } catch {
    return false
  }
}

/**
 * Build a project manifest from pack defaults and explicit overrides, the original
 * `_default_project_manifest` way.
 * @param args - the init arguments.
 * @param timestamp - the current ISO timestamp.
 * @returns the candidate manifest.
 */
export function defaultProjectManifest(args: StudyData, timestamp: string): StudyData {
  const requestedSchemaVersion = stringify(args['schema_version'], PROJECT_SCHEMA_VERSION_V1).trim()
  const requestedDomainPack = stringify(args['domain_pack'], '').trim()
  const requestedDomain = stringify(args['domain'], '').trim()
  const requestedExamType = stringify(args['exam_type'], '').trim()
  const pack = domainPackFor({
    domain_pack: requestedDomainPack,
    domain: requestedDomain || (requestedExamType === '考研' ? 'kaoyan' : ''),
  })
  const defaults = deepCopy(pack.projectDefaults as StudyData)
  const common: StudyData = {
    schema_version: requestedSchemaVersion,
    project_id: stringify(args['project_id'], stringify(defaults['project_id'], '')).trim(),
    title: stringify(args['title'], stringify(defaults['title'], '')).trim(),
    domain: stringify(args['domain'], stringify(defaults['domain'], '')).trim(),
    timezone: stringify(args['timezone'], 'Asia/Shanghai').trim(),
    phase: stringify(args['phase'], stringify(defaults['phase'], '')).trim(),
    domain_pack: stringify(args['domain_pack'], pack.id).trim(),
    workspace_type: stringify(args['workspace_type'], stringify(defaults['workspace_type'], '')).trim(),
    artifact_policy: stringify(args['artifact_policy'], stringify(defaults['artifact_policy'], '')).trim(),
    prompt_policy: { ...DEFAULT_PROMPT_POLICY },
    created_at: timestamp,
    updated_at: timestamp,
  }
  if (requestedSchemaVersion === PROJECT_SCHEMA_VERSION_V2) {
    common['tracks'] = Array.isArray(args['tracks']) ? args['tracks'] : []
    common['objectives'] = Array.isArray(args['objectives']) ? args['objectives'] : []
    const deadline = args['deadline']
    if (typeof deadline === 'string' && deadline.trim()) {
      common['deadline'] = deadline.trim()
    }
    return common
  }
  common['exam_type'] = stringify(args['exam_type'], stringify(defaults['exam_type'], '')).trim()
  common['exam_date'] = stringify(args['exam_date'], stringify(defaults['exam_date'], '')).trim()
  common['subjects'] = Array.isArray(args['subjects']) ? args['subjects'] : defaults['subjects']
  return common
}

/**
 * Report the part of a stored summary the prompt reader cannot reach, the original
 * `_summary_reach_warnings` way.
 * @param summary - the stored summary text.
 * @param policy - the merged prompt policy.
 * @returns the reach warnings.
 */
export function summaryReachWarnings(summary: string, policy: StudyData): string[] {
  const poolTokens = Math.trunc(Number(policy['total_max_tokens']))
  const totalMaxChars = Math.trunc(Number(policy['total_max_chars']))
  const warnings: string[] = []
  const tokens = estimateTokens(summary)
  if (tokens > poolTokens) {
    warnings.push(
      `summary is ${tokens} tokens; prompt_context.load shares a ${poolTokens} `
      + 'token pool (total_max_tokens) across every fragment, so its tail will '
      + 'not reach the model',
    )
  }
  if (summary.length > totalMaxChars) {
    warnings.push(
      `summary is ${summary.length} characters; prompt_context.load shares a `
      + `${totalMaxChars} character ceiling (total_max_chars) across every `
      + 'fragment, so its tail will not reach the model',
    )
  }
  return warnings
}

/**
 * Handle a study_project operation.
 * @param args - the operation payload.
 * @param env - the handler environment.
 * @returns the operation envelope.
 */
export function handleStudyProject(args: StudyData, env: HandlerEnv): StudyEnvelope {
  try {
    const vault = resolveVaultPath(args['vault_path'], env.vaultPath)
    const action = stringify(args['action'], 'status').trim()
    if (action === 'init') {
      const manifest = defaultProjectManifest(args, nowIso(env))
      const result = validateStudyProject(manifest)
      if (!result.ok) return err('VALIDATION_FAILED', result.errors.join('; '))
      if (!isObject(result.value)) {
        return err('VALIDATION_FAILED', 'Project validator returned invalid data')
      }
      const projectId = String(result.value['project_id'])
      const manifestPath = projectManifestPath(vault, projectId)
      writeText(manifestPath, JSON.stringify(result.value))
      const workspace = new StudyWorkspace({ vault, source: 'explicit' })
      workspace.selectProject(projectId)
      const activePath = workspace.activeProjectPath
      return ok({
        project: result.value,
        path: manifestPath.slice(vault.length + 1),
        active_path: activePath.slice(vault.length + 1),
      })
    }
    if (action === 'select') {
      const projectId = validateProjectId(args['project_id'])
      const workspace = new StudyWorkspace({ vault, source: 'explicit' })
      const manifest = workspace.selectProject(projectId)
      const activePath = workspace.activeProjectPath
      return ok({ project: manifest, active_path: activePath.slice(vault.length + 1) })
    }
    if (action === 'status') {
      const manifest = readProjectManifest(vault, args['project_id'])
      const projectId = manifest.project_id
      const summaryPath = promptSummaryPath(vault, projectId)
      const scheduleCount = sortedJsonNames(scheduleDir(vault, projectId)).length
      return ok({
        project: manifest,
        active: activeIsProject(vault, projectId),
        prompt_summary_exists: existsSync(summaryPath),
        schedule_count: scheduleCount,
      })
    }
    if (action === 'update_prompt_summary') {
      const manifest = readProjectManifest(vault, args['project_id'])
      const summary = stringify(args['summary'], '')
      const path = promptSummaryPath(vault, manifest.project_id)
      writeText(path, summary)
      return ok(
        {
          project_id: manifest.project_id,
          path: path.slice(vault.length + 1),
          char_count: summary.length,
        },
        summaryReachWarnings(summary, promptPolicy(manifest)),
      )
    }
    return err('INVALID_ACTION', `Unsupported study_project action: ${action}`)
  } catch (error) {
    if (error instanceof StudyOSError) return errFrom(error)
    return err('STUDY_PROJECT_FAILED', messageOf(error))
  }
}
