import { useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import css from './HivemindHistory.module.css'

export interface HivemindHistoryInjected { openSession: (id: SessionId) => void }
type Props = PropsRuntime<'conversation.session.header.actions'> & PropsLocale<'hivemind-connect'> & HivemindHistoryInjected

/** Compact conversation-history drawer attached to the native Session header. */
export function HivemindHistory({ sessionId, useSessions, openSession, t }: Props) {
  const [open, setOpen] = useState(false)
  const sessions = useSessions(state => state)
  const rows = sessions.ids.filter(id => id !== sessionId).slice(0, 20).map(id => sessions.byId[id]).filter(row => row !== undefined)
  return <div className={css.root}>
    <button type="button" className={css.trigger} aria-expanded={open} onClick={() => { setOpen(value => !value) }}>{t('history')}</button>
    {open ? <div className={css.drawer} role="dialog" aria-label={t('history')}>
      {rows.length === 0 ? <p>{t('history.empty')}</p> : rows.map(row => <button key={row.id} type="button" onClick={() => { openSession(row.id); setOpen(false) }}>{row.displayTitle}</button>)}
    </div> : null}
  </div>
}
