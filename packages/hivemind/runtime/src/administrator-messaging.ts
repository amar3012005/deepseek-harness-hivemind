import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { sessionOwner } from './continuity.ts'
import { createHash } from 'node:crypto'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

type ParkedApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
type ParkedApprovalStatus = 'pending' | ParkedApprovalOutcome

interface RuntimeNativeApprovalNotification {
  readonly callId: string
  readonly rootCallId: string
  readonly approvalId: string
  readonly toolName: string
  readonly argumentsDigest: string
  readonly reason?: string
  readonly owner: {
    readonly orgId: string
    readonly userId: string
    readonly profile: 'hivemind-chat'
    readonly variation: string
    readonly projectId?: string
    readonly nativeSessionHash?: string
  }
  readonly status: ParkedApprovalStatus
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Exact-call Runtime approval checkpoint; args remain in the native tool/call event. */
    'hivemind/runtime-native-approval-notification': RuntimeNativeApprovalNotification
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function argumentsDigest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

/** Keep approval reasons useful while avoiding control data and obvious credentials. */
export function safeApprovalReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined
  const safe = reason
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\bBearer\s+\S+/giu, '[redacted]')
    .replace(/\b(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/giu, '[redacted]')
    .replace(/https?:\/\/\S+/giu, '[link]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[email]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 3500)
  return safe || undefined
}

/** Bound the notification wait even when a sender ignores AbortSignal. */
async function sendApprovalNotification(
  send: AdministratorMessageSender,
  agent: Agent,
  input: Record<string, JsonValue>,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const controller = new AbortController()
  const combinedSignal = AbortSignal.any([
    signal ?? new AbortController().signal,
    controller.signal,
  ])
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error('Runtime approval notification timed out'))
      resolve(false)
    }, 10_000)
  })
  const delivery = Promise.resolve().then(() => send(agent, input, combinedSignal)).then(
    () => true as const,
    () => false as const,
  )
  try {
    return await Promise.race([delivery, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

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

/** Record and notify a genuine native Runtime approval before its answerer waits. */
export function installAdministratorApprovalNotification(ctx: Context, send: AdministratorMessageSender): void {
  const attempted = new WeakMap<Agent, Set<string>>()
  const candidates = new Map<string, ToolExecution>()
  const keyOf = (agent: Agent, callId: string) => `${agent.session.header.id}:${callId}`
  ctx.effect(() => ctx.on('tools/pre-execute', async (execution, next) => {
    const decision = await next()
    if (decision.kind === 'ask' && execution.agent !== undefined) {
      candidates.set(keyOf(execution.agent, String(execution.callId)), execution)
    }
    return decision
  }))
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    const prefix = `${session.header.id}:`
    for (const key of candidates.keys()) if (key.startsWith(prefix)) candidates.delete(key)
  }))
  ctx.effect(() => ctx.on('approval/request', async function (request, next) {
    const { agent, callId, toolName, reason, signal } = request
    if (!callId || signal?.aborted) return next()
    let owner: RuntimeNativeApprovalNotification['owner']
    try {
      requireAdministratorMessageOwner(agent)
      const principal = ctx.hivemindExecutionScope.require()
      owner = {
        orgId: principal.orgId, userId: principal.userId,
        profile: principal.profile, variation: principal.variation,
        ...(principal.projectId === undefined ? {} : { projectId: principal.projectId }),
        ...(principal.nativeSessionHash === undefined ? {} : { nativeSessionHash: principal.nativeSessionHash }),
      }
    } catch { return next() }
    const execution = candidates.get(keyOf(agent, String(callId)))
    const events = agent.session.snapshotEvents()
    const asked = events.findLast(event => event.type === 'approval/asked'
      && event.data.callId === callId && event.data.toolName === toolName)
    if (asked?.type !== 'approval/asked') return next()
    const toolCall = events.findLast(event => event.type === 'tool/call'
      && event.data.callId === callId && event.data.name === toolName)
    if (toolCall?.type !== 'tool/call') return next()
    const checkpoint = events.findLast(event => event.type === 'hivemind/runtime-approval-checkpoint'
      && event.data.callId === String(callId))
    if (checkpoint?.type === 'hivemind/runtime-approval-checkpoint'
      && ['approved', 'executing', 'completed'].includes(checkpoint.data.state)) return next()
    const args = execution?.arguments ?? toolCall.data.arguments
    const safeReason = safeApprovalReason(reason)
    const base: RuntimeNativeApprovalNotification = {
      callId: String(callId), rootCallId: String(execution?.rootCallId ?? callId),
      approvalId: String(asked.data.id), toolName,
      argumentsDigest: argumentsDigest(args),
      ...(safeReason === undefined ? {} : { reason: safeReason }), owner, status: 'pending',
    }
    agent.session.append('hivemind/runtime-native-approval-notification', base)
    if (!await ctx.sessions.flush(agent.session)) {
      ctx.logger.warn('Runtime approval checkpoint was not persisted; native approval remains authoritative')
      return next()
    }
    const seen = attempted.get(agent) ?? new Set<string>()
    attempted.set(agent, seen)
    if (!seen.has(String(callId))) {
      seen.add(String(callId))
      if (!signal?.aborted) {
        try {
          const delivered = await sendApprovalNotification(send, agent, { message_key: `${callId}-user-request`, kind: 'approval',
            subject: 'Approval needed to continue',
            message: safeApprovalReason(reason) ? `I need your approval before continuing. ${safeApprovalReason(reason)}` : 'I need your approval before continuing this action. Please review the saved request in our conversation.',
            request_call_id: String(callId) }, signal)
          if (!delivered) ctx.logger.warn('Runtime approval notification attempt failed or timed out; native approval remains pending')
        } catch {
          ctx.logger.warn('Runtime approval notification attempt failed; native approval remains pending')
        }
      }
    }
    try {
      const outcome = await next()
      agent.session.append('hivemind/runtime-native-approval-notification', { ...base, status: outcome })
      if (!await ctx.sessions.flush(agent.session)) ctx.logger.warn('Runtime approval outcome checkpoint was not persisted')
      return outcome
    } finally {
      candidates.delete(keyOf(agent, String(callId)))
    }
  }, { prepend: true }))
  ctx.effect(() => ctx.on('tools/park-commit', async (execution, park, next) => {
    const agent = execution.agent
    if (!agent) return next()
    const downstream = await next()
    if (downstream.kind !== 'committed') return downstream
    const callId = String(execution.callId)
    const events = agent.session.snapshotEvents()
    const checkpoint = events.findLast(event => event.type === 'hivemind/runtime-approval-checkpoint'
      && event.data.callId === callId && event.data.approvalId === park.approvalId
      && event.data.argumentsDigest === park.argumentsDigest && event.data.state === 'pending')
    const parked = events.findLast(event => event.type === 'tool/parked'
      && String(event.data.callId) === callId && event.data.approvalId === park.approvalId
      && event.data.argumentsDigest === park.argumentsDigest)
    if (checkpoint?.type !== 'hivemind/runtime-approval-checkpoint' || parked?.type !== 'tool/parked') return downstream
    let owner: RuntimeNativeApprovalNotification['owner']
    try {
      requireAdministratorMessageOwner(agent)
      const principal = ctx.hivemindExecutionScope.require()
      owner = {
        orgId: principal.orgId, userId: principal.userId,
        profile: principal.profile, variation: principal.variation,
        ...(principal.projectId === undefined ? {} : { projectId: principal.projectId }),
        ...(principal.nativeSessionHash === undefined ? {} : { nativeSessionHash: principal.nativeSessionHash }),
      }
    } catch { return downstream }
    const toolName = execution.name
    const safeReason = safeApprovalReason(checkpoint.data.reason)
    const base: RuntimeNativeApprovalNotification = {
      callId, rootCallId: String(execution.rootCallId), approvalId: park.approvalId,
      toolName, argumentsDigest: park.argumentsDigest,
      ...(safeReason === undefined ? {} : { reason: safeReason }), owner, status: 'pending',
    }
    agent.session.append('hivemind/runtime-native-approval-notification', base)
    if (!await ctx.sessions.flush(agent.session)) {
      ctx.logger.warn('Runtime park notification receipt was not persisted; approval remains pending')
      return downstream
    }
    const seen = attempted.get(agent) ?? new Set<string>()
    attempted.set(agent, seen)
    if (!seen.has(callId)) {
      seen.add(callId)
      {
        try {
          const sent = await sendApprovalNotification(send, agent, {
            message_key: `${callId}-user-request`, kind: 'approval',
            subject: 'Approval needed to continue',
            message: safeReason ? `I need your approval before continuing. ${safeReason}` : 'I need your approval before continuing this action. Please review the saved request in our conversation.',
            request_call_id: callId,
          }, undefined)
          if (!sent) ctx.logger.warn('Runtime park notification failed or timed out; approval remains pending')
        } catch {
          ctx.logger.warn('Runtime park notification failed; approval remains pending')
        }
      }
    }
    return downstream
  }, { prepend: false }))
}
