/** Exercises the real migration and non-superuser RLS against a disposable PostgreSQL database. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import { Pool } from 'pg'
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import ExecutionScope, { type HivemindPrincipal } from '@deepseek-ai/dsh-hivemind-execution-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createAtScheduleRecord, ScheduleId, type ScheduleTask } from '@deepseek-ai/dsh-schedule'
import PostgresScheduleBackend, { type Config } from '../src/index.ts'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Skills from '@deepseek-ai/dsh-skill'
import * as AppBuilder from '../../app-builder/src/index.ts'

const url = process.env.DSH_SCHEDULE_TEST_URL
const suite = url === undefined ? describe.skip : describe
const a: HivemindPrincipal = {
  orgId: randomUUID(),
  userId: randomUUID(),
  profile: 'hivemind-chat',
  variation: 'harness',
}
const b: HivemindPrincipal = {
  orgId: randomUUID(),
  userId: randomUUID(),
  profile: 'hivemind-chat',
  variation: 'control',
}
const c: HivemindPrincipal = { ...a, userId: randomUUID() }
const schema = `schedule_${randomUUID().replaceAll('-', '')}`
const config: Config = {
  connectionStringEnv: 'UNUSED',
  schema,
  pollIntervalMs: 100,
  retryIntervalMs: 1000,
  batchSize: 100,
  maxConnections: 4,
  statementTimeoutMs: 10000,
  maxTasksPerUser: 100,
}
function task(id = 'a-task', sessionId = 'a-session', at = Date.now() + 60000): ScheduleTask {
  return {
    sessionId: SessionId(sessionId),
    record: createAtScheduleRecord(
      ScheduleId(id),
      'private instruction',
      new Date(at).toISOString(),
      0,
      'Private task',
    ),
    status: 'active',
  }
}

suite('tenant PostgreSQL Schedule provider', () => {
  let admin: Pool
  let ctx: Context
  let scope: ExecutionScope
  let backend: PostgresScheduleBackend
  let close: () => Promise<void>
  beforeAll(async () => {
    const parsed = new URL(url!)
    if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || parsed.pathname !== '/schedule_test')
      throw new Error('Use the disposable local schedule_test database')
    admin = new Pool({ connectionString: url, options: `-c search_path=${schema},public` })
    await admin.query(`CREATE SCHEMA ${schema}; SET search_path=${schema},public;
      DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='codex_schedule_test') THEN CREATE ROLE codex_schedule_test NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$;
      CREATE TABLE users(id uuid PRIMARY KEY,deleted_at timestamptz);
      CREATE TABLE user_organizations(user_id uuid,org_id uuid,is_active boolean DEFAULT true,deactivated_at timestamptz,PRIMARY KEY(user_id,org_id));
      CREATE TABLE harness_sessions(id varchar(180) PRIMARY KEY,org_id uuid,user_id uuid,variation text,project_id uuid,header jsonb,status text DEFAULT 'active',UNIQUE(id,org_id,user_id));
      CREATE TABLE harness_session_leases(session_id text,org_id uuid,user_id uuid,released_at timestamptz,expires_at timestamptz);
      CREATE TABLE harness_session_events(session_id varchar(180),org_id uuid,user_id uuid,event_type text,payload jsonb,sequence bigint);
      ALTER TABLE harness_sessions ENABLE ROW LEVEL SECURITY; ALTER TABLE harness_sessions FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant ON harness_sessions USING(org_id=NULLIF(current_setting('app.hivemind_org_id',true),'')::uuid AND user_id=NULLIF(current_setting('app.hivemind_user_id',true),'')::uuid);
      ALTER TABLE harness_session_events ENABLE ROW LEVEL SECURITY; ALTER TABLE harness_session_events FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant ON harness_session_events USING(org_id=NULLIF(current_setting('app.hivemind_org_id',true),'')::uuid AND user_id=NULLIF(current_setting('app.hivemind_user_id',true),'')::uuid);`)
    await admin.query(await readFile(new URL('../migrations/schedule.sql', import.meta.url), 'utf8'))
    await admin.query(await readFile(new URL('../../hq-runtime/migrations/company-hq.sql', import.meta.url), 'utf8'))
    await admin.query(
      `GRANT USAGE ON SCHEMA ${schema} TO codex_schedule_test; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO codex_schedule_test;`,
    )
    ctx = new Context()
    scope = new ExecutionScope(ctx)
    ctx.provide('agents', { get: () => undefined } as never)
    backend = new PostgresScheduleBackend(
      ctx,
      config,
      new Pool({ connectionString: url, options: `-c search_path=${schema},public -c role=codex_schedule_test` }),
    )
    close = await backend[Service.init]()
  })
  afterAll(async () => {
    await close?.()
    await ctx?.fiber.dispose()
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`)
      await admin.end()
    }
  })
  beforeEach(async () => {
    await admin.query(
      'TRUNCATE harness_company_hq,harness_session_leases,harness_scheduled_due,harness_scheduled_tasks,harness_session_events,harness_sessions,user_organizations,users CASCADE',
    )
    for (const [owner, id] of [
      [a, 'a-session'],
      [b, 'b-session'],
      [c, 'c-session'],
    ] as const) {
      await admin.query('INSERT INTO users(id) VALUES($1)', [owner.userId])
      await admin.query('INSERT INTO user_organizations(user_id,org_id) VALUES($1,$2)', [owner.userId, owner.orgId])
      await admin.query('INSERT INTO harness_sessions(id,org_id,user_id,variation,header) VALUES($1,$2,$3,$4,$5)', [
        id,
        owner.orgId,
        owner.userId,
        owner.variation,
        { agentPreset: 'hivemind-hyperagents' },
      ])
    }
  })
  it('fails closed without an authenticated scope', async () => {
    await expect(backend.manage(async table => [...table.entries()])).rejects.toThrow('execution scope')
  })
  it('isolates tenants and users in the same organization, including guessed task ids', async () => {
    await scope.run(a, () => backend.manage(table => table.put(ScheduleId('a-task'), task())))
    for (const other of [b, c])
      await scope.run(other, async () => {
        expect(await backend.manage(async table => [...table.entries()])).toEqual([])
        expect(await backend.manage(async table => table.get(ScheduleId('a-task')))).toBeUndefined()
        await backend.manage(table => table.delete(ScheduleId('a-task')))
        await expect(
          backend.manage(table =>
            table.put(ScheduleId('a-task'), task('a-task', other === b ? 'b-session' : 'c-session')),
          ),
        ).rejects.toThrow()
      })
    expect(await scope.run(a, () => backend.manage(async table => [...table.entries()].length))).toBe(1)
  })
  it.each(['hivemind-chat', 'hivemind-hq'])('rejects foreign sessions and accepts %s mode', async (preset) => {
    await expect(
      scope.run(a, () => backend.manage(table => table.put(ScheduleId('foreign'), task('foreign', 'b-session')))),
    ).rejects.toThrow('owned HIVE')
    await admin.query('UPDATE harness_sessions SET header=$1 WHERE id=$2', [{ agentPreset: preset }, 'a-session'])
    await scope.run(a, () => backend.manage(table => table.put(ScheduleId('a-task'), task())))
    await admin.query("INSERT INTO harness_session_events VALUES('a-session',$1,$2,'agent-preset/selected',$3,1)", [
      a.orgId,
      a.userId,
      { data: { agentPreset: 'hivemind-hyperagents' } },
    ])
    await scope.run(a, () => backend.manage(table => table.put(ScheduleId('a-task'), task())))
  })
  it('hides the wake index without scope and clears the scanner flag before reusing connections', async () => {
    await scope.run(a, () =>
      backend.manage(table => table.put(ScheduleId('a-task'), task('a-task', 'a-session', Date.now() - 1000))),
    )
    const client = new Pool({
      connectionString: url,
      options: `-c search_path=${schema},public -c role=codex_schedule_test`,
    })
    try {
      expect((await client.query('SELECT * FROM harness_scheduled_tasks')).rowCount).toBe(0)
      expect((await client.query('SELECT * FROM harness_scheduled_due')).rowCount).toBe(0)
      await backend.dispatch(async () => {})
      expect(await scope.run(b, () => backend.manage(async table => [...table.entries()]))).toEqual([])
      expect((await client.query('SELECT * FROM harness_scheduled_due')).rowCount).toBe(0)
    } finally {
      await client.end()
    }
  })
  it('retains paused HQ occurrences and admits them only after a committed human enable', async () => {
    await admin.query('UPDATE harness_sessions SET header=$1 WHERE id=$2', [{ agentPreset: 'hivemind-hq' }, 'a-session'])
    await scope.run(a, () => backend.manage(table => table.put(ScheduleId('hq-task'), task('hq-task', 'a-session', Date.now() - 1000))))
    let calls = 0
    const deliver = async () => { calls++ }
    await backend.dispatch(deliver)
    expect(calls).toBe(0)
    expect(await scope.run(a, () => backend.manage(async table => table.get(ScheduleId('hq-task'))))).toMatchObject({ status: 'active' })
    await admin.query("INSERT INTO harness_session_events VALUES('a-session',$1,$2,'hivemind/hq-mode',$3,1)", [
      a.orgId, a.userId, { data: { revision: 1, enabled: true, changedAt: Date.now() } },
    ])
    // A bare enabled event is not company ownership and cannot admit a wake.
    await admin.query("UPDATE harness_scheduled_due SET due_at=now()-interval '1 second' WHERE task_id='hq-task'")
    await backend.dispatch(deliver)
    expect(calls).toBe(0)
    await admin.query('INSERT INTO harness_company_hq(org_id,user_id,session_id) VALUES($1,$2,$3)', [a.orgId, a.userId, 'a-session'])
    await admin.query("UPDATE harness_scheduled_due SET due_at=now()-interval '1 second' WHERE task_id='hq-task'")
    await backend.dispatch(deliver)
    expect(calls).toBe(1)
    await admin.query("INSERT INTO harness_session_events VALUES('a-session',$1,$2,'hivemind/hq-mode',$3,2)", [
      a.orgId, a.userId, { data: { revision: 2, enabled: false, changedAt: Date.now() } },
    ])
    await admin.query("UPDATE harness_scheduled_due SET due_at=now()-interval '1 second' WHERE task_id='hq-task'")
    await backend.dispatch(deliver)
    expect(calls).toBe(1)
  })
  it('commits task and wake index atomically and rolls both back on failure', async () => {
    await expect(
      scope.run(a, () =>
        backend.manage(async (table) => {
          await table.put(ScheduleId('a-task'), task())
          throw new Error('rollback')
        }),
      ),
    ).rejects.toThrow('rollback')
    expect((await admin.query('SELECT * FROM harness_scheduled_due')).rowCount).toBe(0)
    expect((await admin.query('SELECT * FROM harness_scheduled_tasks')).rowCount).toBe(0)
  })
  it('restores the stored principal for cold delivery and suppresses concurrent replicas', async () => {
    const project = randomUUID()
    await admin.query("UPDATE harness_sessions SET project_id=$1 WHERE id='a-session'", [project])
    await scope.run(a, () =>
      backend.manage(table => table.put(ScheduleId('a-task'), task('a-task', 'a-session', Date.now() - 1000))),
    )
    const otherCtx = new Context()
    new ExecutionScope(otherCtx)
    otherCtx.provide('agents', { get: () => undefined } as never)
    const replica = new PostgresScheduleBackend(
      otherCtx,
      config,
      new Pool({ connectionString: url, options: `-c search_path=${schema},public -c role=codex_schedule_test` }),
    )
    const closeReplica = await replica[Service.init]()
    let deliveries = 0
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const first = backend.dispatch(async (table) => {
      deliveries++
      expect(scope.require()).toEqual({ ...a, projectId: project })
      entered.resolve(undefined)
      await release.promise
      const current = table.get(ScheduleId('a-task'))!
      await table.put(current.record.id, { ...current, status: 'inactive' })
    })
    try {
      await entered.promise
      await replica.dispatch(async () => {
        deliveries++
      })
      release.resolve(undefined)
      await first
      expect(deliveries).toBe(1)
    } finally {
      release.resolve(undefined)
      await first
      await closeReplica()
      await otherCtx.fiber.dispose()
    }
    expect((await admin.query('SELECT * FROM harness_scheduled_due')).rowCount).toBe(0)
  })
  it('restores a project owner for cold delivery and rejects organization CRM before transport', async () => {
    const projectId = randomUUID()
    await admin.query("UPDATE harness_sessions SET project_id=$1 WHERE id='a-session'", [projectId])
    await scope.run(a, () =>
      backend.manage(table => table.put(ScheduleId('crm-project-task'), task('crm-project-task', 'a-session', Date.now() - 1000))),
    )
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(Tools)
    await ctx.plugin(Skills)
    const consumer = await ctx.plugin(AppBuilder, {
      serviceApiBase: 'http://127.0.0.1:1',
      serviceSecretEnv: 'CRM_PROJECT_REJECTION_NO_SECRET',
    })
    let deliveries = 0
    try {
      await backend.dispatch(async (table) => {
        deliveries++
        expect(scope.require()).toEqual({ ...a, projectId })
        const get = ctx.tools.get('hivemind_app_get')!
        await expect(get.execute(
          { app_id: randomUUID() }, { signal: new AbortController().signal } as never,
        )).rejects.toThrow('project-scoped sessions cannot access CRM')
        const current = table.get(ScheduleId('crm-project-task'))!
        await table.put(current.record.id, { ...current, status: 'inactive' })
      })
      expect(deliveries).toBe(1)
      expect((await admin.query('SELECT * FROM harness_scheduled_due')).rowCount).toBe(0)
    } finally { await consumer.dispose() }
  })
  it('leaves a live session due for its owning replica without moving the deadline', async () => {
    const value = task('a-task', 'a-session', Date.now() - 1000)
    await scope.run(a, () => backend.manage(table => table.put(value.record.id, value)))
    await admin.query('INSERT INTO harness_session_leases VALUES(\'a-session\',$1,$2,NULL,now()+interval \'1 minute\')', [a.orgId, a.userId])
    let calls = 0
    await backend.dispatch(async () => { calls++ })
    expect(calls).toBe(0)
    expect((await admin.query<{ due: boolean }>('SELECT due_at<=now() AS due FROM harness_scheduled_due')).rows[0]?.due).toBe(true)
    await admin.query("UPDATE harness_session_leases SET released_at=now() WHERE session_id='a-session'")
    await backend.dispatch(async () => { calls++ })
    expect(calls).toBe(1)
  })
  it('does not wake a revoked member or closed session', async () => {
    await scope.run(a, () =>
      backend.manage(table => table.put(ScheduleId('a-task'), task('a-task', 'a-session', Date.now() - 1000))),
    )
    await admin.query('UPDATE user_organizations SET is_active=false WHERE user_id=$1', [a.userId])
    let called = false
    await backend.dispatch(async () => {
      called = true
    })
    expect(called).toBe(false)
    await admin.query('UPDATE user_organizations SET is_active=true WHERE user_id=$1', [a.userId])
    await scope.run(a, () =>
      backend.manage(table =>
        table.put(ScheduleId('closed-task'), task('closed-task', 'a-session', Date.now() - 1000)),
      ),
    )
    await admin.query("UPDATE harness_sessions SET status='closed' WHERE id='a-session'")
    await backend.dispatch(async () => {
      called = true
    })
    expect(called).toBe(false)
  })
  it('retries an unacknowledged due occurrence without changing its schedule target', async () => {
    const value = task('a-task', 'a-session', Date.now() - 1000)
    await scope.run(a, () => backend.manage(table => table.put(value.record.id, value)))
    await backend.dispatch(async () => {})
    expect(
      (await admin.query<{ future: boolean }>('SELECT due_at>now() AS future FROM harness_scheduled_due')).rows[0]
        ?.future,
    ).toBe(true)
    expect(
      await scope.run(a, () => backend.manage(async table => table.get(value.record.id)?.record.scheduledAt)),
    ).toBe(value.record.scheduledAt)
  })
})
