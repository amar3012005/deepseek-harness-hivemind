/** Final saved plan with native cancellation and the existing room voice transport. */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { HqWorkspace } from '@deepseek-ai/dsh-hivemind-hq-runtime/client'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
interface Props {
  sessionId: SessionId
  turn: number
  events: { subscribe(listener: () => void): () => void; getSnapshot(): SessionEventWindow }
  load(id: SessionId): Promise<RemoteResult<HqWorkspace>>
  cancel(id: SessionId, request: { taskId: string; expectedRevision: number }): Promise<RemoteResult<{ cancelled: boolean }>>
}
export function RuntimePlanSummary({ sessionId, turn, events, load, cancel }: Props) {
  const log = useSyncExternalStore(listener => events.subscribe(listener), () => events.getSnapshot())
  const ready = log.entries.some(entry => entry.type === 'event'
    && String(entry.event.type) === 'hivemind/hq-awakening-checkpoint'
    && (() => { const data = entry.event.data as unknown as { stage: string; turn: number; blocked: boolean }; return data.turn === turn && data.stage === 'conversation' && !data.blocked })())
  const employeeNames = new Map(log.entries.flatMap((entry) => {
    if (entry.type !== 'event' || String(entry.event.type) !== 'hivemind/hq-awakening-checkpoint') return []
    const data = entry.event.data as unknown as { cards: Array<{ employeeId?: string; title: string }> }
    return data.cards.filter(card => card.employeeId).map(card => [card.employeeId, card.title] as const)
  }))
  const [workspace, setWorkspace] = useState<HqWorkspace>()
  const [pending, setPending] = useState<string>()
  const [error, setError] = useState<string>()
  const refresh = useCallback(async () => {
    const result = await load(sessionId)
    if (!result.ok) throw new Error('The saved schedule could not be loaded.')
    setWorkspace(result.value)
  }, [load, sessionId])
  useEffect(() => {
    if (!ready) return
    let disposed = false
    void load(sessionId).then((result) => { if (!disposed && result.ok) setWorkspace(result.value) })
    const timer = setInterval(() => { void refresh().catch(() => {}) }, 15000)
    return () => { disposed = true; clearInterval(timer) }
  }, [ready, load, sessionId, refresh])
  if (!ready) return null
  return <section aria-label="Runtime strategic plan" style={{ border: '1px solid var(--border-color, #e4e7eb)', borderRadius: 16, padding: 18, marginTop: 16 }}>
    <h3>I’ve built the initial strategic plan.</h3>
    <p>Here is the saved schedule. Cancelling a prerequisite also cancels its pending dependent tasks.</p>
    {!workspace && <p role="status">Loading saved tasks…</p>}
    {workspace?.tasks.filter(task => task.nextWakeAt || workspace.calendar.some(item => item.taskId === task.id)).map(task => <article key={task.id} style={{ padding: '12px 0', borderBottom: '1px solid #e4e7eb' }}>
      <strong>{task.title}</strong><p>{employeeNames.get(workspace.calendar.find(item => item.kind === 'assignment' && item.taskId === task.id)?.owner) ?? task.owner} · {task.status === 'deleted' ? 'Cancelled' : task.status}</p>
      <p>{task.nextWakeAt ? new Date(task.nextWakeAt).toLocaleString(undefined, { timeZoneName: 'short' }) : 'No pending trigger'}</p>
      {task.status === 'pending' && <button type="button" disabled={pending !== undefined} onClick={() => {
        setPending(task.id); setError(undefined)
        void cancel(sessionId, { taskId: task.id, expectedRevision: task.revision }).then(async (result) => {
          if (!result.ok) throw result.error
          if (!result.value.cancelled) throw new Error('Cancellation was not confirmed. Refresh and try again.')
          await refresh()
        }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Cancellation failed.')).finally(() => setPending(undefined))
      }}>{pending === task.id ? 'Cancelling…' : 'Cancel task'}</button>}
    </article>)}
    {error && <p role="alert">{error}</p>}
    <div style={{ paddingTop: 16 }}><strong>Let’s talk about your company’s next step.</strong>
      <p>Start a live call with Runtime in this room.</p>
      <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('hivemind:start-room-call', { detail: { sessionId } }))}>Talk to Runtime</button></div>
  </section>
}
