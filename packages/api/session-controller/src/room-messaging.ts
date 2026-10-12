/** Scoped persistent-room messages use native Agent admission and Session receipts. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, ContextFormed } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ExternalEmployeeRoom } from './external-room.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional host adapter for identities whose execution backend is external. */
    externalEmployeeRoomProvider?: ExternalEmployeeRoomProvider
  }
}

export interface RoomMessage {
  id: string
  senderId: SessionId
  senderName: string
  senderEmployee: string
  targetId: SessionId
  kind: 'question' | 'reply' | 'update'
  text: string
  /** Brief display copy; full text remains the durable model-facing message. */
  summary?: string
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
export interface ExternalEmployeeOperation {
  dispatchMessageId: string
  messageKey: string
  kind: RoomMessage['kind']
  text: string
  summary?: string
  replyTo?: string
  artifacts?: RoomMessage['artifacts']
}

export interface RoomMessageRequest {
  key: string
  target: string
  targetProfile?: EmployeeRoomProfile
  kind: RoomMessage['kind']
  text: string
  /** Brief display copy; full text remains the durable model-facing message. */
  summary?: string
  taskId?: string
  replyTo?: string
  artifactIds?: string[]
}
/** A trusted directory profile. Open Dot identities must be explicit and retain
 * their canonical Dot id separately from the DSH Session id. */
export interface EmployeeRoomProfile {
  id: string
  name: string
  role: string
  executionBackend?: 'open-dot'
  dotId?: string
}
function isExternalRoom(target: Agent | ExternalEmployeeRoom): target is ExternalEmployeeRoom {
  return 'kind' in target && target.kind === 'external-persistent-assignee'
}
export interface ExternalRuntimeDispatchStatus {
  readonly state: string
  readonly jobResult: { readonly outcome?: string; readonly reason?: string; readonly phase?: string; readonly executionStarted?: boolean; readonly messageId?: string; readonly accepted?: boolean } | null
  readonly outputs: readonly { readonly messageId: string; readonly role: string; readonly text: string; readonly createdAt: string }[]
  readonly attachments: readonly { readonly id: string; readonly name: string; readonly mime: string; readonly size: number }[]
}
export interface ExternalEmployeeRoomProvider {
  /** Return undefined for native employees. The Agent must wrap a real opaque DSH Session and have no model-loop driver. */
  resolve(employeeId: string, profile: EmployeeRoomProfile | undefined, signal: AbortSignal): Promise<{ room: ExternalEmployeeRoom; driverless: true } | undefined>
  /** Resolve one message into the external backend and return only after durable, idempotent acceptance. */
  deliver(input: { employeeId: string; room: ExternalEmployeeRoom; message: RoomMessage; idempotencyKey: string; authenticatedActor?: Extract<import('@deepseek-ai/dsh-llm').MessageSource, { kind: 'user' }>['authenticatedActor'] }, signal: AbortSignal): Promise<{ receiptId: string; status: 'accepted' | 'recorded' }>
  status?(input: { employeeId: string; room: ExternalEmployeeRoom; dispatchMessageId: string }, signal: AbortSignal): Promise<ExternalRuntimeDispatchStatus>
}
/** Register a host-owned external room provider, including after SessionController initialization. */
export function registerExternalEmployeeRoomProvider(ctx: Context, provider: ExternalEmployeeRoomProvider): () => void {
  const controller = ctx.get('sessionController') as { registerExternalEmployeeRoomProvider?: (value: ExternalEmployeeRoomProvider) => () => void } | undefined
  if (controller?.registerExternalEmployeeRoomProvider) return controller.registerExternalEmployeeRoomProvider(provider)
  return ctx.provide('externalEmployeeRoomProvider', provider)
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Sender outbox packet committed before delivery; stable id binds its exact room and payload. */
    'hivemind/room-message-queued': RoomMessage & { delivery?: { key: string; target: string; authenticatedActor?: Extract<import('@deepseek-ai/dsh-llm').MessageSource, { kind: 'user' }>['authenticatedActor'] } }
    /** Receiver acknowledgement of one admitted question/reply or quietly saved update. */
    'hivemind/room-message-received': RoomMessage
    /** Sender acknowledgement linking its message id to the confirmed receiver room. */
    'hivemind/room-message-delivered': { id: string; targetId: SessionId }
    /** Durable external queue receipt; written only after the provider confirms acceptance. */
    'hivemind/external-delivery-accepted': { id: string; employeeId: string; targetSessionId: SessionId; receiptId: string; status: 'accepted' | 'recorded' }
    /** Canonical ownership metadata for an Open Dot employee's durable proxy room. */
    'hivemind/external-employee-room': { employeeId: string; backend: 'open-dot'; dotId?: string; organizationId?: string; userId?: string }
    /** Exact Dot-to-Runtime operation queued for durable native delivery. */
    'hivemind/open-dot-runtime-operation-queued': { messageId: string; digest: string; dispatchMessageId: string; rootSessionId: string; message: RoomMessage }
    /** Acknowledges one durably accepted Dot-to-Runtime operation. */
    'hivemind/open-dot-runtime-operation-receipt': { messageId: string; digest: string; dispatchMessageId: string; rootSessionId: string; deliveryState: 'accepted' | 'recorded' }
    /** Imported bytes and native attachment reference for a verified Open Dot artifact. */
    'hivemind/external-artifact-created': { artifactId: string; title: string; mediaType: string; provider: 'open-dot-owned'; path: null; file: FileAttachmentRef; sha256: string; size: number; dotId: string; dispatchMessageId: string }
  }
}
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'hivemind-agent-message': { kind: 'hivemind-agent-message'; messageId: string; senderId: SessionId; senderSessionId: SessionId; authenticatedActor?: Extract<import('@deepseek-ai/dsh-llm').MessageSource,{ kind:'user' }>['authenticatedActor'] } & ContextFormed
  }
}
/** Stable RFC 4122-shaped identifier for Core APIs that require UUIDs. */
export function stableRoomDispatchId(senderId: string, packetId: string): string {
  const bytes = createHash('sha256').update(JSON.stringify(['opendot-runtime-dispatch-v1', senderId, packetId])).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
export function roomMessageId(senderId: string, key: string): string {
  if (!/^[A-Za-z0-9._:-]{1,120}$/u.test(key)) throw new Error('agent_message_key_invalid')
  return `agent-message-${createHash('sha256').update(JSON.stringify([senderId, key])).digest('hex')}`
}
/** One controller instance serializes room writes; native leases arbitrate processes. */
export class RoomMessaging {
  private readonly tails = new Map<string, Promise<unknown>>()
  constructor(private readonly ctx: Context, private readonly open: (key: string) => Promise<Agent>, private external?: ExternalEmployeeRoomProvider) {}
  setExternalProvider(provider: ExternalEmployeeRoomProvider): () => void {
    const previous = this.external
    this.external = provider
    return () => { if (this.external === provider) this.external = previous }
  }
  private async serialized<T>(id: string, work: () => Promise<T>): Promise<T> {
    const before = this.tails.get(id) ?? Promise.resolve()
    const run = before.catch(() => undefined).then(work)
    this.tails.set(id, run)
    try { return await run } finally { if (this.tails.get(id) === run) this.tails.delete(id) }
  }
  private async persist(agent: { session: Session }): Promise<void> {
    if (!(await this.ctx.sessions.flush(agent.session))) throw new Error('agent_message_persistence_required')
  }
  /** Resolve the tenant-owned room and checkpoint its directory identity.
   * @param key - Exact employee id.
   * @param profile - Trusted authenticated directory profile.
   * @param signal - Cancellation before room admission.
   * @returns Exact live persistent room Agent.
   */
  async resolveRoom(key: string, profile: EmployeeRoomProfile, signal: AbortSignal): Promise<Agent | ExternalEmployeeRoom> {
    signal.throwIfAborted()
    if (key !== profile.id) throw new Error('agent_message_target_identity_conflict')
    const target = await this.resolveTarget(key, profile, signal)
    const events = target.session.snapshotEvents()
    const externalMarker = events.find(event => event.type === 'hivemind/external-employee-room')?.data as
      { employeeId?: string; backend?: string; dotId?: string } | undefined
    if (profile.executionBackend === 'open-dot' || externalMarker !== undefined) {
      if (!('kind' in target) || target.kind !== 'external-persistent-assignee') throw new Error('agent_message_external_proxy_required')
      if (externalMarker && (externalMarker.employeeId !== profile.id || externalMarker.backend !== 'open-dot'
        || (profile.dotId !== undefined && externalMarker.dotId !== profile.dotId))) throw new Error('agent_message_target_identity_conflict')
      if (target.employeeId !== profile.id || (profile.dotId !== undefined && target.dotId !== profile.dotId)
        || target.id === profile.id || target.id === target.dotId) throw new Error('agent_message_external_session_identity_conflict')
      if (this.ctx.sessions.get(target.id) !== target.session || target.session.header.id !== target.id
        || target.session.header.parentSession !== undefined) throw new Error('agent_message_external_proxy_session_required')
      const owner = events.find(event => String(event.type) === 'hivemind/session-owner')?.data as { id?: string } | undefined
      if (owner?.id !== profile.id) throw new Error('agent_message_target_identity_conflict')
      return target
    }
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
    if (input.summary !== undefined && (typeof input.summary !== 'string' || !input.summary.trim()
      || input.summary.length > 240 || /[\r\n]/u.test(input.summary))) throw new Error('agent_message_summary_invalid')
    if (!['question', 'reply', 'update'].includes(input.kind)) throw new Error('agent_message_kind_invalid')
    const id = roomMessageId(caller.id, input.key)
    return this.serialized('rooms', async () => {
      signal.throwIfAborted()
      const target = await this.resolveTarget(input.target, input.targetProfile, signal)
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
      const message: RoomMessage = { id, senderId: caller.id, senderName: preset === 'hivemind-hq' ? 'Run Time' : owner?.name ?? 'Employee', senderEmployee: preset === 'hivemind-hq' ? 'runtime' : owner?.id ?? '', targetId: target.id, kind: input.kind, text: input.text, ...(input.summary === undefined ? {} : { summary: input.summary }), hops, artifactIds: input.artifactIds ?? [], ...(input.taskId === undefined ? {} : { taskId: input.taskId }), ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }) }
      if (artifacts.length) message.artifacts = artifacts
      const old = events.find(e => e.type === 'hivemind/room-message-queued' && e.data.id === id)
      if (old?.type === 'hivemind/room-message-queued' && !isDeepStrictEqual(JSON.parse(JSON.stringify({ ...old.data, artifacts: undefined, delivery: undefined })), JSON.parse(JSON.stringify({ ...message, artifacts: undefined })))) throw new Error('agent_message_key_conflict')
      const authenticatedActor = old?.type === 'hivemind/room-message-queued'
        ? old.data.delivery?.authenticatedActor : await this.ctx.serial('api-session/user-authorship', caller)
      if (old === undefined) caller.session.append('hivemind/room-message-queued', { ...message, delivery: { key: input.key, target: input.target, ...(authenticatedActor === undefined ? {} : { authenticatedActor }) } })
      await this.persist(caller)
      const external = 'kind' in target && target.kind === 'external-persistent-assignee'
        && target.session.snapshotEvents().some(e => e.type === 'hivemind/external-employee-room')
      if (external && !this.external) throw new Error('agent_message_external_provider_required')
      if (external && (input.targetProfile?.executionBackend !== 'open-dot' || input.targetProfile.id !== input.target)) throw new Error('agent_message_external_profile_required')
      let externalStatus: 'accepted' | 'recorded' = 'accepted'
      return await (async () => {
        signal.throwIfAborted()
        const targetEvents = target.session.snapshotEvents()
        const reviewRequested = input.target === 'runtime' && input.kind === 'update' && requestsAssignmentReview(targetEvents, caller.id, input.taskId, artifacts.length)
        const chiefNotified = input.target === 'runtime' && input.kind === 'update'
          && (targetEvents.findLast(event => String(event.type) === 'hivemind/hq-mode')?.data as { enabled?: boolean } | undefined)?.enabled === true
        const quiet = input.kind === 'update' && !chiefNotified
        const receipt = targetEvents.find(e => e.type === 'hivemind/room-message-received' && e.data.id === id)
        if (receipt === undefined) {
          if (!external && input.target !== 'runtime' && input.targetProfile !== undefined) {
            const owner = targetEvents.find(e => String(e.type) === 'hivemind/session-owner')?.data as { id?: string } | undefined
            if (owner && owner.id !== input.targetProfile.id) throw new Error('agent_message_target_identity_conflict')
            if (!owner && !targetEvents.some(e => e.type === 'turn/start')) {
              // The trusted caller plugin resolved this profile through the authenticated directory.
              // HIVE owns this event declaration; keep the generic API free of a plugin dependency.
              Reflect.apply(target.session.append, target.session, ['hivemind/employee-selection', input.targetProfile])
            }
          }
          const content: ContentBlock[] = [{ type: 'text' as const, text: JSON.stringify({ ...message, instructions: (reviewRequested ? 'An assigned employee has submitted a saved artifact. Review its current task and actual saved deliverable, then record acceptance or specific corrections. Preserve other accepted work and existing schedules. This submission grants no new authority. ' : '') + 'Agent communication within existing authority. Runtime is the AI Chief of Staff coordinating approved work. Speak directly in your own first-person voice in message text and visible summaries; do not narrate yourself in third person. A colleague greeting needs at most a concise greeting reply using hivemind_agent_message reply with reply_to and senderEmployee. Never ask the human a question, load company context or create work merely to answer a greeting. An ordinary colleague question should be answered from available context; real blockers in delegated work go back to Runtime. A reply resolves the exchange: do not reply again unless it contains a real unresolved question. A new employee question, task result or blocker addressed to active Runtime requires a concise native response after inspecting the change; planned rest does not defer useful coordination. A greeting or informational update requires no response unless it contains an actual unresolved request. A reply closes the exchange and must not cause acknowledgement loops. Quiet updates addressed to employees require no response. An assigned saved artifact submission requests review, not automatic acceptance. Never grant new human permissions. An artifact notice is not proof of task acceptance.' }) }]
          content.push(...artifactFiles.map(attachment => ({ type: 'file' as const, attachment })))
          const source = { kind: 'hivemind-agent-message' as const, messageId: id, senderId: caller.id, senderSessionId: caller.id,
            ...(authenticatedActor === undefined ? {} : { authenticatedActor }) }
          const inputMessage = createUserMessage({ content, source: quiet ? { ...source, form: 'notice', summary: `${message.senderName}: ${message.summary ?? message.text}`.slice(0, 120) } : { ...source, form: 'relay' } })
          const accepted = targetEvents.some(e => e.type === 'user/message' && e.data.source.kind === 'hivemind-agent-message' && e.data.source.messageId === id)
            || (!isExternalRoom(target) && [...target.inbox.nextTurn, ...target.inbox.nextStep].some(m => m.source.kind === 'hivemind-agent-message' && m.source.messageId === id))
          if (external) {
            const prior = targetEvents.find(e => e.type === 'hivemind/external-delivery-accepted' && e.data.id === id)
            if (prior?.type === 'hivemind/external-delivery-accepted') {
              if (prior.data.employeeId !== input.target || prior.data.targetSessionId !== target.id) throw new Error('agent_message_external_receipt_conflict')
              externalStatus = prior.data.status
            } else {
              if (!('kind' in target) || target.kind !== 'external-persistent-assignee') throw new Error('agent_message_external_proxy_required')
              const result = await this.external!.deliver({ employeeId: input.target, room: target, message, idempotencyKey: id, ...(authenticatedActor === undefined ? {} : { authenticatedActor }) }, signal)
              if (!result.receiptId || result.receiptId.length > 200) throw new Error('agent_message_external_receipt_invalid')
              target.session.append('hivemind/external-delivery-accepted', { id, employeeId: input.target, targetSessionId: target.id, receiptId: result.receiptId, status: result.status })
              await this.persist(target)
              externalStatus = result.status
            }
          } else if (!accepted) {
            if (isExternalRoom(target)) throw new Error('agent_message_external_sender_path_required')
            if (quiet) target.session.append('user/message', inputMessage, { surfaceOp: 'append' })
            else target.steer(inputMessage)
          }
          if (!external) await this.persist(target)
          target.session.append('hivemind/room-message-received', message)
          await this.persist(target)
        }
        await this.persist(target)
        if (!caller.session.snapshotEvents().some(e => e.type === 'hivemind/room-message-delivered' && e.data.id === id)) {
          caller.session.append('hivemind/room-message-delivered', { id, targetId: target.id })
        }
        await this.persist(caller)
        return { messageId: id, targetSessionId: target.id, status: external ? externalStatus : quiet ? 'recorded' as const : 'accepted' as const }
      })()
    })
  }
  /** Read status for an exact saved Open Dot Runtime dispatch without synthesizing chat messages. */
  getExternalDispatchStatus(room: ExternalEmployeeRoom, dispatchMessageId: string, signal: AbortSignal): Promise<ExternalRuntimeDispatchStatus> {
    if (!this.external?.status) throw new Error('agent_message_external_status_unavailable')
    return this.external.status({ employeeId: room.employeeId, room, dispatchMessageId }, signal)
  }

  /** Admit a reply from a canonically assigned external employee into its exact saved Runtime room. */
  async receiveExternalEmployeeMessage(room: ExternalEmployeeRoom, input: ExternalEmployeeOperation, signal: AbortSignal): Promise<{ messageId: string; rootSessionId: SessionId }> {
    signal.throwIfAborted()
    if (this.ctx.sessions.get(room.id) !== room.session || room.id === room.employeeId || room.id === room.dotId) throw new Error('agent_message_external_proxy_session_required')
    return this.serialized('external:' + room.id, async () => {
      const proxyEvents = room.session.snapshotEvents()
      const dispatch = proxyEvents.findLast(event => event.type === 'hivemind/open-dot-runtime-dispatch-receipt' && event.data.dispatchMessageId === input.dispatchMessageId)
      if (dispatch?.type !== 'hivemind/open-dot-runtime-dispatch-receipt' || dispatch.data.employeeId !== room.employeeId
        || dispatch.data.dotId !== room.dotId || dispatch.data.organizationId !== room.organizationId || dispatch.data.userId !== room.userId) throw new Error('open_dot_runtime_dispatch_receipt_required')
      const rootId = dispatch.data.rootSessionId as SessionId
      const root = this.ctx.agents.get(rootId)
      if (!root || root.session.header.parentSession !== undefined || !['hivemind-hq', 'hivemind-hyperagents'].includes(root.session.header.agentPreset ?? '')) throw new Error('open_dot_runtime_root_unavailable')
      const owner = root.session.snapshotEvents().findLast(event => String(event.type) === 'hivemind/session-owner')?.data as { slug?: string } | undefined
      if (owner?.slug !== 'runtime') throw new Error('open_dot_runtime_root_identity_invalid')
      const rootEvents = root.session.snapshotEvents()
      const original = rootEvents.findLast(event => String(event.type) === 'hivemind/room-message-queued' && (event.data as { id?: string }).id === dispatch.data.nativePacketId)
      const originalData = original?.data as { targetId?: string; senderEmployee?: string; delivery?: { target?: string; authenticatedActor?: unknown } } | undefined
      if (String(original?.type) !== 'hivemind/room-message-queued' || originalData?.targetId !== room.id
        || originalData.senderEmployee !== 'runtime' || originalData.delivery?.target !== room.employeeId
        || !originalData.delivery.authenticatedActor || !isDeepStrictEqual(originalData.delivery.authenticatedActor, dispatch.data.actor)) throw new Error('open_dot_runtime_original_dispatch_authority_invalid')
      if (input.kind === 'reply' && input.replyTo !== dispatch.data.nativePacketId) throw new Error('open_dot_runtime_reply_reference_invalid')
      if (input.replyTo !== undefined && input.replyTo !== dispatch.data.nativePacketId) throw new Error('open_dot_runtime_reply_reference_invalid')
      if (dispatch.data.taskId !== undefined) {
        const assignment = rootEvents.findLast(event => String(event.type) === 'hivemind/hq-employee-assignment' && (event.data as { taskId?: string }).taskId === dispatch.data.taskId)
        const assignmentData = assignment?.data as { employeeId?: string; sessionId?: string } | undefined
        if (String(assignment?.type) !== 'hivemind/hq-employee-assignment' || assignmentData?.employeeId !== room.employeeId || assignmentData.sessionId !== room.id) throw new Error('open_dot_runtime_assignment_changed')
      }
      const messageId = roomMessageId(room.id, input.messageKey)
      const digest = createHash('sha256').update(JSON.stringify({ ...input, messageId, rootSessionId: String(rootId) })).digest('hex')
      const prior = proxyEvents.findLast(event => event.type === 'hivemind/open-dot-runtime-operation-receipt' && event.data.messageId === messageId)
      if (prior?.type === 'hivemind/open-dot-runtime-operation-receipt') {
        if (prior.data.digest !== digest || prior.data.rootSessionId !== String(rootId)) throw new Error('open_dot_runtime_operation_idempotency_conflict')
        return { messageId, rootSessionId: rootId }
      }
      const message: RoomMessage = { id: messageId, senderId: room.id, senderName: room.name, senderEmployee: room.employeeId,
        targetId: rootId, kind: input.kind, text: input.text, ...(input.summary === undefined ? {} : { summary: input.summary }),
        hops: 0, artifactIds: (input.artifacts ?? []).map(artifact => artifact.artifactId), ...(dispatch.data.taskId === undefined ? {} : { taskId: dispatch.data.taskId }),
        ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }), ...(input.artifacts?.length ? { artifacts: input.artifacts } : {}) }
      room.session.append('hivemind/open-dot-runtime-operation-queued', { messageId, digest, dispatchMessageId: input.dispatchMessageId, rootSessionId: String(rootId), message })
      if (!await this.ctx.sessions.flush(room.session)) throw new Error('open_dot_runtime_operation_persistence_required')
      const alreadyAdmitted = rootEvents.some(event => event.type === 'user/message' && event.data.source.kind === 'hivemind-agent-message' && event.data.source.messageId === messageId)
        || [...root.inbox.nextTurn, ...root.inbox.nextStep].some(saved => saved.source.kind === 'hivemind-agent-message' && saved.source.messageId === messageId)
      if (!alreadyAdmitted) {
        const content: ContentBlock[] = [{ type: 'text', text: JSON.stringify({ ...message, instructions: 'Authenticated message from the canonically assigned Open Dot employee. Continue the exact saved Runtime assignment and existing authority. Review actual saved artifacts before acceptance; an update does not mean the task is complete.' }) }, ...(input.artifacts ?? []).map(artifact => ({ type: 'file' as const, attachment: artifact.file }))]
        const source = input.kind === 'update'
          ? { kind: 'hivemind-agent-message' as const, messageId, senderId: room.id, senderSessionId: room.id, form: 'notice' as const,
            summary: (input.summary ?? input.text).slice(0, 120), authenticatedActor: dispatch.data.actor }
          : { kind: 'hivemind-agent-message' as const, messageId, senderId: room.id, senderSessionId: room.id, form: 'relay' as const,
            authenticatedActor: dispatch.data.actor }
        const admitted = createUserMessage({ content, source })
        if (input.kind === 'update') root.session.append('user/message', admitted, { surfaceOp: 'append' })
        else root.steer(admitted)
        if (!await this.ctx.sessions.flush(root.session)) throw new Error('open_dot_runtime_root_admission_persistence_required')
      }
      if (!root.session.snapshotEvents().some(event => event.type === 'hivemind/room-message-received' && event.data.id === messageId)) {
        root.session.append('hivemind/room-message-received', message)
        if (!await this.ctx.sessions.flush(root.session)) throw new Error('open_dot_runtime_root_receipt_persistence_required')
      }
      room.session.append('hivemind/open-dot-runtime-operation-receipt', { messageId, digest, dispatchMessageId: input.dispatchMessageId, rootSessionId: String(rootId), deliveryState: input.kind === 'update' ? 'recorded' : 'accepted' })
      if (!await this.ctx.sessions.flush(room.session)) throw new Error('open_dot_runtime_operation_receipt_persistence_required')
      return { messageId, rootSessionId: rootId }
    })
  }

  private async resolveTarget(key: string, profile: EmployeeRoomProfile | undefined, signal: AbortSignal): Promise<Agent | ExternalEmployeeRoom> {
    if (profile?.id !== undefined && profile.id !== key) throw new Error('agent_message_target_identity_conflict')
    if (profile?.executionBackend === 'open-dot' && !this.external) throw new Error('agent_message_external_provider_required')
    const resolution = await this.external?.resolve(key, profile, signal)
    if (resolution !== undefined) {
      if (resolution.driverless !== true) throw new Error('agent_message_external_proxy_must_be_driverless')
      const external = resolution.room
      if (external.employeeId !== key || (profile?.dotId !== undefined && external.dotId !== profile.dotId)) {
        throw new Error('agent_message_target_identity_conflict')
      }
      if (external.id === key || external.id === external.dotId || this.ctx.sessions.get(external.id) !== external.session
        || external.session.header.id !== external.id || external.session.header.parentSession !== undefined) {
        throw new Error('agent_message_external_session_identity_conflict')
      }
      const events = external.session.snapshotEvents()
      const marker = events.find(event => event.type === 'hivemind/external-employee-room')?.data as
        { employeeId?: string; backend?: string; dotId?: string } | undefined
      if (marker?.employeeId !== key || marker.backend !== 'open-dot' || marker.dotId !== external.dotId) {
        throw new Error('agent_message_external_binding_required')
      }
      return external
    }
    if (profile?.executionBackend === 'open-dot') throw new Error('agent_message_external_room_unavailable')
    return this.open(key)
  }
}
