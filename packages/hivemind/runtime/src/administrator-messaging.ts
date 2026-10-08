import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { sessionOwner } from './continuity.ts'

/** Only the persistent Chief can send a company-scoped human notification. */
export function requireAdministratorMessageOwner(agent: Agent | undefined): Agent {
  let preset = agent?.session.header.agentPreset
  for (const event of agent?.session.snapshotEvents() ?? []) {
    if (String(event.type) === 'agent-preset/selected') preset = (event.data as { agentPreset: string }).agentPreset
  }
  if (!agent || preset !== 'hivemind-hq' || agent.session.header.parentSession !== undefined
    || sessionOwner(agent.session.snapshotEvents())?.slug !== 'runtime' || sessionOwner(agent.session.snapshotEvents())?.id !== null) throw new Error('Only the persistent Runtime can message the administrator')
  return agent
}
type AdministratorMessageSender =
  (agent: Agent, input: Record<string, JsonValue>, signal: AbortSignal) => Promise<Record<string, JsonValue>>
export function administratorMessageTool(send: AdministratorMessageSender) {
  return defineTool({
    name: 'hivemind_administrator_message',
    description: 'Runtime only: send a brief meaningful message to the authenticated company administrator through the existing Cloudflare email service. Use for verified reviewed completion, a plan or decision needing their attention, or approval needed during work. Save the result, native question, approval request, or typed delegated blocker first. For a typed delegated blocker, use its returned blocker_id as request_call_id and stable <blocker_id>-user-request key; no blocking question is needed to send this asynchronous notification. For other decision/approval requests, copy the exact native question/approval request_call_id. The email opens the existing authenticated Runtime conversation; an email or link opening never grants approval. Reuse message_key and identical content to reconcile interrupted sends; unknown delivery must not be regenerated with a new key. Routine progress stays in chat; employees report to Runtime through native messaging. Accepted means the sender accepted the email, not that the user read it or approved work.',
    parameters: {
      message_key: { type: 'string', required: true, description: 'Stable identity for this meaningful update. Reuse the same key and unchanged content on recovery.' },
      kind: { type: 'string', required: true, enum: ['completion', 'decision', 'approval'] },
      subject: { type: 'string', required: true, description: 'Short plain-language heading; up to 120 characters.' },
      message: { type: 'string', required: true, description: 'Brief human-readable message, what changed or what is needed and why; up to 4000 characters. No raw IDs or technical handoff.' },
      request_call_id: { type: 'string', description: 'Exact native question/approval call, or an existing typed HQ blocker_id returned by hivemind_hq_blocker. A blocker uses message_key <blocker_id>-user-request; human_input is decision, connection/permission is approval. This sends a request, never grants permission or holds an employee turn.' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args: unknown, value: JsonValue) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => false,
    async execute(args, execution) {
      const agent = requireAdministratorMessageOwner(execution.agent)
      return send(agent, args, execution.signal)
    },
  })
}
