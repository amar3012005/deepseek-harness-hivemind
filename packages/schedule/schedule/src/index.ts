/** Host-wide durable reminders and shared human/model management. */
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { ScheduleBackend, ScheduleTaskTable } from './backend.ts'
export type { ScheduleBackend, ScheduleTaskTable } from './backend.ts'
import z from '@deepseek-ai/schemastery'
import { Context, Service } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionActivity } from '@deepseek-ai/dsh-workspace'
import { ScheduleRuntime } from './runtime.ts'
import { registerScheduleTools } from './tools.ts'
import { scheduleDomain } from './storage.ts'
import { deliveryHistoryPage } from './delivery-history.ts'
import { resolveScheduleUpdate } from './update.ts'
import {
  foldScheduleEvents, ScheduleInputError, ScheduleLogError, ScheduleId, createAfterScheduleRecord, createAtScheduleRecord,
  createEveryScheduleRecord, createDailyScheduleRecord, createWeeklyScheduleRecord, createCronScheduleRecord,
  scheduleTitle,
} from './domain.ts'
import type {
  DeliveryRetentionBounds, ScheduleCatalogEntry, ScheduleCreateRequest, ScheduleDeleteRequest, ScheduleDeleteResult,
  ScheduleDeliveryHistoryRequest, ScheduleDeliveryHistoryResult, ScheduleListRequest, ScheduleRecord,
  ScheduleUpdateRequest, ScheduleUpdateResult,
} from './types.ts'

export type * from './types.ts'
export { registerScheduleTools } from './tools.ts'
export { scheduleDomain, scheduleTaskSchema } from './storage.ts'
export type { ScheduleTask } from './storage.ts'
export type { RecurringOccurrence } from './domain.ts'
export {
  SCHEDULE_CHANGE_VERSION,
  MIN_EVERY_INTERVAL_SECONDS,
  MAX_TITLE_LENGTH,
  ScheduleId,
  ScheduleInputError,
  ScheduleLogError,
  canonicalizeCronExpression,
  createAfterScheduleRecord,
  createAtScheduleRecord,
  createEveryScheduleRecord,
  createDailyScheduleRecord,
  createWeeklyScheduleRecord,
  createCronScheduleRecord,
  decodeScheduleChange,
  decodeScheduleRecord,
  foldScheduleEvents,
  isRecurringScheduleRecord,
  normalizeWeekdays,
  parseAtInput,
  parseCronInput,
  parseWeeklyInput,
  renderReminderFraming,
  renderRecurringReminderBatchFraming,
  resolveEveryOccurrence,
  resolveDailyOccurrence,
  resolveWeeklyOccurrence,
  resolveCronOccurrence,
  resolveRecurringOccurrence,
  scheduleTitle,
  scheduleView,
  weeklyTime,
} from './domain.ts'


declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable Host-wide reminder management. */
    schedule: ScheduleService
    scheduleBackend: ScheduleBackend
  }
}

/** Configuration for the Host Schedule domain. */
export interface Config {
  /**
   * Delivery-history window retained per task, in days; omission defaults to 30.
   * Pruning happens when an acknowledgment is appended, and `lastDelivery` is always retained.
   */
  storage?: 'domain' | 'external'
  deliveryHistoryDays?: number
  /**
   * Retained delivery records per task; omission defaults to 200. The older of this
   * cap and the window wins, and the newest records survive.
   */
  deliveryHistoryRecords?: number
}

/** Retained delivery-history window applied when the deployment states none. */
const DEFAULT_DELIVERY_HISTORY_DAYS = 30

/** Retained delivery-history record cap applied when the deployment states none. */
const DEFAULT_DELIVERY_HISTORY_RECORDS = 200

/**
 * Shared management service; reads, deletion, and timing edits never activate a Session.
 *
 * `sessionPersistence` is a load-order requirement rather than a directly called
 * service: a delivery commits only when `ctx.sessions.flush()` reports that a
 * `session/flush` listener participated, and the persistence backend providing this
 * service is the plugin that registers that listener.
 */
export class ScheduleService extends TypertRemoteService {
  static inject = ['agents', 'sessions', 'tools', 'storageDomain', 'sessionController', 'sessionPersistence']

  static Config: z<Config> = z.object({
    storage: z.union(['domain', 'external']).default('domain'),
    deliveryHistoryDays: z.number().step(1).min(1).max(3650).default(DEFAULT_DELIVERY_HISTORY_DAYS),
    deliveryHistoryRecords: z.number().step(1).min(1).max(10_000).default(DEFAULT_DELIVERY_HISTORY_RECORDS),
  })

  /** Resolved retention bounds shared with the runtime that appends acknowledgments. */
  private readonly retention: DeliveryRetentionBounds
  private readonly ready: Promise<Domain<typeof scheduleDomain> | undefined>
  private readonly backend: ScheduleBackend | undefined
  private readonly taskContext = new AsyncLocalStorage<{ table: ScheduleTaskTable; changed: boolean }>()
  private readonly initialized: PromiseLike<unknown>
  private chain: Promise<unknown> = Promise.resolve()
  private runtime: ScheduleRuntime | undefined
  private stopping = false

  /**
   * @param ctx - Host services owning storage, dispatch, and Session restoration.
   * @param config - Validated retention configuration for delivery history.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'schedule')
    this.retention = {
      days: config.deliveryHistoryDays ?? DEFAULT_DELIVERY_HISTORY_DAYS,
      records: config.deliveryHistoryRecords ?? DEFAULT_DELIVERY_HISTORY_RECORDS,
    }
    this.backend = config.storage === 'external' ? ctx.get('scheduleBackend') : undefined
    if (config.storage === 'external' && this.backend === undefined) throw new Error('Schedule external storage is required')
    this.ready = this.backend !== undefined ? Promise.resolve(undefined) : ctx.storageDomain.open(scheduleDomain).then(async (domain) => {
      for (const [key, task] of domain.table('tasks').entries()) {
        if (key !== task.record.id) {
          // The mismatch is the actionable failure; a rejecting close must not replace it.
          try {
            await domain.close()
          } catch (error: unknown) {
            ctx.logger.warn(`schedule: closing the domain after a key mismatch failed: ${String(error)}`)
          }
          throw new Error(`schedule: stored task key "${key}" differs from record id "${task.record.id}"`)
        }
      }
      return domain
    })
    this.initialized = ctx.effect(async () => {
      const domain = await this.ready
      if (this.backend !== undefined) {
        const backend = this.backend
        let pending = false
        const wake = () => {
          if (pending || this.stopping) return
          pending = true
          void this.serialize(() => ctx.agents.withoutInitiator(() => backend.dispatch(async (tasks) => {
            const runtime = new ScheduleRuntime(ctx, () => [...tasks.entries()].map(([, task]) => task),
              work => work(), task => tasks.put(task.record.id, task), this.retention, false)
            await runtime.driveOnce()
          }))).then((changed) => { if (changed) this.emitChanged() }).catch((error: unknown) => {
            ctx.logger.warn(`schedule: tenant dispatch failed (${error instanceof Error ? error.name : 'unknown error'})`)
          }).finally(() => { pending = false })
        }
        const stop = backend.start(wake)
        return () => { this.stopping = true; stop(); return this.chain.then(() => undefined) }
      }
      if (domain === undefined) throw new Error('Schedule domain is unavailable')
      let cleanup: () => Promise<void>
      try {
        cleanup = ctx.effect(() => async () => {
          this.stopping = true
          await this.runtime?.dispose()
          await this.chain // The chain contains failures after returning them to their callers.
          await domain.close()
        })
      } catch (error) {
        this.stopping = true
        await domain.close()
        throw error
      }
      const tasks = domain.table('tasks')
      this.runtime = new ScheduleRuntime(ctx,
        () => [...tasks.entries()].map(([, task]) => task),
        work => this.serialize(work),
        async (task) => {
          await tasks.put(task.record.id, task)
          this.emitChanged()
        },
        this.retention)
      this.runtime.requestDrive()
      return cleanup
    })
    const registered = new WeakSet<object>()
    const attached = new Map<import('@deepseek-ai/dsh-agent').Agent, () => Promise<void>>()
    const attach = (agent: import('@deepseek-ai/dsh-agent').Agent): void => {
      if (this.stopping || registered.has(agent) || !ctx.agents.roots().includes(agent)) return
      if (this.backend !== undefined && !this.backend.allowsAgent(agent)) return
      registered.add(agent)
      // The plugin-scope effect is what tears the Agent-scoped registration down when this
      // plugin unloads, so it must also be disposed when the Agent itself is released.
      attached.set(agent, ctx.effect(
        () => agent.ctx.effect(() => registerScheduleTools(ctx, agent.ctx, agent)),
      ))
    }
    ctx.on('agent/created', ({ agent }) => { attach(agent) })
    ctx.on('agent-preset/selected', (id) => {
      const agent = ctx.agents.get(id)
      if (agent !== undefined) attach(agent)
    })
    ctx.on('agent/disposed', ({ agent }) => {
      const detach = attached.get(agent)
      if (detach === undefined) return
      attached.delete(agent)
      // `agent/disposed` declares a void listener, so the disposer promise is not returned;
      // this teardown chain is synchronous, and a failure throws into
      // `AgentRegistry.emitDisposed`, which reports it as a listener throw.
      void detach()
    })
    ctx.on('session/created', (session) => {
      // Historical Schedule events remain readable but do not populate Host tasks.
      // A throwing `session/created` listener rolls the attach back, so an unreadable
      // legacy stream must warn here instead of blocking Session creation.
      let activeLegacy = 0
      try {
        activeLegacy = foldScheduleEvents(session.ownEvents()).active.length
      } catch (error: unknown) {
        /* v8 ignore next -- foldScheduleEvents normalizes every rejected stream to ScheduleLogError. */
        if (!(error instanceof ScheduleLogError)) throw error
        ctx.logger.warn(`schedule: Session "${session.id}" historical events could not be read (${error.message}); the legacy reminder is ignored.`)
        return
      }
      if (activeLegacy > 0) {
        ctx.logger.warn(`schedule: Session "${session.id}" contains legacy reminders; recreate active reminders with schedule_create.`)
      }
    }, { global: true })
    // Host tasks outlive their Session's Agent, so archive admission reads the
    // stored rows rather than a live runtime: an idle Session whose reminders
    // are still armed refuses the archive, and an archiving stop deletes those
    // rows instead of letting them deliver into a closed Session.
    ctx.effect(() => {
      const activity = ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
        const active = await this.list({ sessionId })
        const rest = await next()
        if (active.length === 0) return rest
        const own: SessionActivity = {
          kind: 'schedule',
          items: active.map(record => ({ id: record.id, label: record.title })),
        }
        return [own, ...rest]
      })
      const stop = ctx.on('workspace/session-stop', async ({ sessionId }) => {
        await this.stopSessionTasks(sessionId)
      })
      return () => {
        stop()
        activity()
      }
    }, 'schedule.archiveAdmission()')
    for (const agent of ctx.agents.roots()) attach(agent)
  }

  async [Service.init](): Promise<void> {
    await this.initialized
  }

  /**
   * Create a reminder bound to the caller-selected Session without activating it.
   *
   * The request must supply a title; a missing, blank-after-trim, or over-long
   * title rejects with `invalid_prompt` instead of deriving one from the prompt.
   * The record is built from the clock reading taken before the request joins the
   * serialized queue, so a create that waits behind a longer operation keeps its
   * request-time anchor and may already be due when the queue reaches it.
   * @param sessionId - Original Session receiving the reminder.
   * @param request - Validated tool selector, required title, and reminder content.
   * @param signal - Optional cancellation checked before persistence begins, including after FIFO waits.
   * @returns The durably stored schedule. Cancellation does not roll back an in-flight write.
   */
  async create(sessionId: SessionId, request: ScheduleCreateRequest, signal?: AbortSignal): Promise<ScheduleRecord> {
    if (Number(request.at !== undefined) + Number(request.after_seconds !== undefined)
      + Number(request.every_seconds !== undefined) + Number(request.daily !== undefined)
      + Number(request.weekly !== undefined) + Number(request.cron !== undefined) > 1) {
      throw new ScheduleInputError('invalid_selector', 'Exactly one reminder selector is required.')
    }
    const title = scheduleTitle(request.title)
    const id = ScheduleId(`schedule-${randomUUID()}`)
    const now = Date.now()
    let record: ScheduleRecord
    if (request.at !== undefined) {
      record = createAtScheduleRecord(id, request.prompt, request.at, now, title)
    }
    else if (request.after_seconds !== undefined) {
      record = createAfterScheduleRecord(id, request.prompt, request.after_seconds, now, title)
    }
    else if (request.every_seconds !== undefined) {
      record = createEveryScheduleRecord(id, request.prompt, request.every_seconds, now, title)
    }
    else if (request.daily !== undefined) record = createDailyScheduleRecord(id, request.prompt, request.daily, now, title)
    else if (request.weekly !== undefined) record = createWeeklyScheduleRecord(id, request.prompt, request.weekly, now, title)
    else if (request.cron !== undefined) record = createCronScheduleRecord(id, request.prompt, request.cron, now, title)
    else throw new ScheduleInputError('invalid_selector', 'Exactly one reminder selector is required.')
    // A blank Session may have selected HyperAgents after its creation header.
    // Commit that selection before the external provider checks the stored mode.
    if (this.backend !== undefined) {
      const agent = this.ctx.agents.get(sessionId)
      if (agent !== undefined && this.backend.allowsAgent(agent)) {
        if (!await this.ctx.sessions.flush(agent.session)) throw new Error('Session persistence did not acknowledge the selected mode')
      }
    }
    return this.access(async () => {
      const tasks = await this.tasks()
      signal?.throwIfAborted()
      await tasks.put(id, {
        sessionId, record, status: 'active', deliveryHistory: { records: [], earlierRecordsUnavailable: false },
      })
      this.emitChanged()
      this.runtime?.requestDrive()
      return record
    })
  }

  /**
   * Read the selected Session's active tasks without resuming its Agent.
   * @param request - Session whose task list is requested.
   * @returns Persisted reminders in storage order.
   */
  @Remote('list')
  async list(request: ScheduleListRequest): Promise<ScheduleRecord[]> {
    return this.access(async () => [...(await this.tasks()).entries()]
      .filter(([, task]) => task.sessionId === request.sessionId && task.status === 'active')
      .map(([, task]) => task.record))
  }

  /**
   * Read all active and inactive Host reminders with their original Session bindings.
   * A deleted reminder has no row, so it is absent here.
   * Does not activate Sessions or read Session history.
   * @returns Reminders ordered by scheduledAt ascending, then lexicographically by id.
   */
  @Remote('catalog')
  async catalog(): Promise<ScheduleCatalogEntry[]> {
    return this.access(async () => [...(await this.tasks()).entries()]
      .map(([, task]) => ({
        ...task.record, sessionId: task.sessionId, status: task.status,
        ...(task.lastDelivery === undefined ? {} : { lastDelivery: task.lastDelivery }),
      }))
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.id.localeCompare(b.id)))
  }

  /**
   * Read saved inbox deliveries without activating or reading the original Session.
   * The task's own row supplies its binding, so its records stay readable through this lookup.
   * @param request - Session binding, task identity, explicit limit, and optional exclusive message cursor.
   * @returns Newest-first deliveries in append order, or a task/cursor lookup failure.
   * @throws ScheduleInputError when limit is not a safe integer from 1 through 100.
   */
  @Remote('history')
  async history(request: ScheduleDeliveryHistoryRequest): Promise<ScheduleDeliveryHistoryResult> {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) {
      throw new ScheduleInputError('invalid_rule', 'Delivery history limit must be a safe integer from 1 through 100.')
    }
    return this.access(async () => {
      const task = (await this.tasks()).get(request.id)
      if (task === undefined || task.sessionId !== request.sessionId) {
        return { id: request.id, code: 'schedule_not_found' }
      }
      return deliveryHistoryPage(task, request, this.retention)
    })
  }

  /**
   * Delete one task belonging to the selected Session, leaving queued messages intact.
   *
   * The row is removed: the task no longer schedules, leaves `list` and `catalog`, and its
   * saved delivery records go with it.
   * @param request - Session and exact task identity.
   * @param signal - Optional cancellation checked before persistence begins, including after FIFO waits.
   * @returns Whether that Session owned a deleted task. Cancellation does not roll back an in-flight write.
   */
  @Remote('delete')
  async delete(request: ScheduleDeleteRequest, signal?: AbortSignal): Promise<ScheduleDeleteResult> {
    return this.access<ScheduleDeleteResult>(async () => {
      const tasks = await this.tasks()
      signal?.throwIfAborted()
      const current = tasks.get(request.id)
      if (current === undefined || current.sessionId !== request.sessionId) {
        return { id: request.id, deleted: false, code: 'schedule_not_found' }
      }
      await tasks.delete(request.id)
      this.emitChanged()
      this.runtime?.requestDrive()
      return { id: request.id, deleted: true }
    })
  }

  /**
   * Update the name, instruction, and timing of an active task within the original Session
   * binding without activating the Session or changing saved deliveries.
   *
   * Each supplied field replaces its stored value; an omitted field keeps it. A name or
   * instruction change alone does not reset the committed target.
   * @param request - Task binding, complete observed record, and any combination of timing, name, and instruction.
   * @param signal - Cancellation checked after domain readiness and FIFO waits, before persistence begins.
   * @returns The committed record, unchanged record for a no-op, or a non-mutating input/lookup/conflict result.
   * Storage and lifecycle failures reject; cancellation after a write starts does not roll it back.
   */
  @Remote('update')
  async update(request: ScheduleUpdateRequest, signal?: AbortSignal): Promise<ScheduleUpdateResult> {
    return this.access<ScheduleUpdateResult>(async () => {
      const tasks = await this.tasks()
      signal?.throwIfAborted()
      const current = tasks.get(request.id)
      if (current === undefined || current.sessionId !== request.sessionId) {
        return { id: request.id, updated: false, code: 'schedule_not_found' }
      }
      if (current.status === 'inactive') return { id: request.id, updated: false, code: 'schedule_ended' }
      const result = resolveScheduleUpdate(current.record, request.expected, request.change, Date.now(), request)
      if (!('record' in result) || !result.updated) return result
      await tasks.put(request.id, { ...current, record: result.record })
      this.emitChanged()
      this.runtime?.requestDrive()
      return result
    })
  }

  /**
   * Dispatch one post-commit `schedule/changed` notification, containing
   * synchronous listener failures: every call site emits only after its durable
   * task write landed, so a throwing listener must not reject the caller or
   * skip the following `requestDrive()`.
   */
  private emitChanged(): void {
    const transaction = this.taskContext.getStore()
    if (transaction !== undefined) { transaction.changed = true; return }
    try {
      this.ctx.emit('schedule/changed')
    } catch (error: unknown) {
      // Swallows synchronous observer exceptions only: emit dispatches
      // listeners inline and nothing else runs in the try. The event is a
      // notification, not a transaction participant.
      this.ctx.logger.warn(`schedule: schedule/changed listener failed: ${String(error)}`)
    }
  }

  private async tasks(): Promise<ScheduleTaskTable> {
    const current = this.taskContext.getStore()
    if (current !== undefined) return current.table
    await this.initialized
    const domain = await this.ready
    if (domain === undefined) throw new Error('Schedule tenant transaction is required')
    return domain.table('tasks')
  }

  private access<T>(work: () => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      await this.initialized
      if (this.backend === undefined) return work()
      const changes = { changed: false }
      const result = await this.backend.manage(async (table) => {
        const transaction = { table, changed: false }
        const value = await this.taskContext.run(transaction, work)
        changes.changed = transaction.changed
        return value
      })
      if (changes.changed) this.emitChanged()
      return result
    })
  }

  /**
   * Remove every active task stored for one Session, inside the queue the tools
   * use.
   *
   * Enumerating and deleting in one queue slot is what makes an archive stop
   * ordered behind a create whose write is still in flight: a stop that read the
   * table outside the queue could miss a row the create was about to commit and
   * leave an armed reminder behind. Re-entering the public `delete()` from here
   * would deadlock on this queue, so the rows are removed directly.
   * @param sessionId - Session whose active Host tasks must stop.
   */
  private async stopSessionTasks(sessionId: SessionId): Promise<void> {
    await this.access(async () => {
      const tasks = await this.tasks()
      const active = [...tasks.entries()]
        .filter(([, task]) => task.sessionId === sessionId && task.status === 'active')
        .map(([, task]) => task.record.id)
      if (active.length === 0) return
      // One row per write: the domain table has no batch delete, and each row is
      // durable on its own, so a failure partway through leaves the rows already
      // removed committed. Observers hear about that change before the failure
      // reaches the caller, which still receives it.
      let removed = false
      let failure: Error | undefined
      for (const id of active) {
        try {
          await tasks.delete(id)
          removed = true
        } catch (error: unknown) {
          // Every row is attempted: the archive has already landed, so a row this
          // stop skipped would stay armed in a Session whose runtime then refuses
          // its model steps. A rejection reason that carries no Error still has to
          // report a failure, so it is wrapped before the first one is kept.
          failure ??= error instanceof Error ? error : new Error(`schedule stop failed: ${String(error)}`)
        }
      }
      if (removed) {
        this.emitChanged()
        this.runtime?.requestDrive()
      }
      if (failure !== undefined) throw failure
    })
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new Error('Schedule service is stopping'))
    const pending = this.chain.then(work)
    this.chain = pending.catch(() => undefined) // Preserve FIFO progress after the caller receives the failure.
    return pending
  }
}

export default ScheduleService
