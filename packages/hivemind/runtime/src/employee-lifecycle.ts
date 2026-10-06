import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { sessionOwner } from './continuity.ts'
import { requireAdministratorMessageOwner } from './administrator-messaging.ts'

/** Chief-only registry operations; execution and review remain native Teams and Schedule. */
type SendProfile = (agent: Agent, input: Record<string, JsonValue>, signal: AbortSignal) => Promise<Record<string, JsonValue>>
export function employeeLifecycleTool(send: SendProfile) {
  return defineTool({
    name: 'hivemind_employee_lifecycle',
    description: 'Runtime only: create a company employee without granting connectors or credentials, inspect closeout, begin closeout, or archive after Core verifies accepted work and saved private learning. Use a stable creation_key for replay. Assign work separately through native Teams and Schedule. Temporary employees require an explicit future deadline. Creation does not authorize external actions.',
    parameters: {
      operation: { type: 'string', required: true, enum: ['create', 'configure', 'begin_closeout', 'inspect_closeout', 'archive'] },
      creation_key: { type: 'string', description: 'Stable replay identity for creation.' },
      name: { type: 'string' }, persona: { type: 'string' }, role: { type: 'string' },
      lifecycle: { type: 'string', enum: ['durable', 'temporary'] },
      expires_at: { type: 'string', description: 'Future ISO deadline with explicit timezone for a temporary employee.' },
      expected_profile_revision: { type: 'number', description: 'Current native_lifecycle.profile_revision (default 1), required for bounded profile configure.' },
      appearance: { type: 'object', additionalProperties: true },
      avatar_url: { type: 'string' }, employee_id: { type: 'string' }, expected_revision: { type: 'number' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args: unknown, value: JsonValue) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => false,
    async execute(args, execution) {
      return send(requireAdministratorMessageOwner(execution.agent), args, execution.signal)
    },
  })
}

/** Own-room biography only; the server rechecks the actual session and current administrator. */
export function employeeProfileTool(send: SendProfile) {
  return defineTool({
    name: 'hivemind_employee_profile',
    description: 'Save the responsibilities/biography explicitly agreed with the user in your own persistent room. First recall your current authenticated profile and ask a concise native question with grounded suggestions and free-text when responsibilities are unclear. Confirm the user answer before saving; do not invent agreement. Use current profile_revision (default 1). This edits only your own name, role and persona; it never grants tools, connectors, credentials, permissions or company-memory authority. Report success only after the saved receipt.',
    parameters: {
      expected_profile_revision: { type: 'number', required: true },
      persona: { type: 'string' }, role: { type: 'string' }, name: { type: 'string' },
    },
    output: { schema: { type:'object',additionalProperties:true,properties:{} }, render: (_args: unknown, value: JsonValue) => [{ type:'text',text:JSON.stringify(value) }] },
    isConcurrencySafe: () => false,
    async execute(args, execution) {
      const agent = execution.agent
      const owner = agent && sessionOwner(agent.session.snapshotEvents())
      let preset = agent?.session.header.agentPreset
      for (const event of agent?.session.ownEvents() ?? []) if (String(event.type) === 'agent-preset/selected') preset = (event.data as { agentPreset:string }).agentPreset
      if (!agent || agent.session.header.parentSession !== undefined || preset !== 'hivemind-hyperagents' || !owner?.id) throw new Error('employee_profile_own_room_required')
      return send(agent,{ ...args,operation:'configure',employee_id:owner.id },execution.signal)
    },
  })
}
