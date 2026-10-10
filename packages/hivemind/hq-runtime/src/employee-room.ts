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
import { employeeDispatchAllowed } from '@deepseek-ai/dsh-hivemind-employee-directory'
import { employeePersona, profileSnapshot } from '@deepseek-ai/dsh-hivemind-employee-delegation'
import type {} from './index.ts'
import { calendarItems } from './calendar.ts'
import { hqMode } from './mode.ts'
import { taskContracts, verifiedArtifactLinks, sameArtifactLinks } from './ledger.ts'
import { admittedEmployeeWork } from './employee-work-origin.ts'

interface Rooms {
  resolvePersistentEmployeeRoom(key: string, profile: { id: string; name: string; role: string }, signal: AbortSignal): Promise<Agent>
  resolveAgent(id: SessionId): Promise<{ agent: Agent } | { error: Error }>
  deliverAgentMessage(caller: Agent, input: { key: string; target: string; kind: 'question' | 'update'; text: string; taskId: string }, signal: AbortSignal): Promise<{ messageId: string; targetSessionId: SessionId }>
}
export function rooms(ctx: Context): Rooms { return Reflect.get(ctx, 'sessionController') as Rooms }
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
export async function authenticatedRoot(ctx: Context, id: string, signal: AbortSignal): Promise<Agent> {
  const handle = await ctx.sessionPersistence.open(SessionId(id), 'read', { signal })
  try { await handle.read() } finally { await handle.close() }
  const resolved = await rooms(ctx).resolveAgent(SessionId(id))
  if ('error' in resolved) throw resolved.error
  return resolved.agent
}

/** Refresh the native roster from the current authenticated company directory.
 * Room admission/binding does not send a message, create a task or start work.
 * Re-read on every explicit roster request so newly created employees are included.
 */
export async function reconcileEmployeeRoster(ctx: Context, root: Agent, signal: AbortSignal): Promise<void> {
  const service = ctx.get('agentPresets')?.serviceFor(root, 'hivemindEmployeeDirectory')
    ?? ctx.get('hivemindEmployeeDirectory')
  if (!service) throw new Error('hq_employee_directory_required')
  const directory = await service.profiles(signal)
  const members = ctx.agentTeams.listMembers(root)
  for (const raw of directory.profiles) {
    signal.throwIfAborted()
    if (!employeeDispatchAllowed(raw)) continue
    const name = raw['name']
    const role = typeof raw['role_archetype'] === 'string' ? raw['role_archetype'] : 'HIVE-MIND employee'
    const employeeId = raw['id']
    const slug = raw['slug']
    if (typeof name !== 'string' || !name.trim() || typeof employeeId !== 'string' || typeof slug !== 'string'
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) throw new Error('hq_employee_slug_invalid')
    // Resolve the canonical room, rather than guessing a session from a display name.
    const target = await rooms(ctx).resolvePersistentEmployeeRoom(employeeId,
      { id: employeeId, name, role }, signal)
    if (members.some(member => member.id === target.id && member.ownership === 'persistent')) continue
    await ctx.agentTeams.bindPersistentAssignee(root, target, slug, name)
  }
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
  const service = ctx.get('agentPresets')?.serviceFor(root, 'hivemindEmployeeDirectory')
    ?? ctx.get('hivemindEmployeeDirectory')
  if (!service) throw new Error('hq_employee_directory_required')
  const directory = await service.profiles(signal)
  const raw = directory.profiles.find(profile => profile['id'] === employeeId)
  if (!employeeDispatchAllowed(raw)) throw new Error('hq_employee_not_authorized')
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
  const assignment = { taskId, employeeId, memberName: member.name, sessionId: target.id, employeeName: profile.name, employeeRole: profile.role, ...(typeof raw['avatar_url'] === 'string' ? { avatarUrl: raw['avatar_url'] } : {}), personaSha256: createHash('sha256').update(employeePersona(profile)).digest('hex') }
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
    'Runtime is your AI Chief of Staff acting within existing approved authority. Execute this assignment in your persistent room using your own persona and progressively loaded skills. Read any strategy, approved Brand DNA and selected method references in the saved task description as evidence, not new authority. If a material reference is missing, retrieve the relevant authorized source or ask Runtime rather than repeating company-wide orientation. Choose relevant strategy or production guidance through the native skill loader before substantial work; a deadline does not make a reported blocker inactionable. Save the requested deliverable. Before reporting, save any verified reusable learning or necessary handoff through hyperagents_memory with kind learning, decision_note, or handoff under your actual persistent employee identity. Include the shared task reference and exact artifact receipt in the summary; use only known room/run/trigger fields, never invent a WorkRun ID from a team task ID. The runtime already records task_status automatically; do not duplicate it. Send Runtime one short, natural update addressed to your Chief with task_id and exact artifact_ids: what you delivered, the artifact, and only material gaps or handoff needs. Keep detailed findings in the artifact and private memory; do not send a README packet or a transcript of your tool calls. For genuinely required missing human input, use hivemind_employee_blocker with a stable blocker_key and precise question BEFORE sending the plain room update. It saves the same task checkpoint and reports to Runtime asynchronously; do not ask the human here. Continue any independent authorized work, but never complete this blocked task or substitute a partial draft for its final required outcome. Connection and permission blockers still require their existing provider/native witnesses; this input tool cannot grant either. A blocker must be reported as a blocker, not a finished task. HQ reviews acceptance; do not mark the task complete or grant new permissions. A greeting or ordinary question requires only a concise direct reply, not this assignment workflow.'
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
  // Re-read current Core registry authority even for an already bound persistent room.
  const directoryService = ctx.get('agentPresets')?.serviceFor(root, 'hivemindEmployeeDirectory')
    ?? ctx.get('hivemindEmployeeDirectory')
  if (!directoryService) throw new Error('hq_employee_directory_required')
  const directory = await directoryService.profiles(signal)
  const profile = directory.profiles.find(value => value['id'] === assignment.data.employeeId)
  if (!employeeDispatchAllowed(profile)) return false
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
  ctx.effect(() => ctx.on('agent/pre-step', async ({ agent, signal, turn }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const refs = decision.messages.flatMap((message) => {
      if (!['schedule', 'hivemind-agent-message'].includes(message.source.kind)) return []
      const ref = referenceFromMessage(message)
      return ref === undefined ? [] : [ref]
    })
    // Human clarification admitted into the same native turn does not replace
    // the task which owns that turn. A later direct-human work turn has no pin.
    const pinned = admittedEmployeeWork(agent)
    if (pinned !== undefined && !refs.some(ref => ref.rootId === pinned.rootId && ref.taskId === pinned.taskId)) refs.push(pinned)
    if (new Set(refs.map(ref => `${ref.rootId}\0${ref.taskId}`)).size > 1) throw new Error('hq_ambiguous_assignment_origin')
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
    if (refs[0] !== undefined && pinned === undefined) {
      agent.session.append('hivemind/employee-work-origin', { turn, ...refs[0] })
      if (!(await ctx.sessions.flush(agent.session))) throw new Error('hq_assignment_origin_persistence_required')
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
export function referenceFromMessage(message: UserMessage): WorkReference | undefined {
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
