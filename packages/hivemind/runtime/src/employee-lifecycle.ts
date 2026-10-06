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
/** Validate operation-specific inputs before Core; never guess registry IDs or revisions. */
export function validateEmployeeLifecycleInput(input: Record<string, unknown>): void {
  const operation = input.operation
  const fields = operation === 'create'
    ? ['operation', 'creation_key', 'name', 'persona', 'role', 'lifecycle', 'expires_at', 'appearance', 'avatar_url']
    : operation === 'configure'
      ? ['operation', 'employee_id', 'expected_profile_revision', 'persona', 'role', 'name']
      : operation === 'inspect_closeout'
        ? ['operation', 'employee_id']
        : ['operation', 'employee_id', 'expected_revision']
  if (!['create', 'configure', 'inspect_closeout', 'begin_closeout', 'archive'].includes(String(operation))) {
    throw new Error('invalid_lifecycle_operation: use a supported employee lifecycle operation')
  }
  if (Object.keys(input).some(key => input[key] !== undefined && !fields.includes(key))) {
    if (operation === 'configure' && input.expected_revision !== undefined) {
      throw new Error('invalid_employee_configuration: configure needs expected_profile_revision from policyRules.native_lifecycle.profile_revision; expected_revision is only for closeout and archive. Inspect the current employee before retrying; do not substitute one revision for the other.')
    }
    throw new Error(`invalid_employee_${operation === 'create' ? 'creation' : 'configuration'}: ${operation} accepts only ${fields.join(', ')}`)
  }
  if (operation === 'create') {
    if (typeof input.creation_key !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(input.creation_key)) {
      throw new Error('invalid_creation_key: supply a stable creation identity of 1-160 letters, digits, dots, underscores, colons or hyphens; preserve it and all content on an identical retry')
    }
    if (input.name === undefined) throw new Error('invalid_name: create requires a nonempty employee name')
    const kind = input.lifecycle ?? 'durable'
    if (!['durable', 'temporary'].includes(String(kind))) throw new Error('invalid_lifecycle: choose durable or temporary')
    if (kind === 'temporary' && (typeof input.expires_at !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(input.expires_at) || !Number.isFinite(Date.parse(input.expires_at)))) {
      throw new Error('future_deadline_required: temporary employees need an explicit ISO deadline with timezone; Core checks that new creation is in the future')
    }
    if (kind === 'durable' && input.expires_at !== undefined) throw new Error('durable_deadline_not_allowed: omit expires_at for a durable employee')
    return
  }
  if (typeof input.employee_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.employee_id)) {
    throw new Error('invalid_employee_id: copy the employee.id UUID from the current registry/profile or confirmed lifecycle receipt. A slug, name, session ID or creation_key is not an employee_id. Inspect the directory; never guess an ID.')
  }
  const field = operation === 'configure' ? 'expected_profile_revision' : 'expected_revision'
  if (operation !== 'inspect_closeout' && (!Number.isSafeInteger(input[field]) || Number(input[field]) < 1)) {
    throw new Error(`missing_employee_revision: ${operation} requires ${field}, a positive integer copied from current policyRules.native_lifecycle.${operation === 'configure' ? 'profile_revision' : 'revision'}. Inspect the current employee with inspect_closeout before retrying; do not default or guess.`)
  }
  if (operation === 'configure' && !['name', 'role', 'persona'].some(key => input[key] !== undefined)) {
    throw new Error('empty_employee_configuration: configure needs at least one of name, role or persona')
  }
}
/** Static recovery guidance for known errors; never expose arbitrary response bodies. */
export function lifecycleErrorGuidance(code: string): string {
  if (code === 'lifecycle_revision_conflict') return `${code}: inspect_closeout with the exact employee.id UUID, read policyRules.native_lifecycle.revision and phase, and reconsider the requested transition before retrying with current expected_revision. Do not guess a revision or repeat completed work.`
  if (code === 'employee_profile_revision_conflict') return `${code}: inspect the current employee, review its changed responsibilities, then retry configure with policyRules.native_lifecycle.profile_revision as expected_profile_revision. Do not use expected_revision or overwrite a newer profile blindly.`
  return code
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
    description: 'Runtime only: create a company employee without granting connectors or credentials, inspect closeout, begin closeout, or archive after Core verifies accepted work and saved private learning. Use a stable creation_key for replay. When a new employee reports agreed responsibility notes, inspect their current saved profile and company context, then configure a useful biography and operating instructions within the existing permitted skills/tools. For configure use expected_profile_revision from policyRules.native_lifecycle.profile_revision; never expected_revision. For begin_closeout and archive, expected_revision from policyRules.native_lifecycle.revision is required. First inspect_closeout to read the exact employee.id UUID, both revisions and closeout state. Never use a slug, name or creation_key as employee_id. On a revision conflict inspect again, reconsider the transition and use the current revision; never guess or bypass it. A confirmed configure receipt admits one native welcome and first context check-in; do not separately duplicate that awakening. Assign work separately through native Teams and Schedule. Temporary employees require an explicit future deadline. Creation does not authorize external actions.',
    parameters: {
      operation: { type: 'string', required: true, enum: ['create', 'configure', 'begin_closeout', 'inspect_closeout', 'archive'] },
      creation_key: { type: 'string', description: 'Stable replay identity for creation.' },
      name: { type: 'string', description: 'Nonempty display name, maximum 100 characters.' }, persona: { type: 'string', description: 'Biography and operating instructions, maximum 12000 characters.' }, role: { type: 'string', description: 'Short role label, maximum 40 characters; put detailed responsibilities in persona.' },
      lifecycle: { type: 'string', enum: ['durable', 'temporary'] },
      expires_at: { type: 'string', description: 'Future ISO deadline with explicit timezone for a temporary employee.' },
      expected_profile_revision: { type: 'number', description: 'Configure only: required positive integer copied from current policyRules.native_lifecycle.profile_revision. Different from lifecycle revision; inspect first, never assume a default.' },
      appearance: { type: 'object', additionalProperties: true },
      avatar_url: { type: 'string' },
      employee_id: { type: 'string', description: 'Required except create: exact employee.id UUID from the saved registry/profile or lifecycle receipt, never slug, name, creation_key or session ID.' },
      expected_revision: { type: 'number', description: 'Required for begin_closeout and archive only: current positive integer policyRules.native_lifecycle.revision from inspect_closeout. Never use this field for configure.' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args: unknown, value: JsonValue) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => false,
    async execute(args, execution) {
      validateEmployeeProfileFields(args)
      validateEmployeeLifecycleInput(args)
      const input = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined))
      try {
        return await send(requireAdministratorMessageOwner(execution.agent), input, execution.signal)
      } catch (error) {
        if (error instanceof Error && ['lifecycle_revision_conflict', 'employee_profile_revision_conflict'].includes(error.message)) {
          throw new Error(lifecycleErrorGuidance(error.message), { cause: error })
        }
        throw error
      }
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
