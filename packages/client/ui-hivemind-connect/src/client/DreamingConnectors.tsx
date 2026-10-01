import { useEffect, useState } from 'react'
import css from './DreamingConnectors.module.css'
const appNames: Record<string, string> = { gmail: 'Gmail', slack: 'Slack', googledocs: 'Google Docs', googledrive: 'Google Drive', github: 'GitHub', outlook: 'Outlook', notion: 'Notion' }
interface Account { id: string; toolkit: string; label: string; enabled: boolean }
interface State { available: boolean; enabled: boolean; accounts: Account[] }
/** Explicit per-user, per-account Dreaming consent; connecting new apps stays in Connectors. */
export function DreamingConnectors() {
  const [state, setState] = useState<State>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    void fetch('/hivemind/dreamer/connectors', { credentials: 'include', signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error('load'); setState(await response.json() as State) })
      .catch(() => { if (!controller.signal.aborted) setMessage('Connected apps could not be loaded. Reload to try again.') })
    return () => { controller.abort() }
  }, [])
  async function save(enabled: boolean, accountIds: string[]) {
    if (busy || !state) return
    setBusy(true); setMessage('')
    try {
      const response = await fetch('/hivemind/dreamer/connectors', { method: 'PUT', credentials: 'include',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled, accountIds }) })
      const result = await response.json() as State & { error?: string }
      if (!response.ok) throw new Error(result.error === 'read_tools_unavailable'
        ? 'This app has no compatible read tools yet. Your previous choices are unchanged.'
        : response.status === 401 ? 'Your session expired. Reload to continue.' : 'Access could not be saved. Please try again.')
      setState(result); setMessage('Saved for future dreams.')
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Access could not be saved.') }
    finally { setBusy(false) }
  }
  return <section className={css.root} aria-label="Dreaming connected apps">
    <label className={css.heading}><span className={css.connectorLabel}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 3v5M15 3v5M7 8h10v4a5 5 0 0 1-5 5v4M7 8v4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>Connected apps</span><input className={css.switch} type="checkbox" role="switch"
      aria-label="Use connected apps while dreaming" checked={state?.enabled ?? false} disabled={!state?.available || busy}
      onChange={event => void save(event.target.checked,
        state?.accounts.filter(account => account.enabled).map(account => account.id) ?? [])} /></label>
    <p>Optional, read-only access for HyperAgents.</p>
    <p title="Turning access off prevents future reads; saved Flashbacks remain.">Insights are saved to company Flashbacks.</p>
    {state?.enabled && <div className={css.accounts}>
      {!state.accounts.length && <p>No connected apps yet. Add them in Connectors.</p>}
      {state.accounts.map(account => <label className={css.account} key={account.id}>
        <img className={css.logo} src={`https://logos.composio.dev/api/${encodeURIComponent(account.toolkit)}`} alt="" loading="lazy" /><span className={css.appName}>{appNames[account.toolkit.toLowerCase()] ?? account.toolkit}<small>Read-only · {account.id.slice(-6)}</small></span><input className={css.switch} role="switch" type="checkbox" checked={account.enabled} disabled={busy}
          aria-label={`Allow Dreaming to read ${account.label}`} onChange={event => void save(true, state.accounts
            .filter(item => item.id === account.id ? event.target.checked : item.enabled).map(item => item.id))} />
      </label>)}
    </div>}
    <a className={css.more} href="/hivemind/app/connectors">More apps <span aria-hidden="true">›</span></a>
    {!state?.available && state && <p>Connected apps are unavailable on this server.</p>}
    {message && <p role="status">{message}</p>}
    {busy && <p role="status">Saving access and preparing read tools…</p>}
  </section>
}
