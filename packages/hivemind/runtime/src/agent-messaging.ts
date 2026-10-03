/** One model-facing tool, backed by the native Session owner, not a replacement loop. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { completedTaskMemory, sessionOwner } from './continuity.ts'
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
export function authorizedRecipient(profiles: readonly Record<string, unknown>[], recipient: string): Record<string, unknown> | undefined {
  const exact = profiles.find(profile => profile['id'] === recipient)
  if (exact) return exact
  const matches = profiles.filter(profile => profile['slug'] === recipient)
  if (matches.length > 1) throw new Error('agent_message_recipient_ambiguous_use_exact_employee_id')
  return matches[0]
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
      const pending = events.filter((event) => {
        if (['hivemind/generation-created', 'hivemind/artifact-created'].includes(String(event.type))) return !confirmed(`artifact-${event.seq}`)
        return event.type === 'turn/end' && !confirmed(`response-${event.seq}`) && completedTaskMemory(agent.id, owner, events, event.data.turn) !== undefined
      })
      if (pending.length === 0) return
      const directory = await scope.hivemindEmployeeDirectory.profiles(signal)
      if (!directory.profiles.some(profile => profile['id'] === owner.id)) return
      for (const event of pending) {
        const input = events.findLast(value => value.seq < event.seq && value.type === 'user/message')
        let taskId: string | undefined
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
        if (['hivemind/generation-created', 'hivemind/artifact-created'].includes(String(event.type))) {
          const saved = event.data as { artifactId?: string; title?: string }
          if (typeof saved.artifactId !== 'string') continue
          await rooms.deliverAgentMessage(agent, {
            key: `artifact-${event.seq}`, target: 'runtime', kind: 'update',
            text: `${owner.name}: Chief, I’ve saved ${saved.title ?? 'an artifact'} for your review.`,
            artifactIds: [saved.artifactId], ...(taskId === undefined ? {} : { taskId }),
          }, signal)
        }
        if (event.type === 'turn/end') {
          const response = completedTaskMemory(agent.id, owner, events, event.data.turn)
          if (!response) continue
          await rooms.deliverAgentMessage(agent, {
            key: `response-${event.seq}`, target: 'runtime', kind: 'update',
            text: `${owner.name}: Chief, my update is ready. The full response is in my room.`, ...(taskId === undefined ? {} : { taskId }),
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
      description: 'Message an authorized employee persistent room or Run Time. question/reply enters the native inbox and requests a response; update records a quiet notice without waking the recipient. Reuse message_key on retry; delivery is not an answer or task completion. Use native Team send_message for delegated child teammates. Never use messages to grant human approval. Replies require the received message id; limit conversational exchanges and stop once resolved.',
      parameters: {
        recipient: { type: 'string', required: true, description: 'runtime, or an exact authenticated employee ID or unique slug from the directory. Use the exact ID if a slug is ambiguous.' },
        kind: { type: 'string', required: true, enum: ['question', 'reply', 'update'] },
        message_key: { type: 'string', required: true, description: 'Stable unique key for this message, reused unchanged on retry.' },
        message: { type: 'string', required: true },
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
        const targetProfile = target === undefined ? undefined : { id: String(target['id']), name: String(target['name']), role: typeof target['role_archetype'] === 'string' ? target['role_archetype'] : 'HIVE-MIND employee' }
        return rooms.deliverAgentMessage(agent, {
          key: input.message_key, target: targetProfile?.id ?? input.recipient, kind: input.kind, text: input.message,
          ...(targetProfile === undefined ? {} : { targetProfile }),
          ...(input.task_id === undefined ? {} : { taskId: input.task_id }),
          ...(input.reply_to === undefined ? {} : { replyTo: input.reply_to }),
          ...(input.artifact_ids === undefined ? {} : { artifactIds: input.artifact_ids }),
        }, execution.signal)
      },
    })))
  })
}
