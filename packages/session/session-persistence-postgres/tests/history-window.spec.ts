/** Actual restricted PostgreSQL proof. Opt-in disposable local fixture only. */
import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import ExecutionScope from '@deepseek-ai/dsh-hivemind-execution-scope'
import { PostgresSessionPersistence } from '../src/index.ts'
import { Pool } from 'pg'
import { expect, it, vi } from 'vitest'
import { readColdHistorySource } from '../../../api/session-controller/src/cold-history.ts'
import { SessionHistoryController } from '../../../api/session-controller/src/history.ts'
import { installSessionReadTestServices } from '../../../api/session-controller/tests/test-remote.ts'

const fixture = process.env.DSH_HISTORY_TEST_DATABASE_URL
it.skipIf(fixture === undefined)('loads only a recent native window under forced tenant RLS on actual PostgreSQL', async () => {
  // Never accept a production URL, published host port or operator credentials.
  const target = new URL(fixture!)
  expect(['127.0.0.1', 'localhost']).toContain(target.hostname)
  expect(target.pathname).toBe('/history_test')
  expect(target.search).toBe('')
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
    await admin.query('DROP SCHEMA IF EXISTS hivemind CASCADE; CREATE SCHEMA hivemind')
    await admin.query(`CREATE TABLE organizations(id uuid PRIMARY KEY); CREATE TABLE users(id uuid PRIMARY KEY);
      INSERT INTO organizations VALUES('${a.orgId}'),('${b.orgId}'); INSERT INTO users VALUES('${a.userId}'),('${b.userId}')`)
    await admin.query(await readFile(new URL('./fixtures/session-baseline.sql', import.meta.url), 'utf8'))
    await admin.query(await readFile(new URL('./fixtures/session-hardening.sql', import.meta.url), 'utf8'))
    await admin.query(await readFile(new URL('../migrations/session-format-predecessors.sql', import.meta.url), 'utf8'))
    await admin.query(await readFile(new URL('../migrations/session-variation-width.sql', import.meta.url), 'utf8'))
    await admin.query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='history_fixture') THEN CREATE ROLE history_fixture LOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$;
      GRANT USAGE ON SCHEMA hivemind TO history_fixture;
      GRANT SELECT,INSERT,UPDATE,DELETE ON harness_sessions,harness_session_events,harness_session_leases TO history_fixture;
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA hivemind TO history_fixture`)
    const fixturePassword = randomUUID()
    await admin.query(`ALTER ROLE history_fixture PASSWORD '${fixturePassword}'`)
    const restricted = new URL(target)
    restricted.username = 'history_fixture'
    restricted.password = fixturePassword
    pool = new Pool({ connectionString: restricted.toString(), options: '-c search_path=hivemind,public', max: 3 })
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
    const presentation = { sessions: ctx.sessions, get: (key: string) => key === 'sessionPersistence' ? store : undefined } as unknown as Context
    const bodyReads = vi.spyOn(store, 'read')
    const fullReads = vi.spyOn(store as unknown as {
      eventRows: (...args: unknown[]) => Promise<unknown[]>
    }, 'eventRows').mockRejectedValue(new Error('Unexpected full-log read during bounded presentation'))
    const noCheckpoint = { sessions: ctx.sessions, get: (key: string) => key === 'sessionPersistence' ? store : undefined } as unknown as Context
    const phoneBegan = performance.now()
    const phone = await scope.run(a, () => readColdHistorySource(noCheckpoint, id, new AbortController().signal,
      { maxMessages: 50, maxTurns: 5, withProjections: true }))
    const phoneWindowMs = performance.now() - phoneBegan
    expect(phone?.source).toBe('window')
    expect(phone?.projections).toBeUndefined()
    expect(phone?.cursor).toBe(9999)
    expect(bodyReads.mock.calls.every(([, , offset]) => offset > 0)).toBe(true)
    expect(bodyReads.mock.calls.reduce((sum, [, , , length]) => sum + length, 0)).toBeLessThanOrEqual(256)
    await expect(scope.run(b, () => readColdHistorySource(noCheckpoint, id, new AbortController().signal,
      { maxMessages: 50, maxTurns: 5, withProjections: true }))).rejects.toMatchObject({ code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
    bodyReads.mockClear()
    const began = performance.now()
    const source = await scope.run(a, () => readColdHistorySource(presentation, id, new AbortController().signal,
      { maxMessages: 50, maxTurns: 20, withProjections: false }))
    const windowMs = performance.now() - began
    expect(source?.source).toBe('window')
    expect(source?.cursor).toBe(9999)
    expect(bodyReads.mock.calls.every(([, , offset]) => offset > 0)).toBe(true)
    const rowsRequested = bodyReads.mock.calls.reduce((sum, [, , , length]) => sum + length, 0)
    expect(rowsRequested).toBeLessThan(300)
    expect(fullReads).not.toHaveBeenCalled()
    const controller = new SessionHistoryController(ctx, observation => observation[Symbol.dispose]())
    const page = await scope.run(a, () => controller.page({
      address: { kind: 'session', sessionId: id }, throughSeq: 9999, maxMessages: 50,
      turnWindow: { minMessages: 2, minTurns: 20 },
    }, new AbortController().signal))
    expect(page.records.length).toBeGreaterThan(90)
    expect(page.records.length).toBeLessThan(110)
    expect(page.records[0]?.event.type).toBe('turn/start')
    expect(page.records.at(-1)?.event.seq).toBe(9999)
    expect(page.hasMore).toBe(true)
    expect(fullReads).not.toHaveBeenCalled()
    // This composition has no checkpoint cache. Preserve full observation
    // instead of supplying invented complete projections for its suffix.
    expect(await scope.run(a, () => readColdHistorySource(presentation, id, new AbortController().signal,
      { maxMessages: 50, maxTurns: 20, withProjections: true }))).toBeUndefined()
    bodyReads.mockClear()
    const nativeWindow = await scope.run(a, () => readColdHistorySource(presentation, id,
      new AbortController().signal, {
        maxMessages: 50, turnWindow: { minMessages: 2, minTurns: 20 }, withProjections: false,
      }))
    expect(nativeWindow?.source).toBe('window')
    expect(nativeWindow?.cursor).toBe(9999)
    expect(nativeWindow?.events[0]?.seq).toBeGreaterThan(9700)
    expect(bodyReads.mock.calls.every(([, , offset]) => offset > 0)).toBe(true)
    expect(bodyReads.mock.calls.reduce((sum, [, , , length]) => sum + length, 0)).toBeLessThan(300)
    expect(fullReads).not.toHaveBeenCalled()
    await expect(scope.run(b, () => readColdHistorySource(presentation, id, new AbortController().signal,
      { maxMessages: 50, withProjections: false }))).rejects.toMatchObject({ code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
    const role = await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false })
    const rls = await admin.query<{ forced: boolean }>('SELECT bool_and(relforcerowsecurity) AS forced FROM pg_class WHERE relname=ANY($1)', [['harness_sessions', 'harness_session_events', 'harness_session_leases']])
    expect(rls.rows[0]?.forced).toBe(true)
    fullReads.mockRestore()
    const fullHandle = await scope.run(a, () => store.open(id, 'read'))
    const fullBegan = performance.now()
    const full = await fullHandle.read(0)
    const fullMs = performance.now() - fullBegan
    expect(full.events).toHaveLength(10000)
    await fullHandle.close()
    // Use the native point-read engine against the actual restricted database.
    // Only search is unconfigured by this helper; observeSession is inherited.
    installSessionReadTestServices(ctx)
    const promoted = vi.fn((observation: SessionObservation) => {
      expect(observation.events).toHaveLength(10000)
      observation[Symbol.dispose]()
    })
    const followController = new SessionHistoryController(ctx, promoted)
    const abort = new AbortController()
    const iterator = followController.follow({ address: { kind: 'session', sessionId: id },
      maxMessages: 50 }, abort.signal)[Symbol.asyncIterator]()
    try {
      const first = await scope.run(a, () => iterator.next())
      expect(first.value).toMatchObject({ type: 'snapshot', cursor: 9999 })
      const waiting = scope.run(a, () => iterator.next())
      await vi.waitFor(() => expect(promoted).toHaveBeenCalledOnce())
      abort.abort()
      await waiting
    } finally {
      abort.abort()
      await iterator.return?.()
    }
    console.log(JSON.stringify({ fixture: 'network-isolated-postgresql', events: 10000, phoneWindowMs, checkpointRequiredForPhone: false, rowsRequested, windowMs, fullMs, crossOrgDenied: true, forcedRls: true }))
  } finally {
    await ctx?.fiber.dispose()
    await pool?.end()
    await admin.end()
  }
}, 30000)
