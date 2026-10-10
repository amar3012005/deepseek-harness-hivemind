/** One model-facing tool, backed by the native Session owner, not a replacement loop. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { sessionOwner } from './continuity.ts'
import type {} from '@deepseek-ai/dsh-hivemind-employee-directory'
import type {} from '@deepseek-ai/dsh-agent-presets'

interface RoomDelivery {
  deliverAgentMessage(caller: Agent, input: {
    key: string
    target: string
    targetProfile?: { id: string; name: string; role: string }
    kind: 'question' | 'reply' | 'update'
    text: string
    summary?: string
    taskId?: string
    replyTo?: string
    artifactIds?: string[]
  }, signal: AbortSignal): Promise<Record<string, JsonValue>>
}
/** Resolve only a unique row in the caller's authenticated directory. */
export function authorizedRecipient<T extends Record<string, unknown>>(profiles: readonly T[], recipient: string): T | undefined {
  const exact = profiles.find(profile => profile['id'] === recipient)
  if (exact) return exact
  const matches = profiles.filter(profile => profile['slug'] === recipient)
  if (matches.length > 1) throw new Error('agent_message_recipient_ambiguous_use_exact_employee_id')
  return matches[0]
}
/** Resolve the sender's preset realm, retaining fresh tenant-authorized lookup. */
export function messageDirectory(ctx: Context, agent: Agent) {
  return (typeof ctx.get === 'function' ? ctx.get('agentPresets')?.serviceFor(agent, 'hivemindEmployeeDirectory') : undefined)
    ?? ctx.hivemindEmployeeDirectory
}
export function employeeFailureSummary(code: string): string {
  const category = /POLICY|SAFETY|REFUS|CONTENT_FILTER/i.test(code) ? 'a provider policy rejection'
    : /AUTH|PERMISSION|FORBIDDEN/i.test(code) ? 'an authorization failure'
      : /QUOTA|BILLING|CREDIT/i.test(code) ? 'a provider quota limit'
        : /TIMEOUT|TRANSPORT|SERVER/i.test(code) ? 'a provider availability failure'
          : 'a model request failure'
  return `Chief, my turn ended because of ${category}. The assignment remains unfinished; please review the blocker before resuming it.`
}
/** Replay bounded company-owned packets through the same native Inbox owner.
 * A fresh authenticated directory remains mandatory; no native Team outbox is assumed.
 */
export async function reconcileRoomMessages(ctx: Context, rooms: RoomDelivery, agent: Agent, signal: AbortSignal): Promise<void> {
  if (agent.session.header.parentSession !== undefined) return
  const events = agent.session.snapshotEvents()
  const delivered = new Set(events.filter(event => String(event.type) === 'hivemind/room-message-delivered')
    .map(event => (event.data as { id: string }).id))
  type Packet = {
    id: string
    senderId: string
    targetId: string
    kind: 'question' | 'reply' | 'update'
    text: string
    summary?: string
    taskId?: string
    replyTo?: string
    artifactIds: string[]
    delivery?: { key: string; target: string }
  }
  const savedKeys = new Map<string, { key: string; target: string }>()
  for (const event of events) {
    if (event.type !== 'tool/call' || event.data.name !== 'hivemind_agent_message') continue
    try {
      const input = JSON.parse(event.data.arguments) as { message_key?: string; recipient?: string }
      if (typeof input.message_key !== 'string' || typeof input.recipient !== 'string') continue
      const id = `agent-message-${createHash('sha256').update(JSON.stringify([agent.id, input.message_key])).digest('hex')}`
      savedKeys.set(id, { key: input.message_key, target: input.recipient })
    } catch { /* Historical malformed tool input cannot reconstruct a delivery key. */ }
  }
  const pending = events.filter(event => String(event.type) === 'hivemind/room-message-queued')
    .map(event => event.data as unknown as Packet)
    .map(packet => packet.delivery === undefined ? { ...packet, delivery: savedKeys.get(packet.id) } : packet)
    .filter(packet => packet.senderId === agent.id && packet.delivery !== undefined && !delivered.has(packet.id)).slice(0, 8)
  if (pending.length === 0) return
  const directory = await messageDirectory(ctx, agent).profiles(signal)
  const owner = sessionOwner(events)
  if (agent.session.header.agentPreset !== 'hivemind-hq' && !directory.profiles.some(profile => profile['id'] === owner?.id)) return
  for (const packet of pending) {
    signal.throwIfAborted()
    const delivery = packet.delivery
    if (delivery === undefined) continue
    if (packet.taskId !== undefined && agent.session.header.agentPreset === 'hivemind-hq') {
      const task = events.findLast(event => String(event.type) === 'team/task'
        && (event.data as { task?: { id?: string } }).task?.id === packet.taskId)?.data as { task?: { status?: string } } | undefined
      const assignment = events.findLast(event => String(event.type) === 'hivemind/hq-employee-assignment'
        && (event.data as { taskId?: string }).taskId === packet.taskId)?.data as { sessionId?: string } | undefined
      if (task?.task?.status === 'completed' || task?.task?.status === 'deleted'
        || (assignment?.sessionId !== undefined && assignment.sessionId !== packet.targetId)) continue
    }
    // Never infer an identity or change a saved target when permissions or the roster changed.
    const profile = delivery.target === 'runtime' ? undefined : authorizedRecipient(directory.profiles, delivery.target)
    if (delivery.target !== 'runtime' && (profile === undefined || profile['status'] === 'paused'
      || profile['status'] === 'archived' || profile['archived_at'] || profile['archivedAt'])) continue
    try {
      await rooms.deliverAgentMessage(agent, { key: delivery.key, target: delivery.target, kind: packet.kind, text: packet.text,
        ...(profile === undefined ? {} : { targetProfile: { id: String(profile['id']), name: String(profile['name']), role: String(profile['role_archetype'] ?? 'HIVE-MIND employee') } }),
        ...(packet.summary === undefined ? {} : { summary: packet.summary }),
        ...(packet.taskId === undefined ? {} : { taskId: packet.taskId }),
        ...(packet.replyTo === undefined ? {} : { replyTo: packet.replyTo }), artifactIds: packet.artifactIds }, signal)
    } catch {
      signal.throwIfAborted()
      ctx.logger.warn('A saved company message remains unconfirmed; a later admitted turn can retry the same packet.')
    }
  }
}
export function installAgentMessaging(ctx: Context): void {
  ctx.inject(['sessionController', 'hivemindEmployeeDirectory'], (scope) => {
    const rooms = Reflect.get(scope, 'sessionController') as RoomDelivery
    const forwardUpdates = async (agent: Agent, signal: AbortSignal): Promise<void> => {
      if (agent.session.header.parentSession !== undefined || agent.session.header.agentPreset === 'hivemind-hq') return
      const owner = sessionOwner(agent.session.snapshotEvents())
      if (!owner?.id) return
      const events = agent.session.snapshotEvents()
      const delivered = new Set(events.filter(event => String(event.type) === 'hivemind/room-message-delivered').map(event => (event.data as { id: string }).id))
      const confirmed = (key: string) => delivered.has(`agent-message-${createHash('sha256').update(JSON.stringify([agent.id, key])).digest('hex')}`)
      // Report once at the terminal lifecycle boundary. Artifact creation is
      // intermediate progress, not a separate employee conversation turn.
      const pending = events.filter(event => event.type === 'turn/end'
        && !confirmed(`response-${event.seq}`)
        && (event.data.reason.kind === 'error' || event.data.reason.kind === 'completed'))
      if (pending.length === 0) return
      const directory = await messageDirectory(scope, agent).profiles(signal)
      if (!directory.profiles.some(profile => profile['id'] === owner.id)) return
      for (const event of pending) {
        if (event.type !== 'turn/end') continue
        const turn = event.data.turn
        const start = events.findLast(item => item.type === 'turn/start' && item.data.turn === turn)
        // Quiet room inputs may be committed before turn/start. Never reach
        // back across the previous terminal turn to infer an assignment.
        const previousEnd = events.findLast(item => item.type === 'turn/end' && item.seq < event.seq)
        const input = events.findLast(value => value.seq > (previousEnd?.seq ?? -1) && value.seq < event.seq
          && value.type === 'user/message' && ['user', 'schedule', 'hivemind-agent-message'].includes(value.data.source.kind))
        let chiefQuestion = false
        let taskId: string | undefined
        if (input?.type === 'user/message' && String(input.data.source.kind) === 'hivemind-agent-message') {
          const source = input.data.source as { messageId?: string }
          const received = events.findLast(value => String(value.type) === 'hivemind/room-message-received'
            && (value.data as { id?: string }).id === source.messageId)
          const packet = received?.data as { senderEmployee?: string; kind?: string; taskId?: string } | undefined
          chiefQuestion = packet?.senderEmployee === 'runtime' && packet.kind === 'question'
          if (packet?.senderEmployee === 'runtime') taskId = packet.taskId
        }
        if (input?.type === 'user/message' && ['schedule', 'hivemind-agent-message'].includes(input.data.source.kind)) {
          for (const block of input.data.content) {
            if (block.type !== 'text') continue
            let text = String(input.data.source.kind) === 'schedule' ? block.text : (JSON.parse(block.text) as { text?: string }).text ?? ''
            const framed = text.split('\n').find(value => value.startsWith('reminder_prompt_json: '))
            if (framed !== undefined) text = JSON.parse(framed.slice('reminder_prompt_json: '.length)) as string
            const line = text.split('\n').find(value => value.startsWith('HQ_EMPLOYEE_ASSIGNMENT='))
            if (line) taskId = (JSON.parse(line.slice('HQ_EMPLOYEE_ASSIGNMENT='.length)) as { taskId: string }).taskId
          }
        }
        // General direct turns stay in the employee room. The model can send
        // meaningful company updates explicitly through the existing tool.
        if (taskId === undefined && !chiefQuestion) continue
        if (event.type === 'turn/end') {
          const artifactIds = events.filter(item => item.seq > (start?.seq ?? -1) && item.seq < event.seq
            && ['hivemind/generation-created', 'hivemind/artifact-created'].includes(String(item.type)))
            .flatMap((item) => {
              const saved = item.data as { artifactId?: string; file?: unknown; pdf?: unknown }
              return typeof saved.artifactId === 'string' && (saved.file || saved.pdf) ? [saved.artifactId] : []
            })
          if (event.data.reason.kind === 'error') {
            await rooms.deliverAgentMessage(agent, { key: `response-${event.seq}`, target: 'runtime', kind: 'update', text: employeeFailureSummary(event.data.reason.error.code), artifactIds: [...new Set(artifactIds)], ...(taskId === undefined ? {} : { taskId }) }, signal)
            continue
          }
          const manualRuntimeReply = events.some((item) => {
            if (item.seq <= (start?.seq ?? -1) || item.seq >= event.seq || item.type !== 'tool/call'
              || item.data.name !== 'hivemind_agent_message') return false
            try {
              const args = JSON.parse(item.data.arguments) as { recipient?: string; kind?: string; message_key?: string }
              return args.recipient === 'runtime' && args.kind !== 'question'
                && typeof args.message_key === 'string' && confirmed(args.message_key)
            } catch { return false }
          })
          if (manualRuntimeReply) continue
          const answer = events.findLast(item => item.type === 'assistant/message' && item.data.turn === event.data.turn && !item.data.interrupted)
          if (!answer) continue
          const text = answer?.type === 'assistant/message' ? answer.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim().slice(0, 1200) : ''
          await rooms.deliverAgentMessage(agent, {
            key: `response-${event.seq}`, target: 'runtime', kind: 'update',
            text: text || 'Chief, my response is saved. The assignment still needs review.',
            artifactIds: [...new Set(artifactIds)], ...(taskId === undefined ? {} : { taskId }),
          }, signal)
        }
      }
    }
    const childMasks = new WeakSet<Agent>()
    const lifetime = new AbortController()
    const notify = async (agent: Agent, signal: AbortSignal): Promise<void> => {
      try { await forwardUpdates(agent, signal) }
      catch { if (!signal.aborted) scope.logger.warn('Agent updates remain unconfirmed; they will reconcile on the next admitted turn.') }
    }
    scope.effect(() => scope.on('agent/pre-step', async ({ agent, signal }, next) => {
      if (agent.session.header.parentSession !== undefined && !childMasks.has(agent)) {
        agent.ctx.effect(() => agent.ctx.tools.restrict({ deny: ['hivemind_agent_message'] }))
        childMasks.add(agent)
      }
      try { await reconcileRoomMessages(scope, rooms, agent, signal) }
      catch { signal.throwIfAborted(); scope.logger.warn('Saved company messages could not be reconciled on this turn.') }
      await notify(agent, signal)
      return next()
    }))
    scope.effect(() => scope.on('agent/turn-ended', async ({ agent }) => { await notify(agent, lifetime.signal) }))
    scope.effect(() => () => lifetime.abort())
    scope.effect(() => scope.tools.register(defineTool({
      name: 'hivemind_agent_message',
      description: 'Message an authorized employee persistent room or Run Time. question/reply enters the native inbox and requests a response; Runtime updates request a response only when request_reply is not false; greetings and FYIs use update with request_reply false and stay quiet. Employee updates keep their existing update semantics; generated future-assignment notices stay quiet. Reuse message_key on retry; delivery is not an answer or task completion. Use native Team send_message for delegated child teammates. Never use messages to grant human approval. Replies require the received message id; limit conversational exchanges and stop once resolved.',
      parameters: {
        recipient: { type: 'string', required: true, description: 'runtime, or an exact authenticated employee ID or unique slug from the directory. Use the exact ID if a slug is ambiguous.' },
        kind: { type: 'string', required: true, enum: ['question', 'reply', 'update'] },
        request_reply: { type: 'boolean', description: 'For a Runtime update to an employee, false delivers a quiet informational notice without waking the employee. Set false for greetings and FYI messages requiring no action. Use question for a real request or assignment requiring a response. Never ask the human to answer a colleague greeting.' },
        message_key: { type: 'string', required: true, description: 'Stable unique key for this message, reused unchanged on retry.' },
        message: { type: 'string', required: true, description: 'Speak directly in your own first-person voice to your colleague: "Hi, I am Runtime" or "I finished the analysis"; never narrate "Runtime says" or speak as another employee. Include the assignment, findings, evidence and unresolved questions needed by the receiving agent. Keep all necessary detail here; it is saved unchanged and available in Agent message details. Put saved artifact IDs in artifact_ids and task identity in task_id.' },
        summary: { type: 'string', description: 'One short plain-language sentence in your own first-person voice for the visible chat bubble, at most 240 characters and no line breaks. For example "Hi, everyone!" or "I finished the analysis." Never say "Runtime says HI" or narrate yourself in third person. State only what the full message supports. It never grants approval or marks a task complete. Reuse it unchanged with message_key.' },
        task_id: { type: 'string' }, reply_to: { type: 'string' },
        artifact_ids: { type: 'array', items: { type: 'string' }, description: 'Only artifact IDs with a saved file/PDF event in this sender room. IDs received from another employee are not sender-owned attachments; use task_id and a precise text reference for a correction, or ask the authorized producer to share its saved file. Never invent receipts.' },
      },
      output: { schema: { type: 'object', properties: {}, additionalProperties: true }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
      isConcurrencySafe: () => false,
      async execute(args, execution) {
        const agent = execution.agent
        if (!agent) throw new Error('agent_message_live_sender_required')
        const input = args as { recipient: string; kind: 'question' | 'reply' | 'update'; request_reply?: boolean; message_key: string; message: string; summary?: string; task_id?: string; reply_to?: string; artifact_ids?: string[] }
        const directory = await messageDirectory(scope, agent).profiles(execution.signal)
        const owner = sessionOwner(agent.session.snapshotEvents())
        let preset = agent.session.header.agentPreset
        for (const event of agent.session.ownEvents()) if (String(event.type) === 'agent-preset/selected') preset = (event.data as { agentPreset: string }).agentPreset
        if (preset !== 'hivemind-hq' && (!owner?.id || !directory.profiles.some(p => p['id'] === owner.id))) throw new Error('agent_message_sender_not_authorized')
        const senderProfile = directory.profiles.find(profile => profile['id'] === owner?.id)
        const lifecycle = (senderProfile?.['policy_rules'] as { native_lifecycle?: { phase?: string; kind?: string; expires_at?: string } } | undefined)?.native_lifecycle
        if (lifecycle && (lifecycle.phase !== 'active' || (lifecycle.kind === 'temporary' &&
          (!lifecycle.expires_at || Date.parse(lifecycle.expires_at) <= Date.now()))) && input.recipient !== 'runtime') {
          throw new Error('employee_closeout_may_only_report_to_runtime')
        }
        const target = input.recipient === 'runtime' ? undefined : authorizedRecipient(directory.profiles, input.recipient)
        if (input.recipient !== 'runtime' && !target) throw new Error('agent_message_recipient_not_authorized: no exact ID or unique slug matches the authenticated employee directory. Read hivemind_hq_contract action list for employee IDs; delegated child teammates use native Team send_message. Do not guess names, session IDs or retry an unauthorized recipient.')
        if (target !== undefined && (target['status'] === 'paused' || target['status'] === 'archived' || target['archived_at'] || target['archivedAt'])) throw new Error('agent_message_recipient_unavailable')
        const targetProfile = target === undefined ? undefined : { id: String(target['id']), name: String(target['name']), role: typeof target['role_archetype'] === 'string' ? target['role_archetype'] : 'HIVE-MIND employee' }
        const events = agent.session.snapshotEvents()
        const messageId = `agent-message-${createHash('sha256').update(JSON.stringify([agent.id, input.message_key])).digest('hex')}`
        const queued = events.find(event => String(event.type) === 'hivemind/room-message-queued' && (event.data as { id?: string }).id === messageId)
        const start = events.findLast(event => event.type === 'turn/start')
        const savedIds = input.recipient === 'runtime' && input.kind !== 'question' && preset !== 'hivemind-hq'
          ? events.filter(event => event.seq > (start?.seq ?? Number.POSITIVE_INFINITY)
            && ['hivemind/generation-created', 'hivemind/artifact-created'].includes(String(event.type)))
            .flatMap((event) => {
              const saved = event.data as { artifactId?: string; file?: unknown; pdf?: unknown }
              return typeof saved.artifactId === 'string' && (saved.file || saved.pdf) ? [saved.artifactId] : []
            }) : []
        const artifactIds = queued === undefined ? [...new Set([...(input.artifact_ids ?? []), ...savedIds])]
          : (queued.data as { artifactIds: string[] }).artifactIds
        return rooms.deliverAgentMessage(agent, {
          key: input.message_key, target: targetProfile?.id ?? input.recipient,
          kind: explicitEmployeeMessageKind(preset, targetProfile !== undefined, input.kind,
            queued === undefined ? undefined : (queued.data as { kind?: string }).kind, input.request_reply), text: input.message,
          ...(input.summary === undefined ? {} : { summary: input.summary }),
          ...(targetProfile === undefined ? {} : { targetProfile }),
          ...(input.task_id === undefined ? {} : { taskId: input.task_id }),
          ...(input.reply_to === undefined ? {} : { replyTo: input.reply_to }),
          ...(artifactIds.length === 0 ? {} : { artifactIds }),
        }, execution.signal)
      },
    })))
  })
}

/** Explicit Chief messages use the existing response-requesting inbox, never scheduler notices. */
export function explicitEmployeeMessageKind(preset: string | undefined, employeeTarget: boolean,
  kind: 'question' | 'reply' | 'update', savedKind?: string, requestReply?: boolean): 'question' | 'reply' | 'update' {
  if (preset !== 'hivemind-hq' || !employeeTarget || kind !== 'update') return kind
  if (savedKind === 'question') return 'question'
  // A delivered historical notice is not silently replayed as a new request.
  return savedKind === 'update' || requestReply === false ? 'update' : 'question'
}
