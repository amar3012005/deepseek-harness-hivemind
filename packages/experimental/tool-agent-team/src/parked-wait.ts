/** Durable Team reply checkpoint; native Inbox delivery owns reawakening. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'

export interface ParkedTeamWait {
  readonly callId: ToolCallId
  readonly expectedSenderIds: readonly string[]
  readonly teamId: string
  readonly originalSourceMessageId?: string
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'team/wait/parked': ParkedTeamWait
    'team/wait/fulfilled': { readonly callId: ToolCallId; readonly messageId: string }
  }
}
/** Recover the outstanding checkpoint from the durable Session journal. */
export function activeTeamWait(events: readonly SessionEvent[]): ParkedTeamWait | undefined {
  let pending: ParkedTeamWait | undefined
  for (const event of events) {
    if (event.type === 'team/wait/parked') pending = event.data
    if (event.type === 'team/wait/fulfilled' && event.data.callId === pending?.callId) pending = undefined
  }
  return pending
}
/** Record a same-Team response once; unrelated user/employee messages never settle this wait. */
export function fulfillTeamWait(agent: Agent): ParkedTeamWait | undefined {
  const events = agent.session.snapshotEvents()
  const pending = activeTeamWait(events)
  if (pending === undefined) return undefined
  const checkpoint = events.findLast(event => event.type === 'team/wait/parked' && event.data.callId === pending.callId)
  const reply = events.find(event => event.seq > (checkpoint?.seq ?? -1) && event.type === 'user/message'
    && event.data.source.kind === 'team-message' && event.data.source.teamId === pending.teamId
    && pending.expectedSenderIds.includes(event.data.source.senderId))
  if (reply?.type !== 'user/message') return undefined
  agent.session.append('team/wait/fulfilled', { callId: pending.callId, messageId: reply.data.id })
  return pending
}
