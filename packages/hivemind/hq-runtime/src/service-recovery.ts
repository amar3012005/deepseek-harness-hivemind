/** Tenant-scoped restart recovery through existing native Schedule delivery. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { ScheduleId } from '@deepseek-ai/dsh-schedule'
import { hqMode } from './mode.ts'
import { TeamTaskId } from '@deepseek-ai/dsh-experimental-agent-team'
import { currentEmployeeWork } from './employee-room.ts'
const MARKER = '[HIVEMIND SERVICE RECOVERY]\n'
type Recovery = { sessionId: string; turn: number } & (
  | { rootId: string; modeRevision: number; employeeId?: never; requestSeq?: never }
  | { employeeId: string; requestSeq: number; rootId?: never; modeRevision?: never }
  | { employeeId: string; requestSeq: number; rootId: string; modeRevision: number }
)
/** A direct employee chat is authorized by its exact saved human request, not HQ autonomy. */
function directHumanRequest(events: readonly SessionEvent[], turn: number): number | undefined {
  const start = events.findLast(event => event.type === 'turn/start')
  if (start?.type !== 'turn/start' || start.data.turn !== turn) return
  const request = events.findLast(event => event.type === 'user/message' && event.seq > start.seq)
  return request?.type === 'user/message' && request.data.source.kind === 'user' ? request.seq : undefined
}
/** A saved authenticated Chief request, never a quiet scheduling notice. */
function chiefRequest(events: readonly SessionEvent[], turn: number): { requestSeq: number; rootId: string } | undefined {
  const start = events.findLast(event => event.type === 'turn/start')
  if (start?.type !== 'turn/start' || start.data.turn !== turn) return
  const request = events.findLast(event => event.type === 'user/message' && event.seq > start.seq
    && event.data.source.kind !== 'plugin')
  if (request?.type !== 'user/message' || request.data.source.kind !== 'hivemind-agent-message') return
  const source = request.data.source
  const receipt = events.findLast(event => event.type === 'hivemind/room-message-received'
    && event.data.id === source.messageId)
  if (receipt?.type !== 'hivemind/room-message-received' || receipt.data.senderEmployee !== 'runtime'
    || !['question', 'reply'].includes(receipt.data.kind) || receipt.data.senderId !== source.senderSessionId) return
  return { requestSeq: request.seq, rootId: source.senderSessionId }
}
function pinnedEmployee(events: readonly SessionEvent[]): string | undefined {
  const owner = events.find(event => String(event.type) === 'hivemind/session-owner')?.data as { id?: unknown } | undefined
  return typeof owner?.id === 'string' && owner.id.trim() !== '' ? owner.id : undefined
}
async function canonicalEmployee(ctx: Context, agent: Agent, employeeId: string): Promise<boolean> {
  const persistence = ctx.sessionPersistence as typeof ctx.sessionPersistence & { employeeRoomId?: (key: string) => Promise<SessionId> }
  return pinnedEmployee(agent.session.ownEvents()) === employeeId && persistence.employeeRoomId !== undefined
    && await persistence.employeeRoomId(employeeId) === agent.id
}
const keyOf = (turn: number) => `hivemind-service-recovery-turn-${turn}`
const idOf = (sessionId: string, turn: number) => ScheduleId(`schedule-${createHash('sha256').update(`${sessionId}\0${keyOf(turn)}`).digest('hex')}`)
function effectivePreset(agent: Agent): string | undefined {
  return agent.session.ownEvents().findLast(event => event.type === 'agent-preset/selected')?.data.agentPreset
    ?? agent.session.header.agentPreset
}
/** The saved exact turn must prove service disposal or native crash repair. */
export function serviceInterrupted(events: readonly SessionEvent[], turn: number): boolean {
  const start = events.findLast(event => event.type === 'turn/start')
  if (start?.type !== 'turn/start' || start.data.turn !== turn) return false
  const end = events.findLast(event => event.type === 'turn/end' && event.data.turn === turn)
  if (end?.type !== 'turn/end' || !(end.data.reason.kind === 'interrupted'
    || (end.data.reason.kind === 'aborted' && end.data.reason.reason.kind === 'disposed'))) return false
  if (events.some(event => event.seq > start.seq && event.type === 'hivemind/hq-rest-confirmed')) return false
  // Native questions are tool-backed; an interrupted or repaired question is not a human answer.
  const answered = new Set(events.flatMap(event => event.type === 'tool/result'
    ? event.data.message.content.flatMap(block => block.type === 'tool-result' && !block.isError ? [block.toolCallId] : []) : []))
  if (events.some(event => event.seq > start.seq && event.type === 'tool/call'
    && event.data.name === 'ask_user_question' && !answered.has(event.data.callId))) return false
  // Pending/cancelled human approval is not authorization to try again after restart.
  const decisions = new Map<string, string>()
  for (const event of events) {
    if (event.seq <= start.seq) continue
    const data = event.data as unknown as { id?: string; outcome?: string }
    if (String(event.type) === 'approval/decided' && data.id && data.outcome) decisions.set(data.id, data.outcome)
  }
  return !events.some(event => event.seq > start.seq && String(event.type) === 'approval/asked'
    && decisions.get((event.data as unknown as { id: string }).id) !== 'allowed-once')
}
function recoveryFrom(prompt: string): Recovery | undefined {
  if (!prompt.startsWith(MARKER)) return
  try {
    const value: unknown = JSON.parse(prompt.slice(MARKER.length).split('\n')[0] ?? '')
    if (typeof value !== 'object' || value === null) return
    const ref = value as Partial<Recovery>
    if (typeof ref.sessionId !== 'string' || typeof ref.turn !== 'number' || !Number.isSafeInteger(ref.turn) || ref.turn < 0) return
    const team = typeof ref.rootId === 'string' && typeof ref.modeRevision === 'number'
      && Number.isSafeInteger(ref.modeRevision) && ref.modeRevision >= 1
      && ref.employeeId === undefined && ref.requestSeq === undefined
    const direct = typeof ref.employeeId === 'string' && ref.employeeId.trim() !== ''
      && typeof ref.requestSeq === 'number' && Number.isSafeInteger(ref.requestSeq) && ref.requestSeq >= 0
      && ref.rootId === undefined && ref.modeRevision === undefined
    const chief = typeof ref.employeeId === 'string' && ref.employeeId.trim() !== ''
      && typeof ref.requestSeq === 'number' && Number.isSafeInteger(ref.requestSeq) && ref.requestSeq >= 0
      && typeof ref.rootId === 'string' && typeof ref.modeRevision === 'number'
      && Number.isSafeInteger(ref.modeRevision) && ref.modeRevision >= 1
    if (!team && !direct && !chief) return
    return ref as Recovery
  } catch { return }
}
/** Arm while authenticated; native Schedule retains tenant dispatch authority across restart. */
export function installServiceRecovery(ctx: Context): void {
  const armed = new WeakMap<Agent, number>()
  const jobs = new Set<Promise<unknown>>()
  ctx.effect(() => ctx.schedule.guardDelivery(async (agent, task) => {
    const ref = recoveryFrom(task.record.prompt)
    if (!ref) return true
    if (ref.sessionId !== agent.id || task.record.id !== idOf(agent.id, ref.turn)) return false
    const events = agent.session.ownEvents()
    const deliveryKey = createHash('sha256').update(`${task.record.id}:${task.record.scheduledAt}`).digest('hex')
    // A durable native inbox receipt only acknowledges delivery; never enqueue twice.
    if (events.some(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.source.kind === 'schedule' && message.source.deliveryKey === deliveryKey))) return true
    if (agent.status === 'running' || agent.inbox.nextStep.length || agent.inbox.nextTurn.length
      || !serviceInterrupted(events, ref.turn)) return false
    if (typeof ref.employeeId === 'string' && ref.rootId === undefined) {
      const mode = events.findLast(event => event.type === 'hivemind/hq-mode')
      return effectivePreset(agent) === 'hivemind-hyperagents'
        && mode?.data.enabled !== false && !ctx.agentTeams.tryMembership(agent) && !currentEmployeeWork(agent)
        && directHumanRequest(events, ref.turn) === ref.requestSeq
        && await canonicalEmployee(ctx, agent, ref.employeeId)
    }
    const handle = await ctx.sessionPersistence.open(SessionId(ref.rootId), 'read')
    try { await handle.read() } finally { await handle.close() }
    const resolved = await ctx.sessionController.resolveAgent(SessionId(ref.rootId))
    if ('error' in resolved) throw resolved.error
    const root = resolved.agent
    const mode = hqMode(root.session.snapshotEvents())
    if (effectivePreset(root) !== 'hivemind-hq' || !mode.enabled || mode.revision !== ref.modeRevision) return false
    if (typeof ref.employeeId === 'string') {
      const request = chiefRequest(events, ref.turn)
      return effectivePreset(agent) === 'hivemind-hyperagents'
        && events.findLast(event => event.type === 'hivemind/hq-mode')?.data.enabled !== false
        && request?.rootId === ref.rootId && request.requestSeq === ref.requestSeq
        && await canonicalEmployee(ctx, agent, ref.employeeId)
    }
    const work = currentEmployeeWork(agent)
    if (work && (work.rootId !== root.id || ['completed', 'deleted'].includes(ctx.agentTeams.getTask(root, TeamTaskId(work.taskId)).status))) return false
    return effectivePreset(agent) === 'hivemind-hq' || effectivePreset(agent) === 'hivemind-hyperagents'
  }))
  const arm = async (agent: Agent, turn: number): Promise<void> => {
    if (armed.get(agent) === turn) return
    const preset = effectivePreset(agent)
    if (preset !== 'hivemind-hq' && preset !== 'hivemind-hyperagents') return
    const root = preset === 'hivemind-hq' ? agent : ctx.agentTeams.tryMembership(agent)?.root
    const events = agent.session.ownEvents()
    const employeeId = pinnedEmployee(events)
    const chief = preset === 'hivemind-hyperagents' ? chiefRequest(events, turn) : undefined
    const start = events.findLast(event => event.type === 'turn/start')
    const request = events.findLast(event => event.type === 'user/message' && event.seq > (start?.seq ?? Infinity)
      && event.data.source.kind !== 'plugin')
    if (preset === 'hivemind-hyperagents' && request?.type === 'user/message'
      && request.data.source.kind === 'hivemind-agent-message') {
      const source = request.data.source
      if (!events.some(event => event.type === 'hivemind/room-message-received' && event.data.id === source.messageId)) return
    }
    let ref: Recovery
    // A fresh explicit request supersedes historical membership or completed work.
    if (chief && employeeId !== undefined && await canonicalEmployee(ctx, agent, employeeId)) {
      const resolved = await ctx.sessionController.resolveAgent(SessionId(chief.rootId))
      if ('error' in resolved) throw resolved.error
      const mode = hqMode(resolved.agent.session.snapshotEvents())
      if (effectivePreset(resolved.agent) !== 'hivemind-hq' || !mode.enabled) return
      ref = { sessionId: agent.id, employeeId, ...chief, turn, modeRevision: mode.revision }
    } else if (root) {
      const mode = hqMode(root.session.snapshotEvents())
      if (!mode.enabled) return
      ref = { sessionId: agent.id, rootId: root.id, turn, modeRevision: mode.revision }
    } else {
      const requestSeq = directHumanRequest(events, turn)
      if (preset !== 'hivemind-hyperagents' || employeeId === undefined || requestSeq === undefined
        || currentEmployeeWork(agent) || events.findLast(event => event.type === 'hivemind/hq-mode')?.data.enabled === false
        || !await canonicalEmployee(ctx, agent, employeeId)) return
      ref = { sessionId: agent.id, employeeId, requestSeq, turn }
    }
    if (!await ctx.sessions.flush(agent.session)) throw new Error('service_recovery_source_persistence_required')
    await ctx.schedule.ensure(agent.id, keyOf(turn), { title: 'Service interruption recovery', after_seconds: 1,
      prompt: MARKER + JSON.stringify(ref) + '\nThe service stopped during your unfinished work. Resume the existing native plan from saved state, private handoff and exact receipts. Reconcile any TOOL_OUTCOME_UNKNOWN before retrying: verify saved/external state for writes, and retry only proven absent or idempotent work. Do not repeat completed work or awakening. Preserve existing schedules and permissions. Explain meaningful progress naturally.' })
    armed.set(agent, turn)
  }
  ctx.effect(() => ctx.on('agent/pre-step', async ({ agent, turn }, next) => {
    const decision = await next()
    if (decision.kind !== 'reject') await arm(agent, turn)
    return decision
  }, { global: true }))
  // Native streaming begins after accepted incoming messages are committed.
  ctx.effect(() => ctx.on('llm/stream', async function* (options, next) {
    if (isAgentLoopRequest(options) && options.sessionId) {
      const agent = ctx.agents.get(SessionId(options.sessionId))
      const start = agent?.session.ownEvents().findLast(event => event.type === 'turn/start')
      if (agent?.status === 'running' && start?.type === 'turn/start') await arm(agent, start.data.turn)
    }
    yield* next()
  }, { global: true }))
  // Native room delivery persists its receipt after steer; the first step may already be streaming.
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    if (event.type !== 'hivemind/room-message-received') return
    const agent = ctx.agents.get(session.id)
    const start = agent?.session.ownEvents().findLast(value => value.type === 'turn/start')
    if (agent?.status !== 'running' || start?.type !== 'turn/start') return
    const job = arm(agent, start.data.turn).catch((error: unknown) => {
      ctx.logger.warn(`Chief request recovery remains unconfirmed: ${error instanceof Error ? error.name : 'unknown error'}`)
    })
    jobs.add(job)
    void job.finally(() => jobs.delete(job))
  }, { global: true }))
  ctx.effect(() => ctx.on('agent/turn-ended', ({ agent, turn, reason }) => {
    if (armed.get(agent) !== turn || reason.kind === 'interrupted'
      || (reason.kind === 'aborted' && reason.reason.kind === 'disposed')) return
    const job = ctx.schedule.delete({ sessionId: agent.id, id: idOf(agent.id, turn) })
      .catch((error: unknown) => { ctx.logger.warn(`Service recovery cleanup pending: ${error instanceof Error ? error.name : 'unknown error'}`) })
    jobs.add(job)
    void job.finally(() => jobs.delete(job))
  }, { global: true }))
  ctx.effect(() => async () => { await Promise.allSettled([...jobs]) })
}
