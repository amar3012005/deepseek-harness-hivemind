import { useEffect, useState } from 'react'
import css from './DreamingAutomation.module.css'
interface Run { id: string; status: string; created_at: string; updated_at: string; output_ids: string[] }
interface Activity {
  enabled: boolean
  activity: { session?: { parentSessionId: string; childSessionId: string; mode: 'continuable' }; timezone: string; cron: string; nextRunAt: string | null; scheduleState: string; runs: Run[] }
}
/** Read-only view of the existing dispatcher and durable tenant ledger, never a second schedule. */
export function DreamingAutomation() {
  const [state, setState] = useState<Activity>()
  const [error, setError] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    let busy = false
    const refresh = async () => {
      if (busy || controller.signal.aborted) return
      busy = true
      try {
        const response = await fetch('/hivemind/dreamer/settings?view=activity', { credentials: 'include', signal: controller.signal })
        if (!response.ok) throw new Error('activity_unavailable')
        const value = await response.json() as Activity
        if (!value.activity || !Array.isArray(value.activity.runs)) throw new Error('activity_invalid')
        if (!controller.signal.aborted) { setState(value); setError(false) }
      } catch { if (!controller.signal.aborted) setError(true) }
      finally { busy = false }
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 15000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [])
  const timing = state?.activity
  const date = (value: string) => new Date(value).toLocaleString(undefined, { timeZone: timing?.timezone, dateStyle: 'medium', timeStyle: 'short' })
  const latest = timing?.runs[0]
  const sessionHref = timing?.session ? '/hivemind/app/overview/dreaming' : undefined
  return <section className={css.card} aria-label="Nightly Dreaming">
    <div className={css.heading}><a className={css.sessionLink} href={sessionHref}>Nightly Dreaming</a><span>{state ? state.enabled ? 'On' : 'Off' : 'Loading…'}</span></div>
    <p>Company memory exploration → Flashbacks</p>
    {error && <p role="alert">Dreaming activity could not be refreshed. Displayed details may be stale.</p>}
    {timing && <>
      <p>Next run: {timing.nextRunAt ? `${date(timing.nextRunAt)} (${timing.timezone})` : timing.scheduleState === 'off' ? 'Not scheduled — Dreaming is Off' : timing.scheduleState === 'unavailable' ? 'Scheduler unavailable' : 'Waiting for schedule registration'}</p>
      <p>Status: {latest && ['queued', 'running'].includes(latest.status) ? latest.status : timing.scheduleState}. {latest && !['queued', 'running'].includes(latest.status) ? `Last run: ${latest.status}.` : ''}</p>
      <button type="button" aria-expanded={open} onClick={() => { setOpen(value => !value) }}>Run history ({timing.runs.length})</button>
      {open && <div aria-label="Dreaming run history">{timing.runs.length === 0 ? <p>No dreaming runs yet.</p> : <ol>{timing.runs.map(run => <li key={run.id}><time dateTime={run.created_at}>{date(run.created_at)}</time> · {run.status} · {run.output_ids.length} Flashbacks</li>)}</ol>}</div>}
    </>}
    {sessionHref && <a href={sessionHref}>View dreaming</a>}
    <a href="/hivemind/app/settings">Manage in Settings</a>
  </section>
}
