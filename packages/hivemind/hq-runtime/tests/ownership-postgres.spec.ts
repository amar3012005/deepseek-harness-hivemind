/** Real non-BYPASSRLS transactions arbitrate competing HQ roots and tenant access. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import { Pool } from 'pg'
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import ExecutionScope, { type HivemindPrincipal } from '@deepseek-ai/dsh-hivemind-execution-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import HqOwnership from '../src/ownership.ts'
import PostgresOwnership from '../src/ownership-postgres.ts'

const url = process.env.DSH_SCHEDULE_TEST_URL
const suite = url ? describe : describe.skip
const schema = `hq_${randomUUID().replaceAll('-', '')}`
const a: HivemindPrincipal = { orgId: randomUUID(), userId: randomUUID(), profile: 'hivemind-chat', variation: 'harness' }
const b = { ...a, userId: randomUUID() }
const c = { ...a, orgId: randomUUID(), userId: randomUUID() }
suite('canonical company HQ ownership', () => {
  let admin: Pool, ctx: Context, scope: ExecutionScope, close: () => Promise<void>
  beforeAll(async () => {
    if (!url) throw new Error('disposable database required')
    const parsed = new URL(url)
    if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || parsed.pathname !== '/schedule_test') {
      throw new Error('Use the disposable local schedule_test database')
    }
    admin = new Pool({ connectionString: url, options: `-c search_path=${schema},public` })
    await admin.query(`CREATE SCHEMA ${schema}; DO $$ BEGIN
      IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='codex_schedule_test') THEN
        CREATE ROLE codex_schedule_test NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$`)
    await admin.query(await readFile(new URL('../../schedule-postgres/tests/sessions.sql', import.meta.url), 'utf8'))
    await admin.query(await readFile(new URL('../migrations/company-hq.sql', import.meta.url), 'utf8'))
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO codex_schedule_test;
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO codex_schedule_test;
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO codex_schedule_test`)
    ctx = new Context()
    scope = new ExecutionScope(ctx)
    new HqOwnership(ctx)
    const backend = new PostgresOwnership(ctx,
      { connectionStringEnv: 'UNUSED', schema, maxConnections: 4, statementTimeoutMs: 10000 },
      new Pool({ connectionString: url, options: `-c search_path=${schema},public -c role=codex_schedule_test` }))
    close = await backend[Service.init]()
  })
  beforeEach(async () => {
    await admin.query('TRUNCATE harness_company_hq,harness_session_events,harness_sessions,user_organizations,users CASCADE')
    for (const [principal, id] of [[a, 'a-hq'], [b, 'b-hq'], [c, 'c-hq']] as const) {
      await admin.query('INSERT INTO users(id) VALUES($1)', [principal.userId])
      await admin.query('INSERT INTO user_organizations(user_id,org_id) VALUES($1,$2)', [principal.userId, principal.orgId])
      await admin.query(`INSERT INTO harness_sessions(id,org_id,user_id,profile,variation,header)
        VALUES($1,$2,$3,'hivemind-chat','harness',$4)`, [id, principal.orgId, principal.userId, { agentPreset: 'hivemind-hq' }])
    }
  })
  afterAll(async () => {
    await close?.(); await ctx?.fiber.dispose()
    if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end() }
  })
  const claim = (principal: HivemindPrincipal, id: string) => scope.run(principal, () => ctx.hivemindHqOwnership.claim(SessionId(id)))
  it('allows exactly one of two company members to claim concurrently and replays its ownership', async () => {
    const outcomes = await Promise.allSettled([claim(a, 'a-hq'), claim(b, 'b-hq')])
    expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(item => item.status === 'rejected')).toHaveLength(1)
    const saved = await admin.query<{ session_id: string }>('SELECT session_id FROM harness_company_hq')
    expect(saved.rowCount).toBe(1)
    const first = saved.rows[0]?.session_id
    expect(['a-hq', 'b-hq']).toContain(first)
    await expect(claim(first === 'a-hq' ? a : b, first ?? '')).resolves.toBeUndefined()
    await expect(claim(c, 'c-hq')).resolves.toBeUndefined()
  })
  it('fresh reset removes only the requesting team and its private memories', async () => {
    await claim(a, 'a-hq')
    await admin.query('CREATE TABLE IF NOT EXISTS hyper_agent_operating_memories(id text,org_id uuid,author_user_id uuid,project_slug text)')
    await admin.query('GRANT SELECT,DELETE ON hyper_agent_operating_memories TO codex_schedule_test')
    await admin.query('TRUNCATE hyper_agent_operating_memories')
    await admin.query('INSERT INTO hyper_agent_operating_memories VALUES (\'own\',$1,$2,\'hyper-agents\'),(\'other\',$1,$3,\'hyper-agents\'),(\'company\',$1,$2,\'company\')',[a.orgId,a.userId,b.userId])
    await admin.query('INSERT INTO harness_sessions(id,org_id,user_id,profile,variation,header) VALUES (\'a-employee\',$1,$2,\'hivemind-chat\',\'harness\',$3),(\'a-brain\',$1,$2,\'hivemind-chat\',\'harness\',$4)',[a.orgId,a.userId,{ agentPreset:'hivemind-hyperagents' },{ agentPreset:'hivemind-chat' }])
    await expect(scope.run(b,()=>ctx.hivemindHqOwnership.freshTargets(SessionId('a-hq')))).rejects.toThrow('fresh_reset_owned_runtime_required')
    const ids=await scope.run(a,()=>ctx.hivemindHqOwnership.freshTargets(SessionId('a-hq')))
    expect(ids).toEqual(['a-employee','a-hq'])
    await expect(scope.run(a,()=>ctx.hivemindHqOwnership.resetFresh(SessionId('a-hq'),ids))).resolves.toEqual({ sessions:2,memories:1 })
    expect((await admin.query("SELECT header->>'agentPreset' AS preset,event_count::int AS event_count FROM harness_sessions WHERE id='a-hq'")).rows[0]).toMatchObject({ preset:'hivemind-hq',event_count:0 })
    expect((await admin.query('SELECT id FROM harness_sessions ORDER BY id')).rows.map(r=>r.id)).toEqual(['a-brain','a-hq','b-hq','c-hq'])
    expect((await admin.query('SELECT id FROM hyper_agent_operating_memories ORDER BY id')).rows.map(r=>r.id)).toEqual(['company','other'])
  })
  it('rejects foreign, revoked, inactive, and non-HQ roots without storing ownership', async () => {
    await expect(claim(a, 'c-hq')).rejects.toThrow('hq_owned_active_root_required')
    await admin.query("UPDATE harness_sessions SET header='{}' WHERE id='a-hq'")
    await expect(claim(a, 'a-hq')).rejects.toThrow('hq_owned_active_root_required')
    await admin.query("UPDATE harness_sessions SET status='closed' WHERE id='b-hq'")
    await expect(claim(b, 'b-hq')).rejects.toThrow('hq_owned_active_root_required')
    await admin.query('UPDATE user_organizations SET is_active=false WHERE user_id=$1', [c.userId])
    await expect(claim(c, 'c-hq')).rejects.toThrow('hq_owned_active_root_required')
    expect((await admin.query('SELECT 1 FROM harness_company_hq')).rowCount).toBe(0)
  })
})
