/** PostgreSQL Schedule provider. Management captures the request principal; timers restore stored ownership. */
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Pool, type PoolClient } from 'pg'
import type { ScheduleId } from '@deepseek-ai/dsh-schedule/client'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { HivemindPrincipal } from '@deepseek-ai/dsh-hivemind-execution-scope'
import {
  scheduleTaskSchema,
  type ScheduleBackend,
  type ScheduleTaskTable,
  type ScheduleTask,
} from '@deepseek-ai/dsh-schedule'

/** Deployment controls for the shared PostgreSQL scheduler. */
export interface Config {
  connectionStringEnv: string
  schema: string
  pollIntervalMs: number
  retryIntervalMs: number
  batchSize: number
  maxConnections: number
  statementTimeoutMs: number
  maxTasksPerUser: number
}
class ScheduleAuthorizationError extends Error {}
interface DueRow {
  task_id: string
  org_id: string
  user_id: string
}
const currentPreset =
  "COALESCE((SELECT e.payload->'data'->>'agentPreset' FROM harness_session_events e WHERE e.session_id=s.id AND e.org_id=s.org_id AND e.user_id=s.user_id AND e.event_type='agent-preset/selected' ORDER BY e.sequence DESC LIMIT 1),s.header->>'agentPreset')"
interface SessionRow {
  preset: string
  id: string
  variation: string
  project_id: string | null
  header: { agentPreset?: string }
  status: string
}
interface TaskRow {
  id: ScheduleId
  session_id: string
  record: unknown
  status: string
  last_delivery: unknown
  delivery_history: unknown
}

/** Trusted timer index contains ownership and timing only; prompt/history reads always use RLS. */
export default class PostgresScheduleBackend extends Service implements ScheduleBackend {
  static inject = ['hivemindExecutionScope', 'agents']
  static Config: z<Config> = z.object({
    connectionStringEnv: z.string().required(),
    schema: z
      .string()
      .required()
      .pattern(/^[a-z_][a-z0-9_]*$/u),
    pollIntervalMs: z.natural().min(100).required(),
    retryIntervalMs: z.natural().min(1000).required(),
    batchSize: z.natural().min(1).max(1000).required(),
    maxConnections: z.natural().min(1).required(),
    statementTimeoutMs: z.natural().min(1000).required(),
    maxTasksPerUser: z.natural().min(1).max(10000).required(),
  })
  private readonly pool: Pool
  private readonly scope: Context['hivemindExecutionScope']
  constructor(
    ctx: Context,
    private readonly config: Config,
    testPool?: Pool,
  ) {
    super(ctx, 'scheduleBackend')
    this.scope = ctx.hivemindExecutionScope
    const url = process.env[config.connectionStringEnv]
    if (testPool === undefined && !url) throw new Error('Schedule database URL is required')
    this.pool =
      testPool ??
      new Pool({ connectionString: url, max: config.maxConnections, options: `-c search_path=${config.schema},public` })
  }
  async [Service.init](): Promise<() => Promise<void>> {
    try {
      await this.pool.query('SELECT 1 FROM harness_scheduled_tasks LIMIT 0')
      await this.pool.query('SELECT 1 FROM harness_scheduled_due LIMIT 0')
      return () => this.pool.end()
    } catch (error) {
      await this.pool.end()
      throw error
    }
  }
  allowsAgent(agent: Agent): boolean {
    let preset = agent.session.header.agentPreset
    for (const event of agent.session.ownEvents())
      if (event.type === 'agent-preset/selected') preset = event.data.agentPreset
    return preset === 'hivemind-hyperagents' || preset === 'hivemind-chat'
  }
  start(wake: () => void): () => void {
    const initial = setTimeout(wake, 0)
    const timer = setInterval(wake, this.config.pollIntervalMs)
    initial.unref()
    timer.unref()
    return () => {
      clearTimeout(initial)
      clearInterval(timer)
    }
  }
  async manage<T>(work: (tasks: ScheduleTaskTable) => Promise<T>): Promise<T> {
    const principal = Object.freeze({ ...this.scope.require() })
    return this.transaction(principal, false, async (client) => {
      await this.authorize(client, principal)
      return work(await this.table(client, principal))
    }) as Promise<T>
  }
  async dispatch(work: (tasks: ScheduleTaskTable) => Promise<void>): Promise<boolean> {
    let changed = false
    const scanner = await this.pool.connect()
    let due: DueRow[]
    try {
      await scanner.query('BEGIN')
      await scanner.query("SELECT set_config('app.hivemind_scheduler','on',true)")
      due = (
        await scanner.query<DueRow>(
          `SELECT task_id,org_id,user_id FROM harness_scheduled_due
        WHERE due_at <= now() ORDER BY due_at,task_id LIMIT $1`,
          [this.config.batchSize],
        )
      ).rows
      await scanner.query('COMMIT')
    } catch (error) {
      await scanner.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      scanner.release()
    }
    for (const row of due) {
      const owner: HivemindPrincipal = {
        orgId: row.org_id,
        userId: row.user_id,
        profile: 'hivemind-chat',
        variation: 'harness',
      }
      try {
        const committed = await this.transaction(owner, true, async (client) => {
          const pending = await client.query(
            'SELECT 1 FROM harness_scheduled_due WHERE task_id=$1 AND org_id=$2 AND user_id=$3 AND due_at<=now()',
            [row.task_id, owner.orgId, owner.userId],
          )
          if (pending.rowCount === 0) return
          try {
            await this.authorize(client, owner)
          } catch (error) {
            if (!(error instanceof ScheduleAuthorizationError)) throw error
            await client.query(
              "UPDATE harness_scheduled_tasks SET status='inactive',updated_at=now() WHERE id=$1 AND org_id=$2 AND user_id=$3",
              [row.task_id, owner.orgId, owner.userId],
            )
            await client.query('DELETE FROM harness_scheduled_due WHERE task_id=$1 AND org_id=$2 AND user_id=$3', [
              row.task_id,
              owner.orgId,
              owner.userId,
            ])
            return true
          }
          const bound = await client.query<SessionRow>(
            `SELECT s.id,s.variation,s.project_id,s.header,s.status,${currentPreset} AS preset
            FROM harness_sessions s JOIN harness_scheduled_tasks t ON t.session_id=s.id AND t.org_id=s.org_id AND t.user_id=s.user_id
            WHERE t.id=$1 AND t.org_id=$2 AND t.user_id=$3`,
            [row.task_id, owner.orgId, owner.userId],
          )
          const session = bound.rows[0]
          if (session === undefined || session.status !== 'active'
            || (session.preset !== 'hivemind-hyperagents' && session.preset !== 'hivemind-chat')) {
            await client.query(
              "UPDATE harness_scheduled_tasks SET status='inactive',updated_at=now() WHERE id=$1 AND org_id=$2 AND user_id=$3",
              [row.task_id, owner.orgId, owner.userId],
            )
            await client.query('DELETE FROM harness_scheduled_due WHERE task_id=$1 AND org_id=$2 AND user_id=$3', [
              row.task_id,
              owner.orgId,
              owner.userId,
            ])
            return true
          }
          // Leave an owned session due for its live runner. A non-owner must not
          // keep moving the retry deadline before the owning replica can poll it.
          if (this.ctx.agents.get(SessionId(session.id)) === undefined) {
            const owned = await client.query(
              `SELECT 1 FROM harness_session_leases WHERE session_id=$1 AND org_id=$2 AND user_id=$3
               AND released_at IS NULL AND expires_at>now()`,
              [session.id, owner.orgId, owner.userId],
            )
            if (owned.rowCount !== 0) return
          }
          const principal: HivemindPrincipal = {
            ...owner,
            variation: session.variation,
            ...(session.project_id === null ? {} : { projectId: session.project_id }),
          }
          const table = await this.table(client, principal, session.id)
          const changes = { wrote: false }
          await this.scope.run(principal, () =>
            work({
              ...table,
              put: async (id, task) => {
                await table.put(id, task)
                changes.wrote = true
              },
            }),
          )
          // A failed inbox flush leaves the original target intact, with bounded retry delay.
          await client.query(
            `UPDATE harness_scheduled_due SET due_at=now()+($4::int * interval '1 millisecond')
            WHERE org_id=$1 AND user_id=$2 AND task_id IN
              (SELECT id FROM harness_scheduled_tasks WHERE org_id=$1 AND user_id=$2 AND session_id=$3)
            AND due_at<=now()`,
            [owner.orgId, owner.userId, session.id, this.config.retryIntervalMs],
          )
          return changes.wrote
        })
        changed ||= committed === true
      } catch (error) {
        // No content or identity is exposed through the host log.
        this.ctx.logger.warn(
          `schedule: delivery transaction failed (${error instanceof Error ? error.name : 'unknown error'})`,
        )
      }
    }
    return changed
  }
  private async authorize(client: PoolClient, principal: HivemindPrincipal): Promise<void> {
    const result = await client.query(
      `SELECT 1 FROM user_organizations m JOIN users u ON u.id=m.user_id
      WHERE m.org_id=$1 AND m.user_id=$2 AND m.is_active=true AND m.deactivated_at IS NULL AND u.deleted_at IS NULL`,
      [principal.orgId, principal.userId],
    )
    if (result.rowCount !== 1) throw new ScheduleAuthorizationError('Schedule principal is no longer authorized')
  }
  private async transaction<T>(
    principal: HivemindPrincipal,
    tryLock: boolean,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T | undefined> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        "SELECT set_config('app.hivemind_org_id',$1,true),set_config('app.hivemind_user_id',$2,true),set_config('statement_timeout',$3,true)",
        [principal.orgId, principal.userId, String(this.config.statementTimeoutMs)],
      )
      const key = `harness-schedule:${principal.orgId}:${principal.userId}`
      if (tryLock) {
        const result = await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',
          [key],
        )
        if (!result.rows[0]?.locked) {
          await client.query('ROLLBACK')
          return undefined
        }
      } else await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key])
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
  private async table(client: PoolClient, owner: HivemindPrincipal, sessionId?: string): Promise<ScheduleTaskTable> {
    const rows = await client.query<TaskRow>(
      `SELECT t.* FROM harness_scheduled_tasks t JOIN harness_sessions s
      ON s.id=t.session_id AND s.org_id=t.org_id AND s.user_id=t.user_id
      WHERE t.org_id=$1 AND t.user_id=$2 AND ($3::text IS NULL OR t.session_id=$3)
      AND ${currentPreset} IN ('hivemind-hyperagents','hivemind-chat') ORDER BY t.created_at,t.id`,
      [owner.orgId, owner.userId, sessionId ?? null],
    )
    const tasks = new Map<ScheduleId, ScheduleTask>(
      rows.rows.map((row) => {
        const task = scheduleTaskSchema.parse({
          sessionId: row.session_id,
          record: row.record,
          status: row.status,
          ...(row.last_delivery === null ? {} : { lastDelivery: row.last_delivery }),
          ...(row.delivery_history === null ? {} : { deliveryHistory: row.delivery_history }),
        })
        if (row.id !== task.record.id) throw new Error('Schedule record identity mismatch')
        return [row.id, task]
      }),
    )
    return {
      entries: () => tasks.entries(),
      get: id => tasks.get(id),
      put: async (id, value) => {
        const task = scheduleTaskSchema.parse(value)
        if (id !== task.record.id || (sessionId !== undefined && sessionId !== task.sessionId))
          throw new Error('Schedule identity mismatch')
        const current = tasks.get(id)
        if (current !== undefined && current.sessionId !== task.sessionId)
          throw new Error('Schedule session cannot change')
        const authorized = await client.query(
          `SELECT 1 FROM harness_sessions s WHERE s.id=$1 AND s.org_id=$2 AND s.user_id=$3
          AND s.status='active' AND ${currentPreset} IN ('hivemind-hyperagents','hivemind-chat')`,
          [task.sessionId, owner.orgId, owner.userId],
        )
        if (authorized.rowCount !== 1) throw new Error('Schedule requires an owned HIVE session')
        if (current === undefined && tasks.size >= this.config.maxTasksPerUser)
          throw new Error('Schedule task limit reached')
        const result = await client.query(
          `INSERT INTO harness_scheduled_tasks
          (id,session_id,org_id,user_id,record,status,scheduled_at,last_delivery,delivery_history)
          VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9::jsonb)
          ON CONFLICT(id) DO UPDATE SET record=EXCLUDED.record,status=EXCLUDED.status,scheduled_at=EXCLUDED.scheduled_at,
          last_delivery=EXCLUDED.last_delivery,delivery_history=EXCLUDED.delivery_history,updated_at=now()
          WHERE harness_scheduled_tasks.org_id=$3 AND harness_scheduled_tasks.user_id=$4 AND harness_scheduled_tasks.session_id=$2`,
          [
            id,
            task.sessionId,
            owner.orgId,
            owner.userId,
            JSON.stringify(task.record),
            task.status,
            task.record.scheduledAt,
            task.lastDelivery === undefined ? null : JSON.stringify(task.lastDelivery),
            task.deliveryHistory === undefined ? null : JSON.stringify(task.deliveryHistory),
          ],
        )
        if (result.rowCount !== 1) throw new Error('Schedule write refused')
        if (task.status === 'active')
          await client.query(
            `INSERT INTO harness_scheduled_due(task_id,org_id,user_id,due_at)
          VALUES($1,$2,$3,$4) ON CONFLICT(task_id) DO UPDATE SET due_at=EXCLUDED.due_at
          WHERE harness_scheduled_due.org_id=$2 AND harness_scheduled_due.user_id=$3`,
            [id, owner.orgId, owner.userId, task.record.scheduledAt],
          )
        else
          await client.query('DELETE FROM harness_scheduled_due WHERE task_id=$1 AND org_id=$2 AND user_id=$3', [
            id,
            owner.orgId,
            owner.userId,
          ])
        tasks.set(id, task)
      },
      delete: async (id) => {
        await client.query('DELETE FROM harness_scheduled_tasks WHERE id=$1 AND org_id=$2 AND user_id=$3', [
          id,
          owner.orgId,
          owner.userId,
        ])
        tasks.delete(id)
      },
    }
  }
}
