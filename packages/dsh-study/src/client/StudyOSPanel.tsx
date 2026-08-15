/** Workspace-scoped StudyOS overview opened from the sidebar footer. */

import { useCallback, useEffect, useState } from 'react'
import { IconSkillOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { StudyDashboardOverview } from '@puji4810/dsh-study/types'
import type { StudyOSPanelFace } from './slots.ts'
import type {} from './locales.ts'
import css from './StudyOSPanel.module.css'

/** Full StudyOS panel props composed by the sidebar footer-action slot. */
export type StudyOSPanelProps =
  PropsRuntime<'sidebar.footer.action'> & InjectFace<StudyOSPanelFace> & PropsLocale<'studyos'>

/**
 * Render the StudyOS workspace dashboard and project selector.
 * @param props - sidebar runtime, localized copy, and StudyOS Remote actions.
 * @returns footer trigger and its workspace panel.
 */
export function StudyOSPanel({ wide, useSessions, load, selectProject, t }: StudyOSPanelProps) {
  const current = useSessions(state => state.current)
  const [open, setOpen] = useState(false)
  const [overview, setOverview] = useState<StudyDashboardOverview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (current === undefined) {
      setOverview(null)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      setOverview(await load(current))
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

  const chooseProject = async (projectId: string) => {
    if (current === undefined || loading) return
    setLoading(true)
    setError(null)
    try {
      setOverview(await selectProject(current, projectId))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={wide ? css.layer : `${css.layer} ${css.rail}`}>
      {open && (
        <section className={css.panel} data-studyos-panel aria-label={t('title')}>
          <header className={css.header}>
            <span className={css.title}>{t('title')}</span>
            <button type="button" className={css.refresh} disabled={loading || current === undefined} onClick={() => { void refresh() }}>
              {t('refresh')}
            </button>
          </header>
          <div className={css.body}>
            {current === undefined && <p className={css.note}>{t('noSession')}</p>}
            {current !== undefined && loading && overview === null && <p className={css.note}>{t('loading')}</p>}
            {error !== null && <p className={css.error} role="alert">{t('readFailed', { message: error })}</p>}
            {overview !== null && (
              <>
                <section className={css.vault}>
                  <span>{t('vault')}</span>
                  <code title={overview.vaultPath}>{overview.vaultPath}</code>
                </section>
                <section>
                  <h3 className={css.sectionTitle}>{t('projects')}</h3>
                  {overview.projects.length === 0 && <p className={css.note}>{t('empty')}</p>}
                  <ul className={css.rows}>
                    {overview.projects.map(project => {
                      const active = project.projectId === overview.activeProjectId
                      return (
                        <li key={project.projectId} className={css.project} data-active={active || undefined}>
                          <div className={css.projectHead}>
                            <span className={css.projectTitle}>{project.title}</span>
                            {active
                              ? <span className={css.active}>{t('active')}</span>
                              : <button type="button" disabled={loading} onClick={() => { void chooseProject(project.projectId) }}>{t('select')}</button>}
                          </div>
                          <span className={css.projectMeta}>{`${project.domain} · ${project.phase}`}</span>
                          <span className={css.projectMeta}>{`${t('schedules', { count: project.scheduleCount })} · ${t('attempts', { count: project.attemptCount })}`}</span>
                          {project.deadline !== undefined && <time className={css.deadline}>{project.deadline}</time>}
                        </li>
                      )
                    })}
                  </ul>
                </section>
                <section>
                  <div className={css.sectionHead}>
                    <h3 className={css.sectionTitle}>{t('reviews')}</h3>
                    <span>{t('reviewCount', { count: overview.dueReviewCount })}</span>
                  </div>
                  {overview.dueReviews.length === 0
                    ? <p className={css.note}>{t('noReviews')}</p>
                    : <ul className={css.rows}>
                        {overview.dueReviews.map(review => (
                          <li key={review.path} className={css.review}>
                            <span className={css.reviewTitle}>{review.title}</span>
                            <span className={css.projectMeta}>{`${t('level', { level: review.reviewLevel })} · ${review.path}`}</span>
                            {review.concepts.length > 0 && <span className={css.concepts}>{review.concepts.join(' · ')}</span>}
                          </li>
                        ))}
                      </ul>}
                </section>
              </>
            )}
          </div>
        </section>
      )}
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
