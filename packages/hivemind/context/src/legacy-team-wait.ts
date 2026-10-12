/** Read-only compatibility fold for saved pre-migration Team checkpoints. New waits use native Team APIs. */
/** Durable Team reply checkpoint; native Inbox delivery owns reawakening. */
import type {} from '@deepseek-ai/dsh-subagent'
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
    /** A native Team wait ended its turn with these expected same-Team senders and original source identity. */
    'team/wait/parked': ParkedTeamWait
    /** The expected same-Team message settled this saved wait once; the message is retained in the native Inbox. */
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
