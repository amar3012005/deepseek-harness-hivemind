import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, IconNewChatOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
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
  & PropsRenderSlots<'conversation.sidebar.viewTabs' | 'shell.sessionRail.avatar'>
  & HiveSessionProjectionInjected

/** A stable local timestamp is a useful label for sessions without distinct titles. */
export function sessionTimestamp(updatedAt: number, now: number, locale: string): string {
  const date = new Date(updatedAt)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(locale || 'en', {
    ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }),
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date)
}

/** Native session rows projected into the host-owned HIVE canvas. */
export function HiveSessionProjection({
  useSessions, useSessionPendingInteraction, createSession, openSession,
  renameSession, forkSession, deleteSession, renderSlot, t,
}: Props) {
  const [creating, setCreating] = useState(false)
  const [recentsAtEnd, setRecentsAtEnd] = useState(false)
  const [renameTarget, setRenameTarget] = useState<{ id: SessionId; title: string }>()
  const [renameDraft, setRenameDraft] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameError, setRenameError] = useState<string>()
  const composing = useRef(false)
  const list = useSessions(value => value)
  const pending = useSessionPendingInteraction(value => value)
  const [pathname, setPathname] = useState(window.location.pathname)
  useEffect(() => {
    const update = () => { setPathname(window.location.pathname) }
    window.addEventListener('popstate', update)
    return () => { window.removeEventListener('popstate', update) }
  }, [])
  const hyperagentRoute = pathname.startsWith('/hivemind/app/employee/harness')
  // The OS sidebar is owned by the host frontend. Its existing first content
  // block is a stable seat, so the runner can show sessions without a host deploy.
  const osRail = hyperagentRoute
    ? document.querySelector<HTMLElement>('[data-product-sidebar="os"] > div') : null
  const rows = useMemo(
    () => deriveFlat(list, [], pending).filter((row) => {
      if (row.blank) return false
      const summary = list.byId[row.id]
      // The list's tenant-scoped value includes blank-session preset changes
      // for cold rows; an open session's live projection can be newer still.
      const preset = row.id === list.current
        ? summary?.projectionValues?.agentPreset ?? summary?.agentPreset
        : summary?.agentPreset ?? summary?.projectionValues?.agentPreset
      const isHyperagent = preset === 'hivemind-hyperagents' || preset === 'hivemind-hq'
        || preset === 'hyperagents' || preset === 'hyperagents-compressed'
      return hyperagentRoute ? isHyperagent : !isHyperagent
    }),
    [list, pending, hyperagentRoute],
  )
  const start = () => {
    if (creating) return
    if (hyperagentRoute) {
      window.history.pushState(window.history.state, '', '/hivemind/app/employee/harness/new')
      window.dispatchEvent(new PopStateEvent('popstate'))
      return
    }
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
    const base = window.location.pathname.startsWith('/hivemind/app/employee/harness/session/')
      ? '/hivemind/app/employee/harness' : '/hivemind/app/overview'
    url.pathname = `${base}/session/${encodeURIComponent(id)}`
    url.search = ''
    url.hash = ''
    const sharing = navigator.share?.({ title, url: url.toString() })
      ?? navigator.clipboard?.writeText(url.toString())
    void sharing?.catch((reason: unknown) => { console.warn('session share rejected:', reason) })
  }
  const now = Date.now()
  const locale = document.documentElement.lang || navigator.language || 'en'
  const content = <div data-agent-room-history={hyperagentRoute || undefined} className={`${css.root} ${osRail === null ? '' : css.osRoot}`}>
    {!hyperagentRoute && osRail === null && <button type="button" className={css.newSession} disabled={creating} onClick={start}>
      <IconNewChatOutline16 /><span>{t('session.new')}</span>
    </button>}
    {hyperagentRoute && <a href="/hivemind/app/employees" className={css.newSession}>Company workspace ↗</a>}
    <div className={css.recentHeading}>
      <span>{hyperagentRoute ? 'Your agent tasks' : t('section.recent')}</span>
    </div>
    <nav className={css.list} aria-label={t('section.sessions')} onScroll={(event) => {
      const listElement = event.currentTarget
      setRecentsAtEnd(listElement.scrollTop + listElement.clientHeight >= listElement.scrollHeight - 2)
    }}>
      {rows.map((row) => {
        let agent: { id: string; name: string; role: string; avatarUrl?: string } | undefined
        if (hyperagentRoute) {
          try {
            const projection = list.byId[row.id]?.projectionValues as { hyperagentOwner?: string | null } | undefined
            const value = JSON.parse(projection?.hyperagentOwner ?? 'null') as { id?: unknown; name?: unknown; role?: unknown; avatarUrl?: unknown } | null
            if (value && typeof value.id === 'string' && typeof value.name === 'string') agent = { id: value.id, name: value.name, role: typeof value.role === 'string' ? value.role : 'employee', ...(typeof value.avatarUrl === 'string' ? { avatarUrl: value.avatarUrl } : {}) }
          } catch { /* Legacy sessions can lack an owner projection. */ }
        }
        return <SessionNodeItem
          key={row.id}
          node={row}
          leading={agent === undefined ? undefined : renderSlot('shell.sessionRail.avatar', agent, { fallback: null })}
          visibleTitle={hyperagentRoute ? agent?.name ?? 'Run Time' : row.title.trim() && row.title !== 'deepseek-harness' ? row.title : sessionTimestamp(row.updatedAt, now, locale)}
          hoverTimestamp={new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'long' }).format(row.updatedAt)}
          hoverTitle={hyperagentRoute ? row.title : undefined}
          recent
          currentId={list.current}
          now={now}
          onOpen={openSession}
          onRename={requestRename}
          onFork={forkSession}
          onArchive={() => {}}
          onDelete={(id) => { void deleteSession(id) }}
          onShare={shareSession}
          flat
          t={t}
        />})}
    </nav>
    {osRail === null && rows.length > 5 && !recentsAtEnd && <div className={css.scrollHint}>Scroll more ↓</div>}
    {list.current !== undefined && <div className={css.viewTabs}>
      {renderSlot('conversation.sidebar.viewTabs', {}, { fallback: null })}
    </div>}
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
  return osRail === null ? content : createPortal(content, osRail)
}
