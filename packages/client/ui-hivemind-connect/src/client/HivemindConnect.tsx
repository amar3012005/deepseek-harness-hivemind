import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { HivemindConnectKey } from './locales.ts'
import type { ConnectionStatus } from './index.ts'
import css from './HivemindConnect.module.css'

type Status = 'connected' | 'connecting' | 'disconnected' | 'unavailable'

export interface HivemindConnectInjected {
  readStatus: () => Promise<ConnectionStatus>
  start: () => Promise<ConnectionStatus>
  disconnect: () => Promise<ConnectionStatus>
}

export type HivemindConnectProps = PropsRuntime<'sidebar.footer.action'> & PropsLocale<'hivemind-connect'> & HivemindConnectInjected

/** Root-overlay button that starts the protected local ICARUS browser login. */
export function HivemindConnect({ wide, t, readStatus, start, disconnect }: HivemindConnectProps) {
  const [status, setStatus] = useState<Status>('unavailable')
  const [userEmail, setUserEmail] = useState<string>()

  useEffect(() => {
    let active = true
    const refresh = async () => {
      const next = await readStatus().catch((): ConnectionStatus => ({ status: 'unavailable' }))
      if (active) {
        setStatus(next.status)
        setUserEmail(next.userEmail)
      }
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, status === 'connecting' ? 1_500 : 15_000)
    window.addEventListener('focus', refresh)
    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [readStatus, status])

  const onClick = async () => {
    if (status === 'connecting') return
    setStatus('connecting')
    const next = await start().catch((): ConnectionStatus => ({ status: 'unavailable' }))
    setStatus(next.status)
    setUserEmail(next.userEmail)
  }
  const onDisconnect = async () => {
    setStatus('connecting')
    const next = await disconnect().catch((): ConnectionStatus => ({ status: 'unavailable' }))
    setStatus(next.status)
    setUserEmail(undefined)
  }
  const key: HivemindConnectKey = status === 'connected'
    ? 'connected'
    : status === 'connecting'
      ? 'connecting'
      : status === 'unavailable'
        ? 'unavailable'
        : 'connect'
  return <div className={css.controls} data-hivemind-status={status} data-wide={wide ? 'true' : 'false'}>
    <button className={css.button} type="button" disabled={status === 'connecting' || status === 'connected'} onClick={() => { void onClick() }} title={!wide && userEmail !== undefined ? `${t('connected')} · ${userEmail}` : t(key)}>
      <span className={css.mark} aria-hidden="true"><i /><i /><i /></span>
      {wide && <span className={css.text}><span>{t(key)}</span>{status === 'connected' && userEmail !== undefined ? <small>{userEmail}</small> : null}</span>}
    </button>
    {status === 'connected'
      ? <>
        <button className={css.iconButton} type="button" title={t('connect')} aria-label={t('connect')} onClick={() => { void onClick() }}>↻</button>
        <button className={css.disconnect} type="button" title={t('disconnect')} aria-label={t('disconnect')} onClick={() => { void onDisconnect() }}>⏻</button>
      </>
      : null}
  </div>
}
