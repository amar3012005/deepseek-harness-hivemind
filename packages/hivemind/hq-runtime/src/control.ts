import z from '@deepseek-ai/schemastery'
import { createHash } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-hivemind-execution-scope'
/** Host-side human controls; no model tool can enable HQ autonomy. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { hqMode, type HqModeState } from './mode.ts'
import { taskContracts, type TaskArtifactLinks } from './ledger.ts'
import { calendarItems, validateCalendarItem } from './calendar.ts'
import { TeamTaskId } from '@deepseek-ai/dsh-experimental-agent-team'
import { ScheduleId } from '@deepseek-ai/dsh-schedule'
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
    /** Human-authored planning metadata with compare-and-set revisions; no execution transition. */
    'hivemind/hq-calendar-item': HqCalendarItem
    /** Native Schedule identity for a committed assignment planning revision. */
    'hivemind/hq-calendar-wake': { itemId: string; revision: number; scheduleId: string }
  }
}

/** Effective native preset including selection after a blank session was created. */
function isHq(agent: Agent): boolean {
  let preset = agent.session.header.agentPreset
  for (const event of agent.session.ownEvents())
    if (event.type === 'agent-preset/selected') preset = event.data.agentPreset
  return preset === 'hivemind-hq'
}

/** Deployment interval used only when HQ ends without scheduling its own next wake. */
export interface Config { checkpointSeconds: number }

/** Native Remote service keeps human authority outside model-callable tools. */
export class HqControl extends TypertRemoteService {
  static inject = [
    'agents',
    'agentTeams',
    'sessions',
    'sessionPersistence',
    'hivemindHqOwnership',
    'schedule',
    'sessionController',
    'hivemindExecutionScope',
  ]
  static Config: z<Config> = z.object({ checkpointSeconds: z.natural().min(60).required() })
  private readonly tails = new Map<string, Promise<void>>()

  /**
   * Mount control and enforce the persisted switch at native dispatch boundaries.
   * @param ctx - authorized native session and Team services.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'hivemindHq')
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      const agent = ctx.agents.get(session.id)
      if (agent) return this.ensureCheckpoint(agent, event.data.turn)
    })
    ctx.on('agent/created', ({ agent }) => {
      const event = agent.session.snapshotEvents().findLast(value => value.type === 'turn/end')
      if (event?.type === 'turn/end') return this.ensureCheckpoint(agent, event.data.turn)
    })
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

  /** Retain a durable wake if a finished activation left no future schedule. */
  private async ensureCheckpoint(agent: Agent, turn: number): Promise<void> {
    if (!isHq(agent) || this.ctx.agentTeams.membership(agent).role !== 'lead'
      || !hqMode(agent.session.snapshotEvents()).enabled) return
    const catalog = await this.ctx.schedule.catalog()
    if (catalog.some(wake => wake.sessionId === agent.id && wake.status === 'active')) return
    if (!hqMode(agent.session.snapshotEvents()).enabled) return
    await this.ctx.schedule.ensure(agent.id, `hq-continuity-${turn}`, {
      title: 'HQ continuity checkpoint', after_seconds: this.config.checkpointSeconds,
      prompt: 'Resume your persistent HQ context. Inspect strategy and unreviewed employee outcomes, recall relevant operating memory and decide whether action is warranted. Do not repeat completed work. Persist your strategic intentions and schedule a meaningful next checkpoint within existing authority.',
    })
  }

  /** Initialize or reopen the canonical company Runtime, preserving an explicit pause.
   * @returns the same persistent HQ identity and committed autonomy state.
   */
  @Remote('start')
  async start(): Promise<{ sessionId: SessionId; mode: HqModeState }> {
    const existing = await this.ctx.hivemindHqOwnership.find()
    const principal = this.ctx.hivemindExecutionScope.require()
    const id = existing ?? SessionId(`session-hq-${createHash('sha256').update(principal.orgId).digest('hex')}`)
    if (!existing) await this.ctx.sessionController.create({ sessionId: id, agentPreset: 'hivemind-hq' })
    const result = await this.ctx.sessionController.resolveAgent(id)
    if ('error' in result) throw result.error
    const root = this.root(result.agent)
    if (!(await this.ctx.sessions.flush(root.session))) throw new Error('hq_mode_persistence_required')
    await this.ctx.hivemindHqOwnership.claim(id)
    const mode = this.mode(root)
    // Initialization is authorized by the workspace's human admission. Reloads
    // never override a committed pause or create another startup occurrence.
    if (mode.revision === 0) await this.setMode(root, { enabled: true, expectedRevision: 0 })
    return { sessionId: id, mode: this.mode(root) }
  }

  /** Exact Remote Agent authority cannot control another or an ordinary employee root. */
  private root(agent: Agent): Agent {
    const member = this.ctx.agentTeams.membership(agent)
    if (member.role !== 'lead' || !isHq(member.root))
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
    const events = root.session.snapshotEvents()
    const contracts = taskContracts(events)
    const calendar = calendarItems(events)
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
        const planning = calendar.find(item => item.taskId === task.id)
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
          owner: task.ownerName ?? 'Unassigned',
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
            .map(event =>
              event.type === 'hivemind/hq-task-review' ? event.data.status : undefined,
            )
            .at(-1),
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
        .filter(wake => wake.sessionId === root.id)
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
    const wake = (await this.ctx.schedule.catalog()).find(
      item => item.sessionId === root.id && item.id === id,
    )
    if (!wake) throw new Error('hq_wake_not_authorized')
    const history = await this.ctx.schedule.history({ sessionId: root.id, id: wake.id, limit: 20 })
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
    if (item.kind !== 'assignment') return
    const bindings = root.session
      .snapshotEvents()
      .filter(
        event => event.type === 'hivemind/hq-calendar-wake' && event.data.itemId === item.id,
      )
    const same = bindings.findLast(
      event =>
        event.type === 'hivemind/hq-calendar-wake' && event.data.revision === item.revision,
    )
    if (!same) {
      // A past committed start becomes an immediate wake on repair. ensure's
      // deterministic identity retains the original delivery if already stored.
      const wake = await this.ctx.schedule.ensure(root.id, `hq-plan-${item.id}-${item.revision}`, {
        title: `HQ planned work: ${item.title}`.slice(0, 120),
        at: new Date(Math.max(Date.parse(item.startsAt), Date.now() + 1000)).toISOString(),
        prompt:
          `Review planned native Team task ${item.taskId}, calendar item ${item.id}, revision ${item.revision}. ` +
          'Read the current calendar revision, task status, dependencies, acceptance contract and employee receipts first. ' +
          'If this revision was superseded or the task is already running or terminal, do not dispatch it again. ' +
          'Otherwise assign its authenticated employee within existing authority. Missing employee, contract or authority must be resolved before dispatch. ' +
          'This wake grants no new permissions; completion requires saved deliverable receipts and HQ review.',
      })
      root.session.append('hivemind/hq-calendar-wake', {
        itemId: item.id,
        revision: item.revision,
        scheduleId: wake.id,
      })
      if (!(await this.ctx.sessions.flush(root.session)))
        throw new Error('hq_calendar_wake_persistence_required')
    }
    // Only persisted host-created references may be removed; a matching user
    // title is never treated as ownership. Delivered occurrence history remains.
    const active = new Set(
      (await this.ctx.schedule.catalog())
        .filter(wake => wake.sessionId === root.id && wake.status === 'active')
        .map(wake => String(wake.id)),
    )
    for (const binding of bindings)
      if (
        binding.type === 'hivemind/hq-calendar-wake' &&
        binding.data.revision < item.revision &&
        active.has(binding.data.scheduleId)
      ) {
        await this.ctx.schedule.delete({
          sessionId: root.id,
          id: ScheduleId(binding.data.scheduleId),
        })
      }
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
        // The wake commits first. Until mode commits, the scheduler retains it paused.
        // Replaying an interrupted switch reuses the same native Schedule identity.
        await this.ctx.schedule.ensure(root.id, `hq-enable-${value.revision}`, {
          title: 'HQ startup review',
          after_seconds: 1,
          prompt:
            'You are resuming the persistent company HQ Runtime. Inspect hivemind_hq_continuity for your strategic plan ' +
            'and activity since your last review, including human-directed employee work. Load relevant private operating memory, ' +
            'company context and artifact receipts progressively. Decide what deserves action within standing authority: ' +
            'continue work, coordinate employees, revise strategy, resolve a source request, or ask the owner a necessary decision. ' +
            'Do not require a new user prompt to observe, organize or plan authorized internal work. ' +
            'Missing objectives are a question to resolve, not a reason to discard continuity. ' +
            'Acknowledge reviewed activity, persist strategy, and use native Schedule for your next meaningful checkpoint. ' +
            'Use native Team messages for employee results; do not duplicate assignments or widen authority.',
        })
      }
      root.session.append('hivemind/hq-mode', value)
      if (!value.enabled) {
        // Cancellation is immediate. Pending native inbox and task state survive.
        root.cancel({ kind: 'user' }, { keepInbox: true })
        for (const member of this.ctx.agentTeams.listMembers(root)) {
          if (member.role === 'teammate')
            this.ctx.agents.get(member.id)?.cancel({ kind: 'parent' }, { keepInbox: true })
        }
      }
      if (!(await this.ctx.sessions.flush(root.session)))
        throw new Error('hq_mode_persistence_required')
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
