/** Final saved plan with native cancellation and the existing room voice transport. */
import type { TurnLocation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './RuntimePlanSummary.module.css'
import { RuntimeCallBanner } from './RuntimeCallBanner.tsx'
import type { HqKey } from './locales.ts'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { HqWorkspace } from '@deepseek-ai/dsh-hivemind-hq-runtime/client'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
interface Props {
  sessionId: SessionId
  t: (key: HqKey) => string
  renderAvatar?: (identity: { employeeId?: string; name?: string }) => import('react').ReactNode
  turn: number
  events: { subscribe(listener: () => void): () => void; getSnapshot(): SessionEventWindow }
  load(id: SessionId): Promise<RemoteResult<HqWorkspace>>
  cancel(id: SessionId, request: { taskId: string; expectedRevision: number }): Promise<RemoteResult<{ cancelled: boolean }>>
}
export function RuntimePlanSummary({ sessionId, turn, events, load, cancel, t, renderAvatar }: Props) {
  const log = useSyncExternalStore(listener => events.subscribe(listener), () => events.getSnapshot())
  let eventTurn: number | undefined
  let summaryTurn: number | undefined
  let invitationTurn: number | undefined
  const reviewedInTurn = new Set<string>()
  for (const entry of log.entries) {
    if (entry.type !== 'event') continue
    const type = String(entry.event.type)
    const data = entry.event.data as unknown as { turn?: number; stage?: string; blocked?: boolean; kind?: string; taskId?: string }
    if (type === 'turn/start' || type === 'step/start') eventTurn = data.turn
    if (type === 'hivemind/hq-awakening-checkpoint' && data.stage === 'conversation' && !data.blocked) {
      invitationTurn = data.turn
      summaryTurn = data.turn
    }
    if (type === 'hivemind/hq-calendar-item' && data.kind === 'assignment') summaryTurn = eventTurn
    if (type === 'hivemind/hq-task-review') {
      summaryTurn = eventTurn
      if (eventTurn === turn && data.taskId) reviewedInTurn.add(data.taskId)
    }
  }
  const invited = invitationTurn === turn
  const ownsSummary = summaryTurn === turn
  const ready = invited || ownsSummary
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
  const scheduledTasks = ownsSummary ? workspace?.tasks.filter(task =>
    (task.status !== 'completed' || reviewedInTurn.has(task.id))
    && (task.nextWakeAt || workspace.calendar.some(item => item.taskId === task.id))) ?? [] : []
  if (!ready) return null
  return <section aria-label="Runtime next steps" className={css.nextSteps}>
    {scheduledTasks.length > 0 && <section aria-label="Assigned work" className={css.assignments}>
      {scheduledTasks.length > 0 && <>
        <h3>{scheduledTasks.every(task => task.status === 'completed') ? 'Completed work' : 'Assigned work'}</h3>
      </>}

      {scheduledTasks.map((task) => {
        const assignment = workspace?.calendar.find(item => item.kind === 'assignment' && item.taskId === task.id)
        const owner = assignment?.owner ?? task.owner
        const start = assignment?.startsAt ?? task.nextWakeAt
        const date = start === undefined ? undefined : new Date(start)
        const format = (value: string) => new Date(value).toLocaleString(undefined, { timeZoneName: 'short' })
        const completed = task.status === 'completed'
        return <article key={task.id} className={css.task}>
          {completed && <span className={css.completedIcon} aria-hidden>✓</span>}
          {!completed && date && <div className={css.date} aria-hidden><small>{date.toLocaleString(undefined, { month: 'short' })}</small><strong>{date.getDate()}</strong></div>}
          <div className={css.identity}>{renderAvatar?.({ employeeId: owner })}</div>
          <div className={css.body}><strong>{task.title}</strong>
            <div className={css.meta}>{employeeNames.get(owner) ?? task.owner} · {completed ? <span className={css.completedLabel}>Completed</span> : task.status === 'deleted' ? 'Cancelled' : task.status === 'pending' ? (assignment ? 'Scheduled' : 'Assigned') : task.status === 'in_progress' ? 'In progress' : task.status}</div>
            {completed && <details className={css.history}><summary>Past schedule</summary>
              {start && <div className={css.meta}>Started {format(start)}</div>}
              {assignment?.endsAt && <div className={css.meta}>Work window ended {format(assignment.endsAt)}</div>}
              {task.dueAt && <div className={css.meta}>Original deadline {format(task.dueAt)}</div>}
            </details>}
            {!completed && start && <div className={css.meta}>Starts {format(start)}</div>}
            {!completed && assignment?.endsAt && <div className={css.meta}>Work window ends {format(assignment.endsAt)}</div>}
            {!completed && task.dueAt && <div className={css.meta}>Due {format(task.dueAt)}</div>}
          </div>
          {task.status === 'pending' && <button className={css.cancel} type="button" disabled={pending !== undefined} onClick={() => {
            setPending(task.id); setError(undefined)
            void cancel(sessionId, { taskId: task.id, expectedRevision: task.revision }).then(async (result) => {
              if (!result.ok) throw result.error
              if (!result.value.cancelled) throw new Error('Cancellation was not confirmed. Refresh and try again.')
              await refresh()
            }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Cancellation failed.')).finally(() => setPending(undefined))
          }}>{pending === task.id ? 'Cancelling…' : 'Cancel'}</button>}
        </article>
      })}
      {error && <p role="alert">{error}</p>}
    </section>}
    {!workspace && <p role="status">Loading saved tasks…</p>}
    {invited && <RuntimeCallBanner sessionId={sessionId} t={t} avatar={renderAvatar?.({ employeeId: 'runtime', name: 'Runtime' })} />}
  </section>
}

/** Additive native footer is absent until this turn has actually finished. */
export function FinalRuntimePlanSummary({ turn, ...props }: Omit<Props, 'turn'> & { turn: TurnLocation }) {
  return turn.end === undefined ? null : <RuntimePlanSummary {...props} turn={turn.turn} />
}
