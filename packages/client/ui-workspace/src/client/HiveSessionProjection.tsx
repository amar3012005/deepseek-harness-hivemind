import { useMemo, useRef, useState } from 'react'
import { Button, IconClockOutline16, IconNewChatOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { deriveFlat } from './tree.ts'
import { SessionNodeItem } from './rows/Rows.tsx'
import css from './HiveSessionProjection.module.css'

export interface HiveSessionProjectionInjected {
  createSession: () => Promise<SessionId>
  openSession: (id: SessionId) => void
  renameSession: (id: SessionId, title: string) => Promise<void>
  forkSession: (id: SessionId) => void
  deleteSession: (id: SessionId) => Promise<void>
}

type Props = PropsRuntime<'shell.sessionRail'>
  & PropsLocale<'workspace'>
  & HiveSessionProjectionInjected

/** Native session rows projected into the host-owned HIVE canvas. */
export function HiveSessionProjection({
  useSessions, useSessionPendingInteraction, createSession, openSession,
  renameSession, forkSession, deleteSession, t,
}: Props) {
  const [creating, setCreating] = useState(false)
  const [renameTarget, setRenameTarget] = useState<{ id: SessionId; title: string }>()
  const [renameDraft, setRenameDraft] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameError, setRenameError] = useState<string>()
  const composing = useRef(false)
  const list = useSessions(value => value)
  const pending = useSessionPendingInteraction(value => value)
  const rows = useMemo(
    () => deriveFlat(list, [], pending).filter(row => !row.blank),
    [list, pending],
  )
  const start = () => {
    if (creating) return
    setCreating(true)
    void createSession().then(openSession).finally(() => { setCreating(false) })
  }
  const requestRename = (id: SessionId, title: string) => {
    setRenameTarget({ id, title })
    setRenameDraft(title)
    setRenameError(undefined)
  }
  const closeRename = () => {
    if (!renaming) setRenameTarget(undefined)
  }
  const confirmRename = () => {
    const title = renameDraft.trim()
    if (renameTarget === undefined || title === '' || renaming) return
    setRenaming(true)
    setRenameError(undefined)
    void renameSession(renameTarget.id, title).then(() => {
      setRenameTarget(undefined)
    }).catch((reason: unknown) => {
      setRenameError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { setRenaming(false) })
  }
  const shareSession = (id: SessionId, title: string) => {
    const url = new URL(window.location.href)
    url.pathname = `/hivemind/app/overview/session/${encodeURIComponent(id)}`
    url.search = ''
    url.hash = ''
    const sharing = navigator.share?.({ title, url: url.toString() })
      ?? navigator.clipboard?.writeText(url.toString())
    void sharing?.catch((reason: unknown) => { console.warn('session share rejected:', reason) })
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
        onRename={requestRename}
        onFork={forkSession}
        onArchive={() => {}}
        onDelete={(id) => { void deleteSession(id) }}
        onShare={shareSession}
        flat
        actionsPersistent
        t={t}
      />)}
    </nav>
    <Modal
      open={renameTarget !== undefined}
      onClose={closeRename}
      closeLabel={t('close')}
      title={t('rename.session.title')}
      footer={<>
        <Button variant="outline" disabled={renaming} onClick={closeRename}>{t('cancel')}</Button>
        <Button variant="primary" disabled={renaming || renameDraft.trim() === ''} onClick={confirmRename}>{t('rename')}</Button>
      </>}
    >
      <input
        className={css.renameInput}
        value={renameDraft}
        aria-label={t('field.sessionName')}
        autoFocus
        disabled={renaming}
        onFocus={(event) => { event.target.select() }}
        onChange={(event) => { setRenameDraft(event.target.value); setRenameError(undefined) }}
        onCompositionStart={() => { composing.current = true }}
        onCompositionEnd={() => { composing.current = false }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !composing.current) { event.preventDefault(); confirmRename() }
        }}
      />
      {renameError !== undefined && <div className={css.renameError} role="alert">{renameError}</div>}
    </Modal>
  </div>
}
