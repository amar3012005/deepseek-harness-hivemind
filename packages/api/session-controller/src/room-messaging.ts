/** Scoped persistent-room messages use native Agent admission and Session receipts. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, ContextFormed } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

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
export interface ExternalEmployeePrincipal {
  readonly orgId: string
  readonly userId: string
  readonly profile: 'hivemind-chat'
  readonly variation: string
  readonly authenticatedActor?: Extract<import('@deepseek-ai/dsh-llm').MessageSource, { kind: 'user' }>['authenticatedActor']
}
export interface ExternalEmployeeRoomProvider {
  /** Re-read the canonical authorized directory projection under principal; profile is an identity hint, never authority. */
  resolve(employeeId: string, profile: EmployeeRoomProfile, principal: ExternalEmployeePrincipal, signal: AbortSignal): Promise<{ agent: Agent; driverless: true }>
  /** Resolve one message into the external backend. Once the job commits, return its durable idempotent receipt even if cancellation arrives. */
  deliver(input: { employeeId: string; room: Agent; message: RoomMessage; idempotencyKey: string; callerSessionId: SessionId; principal: ExternalEmployeePrincipal; authenticatedActor?: ExternalEmployeePrincipal['authenticatedActor'] }, signal: AbortSignal): Promise<{ receiptId: string; status: 'accepted' | 'recorded' }>
}
/** Register before SessionController starts. The host owns provider auth and backend-specific checks. */
export function registerExternalEmployeeRoomProvider(ctx: Context, provider: ExternalEmployeeRoomProvider): () => void {
  return ctx.provide('externalEmployeeRoomProvider', provider)
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** External backend identity bound to this real opaque proxy Session. */
    'hivemind/external-employee-room': { employeeId: string; backend: 'open-dot' }
    /** Sender outbox packet committed before delivery; stable id binds its exact room and payload. */
    'hivemind/room-message-queued': RoomMessage & { delivery?: { key: string; target: string; authenticatedActor?: Extract<import('@deepseek-ai/dsh-llm').MessageSource, { kind: 'user' }>['authenticatedActor'] } }
    /** Receiver acknowledgement of one admitted question/reply or quietly saved update. */
    'hivemind/room-message-received': RoomMessage
    /** Sender acknowledgement linking its message id to the confirmed receiver room. */
    'hivemind/room-message-delivered': { id: string; targetId: SessionId }
    /** Durable external queue receipt; written only after the provider confirms acceptance. */
    'hivemind/external-delivery-accepted': { id: string; employeeId: string; targetSessionId: SessionId; receiptId: string; status: 'accepted' | 'recorded' }
  }
}
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'hivemind-agent-message': { kind: 'hivemind-agent-message'; messageId: string; senderId: SessionId; senderSessionId: SessionId; authenticatedActor?: Extract<import('@deepseek-ai/dsh-llm').MessageSource,{ kind:'user' }>['authenticatedActor'] } & ContextFormed
  }
}
export function roomMessageId(senderId: string, key: string): string {
  if (!/^[A-Za-z0-9._:-]{1,120}$/u.test(key)) throw new Error('agent_message_key_invalid')
  return `agent-message-${createHash('sha256').update(JSON.stringify([senderId, key])).digest('hex')}`
}
/** One controller instance serializes room writes; native leases arbitrate processes. */
export class RoomMessaging {
  private readonly tails = new Map<string, Promise<unknown>>()
  constructor(private readonly ctx: Context, private readonly open: (key: string) => Promise<Agent>, private readonly external?: ExternalEmployeeRoomProvider) {}
  private async serialized<T>(id: string, work: () => Promise<T>): Promise<T> {
    const before = this.tails.get(id) ?? Promise.resolve()
    const run = before.catch(() => undefined).then(work)
    this.tails.set(id, run)
    try { return await run } finally { if (this.tails.get(id) === run) this.tails.delete(id) }
  }
  private async persist(agent: Agent): Promise<void> {
    if (!(await this.ctx.sessions.flush(agent.session))) throw new Error('agent_message_persistence_required')
  }
  private externalPrincipal(): ExternalEmployeePrincipal {
    const scope = (this.ctx as Context & { hivemindExecutionScope?: { require?: () => unknown } }).hivemindExecutionScope
    if (typeof scope?.require !== 'function') throw new Error('agent_message_external_principal_required')
    const value: unknown = scope.require()
    if (value === null || typeof value !== 'object') throw new Error('agent_message_external_principal_invalid')
    const principal = value as Record<string, unknown>
    if (typeof principal.orgId !== 'string' || !principal.orgId.trim()
      || typeof principal.userId !== 'string' || !principal.userId.trim()
      || principal.profile !== 'hivemind-chat'
      || typeof principal.variation !== 'string' || !principal.variation.trim()) throw new Error('agent_message_external_principal_invalid')
    const actor = principal.authenticatedActor
    if (actor !== undefined) {
      if (actor === null || typeof actor !== 'object') throw new Error('agent_message_external_principal_invalid')
      const candidate = actor as Record<string, unknown>
      if (candidate.orgId !== principal.orgId || candidate.userId !== principal.userId
        || typeof candidate.name !== 'string' || !candidate.name.trim()
        || typeof candidate.role !== 'string' || !candidate.role.trim()) throw new Error('agent_message_external_principal_invalid')
    }
    return value as ExternalEmployeePrincipal
  }
  /** Resolve the tenant-owned room and checkpoint its directory identity.
   * @param key - Exact employee id.
   * @param profile - Trusted authenticated directory profile.
   * @param signal - Cancellation before room admission.
   * @returns Exact live persistent room Agent.
   */
  async resolveRoom(key: string, profile: EmployeeRoomProfile, signal: AbortSignal): Promise<Agent> {
    signal.throwIfAborted()
    if (key !== profile.id) throw new Error('agent_message_target_identity_conflict')
    const target = await this.resolveTarget(key, profile, signal)
    signal.throwIfAborted()
    const events = target.session.snapshotEvents()
    const externalMarker = events.find(event => event.type === 'hivemind/external-employee-room')?.data as { employeeId?: string; backend?: string } | undefined
    if (profile.executionBackend === 'open-dot' || externalMarker !== undefined) {
      if (!this.external) throw new Error('agent_message_external_provider_required')
      if (externalMarker && (externalMarker.employeeId !== profile.id || externalMarker.backend !== 'open-dot')) throw new Error('agent_message_target_identity_conflict')
      if (target.id === profile.id || (profile.dotId !== undefined && target.id === profile.dotId)) throw new Error('agent_message_external_session_identity_conflict')
      if (this.ctx.agents.get(target.id) !== target || target.session.header.id !== target.id || target.session.header.parentSession !== undefined) throw new Error('agent_message_external_proxy_agent_required')
      if (!externalMarker) {
        target.session.append('hivemind/external-employee-room', { employeeId: profile.id, backend: 'open-dot' })
        await this.persist(target)
      }
      signal.throwIfAborted()
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
      const external = target.session.snapshotEvents().some(e => e.type === 'hivemind/external-employee-room')
      if (external && !this.external) throw new Error('agent_message_external_provider_required')
      if (external && (input.targetProfile?.executionBackend !== 'open-dot' || input.targetProfile.id !== input.target)) throw new Error('agent_message_external_profile_required')
      const principal = external ? this.externalPrincipal() : undefined
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
      let authenticatedActor = old?.type === 'hivemind/room-message-queued'
        ? old.data.delivery?.authenticatedActor : await this.ctx.serial('api-session/user-authorship', caller)
      if (external && authenticatedActor && principal && (authenticatedActor.orgId !== principal.orgId || authenticatedActor.userId !== principal.userId)) throw new Error('agent_message_external_actor_conflict')
      if (external && principal?.authenticatedActor && authenticatedActor
        && (principal.authenticatedActor.orgId !== authenticatedActor.orgId || principal.authenticatedActor.userId !== authenticatedActor.userId
          || principal.authenticatedActor.name !== authenticatedActor.name || principal.authenticatedActor.role !== authenticatedActor.role)) throw new Error('agent_message_external_actor_conflict')
      if (external && authenticatedActor === undefined) authenticatedActor = principal?.authenticatedActor
      if (old === undefined) caller.session.append('hivemind/room-message-queued', { ...message, delivery: { key: input.key, target: input.target, ...(authenticatedActor === undefined ? {} : { authenticatedActor }) } })
      await this.persist(caller)
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
          const accepted = targetEvents.some(e => e.type === 'user/message' && e.data.source.kind === 'hivemind-agent-message' && e.data.source.messageId === id) || [...target.inbox.nextTurn, ...target.inbox.nextStep].some(m => m.source.kind === 'hivemind-agent-message' && m.source.messageId === id)
          if (external) {
            const prior = targetEvents.find(e => e.type === 'hivemind/external-delivery-accepted' && e.data.id === id)
            if (prior?.type === 'hivemind/external-delivery-accepted') {
              if (prior.data.employeeId !== input.target || prior.data.targetSessionId !== target.id) throw new Error('agent_message_external_receipt_conflict')
              externalStatus = prior.data.status
            } else {
              const result = await this.external!.deliver({ employeeId: input.target, room: target, message, idempotencyKey: id,
                callerSessionId: caller.id, principal: principal!, ...(authenticatedActor === undefined ? {} : { authenticatedActor }) }, signal)
              if (result === null || typeof result !== 'object' || typeof result.receiptId !== 'string'
                || result.receiptId.trim() === '' || result.receiptId.length > 200
                || (result.status !== 'accepted' && result.status !== 'recorded')) throw new Error('agent_message_external_receipt_invalid')
              target.session.append('hivemind/external-delivery-accepted', { id, employeeId: input.target, targetSessionId: target.id, receiptId: result.receiptId, status: result.status })
              await this.persist(target)
              externalStatus = result.status
            }
            // Persist a provider-confirmed job receipt before honoring cancellation.
            // A retry can recover this receipt without enqueueing the job twice.
            signal.throwIfAborted()
          } else if (!accepted) {
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
  private async resolveTarget(key: string, profile: EmployeeRoomProfile | undefined, signal: AbortSignal): Promise<Agent> {
    if (profile?.executionBackend !== undefined && profile.executionBackend !== 'open-dot') throw new Error('agent_message_external_backend_conflict')
    if (profile?.executionBackend === 'open-dot' && !this.external) throw new Error('agent_message_external_provider_required')
    if (profile?.executionBackend === 'open-dot') {
      if (profile.id !== key) throw new Error('agent_message_target_identity_conflict')
      const principal = this.externalPrincipal()
      const resolution = await this.external!.resolve(key, profile, principal, signal)
      signal.throwIfAborted()
      if (resolution === null || typeof resolution !== 'object' || resolution.driverless !== true || !resolution.agent) throw new Error('agent_message_external_proxy_must_be_driverless')
      const external = resolution.agent
      if (external.id === key || (profile?.dotId !== undefined && external.id === profile.dotId)) throw new Error('agent_message_external_session_identity_conflict')
      if (this.ctx.agents.get(external.id) !== external || external.session.header.id !== external.id || external.session.header.parentSession !== undefined) throw new Error('agent_message_external_proxy_agent_required')
      const events = external.session.snapshotEvents()
      const marker = events.find(event => event.type === 'hivemind/external-employee-room')?.data as { employeeId?: string; backend?: string } | undefined
      if (marker && (marker.employeeId !== key || marker.backend !== 'open-dot')) throw new Error('agent_message_target_identity_conflict')
      if (!marker) {
        external.session.append('hivemind/external-employee-room', { employeeId: key, backend: 'open-dot' })
        await this.persist(external)
      }
      signal.throwIfAborted()
      return external
    }
    const target = await this.open(key)
    signal.throwIfAborted()
    return target
  }
}
