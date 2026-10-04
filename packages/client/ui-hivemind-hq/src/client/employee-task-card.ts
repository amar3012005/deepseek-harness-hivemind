/** Event-positioned cards from exact authorized employee snapshot receipts. */
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { EmployeeTaskSnapshot } from '@deepseek-ai/dsh-hivemind-hq-runtime/client'
declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap { 'hivemind-employee-task': EmployeeTaskSnapshot }
}
export const employeeTaskCard: ConversationNodeDefinition<EmployeeTaskSnapshot> = {
  kind: 'hivemind-employee-task', target: 'chat',
  match: event => String(event.type) === 'hivemind/employee-task-snapshot'
    ? { id: String(event.seq), role: 'start' } : null,
  start: (_context, match) => match.event.data as unknown as EmployeeTaskSnapshot,
  update: context => context.state,
  buildViewNode: context => context.start === undefined || context.state === undefined ? null : {
    key: context.key, kind: 'hivemind-employee-task', id: context.id, target: 'chat',
    anchorSeq: context.start.event.seq, location: context.start.location,
    processDisclosure: 'independent', visibility: 'visible', data: context.state,
  },
}
