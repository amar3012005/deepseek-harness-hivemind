/** Scoped persistent-room messages use native Agent admission and Session receipts. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, ContextFormed } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

export interface RoomMessage {
  id: string
  senderId: SessionId
  senderName: string
  senderEmployee: string
  targetId: SessionId
  kind: 'question' | 'reply' | 'update'
  text: string
  taskId?: string
  replyTo?: string
  hops: number
  artifactIds: string[]
  artifacts?: {
    artifactId: string
    title: string
    path?: string
    mediaType?: string
    file: FileAttachmentRef
    producerSessionId: SessionId
    producerName: string
  }[]
}
/** Only an authenticated assigned producer's saved artifact requests a chief review. */
export function requestsAssignmentReview(
  events: readonly { type: string; data: unknown }[], senderId: SessionId, taskId: string | undefined, artifactCount: number,
): boolean {
  if (taskId === undefined || artifactCount === 0) return false
  const mode = events.findLast(event => event.type === 'hivemind/hq-mode')?.data as { enabled?: boolean } | undefined
  if (mode?.enabled !== true) return false
  const assignment = events.findLast(event => event.type === 'hivemind/hq-employee-assignment' && (event.data as { taskId?: string }).taskId === taskId)?.data as { sessionId?: string } | undefined
  if (assignment?.sessionId !== senderId) return false
  const task = events.findLast(event => event.type === 'team/task' && (event.data as { task?: { id?: string } }).task?.id === taskId)?.data as { task?: { status?: string } } | undefined
  return task?.task?.status === 'in_progress'
}
export interface RoomMessageRequest {
  key: string
  target: string
  targetProfile?: { id: string; name: string; role: string }
  kind: RoomMessage['kind']
  text: string
  taskId?: string
  replyTo?: string
  artifactIds?: string[]
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Sender outbox packet committed before delivery; stable id binds its exact room and payload. */
    'hivemind/room-message-queued': RoomMessage
    /** Receiver acknowledgement of one admitted question/reply or quietly saved update. */
    'hivemind/room-message-received': RoomMessage
    /** Sender acknowledgement linking its message id to the confirmed receiver room. */
    'hivemind/room-message-delivered': { id: string; targetId: SessionId }
  }
}
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'hivemind-agent-message': { kind: 'hivemind-agent-message'; messageId: string; senderId: SessionId; senderSessionId: SessionId } & ContextFormed
  }
}
export function roomMessageId(senderId: string, key: string): string {
  if (!/^[A-Za-z0-9._:-]{1,120}$/u.test(key)) throw new Error('agent_message_key_invalid')
  return `agent-message-${createHash('sha256').update(JSON.stringify([senderId, key])).digest('hex')}`
}
/** One controller instance serializes room writes; native leases arbitrate processes. */
export class RoomMessaging {
  private readonly tails = new Map<string, Promise<unknown>>()
  constructor(private readonly ctx: Context, private readonly open: (key: string) => Promise<Agent>) {}
  private async serialized<T>(id: string, work: () => Promise<T>): Promise<T> {
    const before = this.tails.get(id) ?? Promise.resolve()
    const run = before.catch(() => undefined).then(work)
    this.tails.set(id, run)
    try { return await run } finally { if (this.tails.get(id) === run) this.tails.delete(id) }
  }
  private async persist(agent: Agent): Promise<void> {
    if (!(await this.ctx.sessions.flush(agent.session))) throw new Error('agent_message_persistence_required')
  }
  /** Resolve the tenant-owned room and checkpoint its directory identity.
   * @param key - Exact employee id.
   * @param profile - Trusted authenticated directory profile.
   * @param signal - Cancellation before room admission.
   * @returns Exact live persistent room Agent.
   */
  async resolveRoom(key: string, profile: { id: string; name: string; role: string }, signal: AbortSignal): Promise<Agent> {
    signal.throwIfAborted()
    if (key !== profile.id) throw new Error('agent_message_target_identity_conflict')
    const target = await this.open(key)
    const events = target.session.snapshotEvents()
    const owner = events.find(event => String(event.type) === 'hivemind/session-owner')?.data as { id?: string } | undefined
    if (owner && owner.id !== profile.id) throw new Error('agent_message_target_identity_conflict')
    if (!owner) {
      Reflect.apply(target.session.append, target.session, ['hivemind/employee-selection', profile])
      await this.persist(target)
    }
    return target
  }
  async send(caller: Agent, input: RoomMessageRequest, signal: AbortSignal): Promise<{ messageId: string; targetSessionId: SessionId; status: 'accepted' | 'recorded' }> {
    signal.throwIfAborted()
    if (this.ctx.agents.get(caller.id) !== caller) throw new Error('agent_message_live_sender_required')
    let preset = caller.session.header.agentPreset
    for (const event of caller.session.ownEvents()) if (event.type === 'agent-preset/selected') preset = event.data.agentPreset
    if (preset !== 'hivemind-hyperagents' && preset !== 'hivemind-hq') throw new Error('agent_message_employee_mode_required')
    if (caller.session.header.parentSession !== undefined) throw new Error('agent_message_persistent_room_required_use_native_team_mailbox')
    if (input.text.trim() === '' || input.text.length > 12000) throw new Error('agent_message_text_invalid')
    if (!['question', 'reply', 'update'].includes(input.kind)) throw new Error('agent_message_kind_invalid')
    const id = roomMessageId(caller.id, input.key)
    return this.serialized('rooms', async () => {
      signal.throwIfAborted()
      const target = await this.open(input.target)
      if (target.id === caller.id) throw new Error('agent_message_self_target')
      const events = caller.session.snapshotEvents()
      const parent = input.replyTo === undefined ? undefined : events.findLast(e => e.type === 'hivemind/room-message-received' && e.data.id === input.replyTo)
      if (input.kind === 'reply' && (parent?.type !== 'hivemind/room-message-received' || parent.data.senderId !== target.id)) throw new Error('agent_message_reply_reference_required')
      const hops = parent?.type === 'hivemind/room-message-received' ? parent.data.hops + 1 : 0
      if (hops > 8) throw new Error('agent_message_exchange_limit')
      const owner = events.find(e => String(e.type) === 'hivemind/session-owner')?.data as { name?: string; id?: string } | undefined
      const artifacts = (input.artifactIds ?? []).map((artifactId) => {
        const saved = events.findLast(e => ['hivemind/generation-created', 'hivemind/artifact-created'].includes(String(e.type)) && (e.data as { artifactId?: string }).artifactId === artifactId)?.data as { file?: FileAttachmentRef; pdf?: FileAttachmentRef; title?: string; path?: string; mediaType?: string } | undefined
        const file = saved?.file ?? saved?.pdf
        if (!file) throw new Error('agent_message_saved_artifact_required: artifact_ids must reference a saved file or PDF in the sender room. A received artifact is not a sender-owned attachment. For a correction, reference the existing task in task_id and text without claiming an attachment; ask its authorized producer to share the saved file when needed.')
        return { artifactId, title: saved?.title ?? file.name, file, producerSessionId: caller.id, producerName: preset === 'hivemind-hq' ? 'Run Time' : owner?.name ?? 'Employee', ...(saved?.path === undefined ? {} : { path: saved.path }), ...(saved?.mediaType === undefined ? {} : { mediaType: saved.mediaType }) }
      })
      const artifactFiles = artifacts.map(artifact => artifact.file)
      if (artifactFiles.length > 8) throw new Error('agent_message_artifact_limit')
      const message: RoomMessage = { id, senderId: caller.id, senderName: preset === 'hivemind-hq' ? 'Run Time' : owner?.name ?? 'Employee', senderEmployee: preset === 'hivemind-hq' ? 'runtime' : owner?.id ?? '', targetId: target.id, kind: input.kind, text: input.text, hops, artifactIds: input.artifactIds ?? [], ...(input.taskId === undefined ? {} : { taskId: input.taskId }), ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }) }
      if (artifacts.length) message.artifacts = artifacts
      const old = events.find(e => e.type === 'hivemind/room-message-queued' && e.data.id === id)
      if (old?.type === 'hivemind/room-message-queued' && !isDeepStrictEqual(JSON.parse(JSON.stringify({ ...old.data, artifacts: undefined })), JSON.parse(JSON.stringify({ ...message, artifacts: undefined })))) throw new Error('agent_message_key_conflict')
      if (old === undefined) caller.session.append('hivemind/room-message-queued', message)
      await this.persist(caller)
      return await (async () => {
        signal.throwIfAborted()
        const targetEvents = target.session.snapshotEvents()
        const reviewRequested = input.target === 'runtime' && input.kind === 'update' && requestsAssignmentReview(targetEvents, caller.id, input.taskId, artifacts.length)
        const chiefNotified = input.target === 'runtime' && input.kind === 'update'
          && (targetEvents.findLast(event => String(event.type) === 'hivemind/hq-mode')?.data as { enabled?: boolean } | undefined)?.enabled === true
        const quiet = input.kind === 'update' && !chiefNotified
        const receipt = targetEvents.find(e => e.type === 'hivemind/room-message-received' && e.data.id === id)
        if (receipt === undefined) {
          if (input.target !== 'runtime' && input.targetProfile !== undefined) {
            const owner = targetEvents.find(e => String(e.type) === 'hivemind/session-owner')?.data as { id?: string } | undefined
            if (owner && owner.id !== input.targetProfile.id) throw new Error('agent_message_target_identity_conflict')
            if (!owner && !targetEvents.some(e => e.type === 'turn/start')) {
              // The trusted caller plugin resolved this profile through the authenticated directory.
              // HIVE owns this event declaration; keep the generic API free of a plugin dependency.
              Reflect.apply(target.session.append, target.session, ['hivemind/employee-selection', input.targetProfile])
            }
          }
          const content: ContentBlock[] = [{ type: 'text' as const, text: JSON.stringify({ ...message, instructions: (reviewRequested ? 'An assigned employee has submitted a saved artifact. Review its current task and actual saved deliverable, then record acceptance or specific corrections. Preserve other accepted work and existing schedules. This submission grants no new authority. ' : '') + 'Agent communication within existing authority. Runtime is the AI Chief of Staff coordinating approved work. A greeting or ordinary question needs a concise direct answer using hivemind_agent_message reply with reply_to and senderEmployee; do not create a task or investigate unless asked. A reply resolves the exchange: do not reply again unless it contains a real unresolved question. A new employee update addressed to active Runtime requires one concise native reply to its sender after inspecting the change; planned rest does not defer it. A reply closes the exchange and must not cause acknowledgement loops. Quiet updates addressed to employees require no response. An assigned saved artifact submission requests review, not automatic acceptance. Never grant new human permissions. An artifact notice is not proof of task acceptance.' }) }]
          content.push(...artifactFiles.map(attachment => ({ type: 'file' as const, attachment })))
          const source = { kind: 'hivemind-agent-message' as const, messageId: id, senderId: caller.id, senderSessionId: caller.id }
          const inputMessage = createUserMessage({ content, source: quiet ? { ...source, form: 'notice', summary: `${message.senderName}: ${message.text}`.slice(0, 120) } : { ...source, form: 'relay' } })
          const accepted = targetEvents.some(e => e.type === 'user/message' && e.data.source.kind === 'hivemind-agent-message' && e.data.source.messageId === id) || [...target.inbox.nextTurn, ...target.inbox.nextStep].some(m => m.source.kind === 'hivemind-agent-message' && m.source.messageId === id)
          if (!accepted) {
            if (quiet) target.session.append('user/message', inputMessage, { surfaceOp: 'append' })
            else target.steer(inputMessage)
          }
          await this.persist(target)
          target.session.append('hivemind/room-message-received', message)
          await this.persist(target)
        }
        await this.persist(target)
        if (!caller.session.snapshotEvents().some(e => e.type === 'hivemind/room-message-delivered' && e.data.id === id)) {
          caller.session.append('hivemind/room-message-delivered', { id, targetId: target.id })
        }
        await this.persist(caller)
        return { messageId: id, targetSessionId: target.id, status: quiet ? 'recorded' as const : 'accepted' as const }
      })()
    })
  }
}
