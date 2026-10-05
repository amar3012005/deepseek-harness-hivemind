/** Tenant-scoped restart recovery through existing native Schedule delivery. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { ScheduleId } from '@deepseek-ai/dsh-schedule'
import { hqMode } from './mode.ts'
import { TeamTaskId } from '@deepseek-ai/dsh-experimental-agent-team'
import { currentEmployeeWork } from './employee-room.ts'
const MARKER = '[HIVEMIND SERVICE RECOVERY]\n'
interface Recovery { sessionId: string; rootId: string; turn: number; modeRevision: number }
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
    if (typeof ref.sessionId !== 'string' || typeof ref.rootId !== 'string'
      || typeof ref.turn !== 'number' || !Number.isSafeInteger(ref.turn) || ref.turn < 0
      || typeof ref.modeRevision !== 'number' || !Number.isSafeInteger(ref.modeRevision) || ref.modeRevision < 1) return
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
    const handle = await ctx.sessionPersistence.open(SessionId(ref.rootId), 'read')
    try { await handle.read() } finally { await handle.close() }
    const resolved = await ctx.sessionController.resolveAgent(SessionId(ref.rootId))
    if ('error' in resolved) throw resolved.error
    const root = resolved.agent
    const mode = hqMode(root.session.snapshotEvents())
    if (effectivePreset(root) !== 'hivemind-hq' || !mode.enabled || mode.revision !== ref.modeRevision) return false
    const work = currentEmployeeWork(agent)
    if (work && (work.rootId !== root.id || ['completed', 'deleted'].includes(ctx.agentTeams.getTask(root, TeamTaskId(work.taskId)).status))) return false
    return effectivePreset(agent) === 'hivemind-hq' || effectivePreset(agent) === 'hivemind-hyperagents'
  }))
  ctx.effect(() => ctx.on('agent/pre-step', async ({ agent, turn }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || armed.get(agent) === turn) return decision
    const preset = effectivePreset(agent)
    if (preset !== 'hivemind-hq' && preset !== 'hivemind-hyperagents') return decision
    const root = preset === 'hivemind-hq' ? agent : ctx.agentTeams.tryMembership(agent)?.root
    if (!root) return decision
    const mode = hqMode(root.session.snapshotEvents())
    if (!mode.enabled) return decision
    if (!await ctx.sessions.flush(agent.session)) throw new Error('service_recovery_source_persistence_required')
    const ref: Recovery = { sessionId: agent.id, rootId: root.id, turn, modeRevision: mode.revision }
    await ctx.schedule.ensure(agent.id, keyOf(turn), { title: 'Service interruption recovery', after_seconds: 1,
      prompt: MARKER + JSON.stringify(ref) + '\nThe service stopped during your unfinished work. Resume the existing native plan from saved state, private handoff and exact receipts. Reconcile any TOOL_OUTCOME_UNKNOWN before retrying: verify saved/external state for writes, and retry only proven absent or idempotent work. Do not repeat completed work or awakening. Preserve existing schedules and permissions. Explain meaningful progress naturally.' })
    armed.set(agent, turn)
    return decision
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
