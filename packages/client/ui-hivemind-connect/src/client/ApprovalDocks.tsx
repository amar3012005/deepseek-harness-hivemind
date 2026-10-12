import { useEffect, useRef, useState } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import css from './ApprovalDock.module.css'

export interface MemorySaveItem {
  callId: string
  operationId?: string | undefined
  tool: string
  status: 'pending' | 'approved' | 'executing' | 'declined' | 'completed' | 'failed'
  requests: readonly { title: string; content: string; project?: string | undefined }[]
  destination?: 'personal' | 'organization' | 'project' | undefined
}

export interface RuntimeApprovalItem {
  approvalId: string
  callId: string
  rootCallId: string
  toolName: string
  reason?: string
  state: 'pending' | 'approved' | 'executing' | 'declined' | 'completed' | 'failed' | 'blocked'
}

type DockBase = PropsRuntime<'conversation.input.dock'> & PropsLocale<'hivemind-connect'> & {
  useApprovalEvents: SnapshotSelectorHook<SessionEventWindow>
}

type MemoryProps = DockBase & {
  kind: 'memory'
  load: (sessionId: SessionId) => Promise<readonly MemorySaveItem[]>
  decide: (sessionId: SessionId, callId: string, operationId: string, decision: 'decline' | 'personal' | 'organization' | 'project') => Promise<boolean>
}

type RuntimeProps = DockBase & {
  kind: 'runtime'
  load: (sessionId: SessionId) => Promise<readonly RuntimeApprovalItem[]>
  decide: (sessionId: SessionId, callId: string, approvalId: string, decision: 'approve' | 'decline') => Promise<boolean>
}

type Props = MemoryProps | RuntimeProps

export interface MemoryApprovalInjection {
  hooks: { approvalEvents: HostObservable<SessionEventWindow> }
  load: MemoryProps['load']
  decide: MemoryProps['decide']
}

export interface RuntimeApprovalInjection {
  hooks: { approvalEvents: HostObservable<SessionEventWindow> }
  load: RuntimeProps['load']
  decide: RuntimeProps['decide']
}

export function MemoryApprovalDock(props: PropsRuntime<'conversation.input.dock'> & InjectFace<MemoryApprovalInjection> & PropsLocale<'hivemind-connect'>) {
  return <ApprovalDock {...props} kind="memory" />
}

export function RuntimeApprovalDock(props: PropsRuntime<'conversation.input.dock'> & InjectFace<RuntimeApprovalInjection> & PropsLocale<'hivemind-connect'>) {
  return <ApprovalDock {...props} kind="runtime" />
}

/** Durable HIVE approval decisions in the native composer dock. */
export function ApprovalDock(props: Props) {
  const blank = props.useSessions(state => state.byId[props.sessionId]?.blank === true)
  const revision = props.useApprovalEvents(window => window.entries
    .filter(entry => entry.type === 'event'
      && ['hivemind/runtime-approval-checkpoint', 'hivemind/memory-save-checkpoint'].includes(String(entry.event.type)))
    .map(entry => entry.type === 'event' ? entry.event.seq : '').join(':'))
  const [items, setItems] = useState<readonly (MemorySaveItem | RuntimeApprovalItem)[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const request = useRef(0)
  const decisionPending = useRef(false)

  useEffect(() => {
    const generation = ++request.current
    setError(null)
    if (blank) { setItems([]); return }
    void props.load(props.sessionId).then((value) => {
      if (generation === request.current) setItems(value as readonly (MemorySaveItem | RuntimeApprovalItem)[])
    }).catch(() => {
      if (generation === request.current) setError(props.t('approval.unavailable'))
    })
    return () => { request.current++ }
  }, [props.sessionId, props.load, revision, props.t, blank])

  const settle = async (key: string, action: () => Promise<boolean>) => {
    if (decisionPending.current) return
    decisionPending.current = true
    setBusy(key)
    setError(null)
    try {
      if (!await action()) throw new Error('Decision was not accepted')
      const next = await props.load(props.sessionId)
      setItems(next as readonly (MemorySaveItem | RuntimeApprovalItem)[])
    } catch {
      setError(props.t('approval.unavailable'))
    } finally {
      decisionPending.current = false
      setBusy(null)
    }
  }

  const active = items.filter(item => 'status' in item
    ? item.status === 'pending' || item.status === 'approved' || item.status === 'executing'
    : item.state === 'pending' || item.state === 'approved' || item.state === 'executing')
  if (active.length === 0 && error === null) return null

  return <section className={css.dock} data-hivemind-approvals aria-label={props.t('approval.title')}>
    <header className={css.header}><strong>{props.t('approval.title')}</strong></header>
    {error !== null && <p className={css.error} role="alert">{error}</p>}
    {active.map((item) => {
      if (props.kind === 'memory' && 'requests' in item) {
        const operationId = item.operationId ?? ''
        const actionable = item.status === 'pending' && operationId.length > 0
        const key = `memory:${item.callId}`
        return <article className={css.card} key={key} data-memory-approval={item.callId}>
          {item.requests.map((save, index) => <div key={`${item.callId}:${index}`}>
            <strong>{save.title}</strong><p className={css.copy}>{save.content}</p>
          </div>)}
          {item.status !== 'pending' && <p role="status">{props.t(approvalStatusKey(item.status))}</p>}
          {actionable && <div className={css.actions}>
            <Button variant="outline" disabled={busy !== null} onClick={() => { void settle(key, () => props.decide(props.sessionId, item.callId, operationId, 'decline')) }}>{props.t('approval.decline')}</Button>
            {(['personal', 'organization', 'project'] as const).map(destination => (
              destination === 'project' && !item.requests.every(save => save.project !== undefined) ? null :
                <Button key={destination} variant="primary" disabled={busy !== null} onClick={() => { void settle(key, () => props.decide(props.sessionId, item.callId, operationId, destination)) }}>
                  {props.t(`approval.${destination}`)}
                </Button>
            ))}
          </div>}
        </article>
      }
      if (props.kind === 'runtime' && 'approvalId' in item) {
        const actionable = item.state === 'pending' && item.approvalId !== '' && item.callId !== ''
        const key = `runtime:${item.callId}`
        return <article className={css.card} key={key} data-runtime-approval={item.callId}>
          <strong>{item.toolName}</strong>
          {item.reason && <p className={css.copy}>{item.reason}</p>}
          {item.state !== 'pending' && <p role="status">{props.t(approvalStatusKey(item.state))}</p>}
          {actionable && <div className={css.actions}>
            <Button variant="outline" disabled={busy !== null} onClick={() => { void settle(key, () => props.decide(props.sessionId, item.callId, item.approvalId, 'decline')) }}>{props.t('approval.decline')}</Button>
            <Button variant="primary" disabled={busy !== null} onClick={() => { void settle(key, () => props.decide(props.sessionId, item.callId, item.approvalId, 'approve')) }}>{props.t('approval.approve')}</Button>
          </div>}
        </article>
      }
      return null
    })}
  </section>
}

function approvalStatusKey(status: MemorySaveItem['status'] | RuntimeApprovalItem['state']) {
  switch (status) {
    case 'approved': return 'approval.approved'
    case 'executing': return 'approval.executing'
    case 'declined': return 'approval.declined'
    case 'completed': return 'approval.completed'
    case 'failed': return 'approval.failed'
    case 'blocked': return 'approval.blocked'
    case 'pending': return 'approval.pending'
  }
}
