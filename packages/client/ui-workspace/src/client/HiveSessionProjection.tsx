import { useMemo, useState } from 'react'
import { IconClockOutline16, IconNewChatOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { deriveFlat } from './tree.ts'
import { SessionNodeItem } from './rows/Rows.tsx'
import css from './HiveSessionProjection.module.css'

export interface HiveSessionProjectionInjected {
  createSession: () => Promise<SessionId>
  openSession: (id: SessionId) => void
}

type Props = PropsRuntime<'shell.sessionRail'>
  & PropsLocale<'workspace'>
  & HiveSessionProjectionInjected

/** Native session rows projected into the host-owned HIVE canvas. */
export function HiveSessionProjection({
  useSessions, useSessionPendingInteraction, createSession, openSession, t,
}: Props) {
  const [creating, setCreating] = useState(false)
  const list = useSessions(value => value)
  const pending = useSessionPendingInteraction(value => value)
  const rows = useMemo(
    () => deriveFlat(list, [], pending).filter(row => !row.blank).slice(0, 5),
    [list, pending],
  )
  const start = () => {
    if (creating) return
    setCreating(true)
    void createSession().then(openSession).finally(() => { setCreating(false) })
  }
  const hiddenAction = (): never => {
    throw new Error('session actions are hidden in the HIVE projection')
  }
  const now = Date.now()
  return <div className={css.root}>
    <button type="button" className={css.newSession} disabled={creating} onClick={start}>
      <IconNewChatOutline16 /><span>{t('session.new')}</span>
    </button>
    <div className={css.recentHeading}>
      <IconClockOutline16 /><span>{t('section.recent')}</span>
    </div>
    <nav className={css.list} aria-label={t('section.sessions')}>
      {rows.map(row => <SessionNodeItem
        key={row.id}
        node={row}
        currentId={list.current}
        now={now}
        onOpen={openSession}
        onRename={hiddenAction}
        onFork={hiddenAction}
        onArchive={hiddenAction}
        flat
        showActions={false}
        t={t}
      />)}
    </nav>
  </div>
}
