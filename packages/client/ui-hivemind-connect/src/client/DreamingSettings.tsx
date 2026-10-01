import { useEffect, useState } from 'react'
import css from './DreamingSettings.module.css'
interface State {
  enabled: boolean
  available: boolean
  canChange: boolean
  synced: boolean
}
/** One organization switch. The server derives tenant and checks administrator membership. */
export function DreamingSettings({ compact = false }: { compact?: boolean } = {}) {
  const [state, setState] = useState<State>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string>()
  useEffect(() => {
    const controller = new AbortController()
    void fetch('/hivemind/dreamer/settings', { credentials: 'include', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('load')
        setState((await response.json()) as State)
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('Dreaming settings are unavailable.')
      })
    return () =>{  controller.abort() }
  }, [])
  async function change(): Promise<void> {
    if (!state || busy) return
    setBusy(true)
    setError(undefined)
    try {
      const response = await fetch('/hivemind/dreamer/settings', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !state.enabled }),
      })
      if (!response.ok) throw new Error('save')
      setState((await response.json()) as State)
    } catch {
      setError('The setting could not be saved.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className={`${css.root} ${compact ? css.compact : ''}`} aria-label="Company dreaming">
      <div hidden={compact}>
        <strong>Dreaming</strong>
        <p hidden={compact}>Explore company memory automatically.
          Derived insights go directly to the company-visible Flashbacks project.</p>
        <p hidden={compact}>Turning this on authorizes scheduled exploration and saves to Flashbacks without per-dream approval.</p>
        {state && !state.canChange && <small>Only company administrators can change this setting.</small>}
        {state && !state.available && <small>Dreaming is not configured on this server yet.</small>}
        {error && <p role="alert">{error}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-label="Enable company dreaming"
        title={error ?? (state?.enabled ? 'Dreaming is on' : 'Dreaming is off')}
        aria-checked={state?.enabled ?? false}
        disabled={!state || busy || !state.canChange || (!state.available && !state.enabled)}
        onClick={() => void change()}
      >
        {compact ? null : state?.enabled ? 'On' : 'Off'}
      </button>
    </section>
  )
}
