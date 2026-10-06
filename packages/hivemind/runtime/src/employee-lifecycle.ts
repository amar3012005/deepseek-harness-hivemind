import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { requireAdministratorMessageOwner } from './administrator-messaging.ts'

/** Chief-only registry operations; execution and review remain native Teams and Schedule. */
export function employeeLifecycleTool(send: (agent: Agent, input: Record<string, JsonValue>, signal: AbortSignal) => Promise<Record<string, JsonValue>>) {
  return defineTool({
    name: 'hivemind_employee_lifecycle',
    description: 'Runtime only: create a company employee without granting connectors or credentials, inspect closeout, begin closeout, or archive after Core verifies accepted work and saved private learning. Use a stable creation_key for replay. Assign work separately through native Teams and Schedule. Temporary employees require an explicit future deadline. Creation does not authorize external actions.',
    parameters: {
      operation: { type: 'string', required: true, enum: ['create', 'begin_closeout', 'inspect_closeout', 'archive'] },
      creation_key: { type: 'string', description: 'Stable replay identity for creation.' },
      name: { type: 'string' }, persona: { type: 'string' }, role: { type: 'string' },
      lifecycle: { type: 'string', enum: ['durable', 'temporary'] },
      expires_at: { type: 'string', description: 'Future ISO deadline with explicit timezone for a temporary employee.' },
      avatar_url: { type: 'string' }, employee_id: { type: 'string' }, expected_revision: { type: 'number' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args: unknown, value: JsonValue) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => false,
    async execute(args, execution) {
      return send(requireAdministratorMessageOwner(execution.agent), args, execution.signal)
    },
  })
}
