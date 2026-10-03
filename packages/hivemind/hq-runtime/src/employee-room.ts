/** Persistent employee delivery composes native task ownership, room admission, and Schedule. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TeamTaskId } from '@deepseek-ai/dsh-experimental-agent-team'
import { ScheduleId } from '@deepseek-ai/dsh-schedule'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { employeePersona, profileSnapshot } from '@deepseek-ai/dsh-hivemind-employee-delegation'
import type {} from './index.ts'
import { calendarItems } from './calendar.ts'
import { hqMode } from './mode.ts'
import { taskContracts, verifiedArtifactLinks, sameArtifactLinks } from './ledger.ts'

interface Rooms {
  resolvePersistentEmployeeRoom(key: string, profile: { id: string; name: string; role: string }, signal: AbortSignal): Promise<Agent>
  resolveAgent(id: SessionId): Promise<{ agent: Agent } | { error: Error }>
  deliverAgentMessage(caller: Agent, input: { key: string; target: string; kind: 'question' | 'update'; text: string; taskId: string }, signal: AbortSignal): Promise<{ messageId: string; targetSessionId: SessionId }>
}
function rooms(ctx: Context): Rooms { return Reflect.get(ctx, 'sessionController') as Rooms }
interface WorkReference { rootId: string; taskId: string; itemId?: string; revision?: number }
const marker = 'HQ_EMPLOYEE_ASSIGNMENT='

/** Read a host-framed work reference.
 * @param text - Native Schedule framing or trusted room payload.
 * @returns Saved root and task identity, or undefined for ordinary conversation.
 */
export function workReference(text: string): WorkReference | undefined {
  const framed = text.split('\n').find(value => value.startsWith('reminder_prompt_json: '))
  if (framed !== undefined) {
    const prompt: unknown = JSON.parse(framed.slice('reminder_prompt_json: '.length))
    if (typeof prompt !== 'string') throw new Error('hq_assignment_reference_invalid')
    text = prompt
  }
  const line = text.split('\n').find(value => value.startsWith(marker))
  if (!line) return undefined
  const value: unknown = JSON.parse(line.slice(marker.length))
  if (typeof value !== 'object' || value === null) throw new Error('hq_assignment_reference_invalid')
  const ref = value as Partial<WorkReference>
  if (typeof ref.rootId !== 'string' || typeof ref.taskId !== 'string' || (ref.itemId !== undefined && typeof ref.itemId !== 'string') || (ref.revision !== undefined && !Number.isSafeInteger(ref.revision))) throw new Error('hq_assignment_reference_invalid')
  return ref as WorkReference
}
async function authenticatedRoot(ctx: Context, id: string, signal: AbortSignal): Promise<Agent> {
  const handle = await ctx.sessionPersistence.open(SessionId(id), 'read', { signal })
  try { await handle.read() } finally { await handle.close() }
  const resolved = await rooms(ctx).resolveAgent(SessionId(id))
  if ('error' in resolved) throw resolved.error
  return resolved.agent
}

/** Freeze the authenticated employee room as native task assignee.
 * @param ctx - Native task, persistence and room services.
 * @param root - Exact live Runtime root.
 * @param taskId - Native task identity.
 * @param employeeId - Authenticated directory employee identity.
 * @param signal - Cancellation before admission.
 * @returns Durable employee and room binding.
 */
export async function prepareEmployee(ctx: Context, root: Agent, taskId: string, employeeId: string, signal: AbortSignal,
): Promise<{ employeeId: string; memberName: string; sessionId: string; personaSha256: string }> {
  const service = root.ctx.get('hivemindEmployeeDirectory')
  if (!service) throw new Error('hq_employee_directory_required')
  const directory = await service.profiles(signal)
  const raw = directory.profiles.find(profile => profile['id'] === employeeId)
  if (!raw) throw new Error('hq_employee_not_authorized')
  const profile = profileSnapshot(raw)
  const slug = raw['slug']
  if (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) throw new Error('hq_employee_slug_invalid')
  const target = await rooms(ctx).resolvePersistentEmployeeRoom(employeeId, { id: employeeId, name: profile.name, role: profile.role },
    signal)
  const prior = root.session.ownEvents().findLast(event => event.type === 'hivemind/hq-employee-assignment' && event.data.taskId === taskId)
  if (prior?.type === 'hivemind/hq-employee-assignment') {
    if (prior.data.employeeId !== employeeId || prior.data.sessionId !== target.id) throw new Error('hq_existing_assignment_requires_reconciliation')
    return prior.data
  }
  const member = await ctx.agentTeams.bindPersistentAssignee(root, target, slug, profile.name)
  const assignment = { taskId, employeeId, memberName: member.name, sessionId: target.id, personaSha256: createHash('sha256').update(employeePersona(profile)).digest('hex') }
  root.session.append('hivemind/hq-employee-assignment', assignment)
  if (!(await ctx.sessions.flush(root.session))) throw new Error('hq_assignment_persistence_required')
  return assignment
}

/** Frame the saved assignment and acceptance requirements for native delivery.
 * @param ctx - Native task service.
 * @param root - Exact Runtime root holding requirements.
 * @param taskId - Native task identity.
 * @param planning - Saved calendar identity and revision for future work.
 * @returns Employee execution prompt.
 */
export function employeeWorkPrompt(ctx: Context, root: Agent, taskId: string, planning?: { id: string; revision: number }): string {
  const task = ctx.agentTeams.getTask(root, TeamTaskId(taskId))
  const contract = taskContracts(root.session.snapshotEvents()).find(value => value.taskId === taskId)
  if (!contract) throw new Error('hq_contract_required')
  return `${marker}${JSON.stringify({ rootId: root.id, taskId, ...(planning ? { itemId: planning.id, revision: planning.revision } : {}) })}\n` +
    JSON.stringify({ objective: task.description, expectedOutcome: task.subject, acceptanceCriteria: contract.acceptanceCriteria, authority: task.writeScopes, dueAt: contract.dueAt }) + '\n' +
    'Runtime is your AI Chief of Staff acting within existing approved authority. Execute this assignment in your persistent room using your own persona and progressively loaded skills. Save the requested deliverable and send its exact artifact receipt to runtime as a quiet update with task_id. HQ reviews acceptance; do not mark the task complete or grant new permissions. A greeting or ordinary question requires only a concise direct reply, not this assignment workflow.'
}

/** Validate native state before employee inbox insertion.
 * @param ctx - Native task, room and persistence services.
 * @param target - Exact employee room Agent.
 * @param ref - Host-framed saved work identity.
 * @param signal - Cancellation during scoped reads.
 * @returns Whether the saved work is currently authorized and due.
 */
export async function allowsEmployeeWork(ctx: Context, target: Agent, ref: WorkReference, signal: AbortSignal): Promise<boolean> {
  const root = await authenticatedRoot(ctx, ref.rootId, signal)
  const events = root.session.snapshotEvents()
  const assignment = events.findLast(event => event.type === 'hivemind/hq-employee-assignment' && event.data.taskId === ref.taskId)
  if (assignment?.type !== 'hivemind/hq-employee-assignment' || assignment.data.sessionId !== target.id) {
    throw new Error('hq_assignment_target_not_authorized')
  }
  if (!ctx.agentTeams.listMembers(root).some(member => member.id === target.id && member.ownership === 'persistent')) {
    throw new Error('hq_persistent_assignee_required')
  }
  const task = ctx.agentTeams.getTask(root, TeamTaskId(ref.taskId))
  if (!hqMode(events).enabled || (task.status === 'pending' && !task.ready) || ['completed', 'deleted'].includes(task.status)) return false
  const currentPlan = calendarItems(events).find(item => item.taskId === ref.taskId)
  if (currentPlan && (currentPlan.owner !== assignment.data.employeeId || Date.parse(currentPlan.startsAt) > Date.now())) return false
  if (ref.itemId !== undefined) {
    const planning = calendarItems(events).find(item => item.id === ref.itemId)
    if (!planning || planning.taskId !== ref.taskId || planning.revision !== ref.revision
      || planning.owner !== assignment.data.employeeId || Date.parse(planning.startsAt) > Date.now()) return false
  }
  return true
}

/** Deliver immediate work through the durable room mailbox.
 * @param ctx - Native room, task and persistence services.
 * @param root - Exact live Runtime root.
 * @param taskId - Native task identity.
 * @param employeeId - Authenticated employee identity.
 * @param signal - Cancellation before admission.
 * @param resumeRevision - Human mode revision for an explicit resume.
 * @returns Native task ownership and room delivery receipt.
 */
export async function dispatchEmployee(ctx: Context, root: Agent, taskId: string, employeeId: string, signal: AbortSignal,
  resumeRevision?: number,
): Promise<Record<string, JsonValue>> {
  const assignment = await prepareEmployee(ctx, root, taskId, employeeId, signal)
  const target = ctx.agents.get(SessionId(assignment.sessionId))
  if (!target || !(await allowsEmployeeWork(ctx, target, { rootId: root.id, taskId }, signal))) throw new Error('hq_assignment_not_ready')
  const task = ctx.agentTeams.getTask(root, TeamTaskId(taskId))
  if (task.status === 'pending') await ctx.agentTeams.updateTask(root, {
    taskId: task.id, expectedRevision: task.revision, action: 'reassign', owner: assignment.memberName })
  const receipt = await rooms(ctx).deliverAgentMessage(root, { key: `hq-task-${taskId}${resumeRevision === undefined ? '' : `-resume-${resumeRevision}`}`, target: employeeId, kind: 'question', taskId, text: employeeWorkPrompt(ctx, root, taskId) + (resumeRevision === undefined ? '' : '\nThe human resumed HQ. Read your existing progress and saved receipts first; continue unfinished work without repeating completed research or artifacts.') }, signal)
  const itemIds = new Set(calendarItems(root.session.snapshotEvents()).filter(item => item.taskId === taskId).map(item => item.id))
  const bindings = root.session.ownEvents().filter(event => event.type === 'hivemind/hq-calendar-wake' && itemIds.has(event.data.itemId))
  if (bindings.length > 0) {
    const active = new Set((await ctx.schedule.catalog()).filter(wake => wake.status === 'active').map(wake => String(wake.id)))
    for (const binding of bindings) {
      if (binding.type !== 'hivemind/hq-calendar-wake' || !active.has(binding.data.scheduleId)) continue
      await ctx.schedule.delete({
        sessionId: binding.data.sessionId === undefined ? root.id : SessionId(binding.data.sessionId),
        id: ScheduleId(binding.data.scheduleId),
      })
    }
  }
  return {
    task_id: taskId, employee_id: employeeId,
    member: { name: assignment.memberName, session_id: assignment.sessionId, status: target.status },
    message_id: receipt.messageId,
  }
}

/** Resume halted persistent assignments lacking a saved deliverable.
 * @param ctx - Native room, task and persistence services.
 * @param root - Human-authorized Runtime root.
 * @param revision - Committed human resume revision.
 */
export async function resumeEmployeeWork(ctx: Context, root: Agent, revision: number): Promise<void> {
  const signal = new AbortController().signal
  await reconcileEmployeeArtifacts(ctx, root, signal)
  for (const task of ctx.agentTeams.listTasks(root)) {
    if (!['pending', 'in_progress'].includes(task.status) || root.session.ownEvents().some(event => event.type === 'hivemind/hq-task-artifacts' && event.data.taskId === task.id)) continue
    const assignment = root.session.ownEvents().findLast(event => event.type === 'hivemind/hq-employee-assignment' && event.data.taskId === task.id)
    if (assignment?.type !== 'hivemind/hq-employee-assignment') continue
    const member = ctx.agentTeams.listMembers(root).find(value => value.id === assignment.data.sessionId)
    if (member?.ownership !== 'persistent' || member.status === 'running') continue
    const target = await rooms(ctx).resolvePersistentEmployeeRoom(assignment.data.employeeId, { id: assignment.data.employeeId, name: member.description ?? member.name, role: 'Employee' }, signal)
    if (!(await allowsEmployeeWork(ctx, target, { rootId: root.id, taskId: task.id }, signal))) continue
    await dispatchEmployee(ctx, root, task.id, assignment.data.employeeId, signal, revision)
  }
}

/** Import verified producer receipts from quiet room notices.
 * @param ctx - Native task and persistence services.
 * @param root - Exact Runtime receipt owner.
 * @param signal - Cancellation during producer reads.
 */
export async function reconcileEmployeeArtifacts(ctx: Context, root: Agent, signal: AbortSignal): Promise<void> {
  for (const event of root.session.ownEvents()) {
    if (event.type !== 'hivemind/room-message-received' || event.data.kind !== 'update' || !event.data.taskId || !event.data.artifactIds.length) continue
    const assignment = root.session.ownEvents().findLast(value => value.type === 'hivemind/hq-employee-assignment' && value.data.taskId === event.data.taskId)
    if (assignment?.type !== 'hivemind/hq-employee-assignment' || assignment.data.sessionId !== event.data.senderId) continue
    const task = ctx.agentTeams.getTask(root, TeamTaskId(event.data.taskId))
    if (task.status === 'completed' || task.status === 'deleted') continue
    const handle = await ctx.sessionPersistence.open(event.data.senderId, 'read', { signal })
    try {
      const source = (await handle.read()).events
      const prior = root.session.ownEvents().findLast(value => value.type === 'hivemind/hq-task-artifacts' && value.data.taskId === event.data.taskId)
      const ids = [...new Set([...(prior?.type === 'hivemind/hq-task-artifacts' ? prior.data.artifactIds : []), ...event.data.artifactIds])]
      const links = verifiedArtifactLinks(source, event.data.taskId, ids, event.data.senderId)
      if (prior?.type !== 'hivemind/hq-task-artifacts' || !sameArtifactLinks(prior.data, links)) {
        root.session.append('hivemind/hq-task-artifacts', links)
        if (!(await ctx.sessions.flush(root.session))) throw new Error('hq_artifact_link_persistence_required')
      }
    } finally { await handle.close() }
  }
}

/** Install host delivery and execution policies for trusted assignment inputs.
 * @param ctx - Global native control service context.
 */
export function installEmployeeDelivery(ctx: Context): void {
  ctx.effect(() => ctx.schedule.guardDelivery(async (target, task) => {
    const ref = workReference(task.record.prompt)
    if (ref === undefined) return true
    const signal = new AbortController().signal
    if (!(await allowsEmployeeWork(ctx, target, ref, signal))) return false
    const root = await authenticatedRoot(ctx, ref.rootId, signal)
    if (ctx.agentTeams.getTask(root, TeamTaskId(ref.taskId)).status !== 'in_progress') return true
    const key = createHash('sha256').update(`${task.record.id}:${task.record.scheduledAt}`).digest('hex')
    return target.session.ownEvents().some(event => event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.source.kind === 'schedule' && message.source.deliveryKey === key))
  }))
  ctx.effect(() => ctx.on('session/event', (_session, event) => {
    if (event.type === 'team/task' || event.type === 'hivemind/hq-mode') ctx.schedule.reconsiderDelivery()
  }, { global: true }))
  ctx.effect(() => ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const refs = decision.messages.flatMap((message) => {
      if (!['schedule', 'hivemind-agent-message'].includes(message.source.kind)) return []
      const ref = referenceFromMessage(message)
      return ref === undefined ? [] : [ref]
    })
    if (refs.length === 0 && !decision.messages.some(message => message.source.kind !== 'plugin')) {
      const current = currentEmployeeWork(agent)
      if (current !== undefined) refs.push(current)
    }
    for (const ref of refs) {
      if (!(await allowsEmployeeWork(ctx, agent, ref, signal))) return { kind: 'reject' }
      const root = await authenticatedRoot(ctx, ref.rootId, signal)
      const task = ctx.agentTeams.getTask(root, TeamTaskId(ref.taskId))
      const assignment = root.session.ownEvents().findLast(event => event.type === 'hivemind/hq-employee-assignment' && event.data.taskId === ref.taskId)
      if (task.status === 'pending' && assignment?.type === 'hivemind/hq-employee-assignment') await ctx.agentTeams.updateTask(root, { taskId: task.id, expectedRevision: task.revision, action: 'reassign', owner: assignment.data.memberName })
    }
    return decision
  }, { prepend: true }))
}
/** Read the current admitted task input, excluding quiet notices and plugin context.
 * @param agent - Exact employee room Agent.
 * @returns Current host-framed assignment, or undefined for ordinary work.
 */
export function currentEmployeeWork(agent: Agent): WorkReference | undefined {
  const event = agent.session.ownEvents().findLast(value => value.type === 'user/message' && value.data.source.kind !== 'plugin' && !('form' in value.data.source && value.data.source.form === 'notice'))
  if (event?.type !== 'user/message' || !['schedule', 'hivemind-agent-message'].includes(event.data.source.kind)) return undefined
  return referenceFromMessage(event.data)
}
function referenceFromMessage(message: UserMessage): WorkReference | undefined {
  for (const block of message.content) {
    if (block.type !== 'text') continue
    if (message.source.kind === 'schedule') return workReference(block.text)
    const envelope: unknown = JSON.parse(block.text)
    if (typeof envelope === 'object' && envelope !== null && 'text' in envelope && typeof envelope.text === 'string') {
      const ref = workReference(envelope.text)
      if (ref !== undefined && message.source.kind === 'hivemind-agent-message' && message.source.senderId !== ref.rootId) throw new Error('hq_assignment_sender_not_authorized')
      return ref
    }
  }
  return undefined
}
