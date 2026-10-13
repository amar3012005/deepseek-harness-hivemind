import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session'
/** Native saved nightly provenance shared by prompt selection and tool admission. */
import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

/** Only the currently admitted native occurrence can activate this task context.
 * Old reviews and text copied into an ordinary chat cannot activate it. */
export function currentNightlyOccurrence(agent: Agent, admitted: readonly UserMessage[] = []): string | undefined {
  const events = agent.session.snapshotEvents()
  const boundary = events.findLast(event => event.type === 'turn/end')?.seq ?? -1
  const scheduleId = 'schedule-' + createHash('sha256').update(`${agent.id}\0nightly-routine-check-v1`).digest('hex')
  const candidates = [...events.flatMap(event => event.seq > boundary && event.type === 'user/message' && isAppendSurfaceEvent(event) ? [event.data] : []), ...admitted]
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
    if (message.source.kind !== 'schedule') continue
    const sourceOccurrence = message.source.occurrenceAt
    const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    const line = text.split('\n').find(value => value.startsWith('reminders_json: '))
    if (!line) continue
    try {
      const entries: unknown = JSON.parse(line.slice('reminders_json: '.length))
      if (!Array.isArray(entries) || !entries.some(entry => entry && typeof entry === 'object' && entry.occurrence_at === sourceOccurrence)) continue
      const own = entries.find(entry => entry && typeof entry === 'object' && entry.schedule_id === scheduleId)
      if (typeof own?.occurrence_at === 'string' && Number.isFinite(Date.parse(own.occurrence_at))) return own.occurrence_at
    } catch { /* malformed schedule context never activates a review */ }
  }
  return undefined
}

/** Read only the native Schedule's persisted original occurrence; never current wall clock. */
export function requireNightlyOccurrence(agent:Agent,occurrence:string):void {
  const id='schedule-'+createHash('sha256').update(`${agent.id}\0nightly-routine-check-v1`).digest('hex')
  const found=agent.session.snapshotEvents().some((event)=>{
    if(event.type!=='user/message'||event.data.source.kind!=='schedule')return false
    const sourceOccurrence=event.data.source.occurrenceAt
    const text=event.data.content.flatMap(block=>block.type==='text'?[block.text]:[]).join('\n')
    const line=text.split('\n').find(value=>value.startsWith('reminders_json: '))
    if(!line)return false
    try {
      const entries:unknown=JSON.parse(line.slice('reminders_json: '.length))
      return Array.isArray(entries)&&entries.some((entry:unknown)=>entry&&typeof entry==='object'&&(entry as Record<string,unknown>)['occurrence_at']===sourceOccurrence)&&entries.some((entry:unknown)=>{
        if(!entry||typeof entry!=='object')return false
        const data=entry as Record<string,unknown>
        return data['schedule_id']===id&&data['occurrence_at']===occurrence
      })
    }catch{return false}
  })
  if(!found)throw Error('saved_nightly_occurrence_required')
}
