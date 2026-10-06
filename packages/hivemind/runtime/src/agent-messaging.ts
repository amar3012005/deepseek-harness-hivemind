/** One model-facing tool, backed by the native Session owner, not a replacement loop. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { employeeDispatchAllowed, employeeCloseoutAllowed } from '@deepseek-ai/dsh-hivemind-employee-directory'
import { sessionOwner } from './continuity.ts'
import type {} from '@deepseek-ai/dsh-hivemind-employee-directory'

interface RoomDelivery {
  deliverAgentMessage(caller: Agent, input: {
    key: string
    target: string
    targetProfile?: { id: string; name: string; role: string }
    kind: 'question' | 'reply' | 'update'
    text: string
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
export function employeeFailureSummary(code: string): string {
  const category = /POLICY|SAFETY|REFUS|CONTENT_FILTER/i.test(code) ? 'a provider policy rejection'
    : /AUTH|PERMISSION|FORBIDDEN/i.test(code) ? 'an authorization failure'
      : /QUOTA|BILLING|CREDIT/i.test(code) ? 'a provider quota limit'
        : /TIMEOUT|TRANSPORT|SERVER/i.test(code) ? 'a provider availability failure'
          : 'a model request failure'
  return `Chief, my turn ended because of ${category}. The assignment remains unfinished; please review the blocker before resuming it.`
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
      const directory = await scope.hivemindEmployeeDirectory.profiles(signal)
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
      await notify(agent, signal)
      return next()
    }))
    scope.effect(() => scope.on('agent/turn-ended', async ({ agent }) => { await notify(agent, lifetime.signal) }))
    scope.effect(() => () => lifetime.abort())
    scope.effect(() => scope.tools.register(defineTool({
      name: 'hivemind_agent_message',
      description: 'Message an authorized employee persistent room or Run Time. question/reply enters the native inbox and requests a response; Runtime updates to employees request action and a response through the native question inbox. Employee updates keep their existing update semantics; generated future-assignment notices stay quiet. Reuse message_key on retry; delivery is not an answer or task completion. Use native Team send_message for delegated child teammates. Never use messages to grant human approval. Replies require the received message id; limit conversational exchanges and stop once resolved.',
      parameters: {
        recipient: { type: 'string', required: true, description: 'runtime, or an exact authenticated employee ID or unique slug from the directory. Use the exact ID if a slug is ambiguous.' },
        kind: { type: 'string', required: true, enum: ['question', 'reply', 'update'] },
        message_key: { type: 'string', required: true, description: 'Stable unique key for this message, reused unchanged on retry.' },
        message: { type: 'string', required: true, description: 'Short natural colleague-to-colleague message: explain the outcome, uncertainty and next step plainly. Put exact artifact receipt IDs in artifact_ids and task identity in task_id, not in the visible text. The complete envelope remains available to the receiving agent and in Agent message details.' },
        task_id: { type: 'string' }, reply_to: { type: 'string' },
        artifact_ids: { type: 'array', items: { type: 'string' }, description: 'Exact locally saved artifact receipt IDs to include; not filenames or invented IDs.' },
      },
      output: { schema: { type: 'object', properties: {}, additionalProperties: true }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
      isConcurrencySafe: () => false,
      async execute(args, execution) {
        const agent = execution.agent
        if (!agent) throw new Error('agent_message_live_sender_required')
        const input = args as { recipient: string; kind: 'question' | 'reply' | 'update'; message_key: string; message: string; task_id?: string; reply_to?: string; artifact_ids?: string[] }
        const directory = await scope.hivemindEmployeeDirectory.profiles(execution.signal)
        const owner = sessionOwner(agent.session.snapshotEvents())
        let preset = agent.session.header.agentPreset
        for (const event of agent.session.ownEvents()) if (String(event.type) === 'agent-preset/selected') preset = (event.data as { agentPreset: string }).agentPreset
        if (preset !== 'hivemind-hq' && (!owner?.id || !directory.profiles.some(p => p['id'] === owner.id))) throw new Error('agent_message_sender_not_authorized')
        const target = input.recipient === 'runtime' ? undefined : authorizedRecipient(directory.profiles, input.recipient)
        if (input.recipient !== 'runtime' && !target) throw new Error('agent_message_recipient_not_authorized')
        if (target !== undefined && !employeeDispatchAllowed(target) && !employeeCloseoutAllowed(target)) throw new Error('agent_message_recipient_unavailable')
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
            queued === undefined ? undefined : (queued.data as { kind?: string }).kind), text: input.message,
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
  kind: 'question' | 'reply' | 'update', savedKind?: string): 'question' | 'reply' | 'update' {
  if (preset !== 'hivemind-hq' || !employeeTarget || kind !== 'update') return kind
  // A delivered historical notice is not silently replayed as a new request.
  return savedKind === 'update' ? 'update' : 'question'
}
