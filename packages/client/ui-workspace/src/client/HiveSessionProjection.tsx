import { useEffect, useMemo, useState } from 'react'
import { Button, IconNewChatOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { deriveFlat } from './tree.ts'
import { SessionNodeItem } from './RecentsRows.tsx'
import css from './HiveSessionProjection.module.css'

export interface HiveSessionProjectionInjected {
  createSession: () => void
  openSession: (id: SessionId) => void
  renameSession: (id: SessionId, title: string) => Promise<void>
  forkSession: (id: SessionId) => Promise<SessionId>
  /** The current controller archives Sessions instead of hard-deleting their durable history. */
  archiveSession: (id: SessionId) => Promise<void>
}

type Props = PropsRuntime<'shell.sessionRail'>
  & PropsLocale<'workspace'>
  & InjectFace<HiveSessionProjectionInjected>

const HYPERAGENT_PRESETS = new Set(['hivemind-hyperagents', 'hivemind-hq', 'hyperagents', 'hyperagents-compressed'])

function presetOf(list: SessionListState, row: SessionSummary): string | null | undefined {
  return row.projectionValues?.agentPreset ?? list.projectionsBySession[row.id]?.values.agentPreset
}

function isHyperagent(list: SessionListState, row: SessionSummary): boolean {
  return HYPERAGENT_PRESETS.has(presetOf(list, row) ?? '')
}

function rowTitle(row: SessionSummary, now: number, locale: string): string {
  const title = row.title?.trim()
  if (title && title !== 'deepseek-harness') return title
  const date = new Date(row.updatedAt)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(locale || 'en', {
    ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }),
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date)
}

function selectedSession(list: SessionListState): SessionId | undefined {
  return Object.values(list.byId).find(row => (row.retainedBy.mainView ?? 0) > 0)?.id
}

/** Native Session catalog projected as mode-filtered HIVE Recents. */
export function HiveSessionProjection({
  useSessions, useSessionStatus, useWorkspaces, createSession, openSession, renameSession, forkSession, archiveSession, t,
}: Props) {
  const list = useSessions(value => value)
  const statuses = useSessionStatus(value => value)
  const pinnedSessionIds = useWorkspaces(value => value.pinnedSessionIds)
  const archivedSessionIds = useWorkspaces(value => value.archivedSessionIds)
  const [pathname, setPathname] = useState(() => window.location.pathname)
  const [renameTarget, setRenameTarget] = useState<{ id: SessionId; title: string }>()
  const [renameDraft, setRenameDraft] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [renameError, setRenameError] = useState<string>()
  const [actionError, setActionError] = useState<string>()

  useEffect(() => {
    const update = () => { setPathname(window.location.pathname) }
    window.addEventListener('popstate', update)
    return () => window.removeEventListener('popstate', update)
  }, [])

  const employeeRoute = pathname === '/hivemind/app/employee/harness'
    || pathname.startsWith('/hivemind/app/employee/harness/')
  const rows = useMemo(() => deriveFlat(list, list.ids, {
    pinnedSessionIds, archivedSessionIds, archivedFilter: 'default',
  }, statuses).filter(row => !row.blank && list.byId[row.id]?.origin !== 'subagent')
    .filter((row) => { const summary = list.byId[row.id]; return summary !== undefined && isHyperagent(list, summary) === employeeRoute }),
  [list, employeeRoute, pinnedSessionIds, archivedSessionIds, statuses])
  const deleteBridge = (window as Window & { __HIVEMIND_DELETE_SESSION__?: (id: SessionId) => Promise<void> }).__HIVEMIND_DELETE_SESSION__
  const summaryOf = (id: SessionId): SessionSummary => {
    const summary = list.byId[id]
    if (summary === undefined) throw new Error(`Session unavailable: ${id}`)
    return summary
  }
  const currentId = selectedSession(list)
  const now = Date.now()
  const locale = document.documentElement.lang || navigator.language || 'en'

  const beginRename = (row: SessionSummary): void => {
    setRenameTarget({ id: row.id, title: row.title ?? '' })
    setRenameDraft(row.title ?? '')
    setRenameError(undefined)
    setActionError(undefined)
  }
  const confirmRename = (): void => {
    const target = renameTarget
    const title = renameDraft.trim()
    if (target === undefined || title === '' || renameBusy) return
    setRenameBusy(true)
    setRenameError(undefined)
    void renameSession(target.id, title).then(() => {
      setRenameTarget(undefined)
    }).catch((reason) => {
      setRenameError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { setRenameBusy(false) })
  }
  const shareSession = (row: SessionSummary): void => {
    const url = new URL(window.location.href)
    url.pathname = `/hivemind/app/overview/session/${encodeURIComponent(row.id)}`
    url.search = ''
    url.hash = ''
    const result = navigator.share?.({ title: row.displayTitle, url: url.toString() })
      ?? navigator.clipboard?.writeText(url.toString())
    void result?.catch((reason) => { console.warn('session share rejected:', reason) })
  }
  const runAction = (row: SessionSummary, action: 'fork' | 'archive'): void => {
    setActionError(undefined)
    const result = action === 'fork' ? forkSession(row.id) : archiveSession(row.id)
    void result.catch((reason) => { setActionError(reason instanceof Error ? reason.message : String(reason)) })
  }

  return <section className={css.root} aria-label={t('section.sessions')}>
    <button type="button" className={css.newSession} onClick={createSession}><IconNewChatOutlineRegular /><span>{t('session.new')}</span></button>
    <div className={css.recentHeading}>{t('section.sessions')}</div>
    {actionError !== undefined && <p className={css.renameError} role="alert">{actionError}</p>}
    {rows.length === 0
      ? <p className={css.empty}>{t('empty.none')}</p>
      : <nav className={css.list} aria-label={t('section.sessions')}>
        {rows.map(row => <SessionNodeItem
          key={row.id} node={row} currentId={currentId} now={now}
          visibleTitle={row.title.trim() && row.title !== 'deepseek-harness' ? row.title : rowTitle(summaryOf(row.id), now, locale)}
          hoverTimestamp={new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'long' }).format(row.updatedAt)}
          recent flat t={t} onOpen={openSession}
          onRename={(id) => { beginRename(summaryOf(id)) }}
          onFork={(id) => { runAction(summaryOf(id), 'fork') }}
          onArchive={(id) => { runAction(summaryOf(id), 'archive') }}
          onDelete={deleteBridge === undefined ? undefined : (id) => {
            setActionError(undefined)
            void deleteBridge(id).then(() => archiveSession(id)).catch((reason) => {
              setActionError(reason instanceof Error ? reason.message : String(reason))
            })
          }}
          onShare={(id) => { shareSession(summaryOf(id)) }}
        />)}
      </nav>}
    <Modal open={renameTarget !== undefined} onClose={() => { if (!renameBusy) setRenameTarget(undefined) }}
      title={t('rename.session.title')} closeLabel={t('cancel')} footer={<>
        <Button variant="outline" disabled={renameBusy} onClick={() => { setRenameTarget(undefined) }}>{t('cancel')}</Button>
        <Button variant="primary" disabled={renameBusy || renameDraft.trim() === ''} onClick={confirmRename}>{t('rename')}</Button>
      </>}>
      <input className={css.renameInput} value={renameDraft} aria-label={t('field.sessionName')}
        autoFocus disabled={renameBusy} onChange={(event) => { setRenameDraft(event.target.value); setRenameError(undefined) }}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); confirmRename() } }} />
      {renameError !== undefined && <div className={css.renameError} role="alert">{renameError}</div>}
    </Modal>
  </section>
}
