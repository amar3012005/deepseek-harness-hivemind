/** A confirmed registry profile carried by the existing native identity event. */
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './EmployeeJoining.module.css'
export interface EmployeeJoining { name: string; role: string; at: string; creationHash: string }
export function employeeJoiningReceipt(value: unknown): EmployeeJoining | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const data = value as {
    id?: unknown
    name?: unknown
    role?: unknown
    joining?: { at?: unknown; creationHash?: unknown; profileRevision?: unknown }
  }
  const joining = data.joining
  if (typeof data.id !== 'string' || !data.id || typeof data.name !== 'string' || !data.name
    || typeof data.role !== 'string' || !data.role || typeof joining?.at !== 'string' || !Number.isFinite(Date.parse(joining.at))
    || typeof joining.creationHash !== 'string' || !/^[a-f0-9]{64}$/u.test(joining.creationHash)
    || typeof joining.profileRevision !== 'number' || !Number.isInteger(joining.profileRevision) || joining.profileRevision < 1) return undefined
  return { name: data.name, role: data.role, at: joining.at, creationHash: joining.creationHash }
}
export const employeeJoining: ConversationNodeDefinition<EmployeeJoining> = {
  kind: 'hivemind-employee-joining', target: 'chat',
  match: event => String(event.type) === 'hivemind/employee-selection' && employeeJoiningReceipt(event.data) !== undefined
    ? { id: String(event.seq), role: 'start' } : null,
  start: (_context, match) => {
    const receipt = employeeJoiningReceipt(match.event.data)
    if (receipt === undefined) throw Error('employee_joining_receipt_required')
    return receipt
  },
  update: context => context.state,
  buildViewNode: context => context.start === undefined || context.state === undefined ? null : {
    key: context.key, kind: 'hivemind-employee-joining', id: context.id, target: 'chat',
    anchorSeq: context.start.event.seq, location: context.start.location,
    processDisclosure: 'independent', visibility: 'visible', data: context.state,
  },
}
export function EmployeeJoiningMilestone({ receipt, label }: { receipt: EmployeeJoining; label: string }) {
  return <div className={css.milestone} role="note" data-employee-joining>
    <span className={css.check} aria-hidden="true">✓</span>
    <span>{label}</span><span>{receipt.role}</span>
    <time dateTime={receipt.at}>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(receipt.at))}</time>
  </div>
}
