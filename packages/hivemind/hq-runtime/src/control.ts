/** Host-side human controls; no model tool can enable HQ autonomy. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createBrowserTimeZoneConfirmation } from '@deepseek-ai/dsh-time-context'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { installServiceRecovery } from './service-recovery.ts'
import { installEmployeeSnapshots, publishEmployeeSnapshot } from './employee-snapshot.ts'
import { restState as loadRestState, leaveRestNote as saveRestNote } from './rest.ts'
import type { HqRestState, HqRestNoteRequest, HqRestNoteResult } from './types.ts'
import { hqMode, type HqModeState } from './mode.ts'
import { taskContracts, type TaskArtifactLinks } from './ledger.ts'
import { taskDeadlineScheduleId, projectCalendarTaskStatus } from './task-schedule-lifecycle.ts'
import { calendarItems, validateCalendarItem } from './calendar.ts'
import { TeamTaskId } from '@deepseek-ai/dsh-experimental-agent-team'
import { ScheduleId } from '@deepseek-ai/dsh-schedule'
import { SessionId } from '@deepseek-ai/dsh-session'
import { prepareEmployee, employeeWorkPrompt, reconcileEmployeeArtifacts, installEmployeeDelivery, currentEmployeeWork, resumeEmployeeWork } from './employee-room.ts'
import type {
  HqCalendarItem,
  HqCalendarUpdate,
  HqCalendarUpdateResult,
  HqWorkspace,
  HqWakeHistory,
  HqTaskProgress,
} from './types.ts'
import type { HqModeUpdate, HqModeUpdateResult } from './types.ts'
import type {} from './ownership.ts'
import type {} from '@deepseek-ai/dsh-tool-todo/types'
export type { HqModeUpdate, HqModeUpdateResult } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    hivemindHq: HqControl
  }
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Human-only HQ autonomy switch, checkpointed before acknowledging the control. */
    'hivemind/hq-mode': HqModeState
    /** Human-selected public investigation excludes stored company context for this room. */
    'hivemind/hq-public-investigation': { enabled: boolean }
    /** Human-authored planning metadata with compare-and-set revisions; no execution transition. */
    'hivemind/hq-calendar-item': HqCalendarItem
    /** Native Schedule identity for a committed assignment planning revision. */
    'hivemind/hq-calendar-wake': { itemId: string; revision: number; scheduleId: string; sessionId?: string }
  }
}

/** Effective native preset including selection after a blank session was created. */
function isHq(agent: Agent): boolean {
  let preset = agent.session.header.agentPreset
  for (const event of agent.session.ownEvents())
    if (event.type === 'agent-preset/selected') preset = event.data.agentPreset
  return preset === 'hivemind-hq'
}

/** Native Remote service keeps human authority outside model-callable tools. */
export class HqControl extends TypertRemoteService {
  static inject = [
    'agents',
    'agentTeams',
    'agentPresets',
    'sessions',
    'sessionPersistence',
    'hivemindHqOwnership',
    'schedule',
    'sessionController',
  ]
  private readonly tails = new Map<string, Promise<void>>()
  private readonly repairs = new Set<Promise<void>>()

  /**
   * Mount control and enforce the persisted switch at native dispatch boundaries.
   * @param ctx - authorized native session and Team services.
   */
  constructor(ctx: Context) {
    super(ctx, 'hivemindHq')
    installEmployeeDelivery(ctx)
    installEmployeeSnapshots(ctx)
    installServiceRecovery(ctx)
    ctx.effect(() => ctx.on('agent/session-start', ({ agent }) => {
      if (!isHq(agent)) return
      // Cold restoration can occur inside Schedule's serialized dispatch. Its
      // observer must return before a repair can request another Schedule write.
      const repair = this.reconcilePlans(agent).catch((error: unknown) => {
        ctx.logger.warn(`HQ employee plans require reconciliation: ${error instanceof Error ? error.message : String(error)}`)
      })
      this.repairs.add(repair)
      void repair.finally(() => this.repairs.delete(repair))
    }, { global: true }))
    ctx.effect(() => async () => { await Promise.allSettled([...this.repairs]) })
    ctx.effect(() =>
      ctx.agentTeams.guardDispatch((caller) => {
        const member = ctx.agentTeams.tryMembership(caller)
        if (!member || !isHq(member.root)) return
        return hqMode(member.root.session.snapshotEvents()).enabled
          ? undefined
          : 'HQ autonomous activity is paused by the human.'
      }),
    )
  }

  /** Human-only fresh start, scoped by the authenticated storage principal. */
  @Remote('startFresh')
  async startFresh(agent: Agent, request: { confirmed: boolean }): Promise<{ sessions: number; memories: number }> {
    if (request.confirmed !== true) throw new Error('fresh_reset_confirmation_required')
    const root=this.root(agent)
    const ids=await this.ctx.hivemindHqOwnership.freshTargets(root.id)
    const paused=await this.setMode(root,{ enabled:false,expectedRevision:this.mode(root).revision })
    if (!paused.ok) throw new Error('fresh_reset_mode_changed')
    for (const item of await this.ctx.schedule.catalog()) {
      if (ids.includes(item.sessionId)) await this.ctx.schedule.delete({ sessionId:item.sessionId,id:item.id })
    }
    await this.ctx.sessionController.releaseOwnedSessions(ids)
    const result=await this.ctx.hivemindHqOwnership.resetFresh(root.id,ids)
    const created=await this.ctx.sessionController.create({ hyperagentRoom:'runtime' })
    const fresh=await this.ctx.sessionController.resolveAgent(created.sessionId)
    if ('error' in fresh) throw fresh.error
    fresh.agent.session.append('hivemind/hq-public-investigation',{ enabled:false })
    if (!await this.ctx.sessions.flush(fresh.agent.session)) throw new Error('fresh_reset_room_not_persisted')
    await this.ctx.hivemindHqOwnership.claim(fresh.agent.id)
    return result
  }

  /** Human-only investigation scope; does not clear tasks, change autonomy, or start a turn. */
  @Remote('publicInvestigation')
  async publicInvestigation(agent: Agent, request: { enabled: boolean }): Promise<{ enabled: boolean }> {
    if (typeof request.enabled !== 'boolean') throw new Error('invalid_public_investigation_scope')
    const root = this.root(agent)
    return root.runMaintenance(async () => {
      root.session.append('hivemind/hq-public-investigation', { enabled: request.enabled })
      if (!await this.ctx.sessions.flush(root.session)) throw new Error('investigation_scope_not_persisted')
      return { enabled: request.enabled }
    })
  }

  /** Human inspection of checkpointed rest intent and quiet notes; never wakes. */
  @Remote('restState')
  async restState(agent: Agent): Promise<HqRestState> {
    return loadRestState(this.ctx, this.root(agent))
  }

  /** Human-only authorized quiet note; native persistence, no Agent inbox insertion. */
  @Remote('leaveRestNote')
  async leaveRestNote(agent: Agent, request: HqRestNoteRequest): Promise<HqRestNoteResult> {
    return saveRestNote(this.ctx, this.root(agent), request)
  }

  /** Exact Remote Agent authority cannot control another or an ordinary employee root. */
  private root(agent: Agent): Agent {
    const member = this.ctx.agentTeams.membership(agent)
    if (member.role !== 'lead' || member.root !== agent || !isHq(member.root))
      throw new Error('hq_human_control_requires_hq_root')
    return member.root
  }

  /**
   * Read the switch from a native authenticated HQ root.
   * @param agent - exact authorized Agent selected by the native Remote resolver.
   * @returns replayed switch, defaulting to paused.
   */
  @Remote('mode')
  mode(agent: Agent): HqModeState {
    return hqMode(this.root(agent).session.snapshotEvents())
  }

  /** Read native work within the exact authenticated HQ root. Delivery is not completion. */
  @Remote('workspace')
  async workspace(agent: Agent): Promise<HqWorkspace> {
    const root = this.root(agent)
    await reconcileEmployeeArtifacts(this.ctx, root, new AbortController().signal)
    const events = root.session.snapshotEvents()
    const contracts = taskContracts(events)
    const statuses = new Map<string, string>()
    for (const event of events) if (event.type === 'team/task') statuses.set(event.data.task.id, event.data.task.status)
    const calendar = projectCalendarTaskStatus(calendarItems(events), statuses)
    const employeeNames = new Map(events.flatMap(event =>
      event.type === 'hivemind/hq-awakening-checkpoint'
        ? event.data.cards.filter(card => card.employeeId !== undefined)
          .map(card => [card.employeeId, card.title] as const) : []))
    const members = this.ctx.agentTeams.listMembers(root)
    const catalog = await this.ctx.schedule.catalog()
    return {
      mode: this.mode(root),
      calendar,
      tasks: this.ctx.agentTeams.listTasks(root).map((task) => {
        const contract = contracts.find(item => item.taskId === task.id)
        const links = events.findLast(
          event =>
            event.type === 'hivemind/hq-task-artifacts' &&
            (event.data as TaskArtifactLinks).taskId === task.id,
        )?.data as TaskArtifactLinks | undefined
        const planning = calendar.find(item => item.kind === 'assignment' && item.taskId === task.id)
        const binding =
          planning &&
          events.findLast(
            event =>
              event.type === 'hivemind/hq-calendar-wake' &&
              event.data.itemId === planning.id &&
              event.data.revision === planning.revision,
          )
        return {
          id: task.id,
          revision: task.revision,
          title: task.subject,
          objective: task.description,
          status: task.status,
          owner: task.ownerName ?? employeeNames.get(planning?.owner) ?? planning?.owner ?? 'Unassigned',
          sessionId: members.find(member => member.name === task.ownerName)?.id,
          dependencies: [...task.blockedBy],
          authority: [...task.writeScopes],
          dueAt: contract?.dueAt,
          acceptanceCriteria: [...(contract?.acceptanceCriteria ?? [])],
          artifactIds: [...(links?.artifactIds ?? [])],
          startedAt: events
            .filter(
              event =>
                event.type === 'team/task' &&
                event.data.task.id === task.id &&
                event.data.task.status === 'in_progress',
            )
            .map(event => new Date(event.time).toISOString())[0],
          reviewStatus: events
            .filter(
              event =>
                event.type === 'hivemind/hq-task-review' &&
                event.data.taskId === task.id &&
                (event.data.taskRevision === task.revision ||
                  (task.status === 'completed' && event.data.taskRevision === task.revision - 1)),
            )
            .toReversed()
            // Runtime decisions govern status; optional advisory opinions remain secondary.
            .toSorted((a, b) => Number(b.type === 'hivemind/hq-task-review' && b.data.reviewer === 'runtime')
              - Number(a.type === 'hivemind/hq-task-review' && a.data.reviewer === 'runtime'))
            .map(event => event.type === 'hivemind/hq-task-review' ? event.data.status : undefined)
            .at(0),
          completedAt: events
            .filter(
              event =>
                event.type === 'team/task' &&
                event.data.task.id === task.id &&
                event.data.task.status === 'completed',
            )
            .map(event => new Date(event.time).toISOString())
            .at(-1),
          nextWakeAt:
            binding?.type === 'hivemind/hq-calendar-wake'
              ? catalog.find(
                wake => wake.id === binding.data.scheduleId && wake.status === 'active',
              )?.scheduledAt
              : undefined,
        }
      }),
      wakes: catalog
        .filter(wake => wake.sessionId === root.id || events.some(event => event.type === 'hivemind/hq-calendar-wake' && event.data.scheduleId === wake.id))
        .map(wake => ({
          id: wake.id,
          title: wake.title,
          kind: wake.kind,
          scheduledAt: wake.scheduledAt,
          status: wake.status,
          deliveredAt: wake.lastDelivery?.deliveredAt,
          messageId: wake.lastDelivery?.messageId,
          taskId: (() => {
            const binding = events.findLast(
              event =>
                event.type === 'hivemind/hq-calendar-wake' && event.data.scheduleId === wake.id,
            )
            return binding?.type === 'hivemind/hq-calendar-wake'
              ? calendar.find(item => item.id === binding.data.itemId)?.taskId
              : undefined
          })(),
        })),
    }
  }

  /** Read only the selected rostered producer, retaining native plan semantics. */
  @Remote('taskProgress')
  async taskProgress(agent: Agent, taskId: string): Promise<HqTaskProgress> {
    const root = this.root(agent)
    const task = this.ctx.agentTeams.getTask(root, TeamTaskId(taskId))
    const producer = this.ctx.agentTeams
      .listMembers(root)
      .find(member => member.name === task.ownerName)
    if (!producer) return { taskId, sessionId: null, todos: [] }
    const live = this.ctx.agents.get(producer.id)
    const handle = live ? undefined : await this.ctx.sessionPersistence.open(producer.id, 'read')
    try {
      const events = live?.session.snapshotEvents() ?? (await handle?.read())?.events
      if (!events) throw new Error('hq_employee_plan_unavailable')
      let todos: HqTaskProgress['todos'] = []
      for (const event of events) {
        if (event.type === 'turn/start') todos = []
        if (event.type === 'todo/write')
          todos = event.data.todos.map(item => ({ content: item.content, status: item.status }))
      }
      return { taskId, sessionId: producer.id, todos }
    } finally {
      await handle?.close()
    }
  }

  /** Retained recurring occurrences from native Schedule; no fabricated future instances. */
  @Remote('wakeHistory')
  async wakeHistory(agent: Agent, id: string): Promise<HqWakeHistory> {
    const root = this.root(agent)
    const binding = root.session.ownEvents().findLast(event => event.type === 'hivemind/hq-calendar-wake' && event.data.scheduleId === id)
    const targetId = binding?.type === 'hivemind/hq-calendar-wake' && binding.data.sessionId !== undefined ? SessionId(binding.data.sessionId) : root.id
    const wake = (await this.ctx.schedule.catalog()).find(item => item.sessionId === targetId && item.id === id)
    if (!wake) throw new Error('hq_wake_not_authorized')
    const history = await this.ctx.schedule.history({ sessionId: targetId, id: wake.id, limit: 20 })
    if (!('records' in history)) throw new Error('hq_wake_history_unavailable')
    return {
      id,
      records: history.records.map(record => ({
        scheduledAt: record.scheduledAt,
        deliveredAt: record.deliveredAt,
        messageId: record.messageId,
      })),
      earlierRecordsUnavailable: history.earlierRecordsUnavailable,
    }
  }

  /** Human compare-and-set planning command. It never mutates execution or grants authority. */
  @Remote('plan')
  async plan(agent: Agent, request: HqCalendarUpdate): Promise<HqCalendarUpdateResult> {
    const root = this.root(agent)
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0)
      throw new Error('hq_invalid_calendar_revision')
    const item = validateCalendarItem(request.item)
    if (item.revision !== request.expectedRevision + 1)
      throw new Error('hq_invalid_calendar_revision')
    const prior = this.tails.get(root.id) ?? Promise.resolve()
    const result = prior.then(async (): Promise<HqCalendarUpdateResult> => {
      const current =
        calendarItems(root.session.snapshotEvents()).find(value => value.id === item.id) ?? null
      // A lost acknowledgement or interrupted Schedule write repairs this same
      // committed planning revision, rather than inventing another assignment.
      if (
        current &&
        current.revision === item.revision &&
        JSON.stringify(current) === JSON.stringify(item)
      ) {
        await this.syncAssignmentWake(root, current)
        return { ok: true, value: current }
      }
      if ((current?.revision ?? 0) !== request.expectedRevision)
        return { ok: false, code: 'hq-calendar-conflict', current }
      if (current && (current.kind !== item.kind || current.taskId !== item.taskId))
        throw new Error('hq_calendar_identity_immutable')
      if (item.taskId) {
        const task = this.ctx.agentTeams.getTask(root, TeamTaskId(item.taskId))
        if (task.status !== 'pending') throw new Error('hq_calendar_running_or_terminal_task')
      }
      root.session.append('hivemind/hq-calendar-item', item)
      if (!(await this.ctx.sessions.flush(root.session)))
        throw new Error('hq_calendar_persistence_required')
      await this.syncAssignmentWake(root, item)
      return { ok: true, value: item }
    })
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.tails.set(root.id, tail)
    try {
      return await result
    } finally {
      if (this.tails.get(root.id) === tail) this.tails.delete(root.id)
    }
  }

  /** Reconcile committed planning with native Schedule; its backend owns delivery. */
  private async syncAssignmentWake(root: Agent, item: HqCalendarItem): Promise<void> {
    if (item.kind !== 'assignment' || item.taskId === undefined) return
    const task = this.ctx.agentTeams.getTask(root, TeamTaskId(item.taskId))
    if (task.status !== 'pending') return
    const assignment = await prepareEmployee(this.ctx, root, task.id, item.owner, new AbortController().signal)
    const bindings = root.session
      .snapshotEvents()
      .filter(
        event => event.type === 'hivemind/hq-calendar-wake' && event.data.itemId === item.id,
      )
    const same = bindings.findLast(
      event =>
        event.type === 'hivemind/hq-calendar-wake' && event.data.revision === item.revision && event.data.sessionId === assignment.sessionId,
    )
    if (!same) {
      // A past committed start becomes an immediate wake on repair. ensure's
      // deterministic identity retains the original delivery if already stored.
      const wake = await this.ctx.schedule.ensure(SessionId(assignment.sessionId), `hq-room-plan-${item.id}-${item.revision}`, {
        title: `HQ planned work: ${item.title}`.slice(0, 120),
        at: new Date(Math.max(Date.parse(item.startsAt), Date.now() + 1000)).toISOString(),
        prompt: employeeWorkPrompt(this.ctx, root, task.id, item),
      })
      root.session.append('hivemind/hq-calendar-wake', {
        itemId: item.id,
        revision: item.revision,
        scheduleId: wake.id,
        sessionId: assignment.sessionId,
      })
      if (!(await this.ctx.sessions.flush(root.session)))
        throw new Error('hq_calendar_wake_persistence_required')
    }
    // Publish before acknowledging scheduling, under the caller's authenticated scope.
    await publishEmployeeSnapshot(this.ctx, root, task.id)
    const rooms = Reflect.get(this.ctx, 'sessionController') as { deliverAgentMessage: (caller: Agent, input: { key: string; target: string; kind: 'update'; text: string; taskId: string }, signal: AbortSignal) => Promise<unknown> }
    await rooms.deliverAgentMessage(root, { key: `hq-plan-notice-${item.id}-${item.revision}`, target: item.owner, kind: 'update', taskId: task.id,
      text: `Runtime assigned ${item.title}. Start ${item.startsAt}; deadline ${taskContracts(root.session.snapshotEvents()).find(value => value.taskId === task.id)?.dueAt}. This saved future assignment will trigger your room at its start after dependencies are accepted. Acknowledge only if a human asks; this quiet notice grants no new authority.` }, new AbortController().signal)
    // Only persisted host-created references may be removed; a matching user
    // title is never treated as ownership. Delivered occurrence history remains.
    const active = new Set(
      (await this.ctx.schedule.catalog())
        .filter(wake => wake.status === 'active')
        .map(wake => String(wake.id)),
    )
    for (const binding of bindings)
      if (
        binding.type === 'hivemind/hq-calendar-wake' &&
        (binding.data.revision < item.revision || binding.data.sessionId !== assignment.sessionId) &&
        active.has(binding.data.scheduleId)
      ) {
        await this.ctx.schedule.delete({
          sessionId: binding.data.sessionId === undefined ? root.id : SessionId(binding.data.sessionId),
          id: ScheduleId(binding.data.scheduleId),
        })
      }
  }

  /** Repair pending planning wakes into employee rooms without model activity.
   * @param agent - Exact live Runtime root.
   */
  async reconcilePlans(agent: Agent): Promise<void> {
    const root = this.root(agent)
    for (const item of calendarItems(root.session.snapshotEvents())) await this.syncAssignmentWake(root, item)
  }

  /** Cancel pending scheduled work through native Team state before removing its wake. */
  @Remote('cancelScheduledTask')
  async cancelScheduledTask(agent: Agent, request: { taskId: string; expectedRevision: number }): Promise<{ cancelled: boolean }> {
    const root = this.root(agent)
    const task = this.ctx.agentTeams.getTask(root, TeamTaskId(request.taskId))
    if (!['pending', 'deleted'].includes(task.status)) throw new Error('hq_only_pending_work_can_be_cancelled')
    if (task.status === 'pending' && task.revision !== request.expectedRevision) throw new Error('hq_cancel_task_revision_changed')
    const board = this.ctx.agentTeams.listTasks(root)
    const cancelled = new Set<string>([task.id])
    const graph = new Map(board.map(item => [item.id, { id: item.id, blockedBy: item.blockedBy }]))
    for (const event of root.session.snapshotEvents()) {
      if (event.type === 'team/task') graph.set(event.data.task.id, event.data.task)
    }
    for (let pass = 0; pass < graph.size; pass++) {
      const size = cancelled.size
      for (const item of graph.values()) if (item.blockedBy.some(id => cancelled.has(id))) cancelled.add(item.id)
      if (cancelled.size === size) break
    }
    const targets = board.filter(item => cancelled.has(item.id))
    if (targets.some(item => item.status !== 'pending')) throw new Error('hq_cancel_requires_pending_dependents')
    // Native Team requires a prerequisite to outlive its dependents. Remove
    // pending leaves first; a crash leaves only safe pending prerequisites.
    while (targets.length) {
      const index = targets.findIndex(item => !targets.some(other => other.blockedBy.includes(item.id)))
      if (index < 0) throw new Error('hq_cancel_dependency_cycle')
      const item = targets[index]
      if (!item) throw new Error('hq_cancel_dependency_cycle')
      await this.ctx.agentTeams.updateTask(root, { taskId: item.id, expectedRevision: item.revision, action: 'delete' })
      targets.splice(index, 1)
    }
    const events = root.session.snapshotEvents()
    const itemIds = new Set(calendarItems(events)
      .filter(item => item.taskId !== undefined && cancelled.has(item.taskId)).map(item => item.id))
    const catalog = await this.ctx.schedule.catalog()
    const active = new Set(catalog.filter(item => item.status === 'active').map(item => String(item.id)))
    for (const taskId of cancelled) {
      const id = taskDeadlineScheduleId(root.id, taskId)
      if (catalog.some(item => String(item.id) === id && item.sessionId === root.id && item.status === 'active')) {
        await this.ctx.schedule.delete({ sessionId: root.id, id: ScheduleId(id) })
      }
    }
    for (const event of events) {
      if (event.type !== 'hivemind/hq-calendar-wake' || !itemIds.has(event.data.itemId) || !active.has(event.data.scheduleId)) continue
      await this.ctx.schedule.delete({
        sessionId: event.data.sessionId === undefined ? root.id : SessionId(event.data.sessionId),
        id: ScheduleId(event.data.scheduleId),
      })
    }
    return { cancelled: true }
  }

  /**
   * Enable or pause HQ through the human Remote boundary, never a model tool.
   * @param agent - exact authorized HQ root.
   * @param request - observed revision and intended mode.
   * @returns committed state or a concurrent-edit conflict.
   */
  @Remote('setMode')
  async setMode(agent: Agent, request: HqModeUpdate): Promise<HqModeUpdateResult> {
    const root = this.root(agent)
    if (
      typeof request.enabled !== 'boolean' ||
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 0
    )
      throw new Error('hq_invalid_mode_update')
    const zoneContext = request.clientTimeZone === undefined ? undefined : createBrowserTimeZoneConfirmation(request.clientTimeZone)
    const prior = this.tails.get(root.id) ?? Promise.resolve()
    const result = prior.then(async (): Promise<HqModeUpdateResult> => {
      const current = this.mode(root)
      if (current.revision !== request.expectedRevision)
        return { ok: false, code: 'hq-mode-conflict', current }
      if (current.enabled === request.enabled) return { ok: true, value: current }
      if (request.enabled) {
        if (!(await this.ctx.sessions.flush(root.session)))
          throw new Error('hq_mode_persistence_required')
        await this.ctx.hivemindHqOwnership.claim(root.id)
      }
      const value: HqModeState = {
        revision: current.revision + 1,
        enabled: request.enabled,
        changedAt: Date.now(),
      }
      if (value.enabled) {
        if (zoneContext) {
          root.inject(zoneContext)
          if (!await this.ctx.sessions.flush(root.session)) throw new Error('hq_mode_persistence_required')
        }
        // The wake commits first. Until mode commits, the scheduler retains it paused.
        // Replaying an interrupted switch reuses the same native Schedule identity.
        await this.ctx.schedule.ensure(root.id, `hq-enable-${value.revision}`, {
          title: 'HQ startup review',
          after_seconds: 1,
          prompt:
            'The human enabled HQ autonomous mode. Review approved company objectives, the native Team task board, ' +
            'pending employee requests and committed receipts. Continue only authorized unfinished work; ' +
            'do not duplicate assignments or widen authority. If nothing is due or no approved objective exists, remain quiet; do not request work as a greeting. ' +
            'Use native Schedule for a justified next wake and native Team waiting for active employees.',
        })
      }
      root.session.append('hivemind/hq-mode', value)
      if (!value.enabled) {
        // Cancellation is immediate. Pending native inbox and task state survive.
        root.cancel({ kind: 'user' }, { keepInbox: true })
        for (const member of this.ctx.agentTeams.listMembers(root)) {
          if (member.role !== 'teammate') continue
          const target = this.ctx.agents.get(member.id)
          if (member.ownership === 'persistent' && target && currentEmployeeWork(target)?.rootId !== root.id) continue
          target?.cancel({ kind: 'parent' }, { keepInbox: true })
        }
      }
      if (!(await this.ctx.sessions.flush(root.session)))
        throw new Error('hq_mode_persistence_required')
      if (value.enabled) await resumeEmployeeWork(this.ctx, root, value.revision)
      return { ok: true, value }
    })
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.tails.set(root.id, tail)
    try {
      return await result
    } finally {
      if (this.tails.get(root.id) === tail) this.tails.delete(root.id)
    }
  }
}
export default HqControl
