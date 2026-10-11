import type { Context } from '@deepseek-ai/cordis'
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
    description: 'Runtime only: send a brief meaningful message to the authenticated company administrator through the existing Cloudflare email service. Use for verified reviewed completion, a plan or decision needing their attention, or approval needed during work. Whenever genuine approval or app-connection permission is needed, email immediately with the reason and existing secure request link, once per saved request. The server binds recipient, organization and authenticated room/action links; never supply an arbitrary recipient or authorization URL. If the native connection producer already attempted this request email, inspect its saved receipt and do not duplicate it. Save the result, native question, approval request, or typed delegated blocker first. For a typed delegated blocker, use its returned blocker_id as request_call_id and stable <blocker_id>-user-request key; no blocking question is needed to send this asynchronous notification. For a saved connection_authorization receipt, copy its exact request_call_id and use <request_call_id>-user-request as message_key with kind approval. For other decision/approval requests, copy the exact native question/approval request_call_id. The email opens the existing authenticated Runtime conversation; an email or link opening never grants approval. Reuse message_key and identical content to reconcile interrupted sends; unknown delivery must not be regenerated with a new key. Routine progress stays in chat; employees report to Runtime through native messaging. Accepted means the sender accepted the email, not that the user read it or approved work.',
    parameters: {
      message_key: { type: 'string', required: true, description: 'Stable identity for this meaningful update. For reviewed company completion, derive it from the saved task and accepted revision/evidence; inspect the existing delivery receipt before retrying. Reuse the same key and unchanged content on recovery, including later wakes.' },
      kind: { type: 'string', required: true, enum: ['completion', 'decision', 'approval'] },
      subject: { type: 'string', required: true, description: 'Short plain-language heading; up to 120 characters.' },
      message: { type: 'string', required: true, description: 'Brief human-readable message, what changed or what is needed and why; up to 4000 characters. For actual reviewed completion, give the useful result, remaining blocker or decision and next action, with the saved result link when available. Respect scoped notification preferences and existing sending authority. No raw IDs, counts or technical handoff.' },
      request_call_id: { type: 'string', description: 'Exact native question/approval call, an existing typed HQ blocker_id returned by hivemind_hq_blocker, or the request_call_id of a saved connection_authorization receipt. A blocker uses message_key <blocker_id>-user-request; human_input is decision, connection/permission is approval. This sends a request, never grants permission or holds an employee turn.' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args: unknown, value: JsonValue) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => false,
    async execute(args, execution) {
      const agent = requireAdministratorMessageOwner(execution.agent)
      return send(agent, args, execution.signal)
    },
  })
}

/** Notify from the awaited native stopping seam; the approval itself stays parked. */
export function installAdministratorApprovalNotification(ctx: Context, send: AdministratorMessageSender): void {
  const attempted = new WeakMap<Agent, Set<string>>()
  ctx.effect(() => ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    if (signal.aborted) return
    try { requireAdministratorMessageOwner(agent) } catch { return }
    const events = agent.session.snapshotEvents()
    const start = events.findLast(event => event.type === 'turn/start' && event.data.turn === turn)
    if (!start) return
    const current = events.filter(event => event.seq > start.seq)
    for (const event of current) {
      if (String(event.type) !== 'approval/decided') continue
      const decision = event.data as { id?: string; outcome?: string }
      if (decision.outcome !== 'pending') continue
      const asked = current.find(row => String(row.type) === 'approval/asked'
        && (row.data as { id?: string }).id === decision.id)
      const request = asked?.data as { callId?: string; reason?: string; toolName?: string } | undefined
      if (!request?.callId || !current.some(row => row.type === 'tool/call'
        && row.data.callId === request.callId && row.data.name === request.toolName)) continue
      const callId = request.callId
      const seen = attempted.get(agent) ?? new Set<string>()
      attempted.set(agent, seen)
      if (seen.has(callId)) continue
      // A restored occurrence uses the same identity/content: Core reconciles its
      // durable ledger, including unknown delivery, instead of issuing a new send.
      const original = events.find(row => String(row.type) === 'approval/asked'
        && (row.data as { callId?: string }).callId === callId)?.data as { reason?: string } | undefined
      const reason = original?.reason?.trim().slice(0, 3500)
      if (!await ctx.sessions.flush(agent.session)) continue
      signal.throwIfAborted()
      seen.add(callId)
      try {
        await send(agent, { message_key: `${callId}-user-request`, kind: 'approval',
          subject: 'Approval needed to continue',
          message: reason ? `I need your approval before continuing. ${reason}` : 'I need your approval before continuing this action. Please review the saved request in our conversation.',
          request_call_id: callId }, AbortSignal.any([signal, AbortSignal.timeout(10_000)]))
      } catch {
        // Keep the actual permission request parked; never retry a possibly sent
        // email with a different key or mistake transport failure for approval.
        ctx.logger.warn('Runtime approval notification attempt failed; saved approval remains pending')
      }
    }
  }))
}
