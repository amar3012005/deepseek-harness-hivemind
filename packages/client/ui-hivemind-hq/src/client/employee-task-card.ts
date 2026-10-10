/** Event-positioned cards from exact authorized employee snapshot receipts. */
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { EmployeeTaskSnapshot } from '@deepseek-ai/dsh-hivemind-hq-runtime/client'
declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap { 'hivemind-employee-task': EmployeeTaskSnapshot }
}
interface EmployeeTaskCardState {
  snapshot: EmployeeTaskSnapshot
  visible: boolean
  seen: Readonly<Record<string, string>>
}
/** Only fields shown on the shared calendar card participate in its presentation identity. */
export function employeeTaskPresentation(snapshot: EmployeeTaskSnapshot): string {
  return JSON.stringify({ title: snapshot.task.title, status: snapshot.task.status,
    owner: snapshot.employeeId, name: snapshot.employeeName,
    startsAt: snapshot.calendar?.startsAt ?? snapshot.task.nextWakeAt,
    endsAt: snapshot.calendar?.endsAt, dueAt: snapshot.task.dueAt })
}
export const employeeTaskCard: ConversationNodeDefinition<EmployeeTaskCardState> = {
  kind: 'hivemind-employee-task', target: 'chat',
  match: (event) => {
    if (String(event.type) !== 'hivemind/employee-task-snapshot') return null
    const snapshot = event.data as unknown as EmployeeTaskSnapshot
    return { id: `${snapshot.rootSessionId}:${snapshot.task.id}`, role: 'update' }
  },
  // Every receipt is a whole checkpoint: a partial history window needs no start.
  start: (_context, match) => ({ snapshot: match.event.data as unknown as EmployeeTaskSnapshot, visible: true, seen: {} }),
  update: context => context.state,
  buildViewNode: (context) => {
    const first = context.matches[0]
    const latest = context.matches.at(-1)
    if (!first || !latest) return null
    return {
      key: context.key, kind: 'hivemind-employee-task', id: context.id, target: 'chat',
      anchorSeq: first.event.seq, location: first.location,
      processDisclosure: 'independent', visibility: 'visible',
      data: latest.event.data as unknown as EmployeeTaskSnapshot,
    }
  },
}
