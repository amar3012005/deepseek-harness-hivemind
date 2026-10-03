/** UI-only projection of a confirmed delegated native Schedule receipt. */
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ScheduleId } from '@deepseek-ai/dsh-schedule/client'
export interface ScheduledWork { ids: readonly ScheduleId[]; seq: number; employeeIds?: Readonly<Record<string, string>> }
/** Accept an actual saved schedule receipt, never a proposed time. */
export function savedScheduleId(text: string): ScheduleId | undefined {
  try {
    const value = JSON.parse(text) as { status?: unknown; schedule_id?: unknown }
    return value.status === 'scheduled' && typeof value.schedule_id === 'string' && value.schedule_id !== '' ? value.schedule_id as ScheduleId : undefined
  } catch { return undefined }
}
export const scheduledWork: ConversationNodeDefinition<ScheduledWork> = {
  kind: 'hivemind-scheduled-work', target: 'chat',
  match: (event) => {
    if (event.type === 'tool/call' && event.data.name === 'hivemind_hq_contract') return { id: String(event.data.callId), role: 'start' }
    if (event.type === 'tool/result') return { id: String(event.data.message.source.callId), role: 'update' }
    return null
  },
  start: (_context, match) => ({ ids: [], seq: match.event.seq }),
  update: (context, match) => {
    if (match.event.type !== 'tool/result' || match.event.data.message.content.some(block => block.isError)) return context.state
    const text = match.event.data.message.content.flatMap(block => block.content).filter(block => block.type === 'text').map(block => block.text).join('')
    const id = savedScheduleId(text)
    if (id === undefined) return context.state
    const receipt = JSON.parse(text) as { employee_id?: unknown }
    return { ids: [id], seq: match.event.seq, ...(typeof receipt.employee_id === 'string' ? { employeeIds: { [id]: receipt.employee_id } } : {}) }
  },
  buildViewNode: context => context.start === undefined || context.state === undefined || context.state.ids.length === 0 ? null : {
    key: context.key, kind: 'hivemind-scheduled-work', id: context.id, target: 'chat', anchorSeq: context.state.seq,
    location: context.start.location, processDisclosure: 'independent', visibility: 'visible', data: context.state,
  },
}
