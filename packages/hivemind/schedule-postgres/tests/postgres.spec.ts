/** Exercises the native Schedule domain over the hosted PostgreSQL StorageBackend. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { Pool } from 'pg'
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import HivemindExecutionScope, { type HivemindPrincipal } from '@deepseek-ai/dsh-hivemind-execution-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import ScheduleService from '@deepseek-ai/dsh-schedule'
import HivemindScheduleOwnership, { POSTGRES_SCHEDULE_BACKEND } from '../src/index.ts'

const url = process.env.DSH_SCHEDULE_TEST_URL
const suite = url === undefined ? describe.skip : describe
const orgId = randomUUID()
const a: HivemindPrincipal = { orgId, userId: randomUUID(), profile: 'hivemind-chat', variation: 'harness' }
const b: HivemindPrincipal = { orgId: randomUUID(), userId: randomUUID(), profile: 'hivemind-chat', variation: 'control' }
const c: HivemindPrincipal = { orgId, userId: randomUUID(), profile: 'hivemind-chat', variation: 'harness' }
const teamOwner: HivemindPrincipal = { orgId, userId: randomUUID(), profile: 'hivemind-chat', variation: 'harness' }
const schema = `schedule_${randomUUID().replaceAll('-', '')}`
const databaseEnv = 'DSH_SCHEDULE_TEST_DATABASE'

suite('native Schedule with tenant PostgreSQL StorageBackend', () => {
  let admin: Pool
  const contexts: Context[] = []
  const oldDatabaseEnv = process.env[databaseEnv]

  beforeAll(async () => {
    const parsed = new URL(url!)
    if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) || !['/session_persistence_test', '/schedule_test'].includes(parsed.pathname)) {
      throw new Error('Use the disposable local session_persistence_test or schedule_test database')
    }
    const bootstrap = new Pool({ connectionString: url })
    await bootstrap.query(`CREATE SCHEMA ${schema}`)
    await bootstrap.end()
    admin = new Pool({ connectionString: url, options: `-c search_path=${schema},public` })
    await admin.query(`
      DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='codex_schedule_test')
        THEN CREATE ROLE codex_schedule_test NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$;
      CREATE TABLE users(id uuid PRIMARY KEY,deleted_at timestamptz);
      CREATE TABLE user_organizations(user_id uuid,org_id uuid,is_active boolean DEFAULT true,deactivated_at timestamptz,
        PRIMARY KEY(user_id,org_id));
      CREATE TABLE harness_sessions(id varchar(180) NOT NULL,org_id uuid NOT NULL,user_id uuid NOT NULL,
        variation text,project_id uuid,header jsonb NOT NULL,status text NOT NULL DEFAULT 'active',
        UNIQUE(id,org_id,user_id));
      CREATE TABLE harness_session_events(session_id varchar(180),org_id uuid,user_id uuid,event_type text,
        payload jsonb,sequence bigint);
      CREATE TABLE org_agent_scope(org_id uuid,actor_user_id uuid,storage_user_id uuid,is_active boolean,
        PRIMARY KEY(org_id,actor_user_id));
      CREATE FUNCTION organization_agent_storage_scope(p_org uuid,p_actor uuid)
        RETURNS TABLE(storage_user_id uuid) LANGUAGE SQL SECURITY DEFINER SET search_path=${schema},public
        AS $$ SELECT s.storage_user_id FROM org_agent_scope s
          WHERE s.org_id=p_org AND s.actor_user_id=p_actor AND s.is_active $$;
      CREATE TABLE schedule_test_write_failures(id varchar(180) PRIMARY KEY);
      CREATE FUNCTION fail_selected_schedule_write() RETURNS trigger LANGUAGE plpgsql SET search_path=${schema},public
        AS $$ BEGIN IF EXISTS(SELECT 1 FROM schedule_test_write_failures f WHERE f.id=NEW.id)
          THEN RAISE EXCEPTION 'simulated schedule receipt write failure'; END IF; RETURN NEW; END $$;
      ALTER TABLE harness_sessions ENABLE ROW LEVEL SECURITY; ALTER TABLE harness_sessions FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant ON harness_sessions USING(org_id=NULLIF(current_setting('app.hivemind_org_id',true),'')::uuid
        AND user_id=NULLIF(current_setting('app.hivemind_user_id',true),'')::uuid);
      ALTER TABLE harness_session_events ENABLE ROW LEVEL SECURITY; ALTER TABLE harness_session_events FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant ON harness_session_events USING(org_id=NULLIF(current_setting('app.hivemind_org_id',true),'')::uuid
        AND user_id=NULLIF(current_setting('app.hivemind_user_id',true),'')::uuid);`)
    await admin.query(await readFile(new URL('../migrations/schedule.sql', import.meta.url), 'utf8'))
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO codex_schedule_test;
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO codex_schedule_test;
      GRANT EXECUTE ON FUNCTION ${schema}.organization_agent_storage_scope(uuid,uuid) TO codex_schedule_test;
      GRANT EXECUTE ON FUNCTION ${schema}.fail_selected_schedule_write() TO codex_schedule_test;
      CREATE TRIGGER schedule_test_write_failure BEFORE UPDATE ON harness_scheduled_tasks
        FOR EACH ROW EXECUTE FUNCTION ${schema}.fail_selected_schedule_write();`)
    const scoped = new URL(url!)
    scoped.searchParams.set('options', `-c role=codex_schedule_test -c search_path=${schema},public`)
    process.env[databaseEnv] = scoped.toString()
  })

  afterAll(async () => {
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
    if (oldDatabaseEnv === undefined) Reflect.deleteProperty(process.env, databaseEnv)
    else process.env[databaseEnv] = oldDatabaseEnv
    if (admin !== undefined) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`)
      await admin.end()
    }
  })

  beforeEach(async () => {
    await admin.query('TRUNCATE harness_scheduled_due,harness_scheduled_tasks,harness_storage_units,harness_session_events,harness_sessions,user_organizations,users,org_agent_scope,schedule_test_write_failures CASCADE')
    for (const [owner, id] of [[a, 'a-session'], [b, 'b-session'], [c, 'c-session'], [teamOwner, 'team-session']] as const) {
      await admin.query('INSERT INTO users(id) VALUES($1)', [owner.userId])
      await admin.query('INSERT INTO user_organizations(user_id,org_id) VALUES($1,$2)', [owner.userId, owner.orgId])
      await admin.query('INSERT INTO harness_sessions(id,org_id,user_id,variation,header) VALUES($1,$2,$3,$4,$5)', [
        id, owner.orgId, owner.userId, owner.variation,
        { agentPreset: id === 'team-session' ? 'hivemind-hyperagents' : 'hivemind-chat' },
      ])
    }
    await admin.query('INSERT INTO org_agent_scope(org_id,actor_user_id,storage_user_id,is_active) VALUES($1,$2,$3,true)',
      [orgId, c.userId, teamOwner.userId])
  })

  async function boot(sharedOrganizationAgents = false): Promise<{
    ctx: Context
    scope: HivemindExecutionScope
    flushCount: () => number
  }> {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Storage)
    const scope = new HivemindExecutionScope(ctx)
    ctx.provide('agents', { get: () => undefined, withoutInitiator: (work: () => Promise<unknown>) => work() } as never)
    let flushes = 0
    const pending = new Map<string, { id: string; source: Record<string, unknown>; content: unknown[] }>()
    ctx.provide('sessions', { flush: async (session: { id: string }) => {
      flushes++
      const message = pending.get(session.id)
      if (message !== undefined) {
        const event = { type: 'agent/inbox/spliced', data: { inserted: [message] } }
        const next = await admin.query<{ next_sequence: string }>(
          'SELECT (COALESCE(MAX(sequence),-1)+1)::text AS next_sequence FROM harness_session_events WHERE session_id=$1',
          [session.id])
        await admin.query('INSERT INTO harness_session_events(session_id,org_id,user_id,event_type,payload,sequence) VALUES($1,$2,$3,$4,$5,$6)',
          [session.id, a.orgId, a.userId, event.type, event, next.rows[0]?.next_sequence])
        pending.delete(session.id)
      }
      return true
    } } as never)
    ctx.provide('sessionController', { resolveAgent: async (id: string) => {
      const stored = await admin.query<{ payload: { type: string; data: unknown } }>(
        "SELECT payload FROM harness_session_events WHERE session_id=$1 AND event_type='agent/inbox/spliced' ORDER BY sequence", [id])
      const events = stored.rows.map(row => row.payload)
      const session = { id, ownEvents: () => events }
      const agent = { session, followup: (message: { id: string; source: Record<string, unknown>; content: unknown[] }) => {
        events.push({ type: 'agent/inbox/spliced', data: { inserted: [message] } })
        pending.set(id, message)
      } }
      return { agent }
    } } as never)
    ctx.provide('sessionPersistence', {} as never)
    await ctx.plugin(HivemindScheduleOwnership, {
      connectionStringEnv: databaseEnv, schema, maxConnections: 3, statementTimeoutMs: 10000,
      maxTasksPerUser: 100, sharedOrganizationAgents,
    })
    const facility = new DomainFacility(ctx, { backend: POSTGRES_SCHEDULE_BACKEND })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    await ctx.plugin(ScheduleService, { ownershipRequired: true })
    return { ctx, scope, flushCount: () => flushes }
  }

  it('requires authentication and fences create/list/catalog/update/history/delete by tenant and Session owner', async () => {
    const { ctx, scope } = await boot()
    await expect(ctx.schedule.create(SessionId('a-session'), { title: 'private', prompt: 'private', after_seconds: 3600 }))
      .rejects.toThrow(/scope is unavailable/u)
    const record = await scope.run(a, () => ctx.schedule.create(SessionId('a-session'), {
      title: 'private', prompt: 'private', after_seconds: 3600,
    }))
    expect(await scope.run(a, () => ctx.schedule.list({ sessionId: SessionId('a-session') }))).toEqual([record])
    expect((await scope.run(a, () => ctx.schedule.catalog())).map(task => task.id)).toEqual([record.id])

    expect(await scope.run(b, () => ctx.schedule.catalog())).toEqual([])
    expect(await scope.run(b, () => ctx.schedule.update({
      sessionId: SessionId('a-session'), id: record.id, expected: record, enabled: false,
    }))).toMatchObject({ updated: false, code: 'schedule_not_found' })
    expect(await scope.run(b, () => ctx.schedule.history({
      sessionId: SessionId('a-session'), id: record.id, limit: 10,
    }))).toMatchObject({ code: 'schedule_not_found' })
    expect(await scope.run(b, () => ctx.schedule.delete({ sessionId: SessionId('a-session'), id: record.id })))
      .toMatchObject({ deleted: false, code: 'schedule_not_found' })
    expect(await scope.run(a, () => ctx.schedule.catalog())).toHaveLength(1)
  }, 60000)

  it('keeps one task identity and saved receipts across pause, resume, and provider restart', async () => {
    let { ctx, scope } = await boot()
    const record = await scope.run(a, () => ctx.schedule.create(SessionId('a-session'), {
      title: 'restart', prompt: 'retained receipt', after_seconds: 3600,
    }))
    const receipt = {
      scheduledAt: record.scheduledAt,
      deliveredAt: '2026-10-11T00:00:00.000Z',
      messageId: 'saved-message',
    }
    const deliveryHistory = JSON.stringify({
      records: [{ ...receipt, prompt: record.prompt }], earlierRecordsUnavailable: false,
    })
    await admin.query('UPDATE harness_scheduled_tasks SET last_delivery=$1::jsonb,delivery_history=$2::jsonb WHERE id=$3', [
      JSON.stringify(receipt), deliveryHistory, record.id,
    ])
    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)
    ;({ ctx, scope } = await boot())

    const loaded = (await scope.run(a, () => ctx.schedule.catalog()))[0]!
    expect(loaded).toMatchObject({ id: record.id, lastDelivery: receipt, status: 'active' })
    expect(await scope.run(a, () => ctx.schedule.update({
      sessionId: SessionId('a-session'), id: record.id, expected: record, enabled: false,
    }))).toMatchObject({ updated: true, record })
    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)
    ;({ ctx, scope } = await boot())
    expect((await scope.run(a, () => ctx.schedule.catalog()))[0]).toMatchObject({
      id: record.id, status: 'inactive', lastDelivery: receipt,
    })
    expect(await scope.run(a, () => ctx.schedule.update({
      sessionId: SessionId('a-session'), id: record.id, expected: record, enabled: true,
    }))).toMatchObject({ updated: true, record })
    expect((await admin.query('SELECT id,revision FROM harness_scheduled_tasks WHERE session_id=$1', ['a-session'])).rows)
      .toEqual([{ id: record.id, revision: 3 }])
  }, 30000)

  it('reuses the flushed native inbox occurrence after a task receipt write fails and the provider restarts', async () => {
    let { ctx, scope, flushCount } = await boot()
    const record = await scope.run(a, () => ctx.schedule.create(SessionId('a-session'), {
      title: 'restart delivery', prompt: 'one durable wake', after_seconds: 1,
    }))
    await admin.query('INSERT INTO schedule_test_write_failures(id) VALUES($1)', [record.id])
    await vi.waitFor(() => expect(flushCount()).toBe(1), { timeout: 10000 })
    expect((await admin.query('SELECT status FROM harness_scheduled_tasks WHERE id=$1', [record.id])).rows)
      .toEqual([{ status: 'active' }])
    expect((await admin.query("SELECT count(*)::int AS count FROM harness_session_events WHERE session_id='a-session' AND event_type='agent/inbox/spliced'")).rows[0]?.count)
      .toBe(1)

    await admin.query('DELETE FROM schedule_test_write_failures WHERE id=$1', [record.id])
    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)
    ;({ ctx, scope, flushCount } = await boot())
    await vi.waitFor(async () => expect(
      (await admin.query('SELECT status FROM harness_scheduled_tasks WHERE id=$1', [record.id])).rows[0]?.status,
    ).toBe('inactive'), { timeout: 10000 })
    // The retry flushes the restored inbox state after persisting its receipt;
    // wait for the flush counter because the status write can become visible first.
    await vi.waitFor(() => expect(flushCount()).toBe(1), { timeout: 5000 })
    expect((await admin.query("SELECT count(*)::int AS count FROM harness_session_events WHERE session_id='a-session' AND event_type='agent/inbox/spliced'")).rows[0]?.count)
      .toBe(1)
    expect(await scope.run(a, () => ctx.schedule.history({ sessionId: SessionId('a-session'), id: record.id, limit: 10 })))
      .toMatchObject({ records: [{ prompt: 'one durable wake' }] })
  }, 60000)

  it('revokes catalog access after tenant membership is disabled', async () => {
    const { ctx, scope } = await boot()
    await scope.run(a, () => ctx.schedule.create(SessionId('a-session'), {
      title: 'membership', prompt: 'revoke me', after_seconds: 3600,
    }))
    await admin.query('UPDATE user_organizations SET is_active=false WHERE org_id=$1 AND user_id=$2', [a.orgId, a.userId])
    expect(await scope.run(a, () => ctx.schedule.catalog())).toEqual([])
    await expect(scope.run(a, () => ctx.schedule.list({ sessionId: SessionId('a-session') })))
      .rejects.toThrow('schedule_membership_revoked')
  }, 30000)

  it('binds shared tasks to an actor and blocks delivery after that actor is revoked', async () => {
    const { ctx, scope } = await boot(true)
    const record = await scope.run(c, () => ctx.schedule.create(SessionId('team-session'), {
      title: 'team task', prompt: 'actor-bound', after_seconds: 3600,
    }))
    expect((await scope.run(c, () => ctx.schedule.catalog()))[0]).toMatchObject({ id: record.id, status: 'active' })
    expect(await scope.run(b, () => ctx.schedule.catalog())).toEqual([])
    const stored = await admin.query<{ actor_user_id: string; audience: string; user_id: string }>(
      'SELECT actor_user_id,audience,user_id FROM harness_scheduled_tasks WHERE id=$1', [record.id])
    expect(stored.rows).toEqual([{ actor_user_id: c.userId, audience: 'team', user_id: teamOwner.userId }])

    await admin.query('UPDATE user_organizations SET is_active=false WHERE org_id=$1 AND user_id=$2', [orgId, c.userId])
    expect(await scope.run(c, () => ctx.schedule.catalog())).toEqual([])
    const work = vi.fn(async () => 'delivered')
    const ownership = ctx.get('scheduleOwnership')
    expect(ownership).toBeDefined()
    if (!ownership) throw new Error('Schedule ownership provider was not mounted')
    await expect(ownership.runAsOwner({
      sessionId: SessionId('team-session'), record, status: 'active', revision: 1,
      ownership: { orgId, userId: teamOwner.userId, actorUserId: c.userId, audience: 'team' },
    }, work)).rejects.toThrow('schedule_membership_revoked')
    expect(work).not.toHaveBeenCalled()
  }, 30000)

  it('fails the legacy ownership migration atomically when a shared actor cannot be proven', async () => {
    await admin.query('UPDATE harness_sessions SET header=$1 WHERE id=$2', [{ agentPreset: 'hivemind-hyperagents' }, 'a-session'])
    await admin.query(`INSERT INTO harness_scheduled_tasks
      (id,session_id,org_id,user_id,record,status,scheduled_at) VALUES
      ('legacy-shared','a-session',$1,$2,$3::jsonb,'active',now()+interval '1 hour')`, [a.orgId, a.userId, JSON.stringify({
      id: 'legacy-shared', kind: 'after', title: 'legacy', prompt: 'opaque prompt', scheduledAt: '2026-10-11T12:00:00.000Z',
    })])
    const migration = await readFile(new URL('../migrations/schedule.sql', import.meta.url), 'utf8')
    await expect(admin.query(migration)).rejects.toThrow(/ownership backfill incomplete/u)
    expect((await admin.query<{ actor_user_id: string | null; audience: string | null }>(
      "SELECT actor_user_id,audience FROM harness_scheduled_tasks WHERE id='legacy-shared'",
    )).rows).toEqual([{ actor_user_id: null, audience: null }])
  }, 30000)
})
