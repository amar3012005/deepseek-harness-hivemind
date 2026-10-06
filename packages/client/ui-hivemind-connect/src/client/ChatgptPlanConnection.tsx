import { SingulanceMark } from './SingulanceMark.tsx'
import { ChatgptMark } from './ChatgptMark.tsx'
import { useEffect, useState } from 'react'
import css from './ChatgptPlanConnection.module.css'
interface Status {
  available: boolean
  reason?: string
  connected: boolean
  models: string[]
  selected_model: string | null
  platform_fallback: boolean
}
const base = '/api/hivemind/chatgpt-plan'
async function request(action: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${base}/${action}`, { credentials: 'same-origin',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
  if (!response.ok) throw new Error('ChatGPT connection could not be updated. Please try again.')
  return response.json()
}
export function ChatgptPlanConnection() {
  const brain = /^\/hivemind\/app\/overview(?:\/(?:new|session\/[^/]+))?\/?$/u.test(window.location.pathname)
  const [status, setStatus] = useState<Status>(); const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string>()
  useEffect(() => {
    if (!brain) return
    let alive = true
    const load = async () => {
      try {
        const params = new URLSearchParams(window.location.search)
        const code = params.get('code'), state = params.get('state')
        if (code && state) {
          // Remove callback material before fetching or rendering other page content.
          params.delete('code'); params.delete('state'); params.delete('scope')
          const query = params.toString()
          window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`)
          await request('callback', { code, state })
          if (alive) setOpen(true)
        }
        const next = await request('status') as Status
        if (alive) { setStatus(next); setError(undefined) }
      } catch { if (alive) setError('ChatGPT connection is currently unavailable.') }
    }
    void load()
    return () => { alive = false }
  }, [brain])
  if (!brain) return null
  async function act(action: string, body: unknown = {}): Promise<void> {
    if (busy) return
    setBusy(true); setError(undefined)
    try {
      const result = await request(action, body) as { authorization_url?: string }
      if (action === 'start') {
        const url = new URL(result.authorization_url ?? '')
        if (url.origin !== 'https://auth.openai.com') throw new Error('Invalid authorization destination')
        window.location.assign(url.href)
        return
      }
      setStatus(await request('status') as Status)
    } catch { setError('ChatGPT connection could not be updated. Please try again.') }
    finally { setBusy(false) }
  }
  return <div className={css.root}>
    <button type="button" className={css.link} aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className={css.connectionMarks} aria-hidden="true">
        <SingulanceMark size={30} />
        <span className={css.connectionDots}><i /><i /><i /><i /><i /></span>
        <ChatgptMark />
      </span>
      <span>{status?.connected ? 'Your ChatGPT is connected' : 'Connect to your ChatGPT'}</span>
    </button>
    {open && <section className={css.panel} aria-label="Your ChatGPT connection">
      <strong>Your ChatGPT</strong>
      <p>Use your connected account for Brain. Platform fallback uses HIVEMIND’s models.</p>
      {status && !status.available && <p>ChatGPT connection is not enabled on this server yet.</p>}
      {status?.connected ? <>
        <label>Model <select value={status.selected_model ?? ''} disabled={busy} onChange={event => void act('select', { model: event.target.value, platform_fallback: status.platform_fallback })}>
          {!status.selected_model && <option value="" disabled>Choose a model</option>}
          {status.models.map(model => <option key={model} value={model}>{model}</option>)}
        </select></label>
        <label><input type="checkbox" checked={status.platform_fallback} disabled={busy || !status.selected_model}
          onChange={event => void act('select', { model: status.selected_model, platform_fallback: event.target.checked })} /> Use platform models if my ChatGPT is unavailable</label>
        <div className={css.actions}><button type="button" disabled={busy} onClick={() => void act('models')}>Refresh models</button>
          <button type="button" disabled={busy} onClick={() => void act('disconnect')}>Disconnect</button></div>
      </> : <button type="button" disabled={busy || !status?.available} onClick={() => void act('start')}>Continue with ChatGPT</button>}
      {error && <p role="alert">{error}</p>}
    </section>}
  </div>
}
