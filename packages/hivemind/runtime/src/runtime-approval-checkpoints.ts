import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool, type ToolExecution, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createHash, randomUUID } from 'node:crypto'
import { requireAdministratorMessageOwner, safeApprovalReason } from './administrator-messaging.ts'
import { isRuntimeRoom } from './runtime-decision-memory.ts'
import { runtimeApprovalProjection, runtimeParkedCallMessageProjection } from './runtime-approval-projection.ts'

export type RuntimeApprovalState = 'pending' | 'approved' | 'declined' | 'executing' | 'completed' | 'failed' | 'blocked'
interface RuntimeApprovalParkCandidate { checkpoint: RuntimeApprovalCheckpoint; execution: ToolExecution; reason: string | undefined }
export interface RuntimeApprovalCheckpoint {
  readonly approvalId: string
  readonly callId: string
  readonly rootCallId: string
  readonly toolName: string
  readonly arguments: JsonValue
  readonly argumentsDigest: string
  readonly reason?: string
  readonly owner: {
    readonly sessionId: string
    readonly orgId: string
    readonly userId: string
    readonly profile: 'hivemind-chat'
    readonly variation: string
    readonly projectId?: string
    readonly nativeSessionHash?: string
  }
  readonly state: RuntimeApprovalState
  readonly decision?: 'approve' | 'decline'
  readonly decisionStatus?: 'intent' | 'committed'
  readonly result?: JsonValue
  readonly resultSource?: 'native-tool-result'
  readonly resultError?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable generic exact-call approval lifecycle, separate from native closed approval outcomes. */
    'hivemind/runtime-approval-checkpoint': RuntimeApprovalCheckpoint
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'hivemind-runtime-approval': {
      kind: 'hivemind-runtime-approval'
      plugin: 'hivemind-runtime'
      action: 'resume' | 'declined'
      approvalId: string
      callId: string
    } & import('@deepseek-ai/dsh-llm').ContextFormed
  }
}

const RESUME_TOOL = 'hivemind_resume_approval'
const MAX_ARGUMENTS_BYTES = 128 * 1024

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sameOwner(a: RuntimeApprovalCheckpoint['owner'], b: RuntimeApprovalCheckpoint['owner']): boolean {
  return a.sessionId === b.sessionId && a.orgId === b.orgId && a.userId === b.userId && a.profile === b.profile
    && a.variation === b.variation && a.projectId === b.projectId && a.nativeSessionHash === b.nativeSessionHash
}

function latestCheckpoint(agent: Agent, callId: string): RuntimeApprovalCheckpoint | undefined {
  return agent.session.snapshotEvents().findLast(event => event.type === 'hivemind/runtime-approval-checkpoint'
    && event.data.callId === callId)?.data as RuntimeApprovalCheckpoint | undefined
}

function appendCheckpoint(agent: Agent, checkpoint: RuntimeApprovalCheckpoint): void {
  agent.session.append('hivemind/runtime-approval-checkpoint', checkpoint)
}

function hasParkedEvent(agent: Agent, saved: RuntimeApprovalCheckpoint): boolean {
  return agent.session.snapshotEvents().some(event => event.type === 'tool/parked'
    && String(event.data.callId) === saved.callId && String(event.data.rootCallId) === saved.rootCallId
    && event.data.name === saved.toolName && event.data.approvalId === saved.approvalId
    && event.data.argumentsDigest === saved.argumentsDigest)
}

/** Reconcile only a result already saved by the native tool runtime for this exact call. */
export function reconcileExecutingApproval(
  saved: RuntimeApprovalCheckpoint,
  events: ReturnType<Agent['session']['snapshotEvents']>,
): RuntimeApprovalCheckpoint | undefined {
  if (saved.state !== 'executing') return undefined
  const claim = events.findLast(event => event.type === 'hivemind/runtime-approval-checkpoint'
    && event.data.callId === saved.callId && event.data.state === 'executing')
  if (!claim || claim.type !== 'hivemind/runtime-approval-checkpoint') return undefined
  const originalCall = events.findLast(event => event.type === 'tool/call' && String(event.data.callId) === saved.callId)
  if (!originalCall || originalCall.type !== 'tool/call' || originalCall.data.name !== saved.toolName) return undefined
  let originalArgs: unknown
  try { originalArgs = JSON.parse(originalCall.data.arguments) } catch { return undefined }
  if (digest(originalArgs) !== saved.argumentsDigest) return undefined
  const nativeResult = events.findLast(event => event.type === 'tool/result' && Number(event.seq) > Number(claim.seq)
    && String(event.data.message.toolCallId) === saved.callId)
  if (nativeResult?.type !== 'tool/result') return undefined
  const failed = nativeResult.data.message.isError === true || nativeResult.data.error !== undefined
  return {
    ...saved, state: failed ? 'failed' : 'completed', result: nativeResult.data as unknown as JsonValue,
    resultSource: 'native-tool-result', ...(failed ? { resultError: 'Saved native tool result records an error.' } : {}),
  }
}

function exactRoot(ctx: Context, agent: Agent): void {
  if (ctx.agents.get(agent.id) !== agent || !ctx.agents.roots().includes(agent) || !isRuntimeRoom(agent)) {
    throw new Error('runtime_approval_exact_live_root_required')
  }
  requireAdministratorMessageOwner(agent)
}

function authenticatedAdministrator(ctx: Context, agent: Agent, saved: RuntimeApprovalCheckpoint): void {
  const principal = ctx.hivemindExecutionScope.require()
  const actor = principal.authenticatedActor
  if (!actor || !['admin', 'owner'].includes(actor.role) || actor.userId !== principal.userId
    || actor.orgId !== principal.orgId || actor.userId !== saved.owner.userId || actor.orgId !== saved.owner.orgId
    || saved.owner.sessionId !== String(agent.session.id)
    || principal.profile !== saved.owner.profile || principal.variation !== saved.owner.variation
    || principal.projectId !== saved.owner.projectId || principal.nativeSessionHash !== saved.owner.nativeSessionHash) {
    throw new Error('runtime_approval_administrator_scope_mismatch')
  }
}

function ownerOf(ctx: Context, agent: Agent): RuntimeApprovalCheckpoint['owner'] {
  const principal = ctx.hivemindExecutionScope.require()
  const actor = principal.authenticatedActor
  if (!actor || !['admin', 'owner'].includes(actor.role) || actor.userId !== principal.userId || actor.orgId !== principal.orgId) {
    throw new Error('runtime_approval_administrator_scope_mismatch')
  }
  return {
    sessionId: String(agent.session.id), orgId: principal.orgId, userId: principal.userId,
    profile: principal.profile, variation: principal.variation,
    ...(principal.projectId === undefined ? {} : { projectId: principal.projectId }),
    ...(principal.nativeSessionHash === undefined ? {} : { nativeSessionHash: principal.nativeSessionHash }),
  }
}

export interface RuntimeApprovalItem {
  approvalId: string
  callId: string
  rootCallId: string
  toolName: string
  reason?: string
  state: RuntimeApprovalState
}

/** Authenticated administrator endpoint; payloads expose no saved tool arguments. */
export class RuntimeApprovalService extends TypertRemoteService {
  private readonly decisionLocks = new Map<string, Promise<boolean>>()
  private readonly dispatchedContinuations = new WeakMap<Agent, Set<string>>()
  constructor(ctx: Context) { super(ctx, 'hivemindRuntimeApproval') }

  @Remote
  pending(agent: Agent): RuntimeApprovalItem[] {
    exactRoot(this.ctx, agent)
    const owner = ownerOf(this.ctx, agent)
    const events = agent.session.snapshotEvents()
    const latest = new Map<string, RuntimeApprovalCheckpoint>()
    for (const event of events) if (event.type === 'hivemind/runtime-approval-checkpoint') latest.set(event.data.callId, event.data)
    return [...latest.values()].filter(item => sameOwner(item.owner, owner) && hasParkedEvent(agent, item)
      && ['pending', 'approved', 'executing'].includes(item.state)).map(({ approvalId, callId, rootCallId, toolName, reason, state }) => ({
      approvalId, callId, rootCallId, toolName, ...(reason === undefined ? {} : { reason }), state,
    }))
  }

  @Remote
  async decide(agent: Agent, callId: string, approvalId: string, decision: 'approve' | 'decline'): Promise<boolean> {
    const key = `${agent.id}:${callId}`
    const previous = this.decisionLocks.get(key)
    const operation = (async () => {
      if (previous) await previous.catch(() => undefined)
      return this.decideOnce(agent, callId, approvalId, decision)
    })()
    this.decisionLocks.set(key, operation)
    try { return await operation } finally {
      if (this.decisionLocks.get(key) === operation) this.decisionLocks.delete(key)
    }
  }

  private async decideOnce(agent: Agent, callId: string, approvalId: string, decision: 'approve' | 'decline'): Promise<boolean> {
    exactRoot(this.ctx, agent)
    const saved = latestCheckpoint(agent, callId)
    if (!saved || saved.approvalId !== approvalId) throw new Error('runtime_approval_checkpoint_not_found')
    if (!hasParkedEvent(agent, saved)) throw new Error('runtime_approval_park_event_not_found')
    authenticatedAdministrator(this.ctx, agent, saved)
    if (saved.decision === decision && ['approved', 'declined'].includes(saved.state)) {
      const sessions = this.ctx.get('sessions')
      if (!sessions || !await sessions.flush(agent.session)) throw new Error('runtime_approval_decision_not_persisted')
      let durable = saved
      if (saved.decisionStatus !== 'committed') {
        durable = { ...saved, decisionStatus: 'committed' }
        appendCheckpoint(agent, durable)
        if (!await sessions.flush(agent.session)) throw new Error('runtime_approval_decision_not_persisted')
      }
      this.ensureContinuation(agent, durable, decision)
      return true
    }
    if (saved.state !== 'pending') {
      throw new Error('runtime_approval_decision_conflict')
    }
    if (saved.decision !== undefined && saved.decision !== decision) throw new Error('runtime_approval_decision_conflict')
    if (decision === 'approve') {
      const live = agent.ctx.tools.get(saved.toolName, agent)
      if (!live || live.name !== saved.toolName || live.name === RESUME_TOOL || digest(saved.arguments) !== saved.argumentsDigest) {
        throw new Error('runtime_approval_saved_call_mismatch')
      }
    }
    const intent: RuntimeApprovalCheckpoint = { ...saved, state: 'pending', decision, decisionStatus: 'intent' }
    appendCheckpoint(agent, intent)
    const sessions = this.ctx.get('sessions')
    if (!sessions || !await sessions.flush(agent.session)) throw new Error('runtime_approval_decision_intent_not_persisted')
    const updated: RuntimeApprovalCheckpoint = {
      ...saved, state: decision === 'approve' ? 'approved' : 'declined', decision, decisionStatus: 'intent',
    }
    appendCheckpoint(agent, updated)
    if (!await sessions.flush(agent.session)) throw new Error('runtime_approval_decision_not_persisted')
    const committed = { ...updated, decisionStatus: 'committed' as const }
    appendCheckpoint(agent, committed)
    if (!await sessions.flush(agent.session)) throw new Error('runtime_approval_decision_not_persisted')
    this.ensureContinuation(agent, committed, decision)
    return true
  }

  private ensureContinuation(agent: Agent, saved: RuntimeApprovalCheckpoint, decision: 'approve' | 'decline'): void {
    const action = decision === 'approve' ? 'resume' : 'declined'
    const key = `${saved.approvalId}:${saved.callId}:${action}`
    const dispatched = this.dispatchedContinuations.get(agent) ?? new Set<string>()
    this.dispatchedContinuations.set(agent, dispatched)
    if (dispatched.has(key)) return
    const alreadyQueued = agent.session.snapshotEvents().some(event => event.type === 'user/message'
      && event.data.source.kind === 'hivemind-runtime-approval' && event.data.source.action === action
      && event.data.source.approvalId === saved.approvalId && event.data.source.callId === saved.callId)
    if (alreadyQueued) { dispatched.add(key); return }
    agent.steer(createUserMessage({
      source: { kind: 'hivemind-runtime-approval', plugin: 'hivemind-runtime', action, approvalId: saved.approvalId, callId: saved.callId },
      content: [{ type: 'text', text: decision === 'approve'
        ? 'Resume the exact saved Runtime approval checkpoint after revalidating current permissions. Do not alter its arguments.'
        : 'The administrator declined the exact saved Runtime approval checkpoint. Do not execute it.' }],
    }))
    dispatched.add(key)
  }
}

function approvalToolFor(agent: Agent, resumingCalls: WeakMap<Agent, Set<string>>) {
  return defineTool({
    name: RESUME_TOOL,
    description: 'Runtime only. Resume an exact saved approved action by its approval_id from the authenticated Runtime approval panel. Never invent an ID or modify the saved tool arguments. A decline or unknown result cannot be retried.',
    parameters: { approval_id: { type: 'string', required: true, description: 'Exact approval_id returned by the authenticated Runtime approval panel.' } },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => false,
    async execute(args, execution) {
      if (!execution.agent || execution.agent.id !== agent.id) throw new Error('runtime_approval_exact_root_required')
      exactRoot(agent.ctx, agent)
      const source = agent.session.snapshotEvents().findLast(event => event.type === 'user/message')
      const typed = source?.type === 'user/message' ? source.data.source : undefined
      const approvalId = String(args.approval_id)
      if (!typed || typed.kind !== 'hivemind-runtime-approval' || typed.action !== 'resume' || typed.approvalId !== approvalId) {
        throw new Error('runtime_approval_authenticated_resume_source_required')
      }
      const saved = latestCheckpoint(agent, typed.callId)
      if (!saved || saved.approvalId !== approvalId || saved.decision !== 'approve' || saved.decisionStatus !== 'committed'
        || !sameOwner(saved.owner, ownerOf(agent.ctx, agent)) || digest(saved.arguments) !== saved.argumentsDigest) {
        throw new Error('runtime_approval_checkpoint_not_resumable')
      }
      if (saved.state === 'executing') {
        const reconciled = reconcileExecutingApproval(saved, agent.session.snapshotEvents())
        if (!reconciled) throw new Error('runtime_approval_execution_outcome_unknown')
        appendCheckpoint(agent, reconciled)
        const sessions = agent.ctx.get('sessions')
        if (!sessions || !await sessions.flush(agent.session)) throw new Error('runtime_approval_result_not_persisted')
        return reconciled.state === 'failed'
          ? { status: 'blocked', approval_id: approvalId, error: reconciled.resultError ?? 'Saved native tool result records an error.' }
          : { status: 'completed', approval_id: approvalId, result: reconciled.result ?? null }
      }
      if (saved.state !== 'approved') throw new Error('runtime_approval_checkpoint_not_resumable')
      const tool = agent.ctx.tools.get(saved.toolName, agent)
      if (!tool || tool.name !== saved.toolName || tool.name === RESUME_TOOL) throw new Error('runtime_approval_tool_unavailable')
      const claiming: RuntimeApprovalCheckpoint = { ...saved, state: 'executing' }
      appendCheckpoint(agent, claiming)
      const sessions = agent.ctx.get('sessions')
      if (!sessions || !await sessions.flush(agent.session)) throw new Error('runtime_approval_execution_claim_not_persisted')
      const active = resumingCalls.get(agent) ?? new Set<string>()
      resumingCalls.set(agent, active)
      active.add(saved.callId)
      let result: Awaited<ReturnType<typeof agent.ctx.tools.execute>>
      try {
        result = await agent.ctx.tools.execute({ callId: ToolCallId(saved.callId), rootCallId: ToolCallId(saved.rootCallId),
          name: saved.toolName, arguments: saved.arguments, agent, signal: execution.signal })
      } finally { active.delete(saved.callId) }
      if (result.isError) {
        appendCheckpoint(agent, { ...claiming, state: 'blocked', resultError: result.error.message })
        if (!await sessions.flush(agent.session)) throw new Error('runtime_approval_result_not_persisted')
        return { status: 'blocked', approval_id: approvalId, error: result.error.message }
      }
      appendCheckpoint(agent, { ...claiming, state: 'completed', result: result.value })
      if (!await sessions.flush(agent.session)) throw new Error('runtime_approval_result_not_persisted')
      if (result.concludesTurn) (execution as ToolRunContext).concludeTurn()
      return { status: 'completed', approval_id: approvalId, result: result.value }
    },
  })
}

/** Mount the authenticated Remote service and one exact-call resume capability per Runtime root. */
export function installRuntimeApprovalService(ctx: Context): void {
  new RuntimeApprovalService(ctx)
  ctx.effect(() => ctx.sessionProjections.register(runtimeApprovalProjection))
  ctx.sessions.registerMessageProjection(runtimeParkedCallMessageProjection)
  const installed = new WeakSet<Agent>()
  const resumingCalls = new WeakMap<Agent, Set<string>>()
  const parkCandidates = new WeakMap<object, RuntimeApprovalParkCandidate>()
  ctx.effect(() => ctx.on('agent/created', ({ agent }) => {
    if (!isRuntimeRoom(agent) || installed.has(agent)) return
    agent.ctx.effect(() => agent.ctx.tools.register(approvalToolFor(agent, resumingCalls)))
    installed.add(agent)
  }))
  ctx.effect(() => ctx.on('tools/park', async (execution, reason, next) => {
    const agent = execution.agent
    if (!agent || !execution.allowParking || !isRuntimeRoom(agent) || ctx.approval.policyFor(agent.session) !== 'ask') return next()
    exactRoot(ctx, agent)
    const tool = ctx.tools.get(execution.name, agent)
    const callId = String(execution.callId)
    const rootCallId = String(execution.rootCallId)
    const canonicalArgs = JSON.parse(canonical(execution.arguments)) as JsonValue
    const serialized = JSON.stringify(canonicalArgs)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_ARGUMENTS_BYTES) throw new Error('runtime_approval_arguments_too_large')
    if (!tool || tool.name !== execution.name || tool.name === RESUME_TOOL) throw new Error('runtime_approval_tool_unavailable')
    const owner = ownerOf(ctx, agent)
    const previous = latestCheckpoint(agent, callId)
    if (previous) {
      if (previous.toolName !== execution.name || previous.rootCallId !== rootCallId
        || previous.argumentsDigest !== digest(canonicalArgs) || !sameOwner(previous.owner, owner)
        || previous.state !== 'pending') throw new Error('runtime_approval_checkpoint_call_conflict')
      const park = { kind: 'park' as const, approvalId: previous.approvalId, argumentsDigest: previous.argumentsDigest }
      parkCandidates.set(execution, { checkpoint: previous, execution, reason })
      return park
    }
    const approvalReason = safeApprovalReason(reason)
    const checkpoint: RuntimeApprovalCheckpoint = {
      approvalId: randomUUID(), callId, rootCallId, toolName: execution.name,
      arguments: canonicalArgs, argumentsDigest: digest(canonicalArgs),
      ...(approvalReason === undefined ? {} : { reason: approvalReason }),
      owner, state: 'pending',
    }
    parkCandidates.set(execution, { checkpoint, execution, reason })
    return { kind: 'park', approvalId: checkpoint.approvalId, argumentsDigest: checkpoint.argumentsDigest }
  }, { prepend: true }))
  ctx.effect(() => ctx.on('tools/park-commit', async (execution, park, next) => {
    const candidate = parkCandidates.get(execution)
    if (!candidate || candidate.checkpoint.approvalId !== park.approvalId
      || candidate.checkpoint.argumentsDigest !== park.argumentsDigest) return { kind: 'unavailable' }
    const agent = execution.agent
    if (!agent) return { kind: 'unavailable' }
    const events = agent.session.snapshotEvents()
    if (execution.turn === undefined || execution.step === undefined) return { kind: 'unavailable' }
    const turn = execution.turn
    const step = execution.step
    const call = events.findLast(event => event.type === 'tool/call' && event.data.callId === execution.callId)
    if (execution.parent !== undefined) {
      const dispatch = events.findLast(event => event.type === 'tool/ptc-dispatch-start'
        && event.data.subCallId === execution.callId && event.data.rootCallId === execution.rootCallId)
      if (dispatch?.type !== 'tool/ptc-dispatch-start') return { kind: 'unavailable' }
      if (dispatch.data.name !== execution.name || digest(dispatch.data.arguments) !== candidate.checkpoint.argumentsDigest) {
        return { kind: 'unavailable' }
      }
    } else {
      if (call?.type !== 'tool/call') return { kind: 'unavailable' }
      if (call.data.name !== execution.name || digest(JSON.parse(call.data.arguments)) !== candidate.checkpoint.argumentsDigest) {
        return { kind: 'unavailable' }
      }
    }
    appendCheckpoint(agent, candidate.checkpoint)
    agent.session.append('tool/parked', {
      turn, step, callId: execution.callId, rootCallId: execution.rootCallId,
      name: execution.name, approvalId: candidate.checkpoint.approvalId,
      argumentsDigest: candidate.checkpoint.argumentsDigest,
    })
    const sessions = ctx.get('sessions')
    if (!sessions || !await sessions.flush(agent.session)) throw new Error('runtime_approval_park_not_persisted')
    parkCandidates.delete(execution)
    const downstream = await next()
    if (downstream.kind !== 'committed') throw new Error('runtime_approval_park_commit_rejected')
    return { kind: 'committed' }
  }, { prepend: true }))
  ctx.effect(() => ctx.on('approval/request', async function (request, next) {
    const agent = request.agent
    const callId = String(request.callId ?? '')
    if (!agent || !callId || !resumingCalls.get(agent)?.has(callId)) return next()
    const saved = latestCheckpoint(agent, callId)
    if (!saved || saved.state !== 'executing' || saved.toolName !== request.toolName
      || digest(saved.arguments) !== saved.argumentsDigest
      || !sameOwner(saved.owner, ownerOf(agent.ctx, agent))) return next()
    // Only the exact persisted grant is converted into the native one-shot outcome.
    return 'allowed-once'
  }, { prepend: true }))
}
