/** Derived employee-only view of authoritative native work; owns no lifecycle. */
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { calendarItems } from './calendar.ts'
import { taskContracts } from './ledger.ts'
import { runtimeReviewAccepts } from './review.ts'
import type { EmployeeTaskSnapshot } from './types.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Employee-scoped display receipt; native root task/review remains authoritative. */
    'hivemind/employee-task-snapshot': EmployeeTaskSnapshot
  }
}

/** Project one authorized assignment from native source events.
 * @param events - Root-owned durable native records.
 * @param taskId - Exact selected task identity.
 * @param rootSessionId - Owning Runtime identity.
 * @returns Employee-only view, or undefined when no matching assignment exists.
 */
export function employeeTaskSnapshot(
  events: readonly SessionEvent[], taskId: string, rootSessionId: string,
): EmployeeTaskSnapshot | undefined {
  const binding = events.findLast(e => e.type === 'hivemind/hq-employee-assignment' && e.data.taskId === taskId)
  const taskEvent = events.findLast(e => e.type === 'team/task' && e.data.task.id === taskId)
  if (binding?.type !== 'hivemind/hq-employee-assignment' || taskEvent?.type !== 'team/task') return
  const task = taskEvent.data.task
  if (task.ownerId !== undefined && task.ownerId !== binding.data.sessionId) return
  const calendar = calendarItems(events).find(e => e.taskId === taskId) ?? null
  const contract = taskContracts(events).find(e => e.taskId === taskId)
  const links = events.findLast(e => e.type === 'hivemind/hq-task-artifacts' && e.data.taskId === taskId)
  const review = events.findLast(e => e.type === 'hivemind/hq-task-review' && e.data.taskId === taskId && e.data.reviewer === 'runtime')
  const accepted = review?.type === 'hivemind/hq-task-review' && links?.type === 'hivemind/hq-task-artifacts'
    && runtimeReviewAccepts(review.data, task.status === 'completed' ? task.revision - 1 : task.revision, links.data.artifactIds)
  return { rootSessionId, employeeId: binding.data.employeeId,
    employeeName: binding.data.employeeName ?? binding.data.memberName,
    ...(binding.data.employeeRole === undefined ? {} : { employeeRole: binding.data.employeeRole }),
    ...(binding.data.avatarUrl === undefined ? {} : { avatarUrl: binding.data.avatarUrl }),
    sourceSequence: events.at(-1)?.seq ?? 0,
    calendar: calendar === null ? null : { ...calendar, resolved: ['completed', 'deleted'].includes(task.status) },
    task: { id: task.id, revision: task.revision, title: task.subject, objective: task.description,
      status: task.status === 'completed' && !accepted ? 'in_progress' : task.status,
      owner: binding.data.memberName, sessionId: binding.data.sessionId, dependencies: [...task.blockedBy],
      authority: [...task.writeScopes], dueAt: contract?.dueAt, acceptanceCriteria: [...(contract?.acceptanceCriteria ?? [])],
      artifactIds: links?.type === 'hivemind/hq-task-artifacts' ? [...links.data.artifactIds] : [],
      reviewStatus: review?.type === 'hivemind/hq-task-review' ? review.data.status : undefined,
      ...(task.status === 'completed' && accepted ? { completedAt: new Date(taskEvent.time).toISOString() } : {}) } }
}

/** Publish changed derived views through native session lifecycle observers.
 * @param ctx - Authorized host session, agent and persistence services.
 */
export function installEmployeeSnapshots(ctx: Context): void {
  const tails = new Map<string, Promise<void>>()
  const pending = new Map<string, { root: Agent; taskId: string; targetId: string }>()
  const enqueue = (root: Agent, taskId: string): void => {
    const key = `${root.id}:${taskId}`
    let targetId: string | undefined
    const run = (tails.get(key) ?? Promise.resolve()).then(async () => {
      if (!await ctx.sessions.flush(root.session)) throw new Error('hq_employee_snapshot_source_persistence_required')
      const snapshot = employeeTaskSnapshot(root.session.snapshotEvents(), taskId, root.id)
      if (!snapshot?.task.sessionId) return
      // Native authenticated persistence proves this exact room remains readable.
      const handle = await ctx.sessionPersistence.open(SessionId(snapshot.task.sessionId), 'read')
      try { await handle.read() } finally { await handle.close() }
      const resolved = await ctx.sessionController.resolveAgent(SessionId(snapshot.task.sessionId))
      if ('error' in resolved) throw resolved.error
      const target: Agent = resolved.agent
      targetId = target.id
      if (target.status === 'running') {
        if (pending.size >= 128 && !pending.has(key)) throw new Error('hq_employee_snapshot_pending_capacity')
        pending.set(key, { root, taskId, targetId })
        return
      }
      // Remove before maintenance emits idle, so our own publication cannot retry itself.
      pending.delete(key)
      await target.runMaintenance(async () => {
        const previous = target.session.ownEvents().findLast(e => e.type === 'hivemind/employee-task-snapshot' && e.data.rootSessionId === root.id && e.data.task.id === taskId)
        if (previous?.type === 'hivemind/employee-task-snapshot') {
          if (previous.data.sourceSequence >= snapshot.sourceSequence) return
          if (isDeepStrictEqual({ ...previous.data, sourceSequence: 0 }, { ...snapshot, sourceSequence: 0 })) return
        }
        target.session.append('hivemind/employee-task-snapshot', snapshot)
        if (!await ctx.sessions.flush(target.session)) throw new Error('hq_employee_snapshot_persistence_required')
      })
    }).catch((error: unknown) => {
      if (targetId !== undefined && (pending.size < 128 || pending.has(key))) pending.set(key, { root, taskId, targetId })
      ctx.logger.warn(`Employee task snapshot pending: ${error instanceof Error ? error.message : String(error)}`)
    })
    tails.set(key, run)
    void run.finally(() => { if (tails.get(key) === run) tails.delete(key) })
  }
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    if (!['team/task', 'hivemind/hq-calendar-item', 'hivemind/hq-task-review', 'hivemind/hq-task-artifacts', 'hivemind/hq-employee-assignment'].includes(event.type)) return
    const root = ctx.agents.get(session.id)
    if (!root || root.session.header.agentPreset !== 'hivemind-hq') return
    const data = event.data as { taskId?: string; task?: { id: string } }
    const taskId = data.taskId ?? data.task?.id
    if (taskId) enqueue(root, taskId)
  }, { global: true }))
  ctx.effect(() => ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    for (const [key, item] of pending) {
      if (item.targetId !== agent.id) continue
      pending.delete(key)
      enqueue(item.root, item.taskId)
    }
  }, { global: true }))
  // Cold restoration repairs a missed display publication from authoritative state.
  ctx.effect(() => ctx.on('agent/session-start', ({ agent }) => {
    if (agent.session.header.agentPreset !== 'hivemind-hq') return
    const tasks = new Set(agent.session.ownEvents().flatMap(event => event.type === 'hivemind/hq-employee-assignment' ? [event.data.taskId] : []))
    for (const taskId of tasks) enqueue(agent, taskId)
  }, { global: true }))
}
