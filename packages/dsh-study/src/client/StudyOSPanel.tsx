/** Workspace-scoped StudyOS dashboard opened from the sidebar footer. */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
  IconCloseOutline16,
  IconSkillOutline16,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {
  StudyDashboardCalendarDay,
  StudyDashboardOverview,
  StudyDashboardProject,
} from '@puji4810/dsh-study/types'
import type { StudyOSPanelFace } from './slots.ts'
import { StudyPlanPanel } from './StudyPlanPanel.tsx'
import type {} from './locales.ts'
import css from './StudyOSPanel.module.css'

/** Full StudyOS panel props composed by the sidebar footer-action slot. */
export type StudyOSPanelProps =
  PropsRuntime<'sidebar.footer.action'> & InjectFace<StudyOSPanelFace> & PropsLocale<'studyos'>

type View = 'project' | 'plan' | 'calendar'

/** The framework-injected translate seat for the `studyos` locale. */
type T = TranslateNS<'studyos'>

const WEEKDAYS_ZH = ['日', '一', '二', '三', '四', '五', '六']
const WEEKDAYS_EN = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const MONTHS_ZH = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月']
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** True when the locale copy looks like Simplified Chinese. */
function isZh(title: string): boolean {
  return /[\u4e00-\u9fff]/.test(title)
}

/** The ISO date (`YYYY-MM-DD`) that a UTC-midnight Date represents. */
function isoOf(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * Render the StudyOS workspace dashboard living in a dsh-style modal window:
 * a left project list plus the selected project's schedule arrangement and a
 * month calendar.
 * @param props - sidebar runtime, localized copy, and StudyOS Remote actions.
 * @returns footer trigger and its big workspace window.
 */
export function StudyOSPanel({
  wide,
  useSessions,
  load,
  selectProject,
  previewPlan,
  latestPlan,
  savePlan,
  decidePlan,
  applyPlan,
  t,
}: StudyOSPanelProps) {
  const current = useSessions(state => state.current)
  const [open, setOpen] = useState(false)
  const [overview, setOverview] = useState<StudyDashboardOverview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<View>('project')
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [viewYear, setViewYear] = useState(() => new Date().getFullYear())
  const [viewMonth, setViewMonth] = useState(() => new Date().getMonth())
  const [selectedDate, setSelectedDate] = useState<string>(() => isoOf(new Date()))
  const zhUI = useMemo(() => isZh(t('title')), [t])

  const refresh = useCallback(async () => {
    if (current === undefined) {
      setOverview(null)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const next = await load(current)
      setOverview(next)
      setActiveProjectId(prev => prev ?? next.activeProjectId ?? next.projects?.[0]?.projectId ?? null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [current, load])

  useEffect(() => {
    if (!open) return
    void refresh()
  }, [open, refresh])

  const close = useCallback(() => {
    setOpen(false)
    setOverview(null)
  }, [])

  const chooseProject = async (projectId: string) => {
    if (current === undefined || loading) return
    setActiveProjectId(projectId)
    setLoading(true)
    setError(null)
    try {
      const next = await selectProject(current, projectId)
      setOverview(next)
      setActiveProjectId(projectId)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  const activeProject = useMemo(
    () => overview?.projects?.find(project => project.projectId === activeProjectId) ?? null,
    [overview, activeProjectId],
  )

  // Calendar data keyed by date for O(1) lookup.
  const daysByDate = useMemo(() => {
    const map = new Map<string, StudyDashboardCalendarDay>()
    for (const day of overview?.calendar?.days ?? []) map.set(day.date, day)
    return map
  }, [overview])

  // Build the month grid cells (including leading/trailing blanks).
  const monthCells = useMemo(() => {
    const year = viewYear
    const month = viewMonth
    const first = new Date(Date.UTC(year, month, 1))
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
    const leading = first.getUTCDay()
    const cells: Array<{ date: string; day: number; inMonth: boolean }> = []
    for (let i = 0; i < leading; i += 1) {
      const d = new Date(Date.UTC(year, month, i - leading + 1))
      cells.push({ date: isoOf(d), day: d.getUTCDate(), inMonth: false })
    }
    for (let day = 1; day <= daysInMonth; day += 1) {
      cells.push({ date: isoOf(new Date(Date.UTC(year, month, day))), day, inMonth: true })
    }
    let fill = new Date(`${cells[cells.length - 1]!.date}T00:00:00Z`)
    while (cells.length % 7 !== 0) {
      fill = new Date(fill.getTime() + 86_400_000)
      cells.push({ date: isoOf(fill), day: fill.getUTCDate(), inMonth: false })
    }
    return cells
  }, [viewYear, viewMonth])

  const shiftMonth = (delta: number) => {
    setViewMonth(prev => {
      const next = prev + delta
      if (next < 0) { setViewYear(y => y - 1); return 11 }
      if (next > 11) { setViewYear(y => y + 1); return 0 }
      return next
    })
  }

  const selectedDay = daysByDate.get(selectedDate)
  const weekdayNames = zhUI ? WEEKDAYS_ZH : WEEKDAYS_EN
  const monthNames = zhUI ? MONTHS_ZH : MONTHS_EN

  return (
    <div className={wide ? css.layer : `${css.layer} ${css.rail}`}>
      <Modal
        open={open}
        onClose={close}
        title={t('title')}
        closeLabel={t('close')}
        className={css.modal}
        headless
      >
        <div className={css.window} data-studyos-panel>
          <header className={css.header}>
            <span className={css.title}>{t('title')}</span>
            <div className={css.headerActions}>
              <button
                type="button"
                className={css.refresh}
                disabled={loading || current === undefined}
                onClick={() => { void refresh() }}
              >
                {t('refresh')}
              </button>
              <button type="button" className={css.closeIcon} aria-label={t('close')} onClick={close}>
                <IconCloseOutline16 size={14} />
              </button>
            </div>
          </header>

          <div className={css.layout}>
            {/* Left column: project list + view switch. */}
            <aside className={css.railCol}>
              <button
                type="button"
                className={`${css.navItem} ${view === 'project' ? css.navActive : ''}`}
                onClick={() => { setView('project') }}
              >
                {t('allProjects')}
              </button>
              <button
                type="button"
                className={`${css.navItem} ${view === 'plan' ? css.navActive : ''}`}
                onClick={() => { setView('plan') }}
              >
                {t('tabPlan')}
              </button>
              <button
                type="button"
                className={`${css.navItem} ${view === 'calendar' ? css.navActive : ''}`}
                onClick={() => { setView('calendar') }}
              >
                {t('tabCalendar')}
              </button>
              <div className={css.railSep} />
              <nav className={css.projectList} aria-label={t('allProjects')}>
                {overview?.projects?.map(project => (
                  <button
                    type="button"
                    key={project.projectId}
                    className={`${css.projectNav} ${project.projectId === activeProjectId ? css.projectNavActive : ''}`}
                    onClick={() => { void chooseProject(project.projectId) }}
                  >
                    <span className={css.projectNavTitle}>{project.title || project.projectId}</span>
                    <span className={css.projectNavMeta}>
                      {project.phase || project.domain}
                    </span>
                  </button>
                ))}
              </nav>
            </aside>

            {/* Main content. */}
            <div className={css.main}>
              {current === undefined && <p className={css.note}>{t('noSession')}</p>}
              {current !== undefined && loading && overview === null && <p className={css.note}>{t('loading')}</p>}
              {error !== null && <p className={css.error} role="alert">{t('readFailed', { message: error })}</p>}

              {overview !== null && current !== undefined && view === 'project' && activeProject !== null && (
                <ProjectDetail project={activeProject} t={t} />
              )}

              {overview !== null && current !== undefined && view === 'plan' && activeProject !== null && (
                <StudyPlanPanel
                  sessionId={current}
                  project={activeProject}
                  previewPlan={previewPlan}
                  latestPlan={latestPlan}
                  savePlan={savePlan}
                  decidePlan={decidePlan}
                  applyPlan={applyPlan}
                  onApplied={refresh}
                  t={t}
                />
              )}

              {overview !== null && current !== undefined && view === 'calendar' && (
                <div className={css.calendar}>
                  <div className={css.calendarHead}>
                    <button
                      type="button"
                      className={css.monthNav}
                      aria-label={t('prevMonth')}
                      onClick={() => { shiftMonth(-1) }}
                    >
                      <IconChevronLeftOutline14 />
                    </button>
                    <span className={css.monthLabel}>{`${viewYear} ${monthNames[viewMonth]}`}</span>
                    <button
                      type="button"
                      className={css.monthNav}
                      aria-label={t('nextMonth')}
                      onClick={() => { shiftMonth(1) }}
                    >
                      <IconChevronRightOutline14 />
                    </button>
                  </div>

                  <div className={css.weekdays}>
                    {weekdayNames.map(name => <span key={name} className={css.weekday}>{name}</span>)}
                  </div>

                  <div className={css.grid}>
                    {monthCells.map(cell => {
                      const day = daysByDate.get(cell.date)
                      const today = cell.date === isoOf(new Date())
                      const selected = cell.date === selectedDate
                      const evCount = day?.events?.length ?? 0
                      const msCount = day?.milestones?.length ?? 0
                      const hasContent = day !== undefined && (evCount > 0 || msCount > 0 || (day.dueReviewCount ?? 0) > 0)
                      return (
                        <button
                          type="button"
                          key={cell.date}
                          className={`${css.cell} ${cell.inMonth ? css.cellIn : css.cellOut} ${today ? css.cellToday : ''} ${selected ? css.cellSelected : ''}`}
                          onClick={() => { setSelectedDate(cell.date) }}
                          aria-label={cell.date}
                        >
                          <span className={css.cellDay}>{cell.day}</span>
                          {(day?.dueReviewCount ?? 0) > 0 && (
                            <span className={css.reviewBadge} title={t('dueToday', { count: day?.dueReviewCount ?? 0 })}>
                              {day?.dueReviewCount}
                            </span>
                          )}
                          {msCount > 0 && <span className={css.cellMark} />}
                          {evCount > 0 && (
                            <span className={css.cellEventDot} title={day?.events?.map(e => e.title).join(' · ') ?? ''} />
                          )}
                          <span className={hasContent ? css.cellContent : undefined}>
                            {evCount > 0 && <span className={css.cellEventText}>{evCount}</span>}
                          </span>
                        </button>
                      )
                    })}
                  </div>

                  <div className={css.dayDetail}>
                    <div className={css.dayDetailHead}>
                      <span>{selectedDate}</span>
                      {(selectedDay?.dueReviewCount ?? 0) > 0 && (
                        <span className={css.reviewBadge}>{t('dueToday', { count: selectedDay?.dueReviewCount ?? 0 })}</span>
                      )}
                    </div>
                    {selectedDay === undefined
                      ? <p className={css.note}>{t('calendarEmpty')}</p>
                      : (() => {
                          const evs = selectedDay.events ?? []
                          const mss = selectedDay.milestones ?? []
                          return (
                            <>
                              {evs.length > 0 && (
                                <ul className={css.rows}>
                                  {evs.map(event => (
                                    <li key={event.id} className={css.eventRow} data-status={event.status}>
                                      <div className={css.eventTitle}>{event.title}</div>
                                      <div className={css.projectMeta}>
                                        {`${event.projectTitle} · ${event.scheduleTitle} · ${timeOf(event.start)}`}
                                      </div>
                                    </li>
                                  ))}
                                </ul>
                              )}
                              {mss.length > 0 && (
                                <ul className={css.milestones}>
                                  {mss.map((milestone, index) => (
                                    <li key={`${milestone.date}-${milestone.label}-${index}`} className={css.milestone} data-kind={milestone.kind}>
                                      <span className={css.milestoneKind}>{milestoneLabel(t, milestone.kind)}</span>
                                      <span className={css.milestoneText}>{milestone.label}</span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                              {evs.length === 0 && mss.length === 0 && (
                                <p className={css.note}>{t('calendarEmpty')}</p>
                              )}
                            </>
                          )
                        })()}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </Modal>

      <button
        type="button"
        className={css.trigger}
        aria-label={t('title')}
        aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}
      >
        <span aria-hidden><IconSkillOutline16 size={wide ? 16 : 18} /></span>
        {wide && <span>{t('trigger')}</span>}
      </button>
    </div>
  )
}

function timeOf(iso: string): string {
  const match = /T(\d{2}:\d{2})/.exec(iso)
  return match ? match[1] ?? iso : iso
}

function milestoneLabel(t: T, kind: string): string {
  if (kind === 'deadline') return t('milestoneDeadline')
  if (kind === 'exam') return t('milestoneExam')
  return t('milestonePhase')
}

/** Phase status copy, falling back to the raw value when unknown. */
function phaseStatusText(t: T, status: string | undefined): string {
  if (status === 'in_progress') return t('inProgressStatus')
  if (status === 'planned') return t('plannedStatus')
  if (status === 'completed') return t('completedStatus')
  return status ?? t('notCompleted')
}

/** The selected project's summary + its schedule (日期安排) arrangement. */
function ProjectDetail({ project, t }: { project: StudyDashboardProject; t: T }) {
  const schedules = project.schedules ?? []
  return (
    <div className={css.detail}>
      <header className={css.projectHeadMain}>
        <div className={css.projectTitleMain}>{project.title}</div>
        {project.deadline !== undefined && (
          <span className={css.deadline}>{`${t('milestoneDeadline')} ${project.deadline}`}</span>
        )}
      </header>

      <div className={css.profileMeta}>
        <span>{`${project.domain} · ${project.phase}`}</span>
        <span>{t('schedules', { count: project.scheduleCount })}</span>
        <span>{t('attempts', { count: project.attemptCount })}</span>
        {project.objectiveCount > 0 && <span>{t('objectives', { count: project.objectiveCount })}</span>}
      </div>

      {(project.subjectLabels?.length ?? 0) > 0 && (
        <div className={css.taskTags}>
          {project.subjectLabels?.map(label => <span key={label} className={css.taskTag}>{label}</span>)}
        </div>
      )}

      <section>
        <div className={css.sectionHead}>
          <h3 className={css.sectionTitle}>{t('scheduleArrangement')}</h3>
          <span>{t('phases', { count: schedules.reduce((sum, s) => sum + (s.phases?.length ?? 0), 0) })}</span>
        </div>
        {schedules.length === 0 && <p className={css.note}>{t('noSchedule')}</p>}
        <ul className={css.scheduleList}>
          {schedules.map(schedule => (
            <li key={schedule.scheduleId} className={css.scheduleCard}>
              <div className={css.scheduleHead}>
                <span className={css.scheduleTitle}>{schedule.title}</span>
                <span className={css.scheduleRange}>
                  {t('betweenDates', { start: schedule.rangeStart, end: schedule.rangeEnd })}
                </span>
              </div>
              <div className={css.profileMeta}>
                <span>{t('phases', { count: schedule.phaseCount })}</span>
                <span>{t('eventCount', { count: schedule.eventCount })}</span>
              </div>
              {(schedule.phases?.length ?? 0) > 0 && (
                <ul className={css.phaseList}>
                  {schedule.phases.map(phase => (
                    <li key={phase.id} className={css.phaseRow} data-status={phase.status}>
                      <div className={css.phaseTop}>
                        <span className={css.phaseTitle}>{phase.title || phase.id}</span>
                        <span className={css.phaseStatus}>{phaseStatusText(t, phase.status)}</span>
                      </div>
                      <div className={css.phaseDates}>
                        {t('betweenDates', { start: phase.start, end: phase.end })}
                        {phase.effortMinutes !== undefined && ` · ${t('effort', { minutes: phase.effortMinutes })}`}
                      </div>
                      {phase.goal && <p className={css.phaseGoal}>{phase.goal}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
