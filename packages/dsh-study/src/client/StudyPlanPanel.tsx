/** Interactive plan workspace for evidence-derived StudyOS interventions. */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  DayPlanPlacementPreference,
  DayPlanPreferences,
  DayPlanTimeWindow,
  InterventionItem,
  PlanProposal,
  StudyDashboardPlanPreview,
  StudyDashboardProject,
} from '@puji4810/dsh-study/types'
import type { StudyOSPanelFace } from './slots.ts'
import type {} from './locales.ts'
import css from './StudyOSPanel.module.css'

type T = TranslateNS<'studyos'>
type SessionId = Parameters<StudyOSPanelFace['load']>[0]
type WorkingAction = 'latest' | 'preview' | 'save' | 'accept' | 'reject' | 'apply'

interface PlacementDraft {
  scheduleId: string
  startTime: string
  durationMinutes: string
}

interface PlanForm {
  targetDate: string
  maxItems: string
  useCustomWindows: boolean
  windows: DayPlanTimeWindow[]
  busy: DayPlanTimeWindow[]
  breakMinutes: string
  maxMinutes: string
  allowDurationAdjustment: boolean
  minDurationMinutes: string
  order: string[]
  deferred: string[]
  placements: Record<string, PlacementDraft>
}

export interface StudyPlanPanelProps {
  sessionId: SessionId
  project: StudyDashboardProject
  previewPlan: StudyOSPanelFace['previewPlan']
  latestPlan: StudyOSPanelFace['latestPlan']
  savePlan: StudyOSPanelFace['savePlan']
  decidePlan: StudyOSPanelFace['decidePlan']
  applyPlan: StudyOSPanelFace['applyPlan']
  onApplied(): Promise<void>
  t: T
}

function todayIso(): string {
  const today = new Date()
  return [
    String(today.getFullYear()).padStart(4, '0'),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0'),
  ].join('-')
}

function initialForm(): PlanForm {
  return {
    targetDate: todayIso(),
    maxItems: '4',
    useCustomWindows: false,
    windows: [{ start: '19:00', end: '23:00' }],
    busy: [],
    breakMinutes: '10',
    maxMinutes: '',
    allowDurationAdjustment: true,
    minDurationMinutes: '15',
    order: [],
    deferred: [],
    placements: {},
  }
}

function positiveInt(value: string): number | undefined {
  if (value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function buildPreferences(form: PlanForm): DayPlanPreferences {
  const preferences: DayPlanPreferences = { target_date: form.targetDate }
  if (form.useCustomWindows) preferences.windows = form.windows
  if (form.busy.length > 0) preferences.busy = form.busy
  const breakMinutes = positiveInt(form.breakMinutes)
  if (breakMinutes !== undefined) preferences.break_minutes = breakMinutes
  const maxMinutes = positiveInt(form.maxMinutes)
  if (maxMinutes !== undefined && maxMinutes > 0) preferences.max_minutes = maxMinutes
  preferences.allow_duration_adjustment = form.allowDurationAdjustment
  const minDuration = positiveInt(form.minDurationMinutes)
  if (minDuration !== undefined && minDuration > 0) preferences.min_duration_minutes = minDuration
  if (form.order.length > 0) preferences.intervention_order = form.order
  if (form.deferred.length > 0) preferences.defer_intervention_ids = form.deferred
  const placements: DayPlanPlacementPreference[] = Object.entries(form.placements).flatMap(([interventionId, draft]) => {
    const duration = positiveInt(draft.durationMinutes)
    if (draft.scheduleId === '' && draft.startTime === '' && duration === undefined) return []
    return [{
      intervention_id: interventionId,
      ...(draft.scheduleId !== '' ? { schedule_id: draft.scheduleId } : {}),
      ...(draft.startTime !== '' ? { start_time: draft.startTime } : {}),
      ...(duration !== undefined && duration > 0 ? { duration_minutes: duration } : {}),
    }]
  })
  if (placements.length > 0) preferences.placements = placements
  return preferences
}

function statusLabel(t: T, proposal: PlanProposal): string {
  if (proposal.status === 'accepted') return t('planAccepted')
  if (proposal.status === 'rejected') return t('planRejected')
  return t('planProposed')
}

function interventionLabel(t: T, kind: InterventionItem['kind']): string {
  const labels: Record<InterventionItem['kind'], Parameters<T>[0]> = {
    evidence_probe: 'kindEvidenceProbe',
    guided_repair: 'kindGuidedRepair',
    independence_probe: 'kindIndependenceProbe',
    misconception_probe: 'kindMisconceptionProbe',
    prerequisite_repair: 'kindPrerequisiteRepair',
    near_transfer_probe: 'kindNearTransferProbe',
    far_transfer_probe: 'kindFarTransferProbe',
    retention_probe: 'kindRetentionProbe',
  }
  return t(labels[kind])
}

function verificationLabel(t: T, value: InterventionItem['reason_factors']['verification_status']): string {
  if (value === 'independent') return t('verificationIndependent')
  if (value === 'supported') return t('verificationSupported')
  if (value === 'developing') return t('verificationDeveloping')
  return t('verificationUnobserved')
}

/** Configure, preview, decide, and apply one project's plan proposal. */
export function StudyPlanPanel({
  sessionId,
  project,
  previewPlan,
  latestPlan,
  savePlan,
  decidePlan,
  applyPlan,
  onApplied,
  t,
}: StudyPlanPanelProps) {
  const [form, setForm] = useState<PlanForm>(() => initialForm())
  const [preview, setPreview] = useState<StudyDashboardPlanPreview | null>(null)
  const [proposal, setProposal] = useState<PlanProposal | null>(null)
  const [persisted, setPersisted] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [working, setWorking] = useState<WorkingAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const updateForm = useCallback((update: (current: PlanForm) => PlanForm) => {
    setForm(current => update(current))
    setDirty(proposal !== null)
    setNotice(null)
  }, [proposal])

  useEffect(() => {
    let cancelled = false
    setForm(initialForm())
    setPreview(null)
    setProposal(null)
    setPersisted(false)
    setDirty(false)
    setError(null)
    setNotice(null)
    setWorking('latest')
    void latestPlan(sessionId, project.projectId)
      .then((latest) => {
        if (cancelled) return
        setProposal(latest)
        setPersisted(latest !== null)
        if (latest !== null) {
          setForm(current => ({ ...current, order: latest.items.map(item => item.intervention_id) }))
        }
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (!cancelled) setWorking(null)
      })
    return () => { cancelled = true }
  }, [latestPlan, project.projectId, sessionId])

  const queueItems = useMemo(() => {
    const items = preview?.interventionQueue.items ?? proposal?.items ?? []
    const byId = new Map(items.map(item => [item.intervention_id, item]))
    const order = form.order.length > 0 ? form.order : items.map(item => item.intervention_id)
    return [
      ...order.flatMap(id => byId.get(id) ?? []),
      ...items.filter(item => !order.includes(item.intervention_id)),
    ]
  }, [form.order, preview, proposal])

  const plannedEvents = useMemo(
    () => proposal?.day_plan?.schedules.flatMap(schedule => schedule.events.map(event => ({ ...event, scheduleTitle: schedule.schedule_title }))) ?? [],
    [proposal],
  )

  const runPreview = async () => {
    setWorking('preview')
    setError(null)
    setNotice(null)
    try {
      const maxItems = positiveInt(form.maxItems)
      const result = await previewPlan(sessionId, {
        projectId: project.projectId,
        ...(maxItems !== undefined && maxItems > 0 ? { maxItems } : {}),
        scheduling: buildPreferences(form),
      })
      const ids = result.interventionQueue.items.map(item => item.intervention_id)
      setPreview(result)
      setProposal(result.proposal)
      setPersisted(false)
      setDirty(false)
      setForm(current => ({
        ...current,
        order: current.order.length === ids.length && current.order.every(id => ids.includes(id)) ? current.order : ids,
        deferred: current.deferred.filter(id => ids.includes(id)),
      }))
      setNotice(result.proposal === null ? t('planNoProposal') : t('planPreviewReady'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setWorking(null)
    }
  }

  const saveCurrent = async () => {
    if (proposal === null || dirty) return
    setWorking('save')
    setError(null)
    setNotice(null)
    try {
      const result = await savePlan(sessionId, { projectId: project.projectId, proposal })
      setProposal(result.proposal)
      setPersisted(true)
      setNotice(result.created ? t('planSaved') : t('planAlreadySaved'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setWorking(null)
    }
  }

  const decide = async (decision: 'accept' | 'reject') => {
    if (proposal === null || !persisted || proposal.status !== 'proposed') return
    setWorking(decision)
    setError(null)
    setNotice(null)
    try {
      const result = await decidePlan(sessionId, {
        projectId: project.projectId,
        proposalId: proposal.proposal_id,
        decision,
      })
      setProposal(result.proposal)
      setNotice(decision === 'accept' ? t('planAcceptedNotice') : t('planRejectedNotice'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setWorking(null)
    }
  }

  const applyCurrent = async () => {
    if (proposal === null || !persisted || proposal.status !== 'accepted') return
    setWorking('apply')
    setError(null)
    setNotice(null)
    try {
      const result = await applyPlan(sessionId, {
        projectId: project.projectId,
        proposalId: proposal.proposal_id,
      })
      await onApplied()
      setNotice(t('planApplied', { count: result.appliedEventCount }))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setWorking(null)
    }
  }

  const moveItem = (interventionId: string, delta: number) => {
    updateForm(current => {
      const order = current.order.length > 0 ? [...current.order] : queueItems.map(item => item.intervention_id)
      const index = order.indexOf(interventionId)
      const target = index + delta
      if (index < 0 || target < 0 || target >= order.length) return current
      ;[order[index], order[target]] = [order[target]!, order[index]!]
      return { ...current, order }
    })
  }

  const toggleDeferred = (interventionId: string) => {
    updateForm(current => ({
      ...current,
      deferred: current.deferred.includes(interventionId)
        ? current.deferred.filter(id => id !== interventionId)
        : [...current.deferred, interventionId],
    }))
  }

  const updatePlacement = (interventionId: string, patch: Partial<PlacementDraft>) => {
    updateForm((current) => {
      const placement = current.placements[interventionId] ?? {
        scheduleId: '',
        startTime: '',
        durationMinutes: '',
      }
      return {
        ...current,
        placements: {
          ...current.placements,
          [interventionId]: { ...placement, ...patch },
        },
      }
    })
  }

  return (
    <div className={css.planWorkspace} data-studyos-plan>
      <header className={css.projectHeadMain}>
        <div>
          <div className={css.projectTitleMain}>{t('planTitle')}</div>
          <p className={css.planLead}>{t('planDescription')}</p>
        </div>
        <span className={css.planProject}>{project.title}</span>
      </header>

      <section className={css.planSection}>
        <div className={css.sectionHead}>
          <h3 className={css.sectionTitle}>{t('planConstraints')}</h3>
          <span>{t('agentFreedom')}</span>
        </div>
        <div className={css.planFormGrid}>
          <label className={css.field}>
            <span>{t('targetDate')}</span>
            <input
              type="date"
              value={form.targetDate}
              onChange={event => updateForm(current => ({ ...current, targetDate: event.target.value }))}
            />
          </label>
          <label className={css.field}>
            <span>{t('maxItems')}</span>
            <input
              type="number"
              min="1"
              max="20"
              value={form.maxItems}
              onChange={event => updateForm(current => ({ ...current, maxItems: event.target.value }))}
            />
          </label>
          <label className={css.field}>
            <span>{t('breakMinutes')}</span>
            <input
              type="number"
              min="0"
              max="120"
              value={form.breakMinutes}
              onChange={event => updateForm(current => ({ ...current, breakMinutes: event.target.value }))}
            />
          </label>
          <label className={css.field}>
            <span>{t('dailyLimit')}</span>
            <input
              type="number"
              min="1"
              max="1440"
              placeholder={t('noLimit')}
              value={form.maxMinutes}
              onChange={event => updateForm(current => ({ ...current, maxMinutes: event.target.value }))}
            />
          </label>
        </div>

        <label className={css.toggleRow}>
          <input
            type="checkbox"
            checked={form.useCustomWindows}
            onChange={event => updateForm(current => ({ ...current, useCustomWindows: event.target.checked }))}
          />
          <span>
            <strong>{t('customWindows')}</strong>
            <small>{form.useCustomWindows ? t('customWindowsOn') : t('customWindowsOff')}</small>
          </span>
        </label>

        {form.useCustomWindows && (
          <TimeWindowEditor
            label={t('availableWindows')}
            windows={form.windows}
            canBeEmpty={false}
            onChange={windows => updateForm(current => ({ ...current, windows }))}
            t={t}
          />
        )}

        <TimeWindowEditor
          label={t('busyPeriods')}
          windows={form.busy}
          canBeEmpty
          onChange={busy => updateForm(current => ({ ...current, busy }))}
          t={t}
        />

        <div className={css.agentControls}>
          <label className={css.toggleRow}>
            <input
              type="checkbox"
              checked={form.allowDurationAdjustment}
              onChange={event => updateForm(current => ({ ...current, allowDurationAdjustment: event.target.checked }))}
            />
            <span>
              <strong>{t('allowAgentAdjust')}</strong>
              <small>{t('allowAgentAdjustHint')}</small>
            </span>
          </label>
          {form.allowDurationAdjustment && (
            <label className={css.inlineField}>
              <span>{t('minDuration')}</span>
              <input
                type="number"
                min="1"
                max="720"
                value={form.minDurationMinutes}
                onChange={event => updateForm(current => ({ ...current, minDurationMinutes: event.target.value }))}
              />
            </label>
          )}
        </div>

        <div className={css.planActions}>
          <button type="button" className={css.primaryButton} disabled={working !== null} onClick={() => { void runPreview() }}>
            {working === 'preview' ? t('previewingPlan') : t('previewPlan')}
          </button>
          {dirty && <span className={css.staleHint}>{t('repreviewHint')}</span>}
        </div>
      </section>

      {working === 'latest' && <p className={css.note}>{t('loadingLatestPlan')}</p>}
      {error !== null && <p className={css.error} role="alert">{t('planFailed', { message: error })}</p>}
      {notice !== null && <p className={css.success} role="status">{notice}</p>}

      {queueItems.length > 0 && (
        <section className={css.planSection}>
          <div className={css.sectionHead}>
            <h3 className={css.sectionTitle}>{t('interventionQueue')}</h3>
            <span>{t('interventionCount', { count: queueItems.length })}</span>
          </div>
          <p className={css.planHelp}>{t('queueHelp')}</p>
          <ol className={css.interventionList}>
            {queueItems.map((item, index) => {
              const placement = form.placements[item.intervention_id] ?? { scheduleId: '', startTime: '', durationMinutes: '' }
              const deferred = form.deferred.includes(item.intervention_id)
              return (
                <li key={item.intervention_id} className={`${css.interventionCard} ${deferred ? css.interventionDeferred : ''}`}>
                  <div className={css.interventionHead}>
                    <span className={css.rank}>{index + 1}</span>
                    <div className={css.interventionIdentity}>
                      <strong>{item.capability || item.objective_id}</strong>
                      <span>{`${interventionLabel(t, item.kind)} · ${item.evidence_dimension}`}</span>
                    </div>
                    <span className={css.priorityBadge} data-band={item.priority_band}>{Math.round(item.priority_score)}</span>
                  </div>
                  <div className={css.factorRow}>
                    <span>{t('verification', { value: verificationLabel(t, item.reason_factors.verification_status) })}</span>
                    <span>{t('recommendedDuration', { minutes: item.recommended_activity.duration_minutes })}</span>
                    {item.reason_factors.days_to_deadline !== null && (
                      <span>{t('daysToDeadline', { count: item.reason_factors.days_to_deadline })}</span>
                    )}
                  </div>
                  {item.reasons[0] !== undefined && <p className={css.reason}>{item.reasons[0]}</p>}
                  <div className={css.interventionControls}>
                    <div className={css.orderButtons}>
                      <button type="button" aria-label={t('moveUp')} disabled={index === 0} onClick={() => { moveItem(item.intervention_id, -1) }}>↑</button>
                      <button type="button" aria-label={t('moveDown')} disabled={index === queueItems.length - 1} onClick={() => { moveItem(item.intervention_id, 1) }}>↓</button>
                    </div>
                    <label className={css.compactToggle}>
                      <input type="checkbox" checked={deferred} onChange={() => { toggleDeferred(item.intervention_id) }} />
                      <span>{t('deferItem')}</span>
                    </label>
                    <label className={css.compactField}>
                      <span>{t('routeSchedule')}</span>
                      <select value={placement.scheduleId} onChange={event => updatePlacement(item.intervention_id, { scheduleId: event.target.value })}>
                        <option value="">{t('autoRoute')}</option>
                        {project.schedules.map(schedule => <option key={schedule.scheduleId} value={schedule.scheduleId}>{schedule.title}</option>)}
                      </select>
                    </label>
                    <label className={css.compactField}>
                      <span>{t('startTime')}</span>
                      <input type="time" value={placement.startTime} onChange={event => updatePlacement(item.intervention_id, { startTime: event.target.value })} />
                    </label>
                    <label className={css.compactField}>
                      <span>{t('durationOverride')}</span>
                      <input
                        type="number"
                        min="1"
                        max="720"
                        placeholder={String(item.recommended_activity.duration_minutes)}
                        value={placement.durationMinutes}
                        onChange={event => updatePlacement(item.intervention_id, { durationMinutes: event.target.value })}
                      />
                    </label>
                  </div>
                </li>
              )
            })}
          </ol>
        </section>
      )}

      {proposal !== null && (
        <section className={css.planSection}>
          <div className={css.planSummaryHead}>
            <div>
              <h3 className={css.planSummaryTitle}>{proposal.title}</h3>
              <p className={css.planHelp}>{proposal.rationale}</p>
            </div>
            <span className={css.statusBadge} data-status={proposal.status}>{statusLabel(t, proposal)}</span>
          </div>

          {proposal.day_plan !== null && (
            <div className={css.planMetrics}>
              <span>{t('planDate', { date: proposal.day_plan.target_date })}</span>
              <span>{t('minutesPlanned', { minutes: proposal.day_plan.minutes_planned })}</span>
              <span>{t('plannedEventCount', { count: plannedEvents.length })}</span>
              <span>{proposal.day_plan.scheduling?.mode === 'custom' ? t('customMode') : t('automaticMode')}</span>
            </div>
          )}

          {plannedEvents.length > 0 && (
            <ul className={css.plannedEvents}>
              {plannedEvents.map(event => (
                <li key={event.id}>
                  <time>{event.start.slice(11, 16)}</time>
                  <div>
                    <strong>{event.title}</strong>
                    <span>{`${event.scheduleTitle} · ${event.duration_minutes} min · ${event.routing}`}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {(proposal.day_plan?.unplaced.length ?? 0) > 0 && (
            <div className={css.unplacedBox}>
              <strong>{t('unplacedItems')}</strong>
              <ul>
                {proposal.day_plan?.unplaced.map(item => <li key={item.intervention_id}>{item.reason}</li>)}
              </ul>
            </div>
          )}

          <div className={css.planActions}>
            <button
              type="button"
              className={css.secondaryButton}
              disabled={working !== null || persisted || dirty || proposal.status !== 'proposed'}
              onClick={() => { void saveCurrent() }}
            >
              {working === 'save' ? t('savingPlan') : t('savePlan')}
            </button>
            <button
              type="button"
              className={css.primaryButton}
              disabled={working !== null || dirty || !persisted || proposal.status !== 'proposed'}
              onClick={() => { void decide('accept') }}
            >
              {working === 'accept' ? t('acceptingPlan') : t('acceptPlan')}
            </button>
            <button
              type="button"
              className={css.dangerButton}
              disabled={working !== null || dirty || !persisted || proposal.status !== 'proposed'}
              onClick={() => { void decide('reject') }}
            >
              {working === 'reject' ? t('rejectingPlan') : t('rejectPlan')}
            </button>
            <button
              type="button"
              className={css.primaryButton}
              disabled={working !== null || dirty || !persisted || proposal.status !== 'accepted' || plannedEvents.length === 0}
              onClick={() => { void applyCurrent() }}
            >
              {working === 'apply' ? t('applyingPlan') : t('applyPlan')}
            </button>
          </div>
        </section>
      )}

      {proposal === null && working !== 'latest' && queueItems.length === 0 && (
        <p className={css.note}>{t('noPlanYet')}</p>
      )}
    </div>
  )
}

function TimeWindowEditor({
  label,
  windows,
  canBeEmpty,
  onChange,
  t,
}: {
  label: string
  windows: DayPlanTimeWindow[]
  canBeEmpty: boolean
  onChange(windows: DayPlanTimeWindow[]): void
  t: T
}) {
  const add = () => onChange([...windows, { start: '19:00', end: '20:00' }])
  const patch = (index: number, next: Partial<DayPlanTimeWindow>) => {
    onChange(windows.map((window, candidate) => candidate === index ? { ...window, ...next } : window))
  }
  const remove = (index: number) => onChange(windows.filter((_, candidate) => candidate !== index))

  return (
    <fieldset className={css.windowEditor}>
      <legend>{label}</legend>
      {windows.map((window, index) => (
        <div key={`${label}-${index}`} className={css.windowRow}>
          <label>
            <span>{t('windowStart')}</span>
            <input type="time" value={window.start} onChange={event => patch(index, { start: event.target.value })} />
          </label>
          <span className={css.windowArrow}>→</span>
          <label>
            <span>{t('windowEnd')}</span>
            <input type="time" value={window.end} onChange={event => patch(index, { end: event.target.value })} />
          </label>
          <button
            type="button"
            className={css.removeButton}
            disabled={!canBeEmpty && windows.length === 1}
            aria-label={t('removeWindow')}
            onClick={() => { remove(index) }}
          >
            ×
          </button>
        </div>
      ))}
      <button type="button" className={css.linkButton} onClick={add}>+ {t('addWindow')}</button>
    </fieldset>
  )
}
