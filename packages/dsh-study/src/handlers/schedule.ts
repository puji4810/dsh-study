/**
 * StudyOS schedule handler: template / validate / save / list / read. Mirrors the Python
 * `tools.py` `handle_study_schedule` verbatim plus `_schedule_template` and the relationship
 * validation, so registered schedules and model-facing values stay identical.
 * @module @puji4810/dsh-study/handlers/schedule
 */

import { err, errFrom, ok, StudyOSError, type StudyEnvelope } from '../errors.ts'
import { domainPackFor } from '../domain-packs.ts'
import type { StudyData, StudyProject } from '../types.ts'
import { validateStudySchedule, validateScheduleRelationships } from '../validate.ts'
import {
  readJsonFile,
  readProjectManifest,
  resolveVaultPath,
  schedulePath,
  StudyWorkspace,
  validateScheduleId,
  writeText,
} from '../vault.ts'
import type { HandlerEnv } from './dispatch.ts'

/** True for a non-null, non-array object — Python `isinstance(value, dict)`. */
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

/** The Python `_schedule_template`: a project's pack-owned starter template. */
function scheduleTemplate(project: StudyProject): Record<string, unknown> {
  return domainPackFor(project).scheduleTemplate(project)
}

/** Validate a schedule structurally then against its project; returns `(ok, value)` plus errors. */
function validateScheduleForProject(
  data: unknown,
  project: StudyProject,
): { ok: boolean; value: Record<string, unknown> | null; errors: string[] } {
  const result = validateStudySchedule(data)
  if (!result.ok) {
    return { ok: false, value: null, errors: result.errors }
  }
  if (!isObject(result.value)) {
    return { ok: false, value: null, errors: ['Schedule validator returned invalid data'] }
  }
  const relationshipErrors = validateScheduleRelationships(project, result.value)
  if (relationshipErrors.length > 0) {
    return { ok: false, value: null, errors: relationshipErrors }
  }
  return { ok: true, value: result.value, errors: [] }
}

/**
 * Handle a study_schedule operation.
 * @param args - the operation payload.
 * @param env - the handler environment.
 * @returns the operation envelope.
 */
export function handleStudySchedule(args: StudyData, env: HandlerEnv): StudyEnvelope {
  try {
    const vault = resolveVaultPath(args['vault_path'], env.vaultPath)
    const action = stringify(args['action'], 'list').trim()
    if (action === 'template') {
      const project = readProjectManifest(vault, args['project_id'])
      return ok({ schedule: scheduleTemplate(project) })
    }
    if (action === 'validate') {
      const dataValue = args['data']
      const dataProjectId = isObject(dataValue) ? dataValue['project_id'] : undefined
      const project = readProjectManifest(vault, args['project_id'] ?? dataProjectId)
      const validated = validateScheduleForProject(dataValue, project)
      if (!validated.ok) {
        return err('VALIDATION_FAILED', validated.errors.join('; '), { errors: validated.errors })
      }
      return ok({ schedule: validated.value })
    }
    if (action === 'save') {
      const dataValue = args['data']
      if (!isObject(dataValue)) {
        return err('VALIDATION_FAILED', 'data must be a JSON object')
      }
      const project = readProjectManifest(vault, args['project_id'] ?? dataValue['project_id'])
      const validated = validateScheduleForProject(dataValue, project)
      if (!validated.ok) {
        return err('VALIDATION_FAILED', validated.errors.join('; '), { errors: validated.errors })
      }
      if (validated.value === null) {
        return err('VALIDATION_FAILED', 'Schedule validator returned invalid data')
      }
      const path = schedulePath(vault, project.project_id, String(validated.value['schedule_id']))
      writeText(path, JSON.stringify(validated.value))
      return ok({
        schedule: validated.value,
        path: path.slice(vault.length + 1),
        registered: true,
        panel_discovery: 'automatic_on_next_refresh',
        registration_policy: (
          'schedule.save is the registration step; do not write or register the file separately.'
        ),
      })
    }
    if (action === 'list') {
      const catalog = new StudyWorkspace({ vault, source: 'explicit' }).discoverSchedules(
        typeof args['project_id'] === 'string' ? args['project_id'] : undefined,
        validateScheduleRelationships,
      )
      const schedules = catalog.schedules.map(schedule => ({
        schedule_id: schedule.schedule_id,
        project_id: schedule.project_id,
        title: schedule.title,
        timezone: schedule.timezone,
        range: schedule.range,
        phase_count: schedule.phases.length,
        event_count: schedule.events.length,
        path: schedule.path,
      }))
      return ok({
        project_id: catalog.project_id,
        schedules,
        invalid_schedules: catalog.invalid_schedules,
      })
    }
    if (action === 'read') {
      const project = readProjectManifest(vault, args['project_id'])
      const scheduleId = validateScheduleId(args['schedule_id'])
      const path = schedulePath(vault, project.project_id, scheduleId)
      let data: Record<string, unknown>
      try {
        data = readJsonFile(path)
      } catch {
        return err('SCHEDULE_NOT_FOUND', `StudyOS schedule not found: ${scheduleId}`)
      }
      const validated = validateScheduleForProject(data, project)
      if (!validated.ok) {
        return err('VALIDATION_FAILED', validated.errors.join('; '), { errors: validated.errors })
      }
      return ok({ schedule: validated.value, path: path.slice(vault.length + 1) })
    }
    return err('INVALID_ACTION', `Unsupported study_schedule action: ${action}`)
  } catch (error) {
    if (error instanceof StudyOSError) return errFrom(error)
    return err('STUDY_SCHEDULE_FAILED', messageOf(error))
  }
}
