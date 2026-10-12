/** Start invitation uses the existing mounted native room voice owner. */
import { useEffect, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HqKey } from './locales.ts'
import type { ReactNode } from 'react'
import css from './RuntimeCallBanner.module.css'
interface CallStatus { state: 'idle' | 'connecting' | 'live'; error: boolean; busy: boolean }
export function RuntimeCallBanner({ sessionId, t, avatar }: { sessionId: SessionId; t: (key: HqKey) => string; avatar?: ReactNode }) {
  const [status, setStatus] = useState<CallStatus>()
  const [unavailable, setUnavailable] = useState(false)
  useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent<CallStatus & { sessionId: string }>).detail
      if (detail?.sessionId === sessionId && ['idle', 'connecting', 'live'].includes(detail.state)) {
        setStatus(detail); setUnavailable(false)
      }
    }
    window.addEventListener('hivemind:room-call-status', update)
    window.dispatchEvent(new CustomEvent('hivemind:room-call-status-request', { detail: { sessionId } }))
    return () => { window.removeEventListener('hivemind:room-call-status', update) }
  }, [sessionId])
  const active = status !== undefined && status.state !== 'idle'
  return <aside data-runtime-call-banner className={css.banner}>
    <div className={css.identity}>{avatar ?? <span aria-hidden className={css.voiceMark}>✦</span>}<span>Runtime</span></div>
    <div className={css.copy}><strong>{t('call.title')}</strong><p>{t('call.detail')}</p></div>
    <button className={css.action} type="button" disabled={active} onClick={() => {
      setUnavailable(window.dispatchEvent(new CustomEvent('hivemind:start-room-call', { cancelable: true, detail: { sessionId } })))
    }}>{t(status?.state === 'connecting' ? 'call.connecting' : status?.state === 'live' ? 'call.live' : 'call.start')}</button>
    {(unavailable || status?.error || status?.busy) && <p className={css.error} role="alert">{t(unavailable ? 'call.unavailable' : status?.busy ? 'call.busy' : 'call.failed')}</p>}
  </aside>
}
