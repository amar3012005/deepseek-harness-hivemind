/** Actual restricted PostgreSQL proof. Opt-in disposable local fixture only. */
import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import ExecutionScope from '@deepseek-ai/dsh-hivemind-execution-scope'
import { PostgresSessionPersistence } from '@deepseek-ai/dsh-session-persistence-postgres'
import { Pool } from 'pg'
import { expect, it, vi } from 'vitest'
import { readColdHistorySource } from '../../../api/session-controller/src/cold-history.ts'

const fixture = process.env.DSH_HISTORY_TEST_DATABASE_URL
it.skipIf(fixture === undefined)('loads only a recent native window under forced tenant RLS on actual PostgreSQL', async () => {
  // Never accept a production URL, published host port or operator credentials.
  expect(fixture).toBe('postgresql://postgres@127.0.0.1:5432/history_test')
  const admin = new Pool({ connectionString: fixture, options: '-c search_path=hivemind,public' })
  const a = { orgId: '67503d34-97e9-49a8-8c52-8ee30cc7603e', userId: '54f5568b-4d6a-4ae1-9a33-48cb2909d59b', profile: 'hivemind-chat' as const, variation: 'harness' }
  const b = { ...a, orgId: '17503d34-97e9-49a8-8c52-8ee30cc7603e', userId: '14f5568b-4d6a-4ae1-9a33-48cb2909d59b' }
  let pool: Pool | undefined
  let ctx: Context | undefined
  try {
    for (let attempt = 0; ; attempt++) {
      try { await admin.query('SELECT 1'); break } catch (error) {
        if (attempt === 40) throw error
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    await admin.query('CREATE SCHEMA hivemind')
    await admin.query(`CREATE TABLE organizations(id uuid PRIMARY KEY); CREATE TABLE users(id uuid PRIMARY KEY);
      INSERT INTO organizations VALUES('${a.orgId}'),('${b.orgId}'); INSERT INTO users VALUES('${a.userId}'),('${b.userId}')`)
    await admin.query(await readFile('/history-fixtures/session-baseline.sql', 'utf8'))
    await admin.query(await readFile('/history-fixtures/session-hardening.sql', 'utf8'))
    await admin.query(`CREATE ROLE history_fixture LOGIN NOSUPERUSER NOBYPASSRLS;
      GRANT USAGE ON SCHEMA hivemind TO history_fixture;
      GRANT SELECT,INSERT,UPDATE,DELETE ON harness_sessions,harness_session_events,harness_session_leases TO history_fixture;
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA hivemind TO history_fixture`)
    pool = new Pool({ connectionString: 'postgresql://history_fixture@127.0.0.1:5432/history_test', options: '-c search_path=hivemind,public', max: 3 })
    ctx = new Context()
    await ctx.plugin(SessionStore)
    const scope = new ExecutionScope(ctx)
    const store = new PostgresSessionPersistence(ctx, { connectionStringEnv: 'FIXTURE_ONLY', schema: 'hivemind', leaseTtlMs: 30000, maxConnections: 3 }, pool)
    const id = SessionId('isolated-history-window')
    const handle = await scope.run(a, () => store.create({ version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false, cwd: '/fixture' }))
    const events: SessionEvent[] = []
    for (let turn = 1; turn <= 2000; turn++) {
      const seq = events.length
      events.push({ type: 'user/message', seq: SessionSeq(seq), time: seq,
        data: createUserMessage({ content: [{ type: 'text', text: `Fixture prompt ${turn}` }], source: { kind: 'user' } }), surfaceOp: 'append' })
      events.push({ type: 'turn/start', seq: SessionSeq(seq + 1), time: seq + 1, data: { turn } })
      events.push({ type: 'step/start', seq: SessionSeq(seq + 2), time: seq + 2, data: { turn, step: 1 } })
      events.push({ type: 'step/end', seq: SessionSeq(seq + 3), time: seq + 3, data: { turn, step: 1 } })
      events.push({ type: 'turn/end', seq: SessionSeq(seq + 4), time: seq + 4, data: { turn, reason: { kind: 'completed' } } })
    }
    await handle.append(events)
    await handle.flush()
    await handle.close()
    const cache = {
      coldReadFloor: () => SessionLogOffset(events.length - 1),
      coldSnapshotSuffix: (_header: unknown, _inherited: unknown, suffix: readonly SessionEvent[]) => ({
        asOfSeq: suffix.at(-1)?.seq ?? -1, values: {} }),
    }
    const presentation = { sessions: ctx.sessions, get: (key: string) => key === 'sessionPersistence' ? store : cache } as unknown as Context
    const bodyReads = vi.spyOn(store, 'read')
    const began = performance.now()
    const source = await scope.run(a, () => readColdHistorySource(presentation, id, new AbortController().signal,
      { maxMessages: 50, maxTurns: 20, withProjections: true }))
    const windowMs = performance.now() - began
    expect(source?.source).toBe('window')
    expect(source?.cursor).toBe(9999)
    expect(bodyReads.mock.calls.every(([, , offset]) => offset > 0)).toBe(true)
    const rowsRequested = bodyReads.mock.calls.reduce((sum, [, , , length]) => sum + length, 0)
    expect(rowsRequested).toBeLessThan(300)
    await expect(scope.run(b, () => readColdHistorySource(presentation, id, new AbortController().signal,
      { maxMessages: 50, withProjections: false }))).rejects.toMatchObject({ code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
    const role = await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false })
    const rls = await admin.query<{ forced: boolean }>('SELECT bool_and(relforcerowsecurity) AS forced FROM pg_class WHERE relname=ANY($1)', [['harness_sessions', 'harness_session_events', 'harness_session_leases']])
    expect(rls.rows[0].forced).toBe(true)
    const fullHandle = await scope.run(a, () => store.open(id, 'read'))
    const fullBegan = performance.now()
    const full = await fullHandle.read(0)
    const fullMs = performance.now() - fullBegan
    expect(full.events).toHaveLength(10000)
    await fullHandle.close()
    console.log(JSON.stringify({ fixture: 'network-isolated-postgresql', events: 10000, rowsRequested, windowMs, fullMs, crossOrgDenied: true, forcedRls: true }))
  } finally {
    await ctx?.fiber.dispose()
    await pool?.end()
    await admin.end()
  }
}, 30000)
