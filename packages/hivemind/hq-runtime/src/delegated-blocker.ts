/** Durable blockers supplement native tasks; they never grant approval. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { TeamTaskId } from '@deepseek-ai/dsh-experimental-agent-team'
import { authenticatedActorFromSource } from '@deepseek-ai/dsh-hivemind-execution-scope'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DelegatedConnectionRequest, DelegatedConnectionReceipt } from '@deepseek-ai/dsh-hivemind-connected-apps/src/delegated-blocker.ts'
import type {} from '@deepseek-ai/dsh-hivemind-connected-apps'
import { admittedEmployeeWork } from './employee-work-origin.ts'
import { allowsEmployeeWork, authenticatedRoot, rooms, employeeWorkPrompt, referenceFromMessage } from './employee-room.ts'
import { isHqLead } from './rest.ts'

export interface DelegatedBlocker {
  readonly id: string
  readonly kind: 'connection' | 'human_input' | 'permission'
  readonly rootId: string
  readonly taskId: string
  readonly taskRevision: number
  readonly employeeId: string
  readonly employeeSessionId: string
  readonly memberName: string
  readonly checkpointId: string
  readonly callId: string
  readonly state: 'blocked' | 'resumed'
  readonly createdAt: string
  readonly workflowSessionId?: string
  readonly routerSessionId?: string
  readonly toolkits?: readonly string[]
  readonly redirectUrl?: string
  readonly question?: string
  readonly resumeMessageId?: string
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Records a delegated task's durable blocker and its blocked or resumed state.
     * Preserves the employee, task revision, checkpoint, and provider workflow correlation.
     */
    'hivemind/hq-delegated-blocker': DelegatedBlocker
    /** Records the exact cancelled employee turn and task checkpoint.
     * Its legacy connection wait must not be replayed automatically after restart.
     */
    'hivemind/hq-blocker-recovery-hold': { turn: number; callId: string; rootId: string; taskId: string; checkpointId: string }
  }
}

const tails = new WeakMap<Agent, Promise<unknown>>()
function serialized<T>(agent: Agent, work: () => Promise<T>): Promise<T> {
  const next = (tails.get(agent) ?? Promise.resolve()).catch(() => {}).then(work)
  tails.set(agent, next)
  void next.finally(() => { if (tails.get(agent) === next) tails.delete(agent) }).catch(() => {})
  return next
}
export function delegatedBlockers(agent: Agent): DelegatedBlocker[] {
  const saved = new Map<string, DelegatedBlocker>()
  for (const event of agent.session.ownEvents()) if (event.type === 'hivemind/hq-delegated-blocker') saved.set(event.data.id, event.data)
  return [...saved.values()]
}
async function flush(ctx: Context, agent: Agent): Promise<void> {
  if (!await ctx.sessions.flush(agent.session)) throw new Error('hq_blocker_persistence_required')
}

async function record(ctx: Context, employee: Agent, signal: AbortSignal, fields: {
  kind: 'connection' | 'human_input' | 'permission'
  callId: string
  workflowSessionId?: string
  routerSessionId?: string
  toolkits?: readonly string[]
  redirectUrl?: string
  question?: string
}, migrationOrigin?: { rootId: string; taskId: string }): Promise<DelegatedConnectionReceipt | undefined> {
  const origin = migrationOrigin ?? admittedEmployeeWork(employee)
  if (!origin) return undefined
  if (!await allowsEmployeeWork(ctx, employee, origin, signal)) throw new Error('hq_blocker_assignment_not_authorized')
  const root = await authenticatedRoot(ctx, origin.rootId, signal)
  return serialized(root, async () => {
    const assignment = root.session.ownEvents().findLast(e => e.type === 'hivemind/hq-employee-assignment' && e.data.taskId === origin.taskId)
    if (assignment?.type !== 'hivemind/hq-employee-assignment' || assignment.data.sessionId !== employee.id) throw new Error('hq_blocker_assignee_mismatch')
    const task = ctx.agentTeams.getTask(root, TeamTaskId(origin.taskId))
    if (task.ownerName !== assignment.data.memberName) throw new Error('hq_blocker_task_owner_mismatch')
    const id = `hq-blocker-${createHash('sha256').update(JSON.stringify([root.id, origin.taskId, employee.id,
      fields.kind, fields.workflowSessionId ?? fields.callId, [...fields.toolkits ?? []].sort()])).digest('hex')}`
    const prior = delegatedBlockers(root).find(value => value.id === id)
    if (prior?.state === 'resumed') throw new Error('hq_blocker_already_resumed_recheck_workflow')
    const blocker: DelegatedBlocker = prior ?? { id, ...fields, rootId: String(root.id), taskId: origin.taskId,
      taskRevision: task.revision, employeeId: assignment.data.employeeId, employeeSessionId: String(employee.id),
      memberName: assignment.data.memberName, checkpointId: id, state: 'blocked', createdAt: new Date().toISOString() }
    if (!prior) {
      employee.session.append('hivemind/connected-receipt', { version: 1, tool: 'workflow_checkpoint',
        ...(fields.workflowSessionId === undefined ? {} : { workflowSessionId: fields.workflowSessionId }),
        receipt: { status: 'checkpoint_saved', checkpoint_state: 'blocked', checkpoint_id: id,
          checkpoint: JSON.stringify({ blocker_id: id, task_id: origin.taskId, blocked_call_id: fields.callId,
            workflow_session_id: fields.workflowSessionId ?? null, next_step: 'Read existing successful receipts and continue the same task only after Runtime resolves this blocker. Never repeat completed business actions.' }) } })
      await flush(ctx, employee)
      root.session.append('hivemind/hq-delegated-blocker', blocker)
      await flush(ctx, root)
    }
    // Native mailbox key reconciles an interrupted delivery, including after restart.
    const delivery = await rooms(ctx).deliverAgentMessage(employee, { key: id, target: 'runtime', kind: 'question', taskId: origin.taskId,
      text: `HQ_DELEGATED_BLOCKER=${JSON.stringify(blocker)}\nYour delegated task is blocked. Inspect authorized alternatives first. Resolve routine context within existing authority; otherwise save this typed blocker and send one authorized administrator email with message_key ${id}-user-request and request_call_id ${id}. Wait asynchronously; do not open a blocking question merely to send email. Keep other eligible work moving. Email delivery is not approval. Use hivemind_hq_blocker resume only after actual input or verified connection. Do not mark this task complete.` }, signal)
    if (blocker.kind === 'connection') await ctx.schedule.ensure(root.id, `${id}-connection-check`, {
      title: 'Recheck delegated connection blocker', after_seconds: 300,
      prompt: `Review saved blocker ${id} with hivemind_hq_blocker. Recheck actual provider connection using action resume; never treat email or elapsed time as approval. If still disconnected, retain the same checkpoint and remain quiet. This is one bounded check, not a repeating polling loop.`,
    }, signal)
    return { status: 'blocked_reported', blocker_id: id, task_id: origin.taskId, checkpoint_id: id, message_id: delivery.messageId }
  })
}

/** Host-only legacy migration: save a checkpoint before any operator cancellation.
 * This never answers a pending question, grants access, cancels, or invokes a provider.
 * The caller must first capture the exact Remote pending question privately.
 */
export async function checkpointLegacyDelegatedConnection(ctx: Context, employee: Agent, signal: AbortSignal,
  input: { callId: string
    workflowSessionId: string
    routerSessionId: string
    toolkits: readonly string[]
    expectedRootId?: string
    expectedTaskId?: string
    cancelledTurn?: number
    expectedCallSeq?: number
    expectedTaskRevision?: number },
): Promise<DelegatedConnectionReceipt> {
  const events = employee.session.ownEvents()
  const call = events.findLast(event => event.type === 'tool/call' && event.data.callId === input.callId)
  const start = events.findLast(event => event.type === 'turn/start' && call !== undefined && event.seq < call.seq)
  const cancelled = events.findLast(event => event.type === 'turn/end' && start?.type === 'turn/start'
    && event.data.turn === start.data.turn)
  const successful = events.some(event => event.type === 'tool/result' && event.data.message.content.some(block =>
    block.type === 'tool-result' && block.toolCallId === input.callId && !block.isError))
  const cancelledWitness = input.cancelledTurn !== undefined && start?.type === 'turn/start'
    && start.data.turn === input.cancelledTurn && call?.seq === input.expectedCallSeq && cancelled?.type === 'turn/end'
    && cancelled.data.reason.kind === 'aborted' && cancelled.data.reason.reason.kind === 'user'
  if (call?.type !== 'tool/call' || call.data.name !== 'hivemind_connected_task' || start?.type !== 'turn/start' || successful
    || events.some(event => event.type === 'turn/start' && event.seq > start.seq)
    || (cancelled !== undefined && !cancelledWitness) || (input.cancelledTurn !== undefined && !cancelledWitness))
    throw new Error('hq_legacy_pending_call_required')
  let args: unknown = call.data.arguments
  if (typeof args === 'string') args = JSON.parse(args)
  const session = typeof args === 'object' && args !== null ? Reflect.get(args, 'session') : undefined
  if (!session || typeof session !== 'object' || Reflect.get(session, 'id') !== input.workflowSessionId) throw new Error('hq_legacy_workflow_mismatch')
  const router = events.findLast(event => event.type === 'hivemind/composio-session')
  if (router?.type !== 'hivemind/composio-session' || router.data.routerSessionId !== input.routerSessionId) throw new Error('hq_legacy_router_mismatch')
  const refs = events.flatMap((event) => {
    if (event.type !== 'user/message' || event.seq <= start.seq || event.seq >= call.seq
      || !['schedule', 'hivemind-agent-message'].includes(event.data.source.kind)) return []
    const ref = referenceFromMessage(event.data)
    return ref ? [ref] : []
  })
  if (refs.length === 0 || new Set(refs.map(ref => `${ref.rootId}\0${ref.taskId}`)).size !== 1) throw new Error('hq_legacy_assignment_witness_required')
  const ref = refs[0]
  if (!ref) throw new Error('hq_legacy_assignment_witness_required')
  if ((input.expectedRootId !== undefined && ref.rootId !== input.expectedRootId)
    || (input.expectedTaskId !== undefined && ref.taskId !== input.expectedTaskId)) throw new Error('hq_legacy_assignment_mismatch')
  if (!await allowsEmployeeWork(ctx, employee, ref, signal)) throw new Error('hq_blocker_assignment_not_authorized')
  const owner = await authenticatedRoot(ctx, ref.rootId, signal)
  if (input.expectedTaskRevision !== undefined
    && ctx.agentTeams.getTask(owner, TeamTaskId(ref.taskId)).revision !== input.expectedTaskRevision)
    throw new Error('hq_legacy_task_revision_changed')
  const pinned = admittedEmployeeWork(employee)
  if (pinned && (pinned.rootId !== ref.rootId || pinned.taskId !== ref.taskId)) throw new Error('hq_legacy_assignment_mismatch')
  if (!pinned) {
    employee.session.append('hivemind/employee-work-origin', { ...ref, turn: start.data.turn })
    await flush(ctx, employee)
  }
  if (!input.toolkits.length || input.toolkits.length > 8 || input.toolkits.some(t => !/^[a-z0-9_-]{1,80}$/u.test(t)))
    throw new Error('hq_blocker_toolkits_invalid')
  const receipt = await record(ctx, employee, signal, { kind: 'connection', callId: input.callId,
    workflowSessionId: input.workflowSessionId, routerSessionId: input.routerSessionId, toolkits: input.toolkits }, ref)
  if (!receipt) throw new Error('hq_legacy_assignment_witness_required')
  if (!events.some(event => event.type === 'hivemind/hq-blocker-recovery-hold' && event.data.callId === input.callId)) {
    employee.session.append('hivemind/hq-blocker-recovery-hold', { turn: start.data.turn, callId: input.callId,
      rootId: ref.rootId, taskId: ref.taskId, checkpointId: receipt.checkpoint_id })
    await flush(ctx, employee)
  }
  return receipt
}

export function reportDelegatedConnection(
  ctx: Context, input: DelegatedConnectionRequest,
): Promise<DelegatedConnectionReceipt | undefined> {
  if (!input.execution.agent) return Promise.resolve(undefined)
  if (!input.toolkits.length || input.toolkits.length > 8 || input.toolkits.some(t => !/^[a-z0-9_-]{1,80}$/u.test(t))) throw new Error('hq_blocker_toolkits_invalid')
  if (input.redirectUrl !== undefined && new URL(input.redirectUrl).protocol !== 'https:')
    throw new Error('hq_blocker_connection_url_invalid')
  return record(ctx, input.execution.agent, input.execution.signal, { kind: 'connection', callId: String(input.execution.callId),
    workflowSessionId: input.workflowSessionId, routerSessionId: input.routerSessionId, toolkits: input.toolkits,
    ...(input.redirectUrl === undefined ? {} : { redirectUrl: input.redirectUrl }) })
}

/** A fresh provider completion wakes only the assigning Runtime. It is not a grant or task resume. */
export async function notifyDelegatedConnection(
  ctx: Context, root: Agent, id: string, workflow: string, signal: AbortSignal, recheckCanonical?: () => Promise<void>,
) {
  if (!isHqLead(ctx, root)) throw new Error('hq_runtime_blocker_owner_required')
  return serialized(root, async () => {
    const blocker = delegatedBlockers(root).find(value => value.id === id)
    if (!blocker || blocker.rootId !== root.id || blocker.kind !== 'connection' || blocker.workflowSessionId !== workflow)
      throw new Error('hq_blocker_connection_witness_required')
    if (blocker.state !== 'blocked') return { status: 'resolved', blockerId: id, rootId: String(root.id) }
    const employee = await authenticatedRoot(ctx, blocker.employeeSessionId, signal)
    const validate = async () => {
      if (!await allowsEmployeeWork(ctx, employee, { rootId: String(root.id), taskId: blocker.taskId }, signal))
        throw new Error('hq_blocker_assignment_not_authorized')
      const assignment = root.session.ownEvents().findLast(e =>
        e.type === 'hivemind/hq-employee-assignment' && e.data.taskId === blocker.taskId)
      const task = ctx.agentTeams.getTask(root, TeamTaskId(blocker.taskId))
      if (assignment?.type !== 'hivemind/hq-employee-assignment' || assignment.data.sessionId !== blocker.employeeSessionId
        || assignment.data.employeeId !== blocker.employeeId || task.ownerName !== blocker.memberName
        || task.revision !== blocker.taskRevision)
        throw new Error('hq_blocker_assignment_changed')
      await recheckCanonical?.()
    }
    await validate()
    if (!blocker.routerSessionId || !blocker.toolkits?.length) throw new Error('hq_blocker_connection_witness_required')
    const verified = await ctx.serial('hivemind/delegated-connection-verify', { runtime: root, employee,
      workflowSessionId: workflow, routerSessionId: blocker.routerSessionId, toolkits: blocker.toolkits, signal })
    if (verified !== true) return { status: 'waiting', blockerId: id, rootId: String(root.id) }
    await validate()
    const delivery = await rooms(ctx).deliverAgentMessage(employee, { key: `${id}-connection-ready`, target: 'runtime', kind: 'question', taskId: blocker.taskId,
      text: `The account connection for saved blocker ${id} was verified against its original provider workflow. Please recheck this blocker through hivemind_hq_blocker and resume its same unfinished task if still authorized. This notice is not approval for any external action or permission expansion.` }, signal)
    if (!await ctx.sessions.flush(root.session)) throw new Error('hq_blocker_completion_persistence_required')
    return { status: 'accepted', blockerId: id, rootId: String(root.id), messageId: delivery.messageId }
  })
}

export async function resumeDelegatedBlocker(ctx: Context, root: Agent, id: string, signal: AbortSignal, answerCallId?: string,
  context?: { answer: string; evidenceRefs: readonly string[] }, answerEventRef?: string): Promise<Record<string, JsonValue>> {
  if (!isHqLead(ctx, root)) throw new Error('hq_runtime_blocker_owner_required')
  return serialized(root, async () => {
    const blocker = delegatedBlockers(root).find(value => value.id === id)
    if (!blocker || blocker.rootId !== root.id) throw new Error('hq_blocker_not_found')
    if (blocker.state === 'resumed') return { status: 'resumed', blocker_id: id, message_id: blocker.resumeMessageId ?? '', replayed: true }
    const employee = await authenticatedRoot(ctx, blocker.employeeSessionId, signal)
    const validate = async () => {
      if (!await allowsEmployeeWork(ctx, employee, { rootId: String(root.id), taskId: blocker.taskId }, signal)) throw new Error('hq_blocker_assignment_not_authorized')
      const assignment = root.session.ownEvents().findLast(e =>
        e.type === 'hivemind/hq-employee-assignment' && e.data.taskId === blocker.taskId)
      const task = ctx.agentTeams.getTask(root, TeamTaskId(blocker.taskId))
      if (assignment?.type !== 'hivemind/hq-employee-assignment' || assignment.data.sessionId !== blocker.employeeSessionId
        || assignment.data.employeeId !== blocker.employeeId || task.ownerName !== blocker.memberName
        || task.revision !== blocker.taskRevision) throw new Error('hq_blocker_assignment_changed')
    }
    await validate()
    let confirmedAnswer: string | undefined
    if (blocker.kind === 'permission') return { status: 'requires_native_approval', blocker_id: id, resumed: false,
      reason: 'A chat answer or email is not a native permission grant. The original tool approval must be authorized through the native approval service before this checkpoint can resume.' }
    if (blocker.kind === 'connection') {
      if (!blocker.workflowSessionId || !blocker.routerSessionId || !blocker.toolkits?.length) throw new Error('hq_blocker_connection_witness_required')
      const verified = await ctx.serial('hivemind/delegated-connection-verify', { runtime: root, employee,
        workflowSessionId: blocker.workflowSessionId, routerSessionId: blocker.routerSessionId, toolkits: blocker.toolkits, signal })
      if (verified !== true) return { status: 'waiting_for_connection', blocker_id: id, resumed: false }
    } else if (answerEventRef !== undefined) {
      if (!/^event:[1-9][0-9]*$/u.test(answerEventRef)) throw new Error('hq_blocker_actual_human_answer_required')
      const record = root.session.ownEvents().findLast(e => e.type === 'hivemind/hq-delegated-blocker' && e.data.id === id)
      const answer = root.session.ownEvents().find(e => Number(e.seq) === Number(answerEventRef.slice(6)))
      if (!record || answer?.type !== 'user/message' || answer.seq <= record.seq || answer.data.source.kind !== 'user'
        || !authenticatedActorFromSource(answer.data.source)) throw new Error('hq_blocker_actual_human_answer_required')
      confirmedAnswer = answer.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').slice(0, 6000)
      if (!confirmedAnswer.trim()) throw new Error('hq_blocker_actual_human_answer_required')
    } else if (context !== undefined) {
      if (!context.answer.trim() || context.answer.length > 6000 || !context.evidenceRefs.length || context.evidenceRefs.length > 8) throw new Error('hq_blocker_context_evidence_required')
      for (const ref of context.evidenceRefs) {
        if (!/^event:[1-9][0-9]*$/u.test(ref)) throw new Error('hq_blocker_context_evidence_required')
        const event = root.session.ownEvents().find(e => Number(e.seq) === Number(ref.slice(6)))
        const human = event?.type === 'user/message' && event.data.source.kind === 'user'
        const receipt = event?.type === 'tool/result' && event.data.message.content.some(block => block.type === 'tool-result' && !block.isError)
        if (!human && !receipt) throw new Error('hq_blocker_context_evidence_required')
      }
      confirmedAnswer = `Runtime supplied context within existing authority, from ${context.evidenceRefs.join(', ')}: ${context.answer}`
    } else {
      const call = root.session.ownEvents().findLast(e => e.type === 'tool/call' && e.data.callId === answerCallId && e.data.name === 'ask_user_question')
      const answered = root.session.ownEvents().findLast(e => e.type === 'user/message' && e.data.source.kind === 'user'
        && Reflect.get(e.data.source, 'questionCallId') === answerCallId && Reflect.get(e.data.source, 'questionAnswer') === true
        && authenticatedActorFromSource(e.data.source) !== undefined)
      const settled = root.session.ownEvents().some(e => e.type === 'tool/result' && e.data.message.content.some(block =>
        block.type === 'tool-result' && block.toolCallId === answerCallId && !block.isError))
      let args: unknown = call?.type === 'tool/call' ? call.data.arguments : undefined
      if (typeof args === 'string') { try { args = JSON.parse(args) } catch { args = undefined } }
      const questions = typeof args === 'object' && args !== null ? Reflect.get(args, 'questions') as unknown : undefined
      if (call?.type !== 'tool/call' || answered?.type !== 'user/message' || answered.seq <= call.seq || !settled
        || !Array.isArray(questions) || !questions.some(question => typeof question === 'object' && question !== null && Reflect.get(question, 'id') === id)) throw new Error('hq_blocker_actual_human_answer_required')
      confirmedAnswer = answered.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').slice(0, 6000)
    }
    await validate() // Authority may change while provider verification was pending.
    // read_checkpoint must reflect the verified handoff before employee admission.
    // The message key owns execution deduplication; this receipt never grants a tool permission.
    const readyCheckpoint = employee.session.ownEvents().some(event => event.type === 'hivemind/connected-receipt'
      && event.data.tool === 'workflow_checkpoint' && typeof event.data.receipt === 'object' && event.data.receipt !== null
      && !Array.isArray(event.data.receipt) && event.data.receipt['checkpoint_id'] === blocker.checkpointId
      && event.data.receipt['checkpoint_state'] === 'ready')
    if (!readyCheckpoint) {
      employee.session.append('hivemind/connected-receipt', { version: 1, tool: 'workflow_checkpoint',
        ...(blocker.workflowSessionId === undefined ? {} : { workflowSessionId: blocker.workflowSessionId }),
        receipt: { status: 'checkpoint_saved', checkpoint_state: 'ready', checkpoint_id: blocker.checkpointId,
          checkpoint: JSON.stringify({ blocker_id: id, task_id: blocker.taskId, blocked_call_id: blocker.callId,
            workflow_session_id: blocker.workflowSessionId ?? null,
            next_step: 'Runtime verified this blocker. Continue only the unfinished step from existing receipts. Native permission checks remain enforced; never repeat completed business actions.' }) } })
      await flush(ctx, employee)
    }
    const delivered = await rooms(ctx).deliverAgentMessage(root, { key: `${id}-resume`, target: blocker.employeeId, kind: 'question', taskId: blocker.taskId,
      text: `${employeeWorkPrompt(ctx, root, blocker.taskId)}\nRuntime resolved blocker ${id}. Read checkpoint ${blocker.checkpointId} and existing provider receipts first; resume only its unfinished step. Original workflow: ${blocker.workflowSessionId ?? 'not-applicable'}. Do not repeat completed business actions or broaden authority.${confirmedAnswer === undefined ? '' : `\nAuthenticated human answer for this blocker (does not grant unrelated authority): ${JSON.stringify(confirmedAnswer)}`}` }, signal)
    root.session.append('hivemind/hq-delegated-blocker', { ...blocker, state: 'resumed', resumeMessageId: delivered.messageId })
    await flush(ctx, root)
    return { status: 'resumed', blocker_id: id, task_id: blocker.taskId, employee_id: blocker.employeeId, message_id: delivered.messageId }
  })
}

export function installDelegatedBlockerReporting(ctx: Context): void {
  ctx.effect(() => ctx.on('hivemind/delegated-connection-blocker', input => reportDelegatedConnection(ctx, input), { global: true }))
  ctx.effect(() => ctx.on('tools/pre-execute', async (execution, next) => {
    const decision = await next()
    if (!execution.agent || !admittedEmployeeWork(execution.agent)
      || !(decision.kind === 'ask' || (decision.kind === 'allow' && execution.name === 'ask_user_question'))) return decision
    const receipt = await record(ctx, execution.agent, execution.signal, { kind: decision.kind === 'ask' ? 'permission' : 'human_input', callId: String(execution.callId),
      question: JSON.stringify({ tool: execution.name, arguments: execution.arguments,
        ...(decision.kind === 'ask' ? { reason: decision.reason ?? 'Native permission approval required' } : {}) }).slice(0, 6000) })
    if (!receipt) return decision
    return { kind: 'deny', reason: `The Runtime-delegated task is paused at checkpoint ${receipt.checkpoint_id}; blocker ${receipt.blocker_id} was reported to Runtime. Do not ask the human here or repeat this question. Continue other authorized work and report this task as blocked, never complete.` }
  }, { global: true }))
}

export function installDelegatedBlockerTool(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'hivemind_hq_blocker',
    description: 'Runtime only: inspect typed employee blockers or resume the SAME native task/employee after provider-authoritative connection verification or an actual correlated human answer. Inspect authorized alternatives before requesting a new connector. For necessary input use the saved blocker_id as the administrator email request_call_id and <blocker_id>-user-request as its stable message_key, once. Wait asynchronously; do not hold a turn merely waiting for the user. Resume human_input from an authenticated saved user answer event, or a correlated native question answer if the user is already present. Email is not approval. Preserve checkpoint and existing receipts; never resend completed actions. This tool cannot grant new permissions.',
    parameters: { action: { type: 'string', required: true, enum: ['list', 'resume'] }, blocker_id: { type: 'string' },
      answer_event_ref: { type: 'string', description: 'For human_input only: exact event:<sequence> of an actual authenticated human answer saved in Runtime after this blocker. Never invent an event or treat this as a permission grant.' },
      answer_call_id: { type: 'string', description: 'For human_input only: exact Runtime ask_user_question call with an actual authenticated answer. Use blocker_id as that question item id.' },
      context_answer: { type: 'string', description: 'For routine human_input only: answer already established within existing authority, not a new approval or permission. Native external-action approval remains enforced.' },
      evidence_refs: { type: 'array', items: { type: 'string' }, description: 'For context_answer: exact event:<sequence> references to saved Runtime human messages or successful tool receipts. Never invent references.' } },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => false,
    async execute(args, execution) {
      if (!execution.agent || !isHqLead(ctx, execution.agent)) throw new Error('hq_runtime_blocker_owner_required')
      if (args.action === 'list') return { blockers: delegatedBlockers(execution.agent).map(blocker => ({ ...blocker,
        request_call_id: blocker.id, message_key: `${blocker.id}-user-request`,
        notification_kind: blocker.kind === 'human_input' ? 'decision' : 'approval' })) as unknown as JsonValue }
      if (typeof args.blocker_id !== 'string') throw new Error('hq_blocker_id_required')
      return resumeDelegatedBlocker(ctx, execution.agent, args.blocker_id, execution.signal,
        typeof args.answer_call_id === 'string' ? args.answer_call_id : undefined,
        typeof args.context_answer === 'string' ? { answer: args.context_answer, evidenceRefs: args.evidence_refs ?? [] } : undefined,
        typeof args.answer_event_ref === 'string' ? args.answer_event_ref : undefined)
    },
  })))
}
