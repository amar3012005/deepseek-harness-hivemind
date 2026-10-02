/** Human switch for the native HQ session; no model tool can grant this authority. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, IconRefreshOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HqModeState, HqModeUpdate, HqModeUpdateResult } from '@deepseek-ai/dsh-hivemind-hq-runtime/client'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './HqControlAction.module.css'

/** Only the browser plugin receives the human Remote mutation capability. */
export interface HqControlInjected {
  readonly load: (sessionId: SessionId) => Promise<RemoteResult<HqModeState>>
  readonly setMode: (sessionId: SessionId, request: HqModeUpdate) => Promise<RemoteResult<HqModeUpdateResult>>
}
export type HqControlActionProps = Pick<PropsRuntime<'conversation.session.header.actions'>, 'sessionId'>
  & PropsLocale<'hivemind.hq'> & HqControlInjected

/**
 * Render one compare-and-set control and surface uncertain or conflicting writes.
 * @param props - scoped native session, localized copy and human-only RPC actions.
 * @returns the HQ switch, independent of ordinary employee session controls.
 */
export function HqControlAction({ sessionId, load, setMode, t }: HqControlActionProps) {
  const [mode, setState] = useState<HqModeState | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const changing = useRef(false)
  const refresh = useCallback(async () => {
    const current = ++generation.current
    setPending(true)
    try {
      const result = await load(sessionId)
      if (current !== generation.current) return
      if (result.ok) { setState(result.value); setError(null) }
      else { setState(null); setError(result.error.message) }
    } catch {
      if (current === generation.current) { setState(null); setError(t('unavailable')) }
    } finally { if (current === generation.current) setPending(false) }
  }, [load, sessionId, t])
  useEffect(() => {
    setState(null); setError(null); changing.current = false
    void refresh()
    return () => { generation.current++ }
  }, [refresh])
  const change = async () => {
    if (mode === null || changing.current || pending) return
    changing.current = true
    const current = ++generation.current
    setPending(true)
    try {
      const result = await setMode(sessionId, { enabled: !mode.enabled, expectedRevision: mode.revision })
      if (current !== generation.current) return
      if (!result.ok) { setState(null); setError(result.error.message) }
      else if (result.value.ok) { setState(result.value.value); setError(null) }
      else { setState(result.value.current); setError(t('conflict')) }
    } catch {
      if (current === generation.current) { setState(null); setError(t('unavailable')) }
    } finally { if (current === generation.current) { changing.current = false; setPending(false) } }
  }
  return <div className={css.control}>
    {mode && <span role="status">{t(mode.enabled ? 'active' : 'paused')}</span>}
    <Button size="sm" variant="outline" className={mode?.enabled ? css.pause : undefined}
      disabled={pending || mode === null} aria-label={t(mode?.enabled ? 'pause' : mode?.revision === 0 ? 'wake' : 'enable')}
      onClick={() => { void change() }}>
      {mode?.enabled && <span className={css.stop} aria-hidden="true" />}
      {t(pending ? 'pending' : mode?.enabled ? 'pause' : mode?.revision === 0 ? 'wake' : 'enable')}
    </Button>
    <Button size="sm" disabled={pending} aria-label={t('refresh')} icon={<IconRefreshOutline14 />} onClick={() => { void refresh() }} />
    {error && <span className={css.error} role="status">{error}</span>}
  </div>
}
