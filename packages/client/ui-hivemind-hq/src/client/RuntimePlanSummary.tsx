/** Final saved plan with native cancellation and the existing room voice transport. */
import type { TurnLocation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './RuntimePlanSummary.module.css'
import { RuntimeTaskCard } from './RuntimeTaskCard.tsx'
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
  let latestTurn: number | undefined
  let pendingInvitation = false
  let hasRestReceipt = false
  let restWakeAt: string | undefined
  let replyLanguage = 'en'
  const reviewedInTurn = new Set<string>()
  let reviewRevision = 0
  for (const entry of log.entries) {
    if (entry.type !== 'event') continue
    const type = String(entry.event.type)
    const data = entry.event.data as unknown as { turn?: number; stage?: string; blocked?: boolean; kind?: string; taskId?: string }
    if (type === 'command/run') {
      const command = data as { name?: string; args?: string }
      if (command.name === 'hivemind-language') replyLanguage = command.args?.trim() || 'en'
    }
    if (type === 'turn/start' || type === 'step/start') {
      eventTurn = data.turn
      if (data.turn !== undefined) latestTurn = data.turn
    }
    if (type === 'hivemind/hq-awakening-checkpoint' && data.stage === 'conversation' && !data.blocked) {
      invitationTurn = data.turn
      pendingInvitation = true
      summaryTurn = data.turn
    }
    if (type === 'hivemind/voice-baseline-outcome' && (data as { status?: string }).status === 'complete') pendingInvitation = false
    if (type === 'hivemind/hq-rest-confirmed') {
      hasRestReceipt = true
      const receipt = data as { handoffId?: string; scheduleId?: string; effectiveWakeAt?: string }
      if (eventTurn === turn && receipt.handoffId && receipt.scheduleId
        && receipt.effectiveWakeAt && Number.isFinite(Date.parse(receipt.effectiveWakeAt))) {
        restWakeAt = receipt.effectiveWakeAt
      }
    }
    if (type === 'hivemind/hq-calendar-item' && data.kind === 'assignment') summaryTurn = eventTurn
    if (type === 'hivemind/hq-task-review') {
      summaryTurn = eventTurn
      reviewRevision++
      if (eventTurn === turn && data.taskId) reviewedInTurn.add(data.taskId)
    }
  }
  const currentTurn = latestTurn === undefined || latestTurn === turn
  const invited = currentTurn && pendingInvitation && (invitationTurn === turn || hasRestReceipt)
  const ownsSummary = summaryTurn === turn
  const preservesClosure = reviewedInTurn.size > 0
  const ready = invited || ownsSummary || preservesClosure || (currentTurn && restWakeAt !== undefined)
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
  }, [ready, load, sessionId, refresh, reviewRevision])
  const scheduledTasks = (ownsSummary || preservesClosure) ? workspace?.tasks.filter(task =>
    (ownsSummary || (reviewedInTurn.has(task.id) && task.status === 'completed'))
    && (task.status !== 'completed' || reviewedInTurn.has(task.id))
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
        const knownName = employeeNames.get(owner)
        const employeeName = knownName ?? (/^[0-9a-f-]{36}$/iu.test(owner) ? 'Assigned employee' : owner)
        return <RuntimeTaskCard key={task.id} task={task} employeeName={employeeName}
          avatar={renderAvatar?.({ employeeId: owner })}
          {...(assignment?.startsAt ? { startsAt: assignment.startsAt } : {})}
          {...(assignment?.endsAt ? { endsAt: assignment.endsAt } : {})}
          busy={pending !== undefined} cancelling={pending === task.id} cancel={() => {
            setPending(task.id); setError(undefined)
            void cancel(sessionId, { taskId: task.id, expectedRevision: task.revision }).then(async (result) => {
              if (!result.ok) throw result.error
              if (!result.value.cancelled) throw new Error('Cancellation was not confirmed. Refresh and try again.')
              await refresh()
            }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Cancellation failed.')).finally(() => setPending(undefined))
          }} />
      })}
      {error && <p role="alert">{error}</p>}
    </section>}
    {!workspace && <p role="status">Loading saved tasks…</p>}
    {currentTurn && restWakeAt && <p role="status" className={css.restClosure}>
      {replyLanguage === 'de' ? 'Ich pausiere hier; der Fortschritt ist gespeichert.' : t('rest.saved')} {' '}
      {replyLanguage === 'de' ? 'Nächste Prüfung:' : t('rest.next')} {' '}
      <time dateTime={restWakeAt}>{new Date(restWakeAt).toLocaleString(undefined, {
        dateStyle: 'medium', timeStyle: 'short',
      })}</time> {' '}({Intl.DateTimeFormat().resolvedOptions().timeZone}).
    </p>}
    {invited && <RuntimeCallBanner sessionId={sessionId} t={t} avatar={renderAvatar?.({ employeeId: 'runtime', name: 'Runtime' })} />}
  </section>
}

/** Additive native footer is absent until this turn has actually finished. */
export function FinalRuntimePlanSummary({ turn, ...props }: Omit<Props, 'turn'> & { turn: TurnLocation }) {
  return turn.end === undefined ? null : <RuntimePlanSummary {...props} turn={turn.turn} />
}
