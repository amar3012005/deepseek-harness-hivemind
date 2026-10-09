import { useEffect, useRef, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
export interface AccessState { enabled: boolean; revision: number }
export interface RuntimeFullAccessProps {
  sessionId: SessionId
  load: (id: SessionId, request?: { enabled: boolean; expectedRevision: number }) =>
  Promise<RemoteResult<{ ok: boolean; current: AccessState }>>
  subscribe: (id: SessionId, listener: () => void) => () => void
}
/** Explicit selection is the consent; no repeated approval popup. */
export function RuntimeFullAccess({ sessionId, load, subscribe }: RuntimeFullAccessProps) {
  const [state, setState] = useState<AccessState>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const sequence = useRef(0)
  const mutating = useRef(false)
  const refresh = async () => {
    if (mutating.current) return
    const request = ++sequence.current
    try {
      const result = await load(sessionId)
      if (request !== sequence.current) return
      if (!result.ok) throw Error('access_unavailable')
      setState(result.value.current)
      setError(false)
    } catch {
      if (request === sequence.current) { setState(undefined); setError(true) }
    }
  }
  useEffect(() => {
    ++sequence.current
    setState(undefined); setError(false); setBusy(false); mutating.current = false
    const update = () => { void refresh() }
    update()
    const stop = subscribe(sessionId, update)
    window.addEventListener('focus', update)
    return () => { ++sequence.current; stop(); window.removeEventListener('focus', update) }
  }, [sessionId, load, subscribe])
  const change = async (enabled: boolean) => {
    if (!state || mutating.current) return
    mutating.current = true; setBusy(true); setError(false)
    const request = ++sequence.current
    let failed = false
    try {
      const result = await load(sessionId, { enabled, expectedRevision: state.revision })
      if (request !== sequence.current) return
      if (!result.ok) throw Error('permission_change_failed')
      setState(result.value.current)
      failed = !result.value.ok
    } catch { failed = true }
    finally {
      if (request === sequence.current) {
        mutating.current = false; setBusy(false)
        if (failed) { setState(undefined); await refresh(); setError(true) }
      }
    }
  }
  return <section aria-label="Runtime access" style={{ padding: '12px 16px' }}>
    <label style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      <input type="checkbox" checked={state?.enabled ?? false} disabled={!state || busy}
        onChange={(event) => { void change(event.target.checked) }} />Full access
    </label>
    <p style={{ fontSize: 12, opacity: .75 }}>
      Runtime can plan, delegate and act using your organization’s existing access without approval prompts.
      Missing connections or essential facts still need your input.</p>
    {error && <p role="status">Access could not be confirmed or changed. <button type="button" disabled={busy} onClick={() => { void refresh() }}>Retry</button></p>}
  </section>
}
