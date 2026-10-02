import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import css from './SubagentReadOnlyComposer.module.css'

/** Why a catalog-addressed conversation cannot accept human input. */
export interface SubagentReadOnlyMatch {
  reason: 'one-shot' | 'parent-unavailable'
}

/** Full chain props after the read-only subagent selector accepts the owner currency. */
export type SubagentReadOnlyComposerProps =
  PropsRuntime<'conversation.composer'> & { matched: SubagentReadOnlyMatch } & PropsLocale<typeof NS>

/**
 * Explain why the normal composer is unavailable for an addressed child.
 * @param props - selector-owned read-only reason plus standard slot props.
 * @returns A read-only composer replacement.
 */
export function SubagentReadOnlyComposer({
  matched, t,
}: Pick<SubagentReadOnlyComposerProps, 'matched' | 't'>) {
  const oneShot = matched.reason === 'one-shot'
  const dreaming = typeof window !== 'undefined' && (window.location.pathname === '/hivemind/app/overview/dreaming'
    || new URLSearchParams(window.location.search).has('dreamingParent'))
  const [agenda, setAgenda] = useState('')
  const [schedule, setSchedule] = useState<{
    enabled: boolean
    activity: { nextRunAt: string | null; timezone: string; scheduleState: string }
  }>()
  const [scheduleError, setScheduleError] = useState(false)
  useEffect(() => {
    if (!dreaming) return
    const controller = new AbortController()
    let loading = false
    const refresh = async () => {
      if (loading || controller.signal.aborted) return
      loading = true
      try {
        const response = await fetch('/hivemind/dreamer/settings?view=activity', { credentials: 'include', signal: controller.signal })
        if (!response.ok) throw new Error('schedule')
        const value = await response.json()
        if (!controller.signal.aborted) { setSchedule(value); setScheduleError(false) }
      } catch { if (!controller.signal.aborted) setScheduleError(true) }
      finally { loading = false }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 15000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [dreaming])
  useEffect(() => {
    if (!dreaming) return
    const controller = new AbortController()
    const update = (event: Event) => { setAgenda((event as CustomEvent<{ text: string }>).detail.text) }
    window.addEventListener('hivemind:dream-agenda-saved', update)
    void fetch('/hivemind/dreamer/agenda', { credentials: 'include', signal: controller.signal })
      .then(async (response) => { if (response.ok) setAgenda((await response.json() as { text: string }).text) })
      .catch(() => undefined)
    return () => { controller.abort(); window.removeEventListener('hivemind:dream-agenda-saved', update) }
  }, [dreaming])
  return (<div>
    {dreaming && agenda && <aside className={css.checkpoint} aria-label="Saved dream agenda">
      <strong>🌙 Agenda saved for the next dream</strong><p>{agenda}</p>
      <span>A suggestion for the next exploration. No run has been started.</span>
    </aside>}
    <div className={css.frame} role="status">
      {dreaming ? <>
        <strong>Next dream</strong>
        <span>{scheduleError ? 'The next dream time could not be refreshed.' : !schedule ? 'Checking the next dream…' : !schedule.enabled || schedule.activity.scheduleState === 'off' ? 'Dreaming is off.' : schedule.activity.nextRunAt ? <><time dateTime={schedule.activity.nextRunAt}>{new Date(schedule.activity.nextRunAt).toLocaleString(undefined, { timeZone: schedule.activity.timezone, dateStyle: 'medium', timeStyle: 'short' })}</time> · {schedule.activity.timezone}</> : 'The next dream is not scheduled yet.'}</span>
      </> : <><strong>{t(oneShot ? 'readonly.oneShot.title' : 'readonly.title')}</strong><span>{t(oneShot ? 'readonly.oneShot.body' : 'readonly.body')}</span></>}
    </div></div>
  )
}
