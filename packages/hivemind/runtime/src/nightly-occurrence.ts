/** Native saved nightly provenance shared by prompt selection and tool admission. */
import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

function scheduleOccurrence(agent: Agent, message: UserMessage): string | undefined {
  // Schedule currently declares its message-source augmentation in runtime.ts,
  // while the package root declaration does not expose that augmentation.
  // Inspect the durable native discriminator without adding a local source kind.
  if ((message.source as { kind: string }).kind !== 'schedule') return undefined
  const scheduleId = 'schedule-' + createHash('sha256').update(`${agent.id}\0nightly-routine-check-v1`).digest('hex')
  const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  const line = text.split('\n').find(value => value.startsWith('reminders_json: '))
  if (!line) return undefined
  try {
    const entries: unknown = JSON.parse(line.slice('reminders_json: '.length))
    if (!Array.isArray(entries)) return undefined
    const own = entries.find((entry: unknown) => entry && typeof entry === 'object'
      && (entry as Record<string, unknown>)['schedule_id'] === scheduleId)
    if (!own || typeof own !== 'object') return undefined
    const occurrence = (own as Record<string, unknown>)['occurrence_at']
    if (typeof occurrence !== 'string' || !Number.isFinite(Date.parse(occurrence))) return undefined
    return occurrence
  } catch {
    return undefined
  }
}

/** Only the currently admitted native occurrence can activate this task context.
 * Old reviews and text copied into an ordinary chat cannot activate it. */
export function currentNightlyOccurrence(agent: Agent, admitted: readonly UserMessage[] = []): string | undefined {
  const events = agent.session.snapshotEvents()
  const boundary = events.findLast(event => event.type === 'turn/end')?.seq ?? -1
  const candidates = [...events.flatMap(event => event.seq > boundary && event.type === 'user/message' ? [event.data] : []), ...admitted]
  for (const message of candidates) {
    if (String(message.source.kind) === 'hivemind-agent-message') {
      const messageId = (message.source as { messageId?: string }).messageId
      const roomEvents = events as unknown as readonly {
        type: string
        data: { id?: string; kind?: string; targetId?: string; senderId?: string; replyTo?: string; text?: string }
      }[]
      const reply = roomEvents.findLast(event => event.type === 'hivemind/room-message-received' && event.data.id === messageId && event.data.kind === 'reply' && event.data.targetId === agent.id)
      if (reply) {
        const request = roomEvents.find(event => event.type === 'hivemind/room-message-queued' && event.data.id === reply.data.replyTo && event.data.senderId === agent.id && event.data.kind === 'question' && event.data.targetId === reply.data.senderId)
        if (request && typeof request.data.text === 'string') {
          try {
            const marker = request.data.text.split('\n').find(line => line.startsWith('NIGHTLY_REVIEW_REQUEST='))
            const review = JSON.parse(marker?.slice('NIGHTLY_REVIEW_REQUEST='.length) ?? '')
            if (typeof review.occurrence === 'string') { requireNightlyOccurrence(agent, review.occurrence); return review.occurrence }
          } catch { /* Only correlated replies to an original native scheduled review resume it. */ }
        }
      }
    }
    const occurrence = scheduleOccurrence(agent, message)
    if (occurrence !== undefined) return occurrence
  }
  return undefined
}

/** Read only the native Schedule's persisted original occurrence; never current wall clock. */
export function requireNightlyOccurrence(agent: Agent, occurrence: string): void {
  const found = agent.session.snapshotEvents().some(event =>
    event.type === 'user/message' && scheduleOccurrence(agent, event.data) === occurrence)
  if(!found)throw Error('saved_nightly_occurrence_required')
}
