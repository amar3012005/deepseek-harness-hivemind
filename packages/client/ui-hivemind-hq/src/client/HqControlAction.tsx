/** Human switch for the native HQ session; no model tool can grant this authority. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, IconRefreshOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HqModeState, HqModeUpdate, HqModeUpdateResult, HqRestState, HqRestNoteRequest, HqRestNoteResult } from '@deepseek-ai/dsh-hivemind-hq-runtime/client'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './HqControlAction.module.css'

/** Only the browser plugin receives the human Remote mutation capability. */
export interface HqControlInjected {
  readonly load: (sessionId: SessionId) => Promise<RemoteResult<HqModeState>>
  readonly restState: (sessionId: SessionId) => Promise<RemoteResult<HqRestState>>
  readonly leaveRestNote: (sessionId: SessionId, request: HqRestNoteRequest) => Promise<RemoteResult<HqRestNoteResult>>
  readonly setMode: (sessionId: SessionId, request: HqModeUpdate) => Promise<RemoteResult<HqModeUpdateResult>>
}
export type HqControlActionProps = Pick<PropsRuntime<'conversation.session.header.actions'>, 'sessionId'>
  & PropsLocale<'hivemind.hq'> & HqControlInjected

/**
 * Render one compare-and-set control and surface uncertain or conflicting writes.
 * @param props - scoped native session, localized copy and human-only RPC actions.
 * @returns the HQ switch, independent of ordinary employee session controls.
 */
export function HqControlAction({ sessionId, load, setMode, restState, leaveRestNote, t }: HqControlActionProps) {
  const [mode, setState] = useState<HqModeState | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rest, setRest] = useState<HqRestState | null>(null)
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [notePending, setNotePending] = useState(false)
  const [noteError, setNoteError] = useState<string | null>(null)
  const [noteReceipt, setNoteReceipt] = useState<string | null>(null)
  const noteAttempt = useRef<{ id: string; text: string } | null>(null)
  const noteChanging = useRef(false)
  const noteGeneration = useRef(0)
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
  const refreshRest = useCallback(async () => {
    const current = noteGeneration.current
    try {
      const result = await restState(sessionId)
      if (current !== noteGeneration.current) return
      if (result.ok) setRest(result.value)
      else setNoteError(result.error.message)
    } catch { if (current === noteGeneration.current) setNoteError(t('noteUnavailable')) }
  }, [restState, sessionId, t])
  useEffect(() => {
    setRest(null); setNoteOpen(false); setNoteText(''); setNoteReceipt(null); setNoteError(null)
    noteAttempt.current = null; noteChanging.current = false; setNotePending(false)
    void refreshRest()
    return () => { noteGeneration.current++ }
  }, [sessionId, refreshRest])
  const saveNote = async () => {
    const text = noteText.trim()
    if (!text || noteChanging.current) return
    const attempt = noteAttempt.current?.text === text ? noteAttempt.current : { id: randomUUID(), text }
    noteAttempt.current = attempt
    noteChanging.current = true; setNotePending(true); setNoteError(null); setNoteReceipt(null)
    const current = noteGeneration.current
    try {
      const result = await leaveRestNote(sessionId, attempt)
      if (current !== noteGeneration.current) return
      if (!result.ok) setNoteError(result.error.message)
      else {
        setNoteReceipt(t(result.value.note.status === 'presented' ? 'notePresented' : 'noteSaved'))
        setNoteText(''); noteAttempt.current = null
        void refreshRest()
      }
    } catch { if (current === noteGeneration.current) setNoteError(t('noteUnavailable')) }
    finally { if (current === noteGeneration.current) { noteChanging.current = false; setNotePending(false) } }
  }
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
  const wake = rest?.latest
  const wakeAt = wake?.effectiveWakeAt ?? wake?.requestedWakeAt
  const parsedWakeAt = wakeAt ? new Date(wakeAt) : null
  const wakeTime = parsedWakeAt && !Number.isNaN(parsedWakeAt.getTime())
    ? parsedWakeAt.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : wakeAt
  return <div className={css.control}>
    {mode && <span role="status">{t(mode.enabled ? 'active' : 'paused')}</span>}
    <Button size="sm" variant="outline" className={mode?.enabled ? css.pause : undefined}
      disabled={pending || mode === null} aria-label={t(mode?.enabled ? 'pause' : mode?.revision === 0 ? 'wake' : 'enable')}
      onClick={() => { void change() }}>
      {mode?.enabled && <span className={css.stop} aria-hidden="true" />}
      {t(pending ? 'pending' : mode?.enabled ? 'pause' : mode?.revision === 0 ? 'wake' : 'enable')}
    </Button>
    <Button size="sm" disabled={pending} aria-label={t('refresh')} icon={<IconRefreshOutline14 />} onClick={() => { void refresh(); void refreshRest() }} />
    <Button size="sm" variant="outline" onClick={() => setNoteOpen(value => !value)} aria-expanded={noteOpen}>{t('leaveInstruction')}</Button>
    {wake && <span className={css.restStatus}>{t(wake.wakeStatus === 'active' && wake.ready ? 'nextWake' : wake.wakeStatus === 'inactive' ? 'wakeInactive' : 'wakePending')}{wakeTime ? `: ${wakeTime}` : ''}{wake.wakeStatus === 'active' && mode && !mode.enabled ? ` · ${t('wakePaused')}` : ''}</span>}
    {noteOpen && <div className={css.noteBox}>
      <p className={css.noteHint}>{t('noteHint')}</p>
      <textarea className={css.noteInput} aria-label={t('instruction')} value={noteText} disabled={notePending}
        onChange={(event) => { setNoteText(event.target.value); setNoteReceipt(null) }} rows={3} />
      <Button size="sm" disabled={notePending || !noteText.trim()} onClick={() => { void saveNote() }}>{t(notePending ? 'noteSaving' : 'saveInstruction')}</Button>
      {noteReceipt && <span role="status">{noteReceipt}</span>}
      {noteError && <span className={css.error} role="status">{noteError}</span>}
      {rest?.notes.map(note => <p className={css.noteItem} key={note.id}><span>{t(note.status === 'presented' ? 'presented' : 'awaitingWake')}</span> {note.text}</p>)}
    </div>}
    {error && <span className={css.error} role="status">{error}</span>}
  </div>
}
