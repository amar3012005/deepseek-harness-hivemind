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
  match: event => String(event.type) === 'hivemind/employee-task-snapshot'
    ? { id: String(event.seq), role: 'start' } : null,
  start: (_context, match, reader) => {
    const snapshot = match.event.data as unknown as EmployeeTaskSnapshot
    const previous = reader.previous<EmployeeTaskCardState>('hivemind-employee-task')?.state
    const key = `${snapshot.rootSessionId}:${snapshot.task.id}`
    const fingerprint = employeeTaskPresentation(snapshot)
    return { snapshot, visible: previous?.seen[key] !== fingerprint,
      seen: { ...previous?.seen, [key]: fingerprint } }
  },
  update: context => context.state,
  // Prepending history can reveal an earlier identical receipt. Keep the target
  // identity stable when replay changes this card from visible to hidden.
  buildViewNode: context => context.start === undefined || context.state === undefined ? null : {
    key: context.key, kind: 'hivemind-employee-task', id: context.id, target: 'chat',
    anchorSeq: context.start.event.seq, location: context.start.location,
    processDisclosure: 'independent', visibility: context.state.visible ? 'visible' : 'hidden', data: context.state.snapshot,
  },
}
