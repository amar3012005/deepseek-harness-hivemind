import { Pool, type PoolClient } from 'pg'
import { StorageError, UNIT_NAME_RE } from '@deepseek-ai/dsh-storage'
import type { KvFacet, KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'
import { scheduleTaskSchema, type ScheduleTask } from '@deepseek-ai/dsh-schedule'
import type { ScheduleOwnership, ScheduleOwnershipPolicy } from '@deepseek-ai/dsh-schedule'

interface Row {
  id: string
  session_id: string
  record: unknown
  status: 'active' | 'inactive'
  last_delivery: unknown
  delivery_history: unknown
  org_id: string
  user_id: string
  actor_user_id: string
  audience: 'personal' | 'team'
  revision: number
}

const taskSelect = `SELECT id,session_id,record,status,last_delivery,delivery_history,
  org_id,user_id,actor_user_id,audience,revision FROM harness_scheduled_tasks`

function toTask(row: Row): ScheduleTask {
  const task = scheduleTaskSchema.parse({
    sessionId: row.session_id,
    record: row.record,
    status: row.status,
    revision: row.revision,
    ownership: { orgId: row.org_id, userId: row.user_id, actorUserId: row.actor_user_id, audience: row.audience },
    ...(row.last_delivery === null ? {} : { lastDelivery: row.last_delivery }),
    ...(row.delivery_history === null ? {} : { deliveryHistory: row.delivery_history }),
  })
  if (row.id !== task.record.id) throw new Error(`Schedule record identity mismatch for ${row.id}`)
  return task
}

/** PostgreSQL StorageBackend for the native Schedule domain. */
export class PostgresScheduleStorageBackend implements StorageBackend {
  private readonly units = new Map<string, KvUnit>()
  private readonly opening = new Set<string>()
  private closed = false

  constructor(
    private readonly pool: Pool,
    private readonly policy: ScheduleOwnershipPolicy,
    private readonly statementTimeoutMs: number,
  ) {}

  readonly kv: KvFacet = {
    open: async descriptor => this.openUnit(descriptor),
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await Promise.all([...this.units.values()].map(unit => unit.close()))
    await this.pool.end()
  }

  private async openUnit(descriptor: KvUnitDescriptor): Promise<KvUnit> {
    if (this.closed) throw new StorageError('closed', 'postgres schedule backend is closed')
    if (descriptor.name !== 'schedule' || descriptor.version !== 1
      || !descriptor.tables.includes('tasks') || descriptor.tables.length !== 1 || descriptor.hasGlobal) {
      throw new StorageError('malformed-medium', 'postgres schedule backend only serves the native v1 schedule/tasks domain')
    }
    if (!UNIT_NAME_RE.test(descriptor.name) || this.units.has(descriptor.name) || this.opening.has(descriptor.name)) {
      throw new Error(`schedule storage unit '${descriptor.name}' is already open or invalid`)
    }
    this.opening.add(descriptor.name)
    try {
      const loaded = await this.transaction(async (client) => {
        await client.query('INSERT INTO harness_storage_units(name,version) VALUES($1,$2) ON CONFLICT(name) DO NOTHING',
          [descriptor.name, descriptor.version])
        const stamp = await client.query<{ version: number }>('SELECT version FROM harness_storage_units WHERE name=$1',
          [descriptor.name])
        if (stamp.rows[0]?.version !== descriptor.version) {
          throw new StorageError('version-mismatch', `schedule storage is stamped v${stamp.rows[0]?.version}, expected v${descriptor.version}`)
        }
        await client.query("SELECT set_config('app.hivemind_scheduler','on',true)")
        const result = await client.query<Row>(`${taskSelect} ORDER BY created_at,id`)
        return result.rows
      })
      const tasks: { tasks: Record<string, unknown> } = { tasks: {} }
      for (const row of loaded) tasks.tasks[row.id] = toTask(row)
      let unitClosed = false
      const assertOpen = () => {
        if (unitClosed || this.closed) throw new StorageError('closed', 'postgres schedule unit is closed')
      }
      const unit: KvUnit = {
        loadAll: async () => {
          assertOpen()
          return { tables: structuredClone(tasks), global: null }
        },
        putRecord: async (table, key, raw) => {
          assertOpen()
          if (table !== 'tasks') throw new Error(`unknown schedule storage table '${table}'`)
          const task = scheduleTaskSchema.parse(raw)
          if (key !== task.record.id || task.ownership === undefined) throw new Error('schedule_owner_missing_or_key_mismatch')
          if (!await this.policy.authorize(task.sessionId, task.ownership)) throw new Error('schedule_write_unauthorized')
          await this.writeTask(key, task)
          tasks.tasks[key] = structuredClone(task) as unknown as Record<string, unknown>
        },
        deleteRecord: async (table, key) => {
          assertOpen()
          if (table !== 'tasks') throw new Error(`unknown schedule storage table '${table}'`)
          const cached = tasks.tasks[key]
          if (cached === undefined) return
          const task = scheduleTaskSchema.parse(cached)
          if (task.ownership === undefined || !await this.policy.authorize(task.sessionId, task.ownership)) {
            throw new Error('schedule_delete_unauthorized')
          }
          await this.deleteTask(key, task)
          Reflect.deleteProperty(tasks.tasks, key)
        },
        setGlobal: async () => { throw new Error('schedule domain does not declare a global value') },
        close: async () => {
          if (unitClosed) return
          unitClosed = true
          this.units.delete(descriptor.name)
        },
      }
      if (this.closed) {
        await unit.close()
        throw new StorageError('closed', 'postgres schedule backend closed during open')
      }
      this.units.set(descriptor.name, unit)
      return unit
    } finally {
      this.opening.delete(descriptor.name)
    }
  }

  private async writeTask(id: string, task: ScheduleTask): Promise<void> {
    const owner = task.ownership
    if (owner === undefined) throw new Error('schedule_owner_missing_or_key_mismatch')
    await this.transaction(async (client) => {
      await this.setTenant(client, owner)
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`hive-schedule:${owner.orgId}:${owner.userId}`])
      const current = await client.query<{
        revision: number
        session_id: string
        org_id: string
        user_id: string
        actor_user_id: string
        audience: string
      }>(
        'SELECT revision,session_id,org_id,user_id,actor_user_id,audience FROM harness_scheduled_tasks WHERE id=$1', [id])
      const previous = current.rows[0]
      if (previous === undefined) {
        if (task.revision !== 1) throw new Error('schedule_stale_write')
      } else if (previous.org_id !== owner.orgId || previous.user_id !== owner.userId
        || previous.actor_user_id !== owner.actorUserId || previous.audience !== owner.audience
        || previous.session_id !== task.sessionId || task.revision !== previous.revision + 1) {
        throw new Error('schedule_stale_or_foreign_write')
      }
      const session = await client.query(
        'SELECT 1 FROM harness_sessions WHERE id=$1 AND org_id=$2 AND user_id=$3 AND status=\'active\'',
        [task.sessionId, owner.orgId, owner.userId])
      if (session.rowCount !== 1) throw new Error('schedule_session_owner_changed')
      const written = await client.query(
        `INSERT INTO harness_scheduled_tasks
          (id,session_id,org_id,user_id,actor_user_id,audience,record,status,scheduled_at,last_delivery,delivery_history,revision)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb,$11::jsonb,$12)
         ON CONFLICT(id) DO UPDATE SET record=EXCLUDED.record,status=EXCLUDED.status,
          scheduled_at=EXCLUDED.scheduled_at,last_delivery=EXCLUDED.last_delivery,
          delivery_history=EXCLUDED.delivery_history,revision=EXCLUDED.revision,updated_at=now()
         WHERE harness_scheduled_tasks.org_id=$3 AND harness_scheduled_tasks.user_id=$4
          AND harness_scheduled_tasks.session_id=$2 AND harness_scheduled_tasks.revision=$12-1`,
        [id, task.sessionId, owner.orgId, owner.userId, owner.actorUserId, owner.audience,
          JSON.stringify(task.record), task.status, task.record.scheduledAt,
          task.lastDelivery === undefined ? null : JSON.stringify(task.lastDelivery),
          task.deliveryHistory === undefined ? null : JSON.stringify(task.deliveryHistory), task.revision])
      if (written.rowCount !== 1) throw new Error('schedule_stale_or_foreign_write')
      if (task.status === 'active') {
        await client.query(
          `INSERT INTO harness_scheduled_due(task_id,org_id,user_id,actor_user_id,due_at)
           VALUES($1,$2,$3,$4,$5) ON CONFLICT(task_id) DO UPDATE SET due_at=EXCLUDED.due_at,
            actor_user_id=EXCLUDED.actor_user_id WHERE harness_scheduled_due.org_id=$2 AND harness_scheduled_due.user_id=$3`,
          [id, owner.orgId, owner.userId, owner.actorUserId, task.record.scheduledAt])
      } else {
        await client.query('DELETE FROM harness_scheduled_due WHERE task_id=$1 AND org_id=$2 AND user_id=$3',
          [id, owner.orgId, owner.userId])
      }
    })
  }

  private async deleteTask(id: string, expected: ScheduleTask): Promise<void> {
    const owner = expected.ownership
    if (owner === undefined) throw new Error('schedule_delete_unauthorized')
    await this.transaction(async (client) => {
      await this.setTenant(client, owner)
      const deleted = await client.query(
        'DELETE FROM harness_scheduled_tasks WHERE id=$1 AND session_id=$2 AND org_id=$3 AND user_id=$4 AND revision=$5',
        [id, expected.sessionId, owner.orgId, owner.userId, expected.revision])
      if (deleted.rowCount !== 1) throw new Error('schedule_stale_or_foreign_delete')
    })
  }

  private async setTenant(client: PoolClient, owner: ScheduleOwnership): Promise<void> {
    await client.query("SELECT set_config('app.hivemind_org_id',$1,true),set_config('app.hivemind_user_id',$2,true),set_config('statement_timeout',$3,true)",
      [owner.orgId, owner.userId, String(this.statementTimeoutMs)])
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SET LOCAL statement_timeout = '${this.statementTimeoutMs}'`)
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
}
