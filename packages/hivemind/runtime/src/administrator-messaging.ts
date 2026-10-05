import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { sessionOwner } from './continuity.ts'

/** Only the persistent Chief can send a company-scoped human notification. */
export function requireAdministratorMessageOwner(agent: Agent | undefined): Agent {
  if (agent?.session.header.agentPreset !== 'hivemind-hq' || agent.session.header.parentSession !== undefined
    || sessionOwner(agent.session.snapshotEvents())?.slug !== 'runtime' || sessionOwner(agent.session.snapshotEvents())?.id !== null) throw new Error('Only the persistent Runtime can message the administrator')
  return agent
}
type AdministratorMessageSender =
  (agent: Agent, input: Record<string, JsonValue>, signal: AbortSignal) => Promise<Record<string, JsonValue>>
export function administratorMessageTool(send: AdministratorMessageSender) {
  return defineTool({
    name: 'hivemind_administrator_message',
    description: 'Runtime only: send a brief meaningful message to the authenticated company administrator through the existing Cloudflare email service. Use for verified reviewed completion, a plan or decision needing their attention, or approval needed during work. Save the result or native question first. For decision/approval, use native ask_user_question (plan-review when appropriate) or the existing approval request; copy its exact request_call_id. The email opens the existing authenticated Runtime conversation; an email or link opening never grants approval. Reuse message_key and identical content to reconcile interrupted sends; unknown delivery must not be regenerated with a new key. Routine progress stays in chat; employees report to Runtime through native messaging. Accepted means the sender accepted the email, not that the user read it or approved work.',
    parameters: {
      message_key: { type: 'string', required: true, description: 'Stable identity for this meaningful update. Reuse the same key and unchanged content on recovery.' },
      kind: { type: 'string', required: true, enum: ['completion', 'decision', 'approval'] },
      subject: { type: 'string', required: true, description: 'Short plain-language heading; up to 120 characters.' },
      message: { type: 'string', required: true, description: 'Brief human-readable message, what changed or what is needed and why; up to 4000 characters. No raw IDs or technical handoff.' },
      request_call_id: { type: 'string', description: 'Exact native question or approval call reference, required for decision and approval.' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args: unknown, value: JsonValue) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => false,
    async execute(args, execution) {
      const agent = requireAdministratorMessageOwner(execution.agent)
      return send(agent, args, execution.signal)
    },
  })
}
