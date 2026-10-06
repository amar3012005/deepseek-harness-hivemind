import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { sessionOwner } from './continuity.ts'
import { requireAdministratorMessageOwner } from './administrator-messaging.ts'

/** Chief-only registry operations; execution and review remain native Teams and Schedule. */
/** Match Core's bounded public profile contract without granting capability changes. */
export function validateEmployeeProfileFields(input: Record<string, unknown>): void {
  for (const [field, limit] of [['name', 100], ['role', 40], ['persona', 12000]] as const) {
    const value = input[field]
    if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > limit)) throw new Error(`invalid_${field}: use nonempty text of at most ${limit} characters`)
  }
}
export function lifecycleBusinessError(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const code = (value as { error?: unknown }).error
  return typeof code === 'string' && /^(invalid_(name|role|persona|employee_configuration|employee_creation|employee_id|creation_key|lifecycle|avatar_url)|empty_employee_configuration|employee_profile_(revision_conflict|not_active|scope_required)|native_employee_required|administrator_membership_required|future_deadline_required|durable_deadline_not_allowed|lifecycle_revision_conflict)$/.test(code) ? code : undefined
}
type SendProfile = (agent: Agent, input: Record<string, JsonValue>, signal: AbortSignal) => Promise<Record<string, JsonValue>>
export function employeeLifecycleTool(send: SendProfile) {
  return defineTool({
    name: 'hivemind_employee_lifecycle',
    description: 'Runtime only: create a company employee without granting connectors or credentials, inspect closeout, begin closeout, or archive after Core verifies accepted work and saved private learning. Use a stable creation_key for replay. When a new employee reports agreed responsibility notes, inspect their current saved profile and company context, then configure a useful biography and operating instructions within the existing permitted skills/tools. Use the exact current expected_profile_revision. A confirmed configure receipt admits one native welcome and first context check-in; do not separately duplicate that awakening. Assign work separately through native Teams and Schedule. Temporary employees require an explicit future deadline. Creation does not authorize external actions.',
    parameters: {
      operation: { type: 'string', required: true, enum: ['create', 'configure', 'begin_closeout', 'inspect_closeout', 'archive'] },
      creation_key: { type: 'string', description: 'Stable replay identity for creation.' },
      name: { type: 'string', description: 'Nonempty display name, maximum 100 characters.' }, persona: { type: 'string', description: 'Biography and operating instructions, maximum 12000 characters.' }, role: { type: 'string', description: 'Short role label, maximum 40 characters; put detailed responsibilities in persona.' },
      lifecycle: { type: 'string', enum: ['durable', 'temporary'] },
      expires_at: { type: 'string', description: 'Future ISO deadline with explicit timezone for a temporary employee.' },
      expected_profile_revision: { type: 'number', description: 'Current native_lifecycle.profile_revision (default 1), required for bounded profile configure.' },
      appearance: { type: 'object', additionalProperties: true },
      avatar_url: { type: 'string' }, employee_id: { type: 'string' }, expected_revision: { type: 'number' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args: unknown, value: JsonValue) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => false,
    async execute(args, execution) {
      validateEmployeeProfileFields(args)
      if (args.operation === 'configure' && Object.keys(args).some(key => args[key as keyof typeof args] !== undefined
        && !['operation', 'employee_id', 'expected_profile_revision', 'persona', 'role', 'name'].includes(key)))
        throw new Error('invalid_employee_configuration: configure accepts only employee_id, expected_profile_revision, name, role and persona')
      const input = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined))
      return send(requireAdministratorMessageOwner(execution.agent), input, execution.signal)
    },
  })
}

/** Own-room biography only; the server rechecks the actual session and current administrator. */
export function employeeProfileTool(send: SendProfile) {
  return defineTool({
    name: 'hivemind_employee_profile',
    description: 'Save the responsibility notes explicitly agreed with the user in your own persistent room for Runtime to review and complete your company-relevant profile. First recall your current authenticated profile and ask a concise native question with grounded suggestions and free-text when responsibilities are unclear. Confirm the user answer before saving; do not invent agreement. The saved proposal is not a Runtime-confirmed profile; wait for its native welcome before your first company-context check-in. Use current profile_revision (default 1). This edits only your own name, role and persona; it never grants tools, connectors, credentials, permissions or company-memory authority. Report success only after the saved receipt.',
    parameters: {
      expected_profile_revision: { type: 'number', required: true },
      persona: { type: 'string', description: 'Agreed responsibilities and operating instructions, maximum 12000 characters.' }, role: { type: 'string', description: 'Short role label, maximum 40 characters; detailed responsibilities belong in persona.' }, name: { type: 'string', description: 'Nonempty display name, maximum 100 characters.' },
    },
    output: { schema: { type:'object',additionalProperties:true,properties:{} }, render: (_args: unknown, value: JsonValue) => [{ type:'text',text:JSON.stringify(value) }] },
    isConcurrencySafe: () => false,
    async execute(args, execution) {
      const agent = execution.agent
      const owner = agent && sessionOwner(agent.session.snapshotEvents())
      let preset = agent?.session.header.agentPreset
      for (const event of agent?.session.ownEvents() ?? []) if (String(event.type) === 'agent-preset/selected') preset = (event.data as { agentPreset:string }).agentPreset
      if (!agent || agent.session.header.parentSession !== undefined || preset !== 'hivemind-hyperagents' || !owner?.id) throw new Error('employee_profile_own_room_required')
      validateEmployeeProfileFields(args)
      return send(agent,{ ...Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined)),operation:'configure',employee_id:owner.id },execution.signal)
    },
  })
}

/** Core's callback is the single deadline producer; preserve pending receipts. */
export function confirmedEmployeeDeadlineSchedule(employeeId: unknown, activation: unknown): string | undefined {
  if (typeof activation !== 'object' || activation === null || Array.isArray(activation)) return undefined
  const value = activation as Record<string, unknown>
  return value['status'] === 'ready' && value['employeeId'] === employeeId
    && typeof value['scheduleId'] === 'string' && value['scheduleId'].length > 0 ? value['scheduleId'] : undefined
}
