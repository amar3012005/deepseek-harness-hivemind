import { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import HivemindExecutionScope, { type HivemindPrincipal } from '@deepseek-ai/dsh-hivemind-execution-scope'
import { SessionOwnershipLostError } from '@deepseek-ai/dsh-session-persistence'
import { PostgresSessionPersistence } from '../src/index.ts'

const url = process.env.DSH_POSTGRES_TEST_URL
const integration = url === undefined ? describe.skip : describe
const principal: HivemindPrincipal = {
  orgId: '67503d34-97e9-49a8-8c52-8ee30cc7603e',
  userId: '54f5568b-4d6a-4ae1-9a33-48cb2909d59b',
  projectId: 'a7503d34-97e9-49a8-8c52-8ee30cc7603e',
  profile: 'hivemind-chat', variation: 'harness',
}
const other: HivemindPrincipal = {
  orgId: '17503d34-97e9-49a8-8c52-8ee30cc7603e',
  userId: '14f5568b-4d6a-4ae1-9a33-48cb2909d59b',
  profile: 'hivemind-chat', variation: 'control',
}
function header(id: string): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1, isSeeded: false }
}
function start(seq: number): SessionEvent {
  return { type: 'turn/start', seq: SessionSeq(seq), time: 1_788_878_400_000, data: { turn: 1 } }
}

integration('PostgreSQL HIVE SessionPersistence contract', () => {
  let pool: Pool
  let scope: HivemindExecutionScope
  let persistence: PostgresSessionPersistence

  it('opens a current-format presentation slice without reading the full event log', async () => {
    const id = SessionId(`history-slice-${randomUUID()}`)
    const writer = await scope.run(principal, () => persistence.create(header(id)))
    const events: SessionEvent[] = []
    for (let turn = 1; turn <= 2500; turn++) {
      const seq = events.length
      events.push({ type: 'turn/start', seq: SessionSeq(seq), time: seq,
        data: { turn } }, { type: 'turn/end', seq: SessionSeq(seq + 1), time: seq + 1,
        data: { turn, reason: { kind: 'completed' } } })
    }
    await writer.append(events)
    await writer.flush()
    await writer.close()
    // Guard the full-log query, not merely the public slice-read counter.
    const fullRead = vi.spyOn(persistence as unknown as {
      eventRows: (...args: unknown[]) => Promise<unknown[]>
    }, 'eventRows').mockRejectedValue(new Error('unexpected full history read'))
    try {
      const reader = await scope.run(principal, () => persistence.openHistoryRead(id))
      const slice = await scope.run(principal, () => reader.read(4999, 1))
      expect(slice.events.map(event => event.seq)).toEqual([4999])
      expect(fullRead).not.toHaveBeenCalled()
      await reader.close()
      await expect(scope.run(other, () => persistence.openHistoryRead(id))).rejects.toBeDefined()
    } finally {
      fullRead.mockRestore()
      await pool.query('DELETE FROM harness_session_leases WHERE session_id=$1', [id])
      await pool.query('DELETE FROM harness_session_events WHERE session_id=$1', [id])
      await pool.query('DELETE FROM harness_sessions WHERE id=$1', [id])
    }
  }, 30000)

  beforeAll(async () => {
    if (url !== undefined) {
      const target = new URL(url)
      expect(['127.0.0.1', 'localhost', '::1']).toContain(target.hostname)
      expect(target.pathname).toBe('/session_persistence_test')
      expect(target.search).toBe('')
    }
    pool = new Pool({ connectionString: url })
    await pool.query(`
      DROP TABLE IF EXISTS harness_session_format_predecessor_events, harness_session_format_predecessors CASCADE;
      DROP TABLE IF EXISTS harness_session_events, harness_session_leases, harness_sessions CASCADE;
      CREATE TABLE harness_sessions (
        id varchar(180) PRIMARY KEY, org_id uuid NOT NULL, user_id uuid NOT NULL, project_id uuid,
        scope_kind varchar(24) NOT NULL DEFAULT 'organization',
        profile varchar(64) NOT NULL, variation varchar(16) NOT NULL, status varchar(24) NOT NULL DEFAULT 'active',
        header jsonb NOT NULL, inherited_event_count bigint NOT NULL DEFAULT 0, event_count bigint NOT NULL DEFAULT 0,
        revision bigint NOT NULL DEFAULT 0, title varchar(500), created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz,
        UNIQUE (id, org_id, user_id),
        CHECK ((scope_kind IN ('organization', 'personal') AND project_id IS NULL)
          OR (scope_kind = 'project' AND project_id IS NOT NULL))
      );
      CREATE TABLE harness_session_events (
        id bigserial PRIMARY KEY, session_id varchar(180) NOT NULL, org_id uuid NOT NULL, user_id uuid NOT NULL,
        sequence bigint NOT NULL, event_type varchar(80) NOT NULL, payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(session_id, sequence),
        FOREIGN KEY(session_id, org_id, user_id) REFERENCES harness_sessions(id, org_id, user_id)
      );
      CREATE TABLE harness_session_leases (
        id uuid PRIMARY KEY, session_id varchar(180) UNIQUE NOT NULL, org_id uuid NOT NULL, user_id uuid NOT NULL,
        holder_id text NOT NULL, token_hash char(64) UNIQUE NOT NULL, fencing_token bigint NOT NULL DEFAULT 0,
        acquired_at timestamptz NOT NULL, heartbeat_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
        released_at timestamptz,
        FOREIGN KEY(session_id, org_id, user_id) REFERENCES harness_sessions(id, org_id, user_id)
      );
    `)
    const legacyOwner = { orgId: '27503d34-97e9-49a8-8c52-8ee30cc7603e', userId: '24f5568b-4d6a-4ae1-9a33-48cb2909d59b' }
    const legacyHeader = { version: SESSION_FORMAT_VERSION, id: 'legacy-short-session', createdAt: 1, isSeeded: false }
    await pool.query(`INSERT INTO harness_sessions
      (id,org_id,user_id,project_id,scope_kind,profile,variation,status,header)
      VALUES ($1,$2,$3,NULL,'organization','hivemind-chat','harness','active',$4::jsonb)`,
    [legacyHeader.id, legacyOwner.orgId, legacyOwner.userId, JSON.stringify(legacyHeader)])
    await pool.query(`INSERT INTO harness_session_events
      (session_id,org_id,user_id,sequence,event_type,payload)
      VALUES ($1,$2,$3,0,'turn/start',$4::jsonb)`,
    [legacyHeader.id, legacyOwner.orgId, legacyOwner.userId, JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } })])
    await pool.query(await readFile(new URL('../migrations/session-variation-width.sql', import.meta.url), 'utf8'))
    await pool.query(await readFile(new URL('../migrations/session-format-predecessors.sql', import.meta.url), 'utf8'))
    const ctx = new Context()
    scope = new HivemindExecutionScope(ctx)
    persistence = new PostgresSessionPersistence(ctx, {
      connectionStringEnv: 'UNUSED_IN_INTEGRATION_TEST', schema: 'public', leaseTtlMs: 30_000, maxConnections: 2,
    }, pool)
  })

  afterAll(async () => { await pool.end() })

  it('widens legacy tenant variation while preserving session identity and event references', async () => {
    const legacy = await pool.query<{ id: string; variation: string }>(
      'SELECT id,variation FROM harness_sessions WHERE id=$1', ['legacy-short-session'])
    expect(legacy.rows).toEqual([{ id: 'legacy-short-session', variation: 'harness' }])
    const linked = await pool.query<{ session_id: string }>(
      'SELECT session_id FROM harness_session_events WHERE session_id=$1 AND sequence=0', ['legacy-short-session'])
    expect(linked.rows).toEqual([{ session_id: 'legacy-short-session' }])

    const nativeVariation = 'disposable-packaged-boot'
    const nativeId = SessionId(`session-${randomUUID()}`)
    const longVariationOwner = {
      ...principal,
      orgId: '37503d34-97e9-49a8-8c52-8ee30cc7603e',
      userId: '34f5568b-4d6a-4ae1-9a33-48cb2909d59b',
      variation: nativeVariation,
    }
    const handle = await scope.run(longVariationOwner, () =>
      persistence.create(header(nativeId)))
    await handle.close()
    const native = await pool.query<{ id: string; variation: string }>(
      'SELECT id,variation FROM harness_sessions WHERE id=$1', [nativeId])
    expect(native.rows).toEqual([{ id: nativeId, variation: nativeVariation }])
  })

  it('fails closed without scope and isolates every list/stat operation', async () => {
    await expect(persistence.list()).rejects.toThrow(/scope is unavailable/u)
    const mine = await scope.run(principal, () => persistence.create(header('tenant-session')))
    await mine.close()
    const session = await pool.query<{ project_id: string; scope_kind: string }>(
      'SELECT project_id,scope_kind FROM harness_sessions WHERE id=$1', ['tenant-session'])
    expect(session.rows[0]).toEqual({ project_id: principal.projectId, scope_kind: 'project' })
    expect(await scope.run(principal, () => persistence.list())).toHaveLength(1)
    expect(await scope.run(other, () => persistence.list())).toEqual([])
    expect(await scope.run(other, () => persistence.stat(SessionId('tenant-session')))).toBeUndefined()
  })

  it('lists the latest tenant-scoped preset selection for cold session navigation', async () => {
    const id = SessionId('preset-session')
    const writer = await scope.run(principal, () => persistence.create({ ...header(id), agentPreset: 'hivemind-chat' }))
    await writer.append([{
      type: 'agent-preset/selected', seq: SessionSeq(0), time: 1_788_878_400_000,
      data: { agentPreset: 'hivemind-hyperagents' },
    } as unknown as SessionEvent])
    await writer.close()
    await expect(persistence.effectivePresets([id])).rejects.toThrow(/scope is unavailable/u)
    expect(await scope.run(principal, () => persistence.effectivePresets([id]))).toEqual(new Map([[id, 'hivemind-hyperagents']]))
    expect(await scope.run(other, () => persistence.effectivePresets([id]))).toEqual(new Map())
    expect(await scope.run(principal, () => persistence.startedSessions([id]))).toEqual(new Set())
    await expect(persistence.startedSessions([id])).rejects.toThrow(/scope is unavailable/u)
    expect(await scope.run(other, () => persistence.startedSessions([id]))).toEqual(new Set())
  })

  it('stores exact event envelopes, rejects gaps, and fences an expired writer', async () => {
    const writer = await scope.run(principal, () => persistence.create(header('fenced-session')))
    const first = start(0)
    await writer.append([first])
    await expect(writer.append([start(2)])).rejects.toThrow(/seq mismatch/u)
    const stored = await pool.query<{ payload: SessionEvent }>(
      'SELECT payload FROM harness_session_events WHERE session_id=$1', ['fenced-session'])
    expect(stored.rows[0]?.payload).toEqual(first)

    const lease = await pool.query<{ holder_id: string; token_hash: string; fencing_token: string }>(
      'SELECT holder_id, token_hash, fencing_token FROM harness_session_leases WHERE session_id=$1', ['fenced-session'])
    expect(lease.rows[0]?.token_hash).toMatch(/^[a-f0-9]{64}$/u)
    expect(lease.rows[0]?.token_hash).not.toBe(lease.rows[0]?.holder_id)
    await pool.query("UPDATE harness_session_leases SET expires_at=now()-interval '1 second' WHERE session_id=$1", ['fenced-session'])
    const successor = await scope.run(principal, () => persistence.open(SessionId('fenced-session'), 'write'))
    const fenced = await pool.query<{ fencing_token: string }>(
      'SELECT fencing_token FROM harness_session_leases WHERE session_id=$1', ['fenced-session'])
    expect(Number(fenced.rows[0]?.fencing_token)).toBe(2)
    await expect(writer.append([start(1)])).rejects.toBeInstanceOf(SessionOwnershipLostError)
    await successor.append([start(1)])
    expect((await successor.read()).events).toEqual([first, start(1)])
    await successor.close()
    await writer.close()
  })

  it('lets the current fenced holder persist a delayed first prompt after its lease expires', async () => {
    const writer = await scope.run(principal, () => persistence.create(header('delayed-first-prompt')))
    await pool.query(
      "UPDATE harness_session_leases SET expires_at=now()-interval '1 second' WHERE session_id=$1",
      ['delayed-first-prompt'],
    )

    await writer.append([start(0)])
    await writer.flush()

    const stored = await pool.query<{ event_type: string; sequence: string }>(
      'SELECT event_type,sequence FROM harness_session_events WHERE session_id=$1 ORDER BY sequence',
      ['delayed-first-prompt'],
    )
    expect(stored.rows).toEqual([{ event_type: 'turn/start', sequence: '0' }])
    const renewed = await pool.query<{ active: boolean }>(
      'SELECT expires_at>now() AS active FROM harness_session_leases WHERE session_id=$1',
      ['delayed-first-prompt'],
    )
    expect(renewed.rows[0]?.active).toBe(true)
    await writer.close()
  })

  it('archives opaque V3 rows, completes child catalogs, promotes V4 atomically, and reopens after restart', async () => {
    const id = SessionId('format-v3-restart')
    const oldHeader = { version: 3, id, createdAt: 1, isSeeded: false, delegationDepth: 0 }
    const childId = SessionId('format-v3-restart-child')
    const childHeader = { version: 3, id: childId, createdAt: 2, isSeeded: false, delegationDepth: 1,
      parentSession: id, origin: 'subagent' }
    const opaque = {
      type: 'external/future', seq: SessionSeq(2), time: 12, ignorable: true,
      data: { opaqueField: { retain: ['all', 7] } },
      // V3 stores source references in range form; the codec expands this to [0]
      // before migrating, while leaving unknown-event surfaceOp uninterpreted.
      sourceEventSeqs: [0], surfaceOp: { op: 'plugin-private', retain: true },
    } as unknown as SessionEvent
    const oldEvents: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 10, data: { turn: 1 } },
      { type: 'turn/end', seq: SessionSeq(1), time: 11, data: { turn: 1, reason: { kind: 'completed' } } },
      opaque,
    ]
    const descriptor: SessionEvent = { type: 'subagent/descriptor', seq: SessionSeq(0), time: 12,
      data: { version: 3, mode: 'continuable', provider: 'spawn', label: 'restart child' } } as unknown as SessionEvent
    await pool.query(`INSERT INTO harness_sessions
      (id,org_id,user_id,project_id,scope_kind,profile,variation,status,header,inherited_event_count,event_count,revision)
      VALUES($1,$2,$3,$4,'project',$5,$6,'active',$7::jsonb,0,$8,7)`,
    [id, principal.orgId, principal.userId, principal.projectId, principal.profile, principal.variation,
      JSON.stringify(oldHeader), oldEvents.length])
    for (const event of oldEvents) await pool.query(`INSERT INTO harness_session_events
      (session_id,org_id,user_id,sequence,event_type,payload,created_at)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,to_timestamp($7/1000.0))`,
    [id, principal.orgId, principal.userId, event.seq, event.type, JSON.stringify(event), event.time])
    await pool.query(`INSERT INTO harness_sessions
      (id,org_id,user_id,project_id,scope_kind,profile,variation,status,header,inherited_event_count,event_count,revision)
      VALUES($1,$2,$3,$4,'project',$5,$6,'active',$7::jsonb,0,1,0)`,
    [childId, principal.orgId, principal.userId, principal.projectId, principal.profile, principal.variation, JSON.stringify(childHeader)])
    await pool.query(`INSERT INTO harness_session_events
      (session_id,org_id,user_id,sequence,event_type,payload,created_at)
      VALUES($1,$2,$3,0,$4,$5::jsonb,to_timestamp($6/1000.0))`,
    [childId, principal.orgId, principal.userId, descriptor.type, JSON.stringify(descriptor), descriptor.time])
    await pool.query(`INSERT INTO harness_session_leases
      (id,session_id,org_id,user_id,holder_id,token_hash,fencing_token,acquired_at,heartbeat_at,expires_at,released_at)
      VALUES(gen_random_uuid(),$1,$2,$3,'expired-fixture',repeat('0',64),1,now(),now(),now()-interval '1 second',now())`,
    [id, principal.orgId, principal.userId])

    expect((await scope.run(principal, () => persistence.stat(id)))?.formatStatus).toBe('migration-required')
    const reader = await scope.run(principal, () => persistence.open(id, 'read'))
    const migratedEvents: SessionEvent[] = [
      oldEvents[0]!, oldEvents[1]!, { ...opaque, type: 'plugin:external/future' } as unknown as SessionEvent,
      { type: 'subagent/catalog', seq: SessionSeq(3), time: 12,
        data: { version: 0, childId, childCreatedAt: 2, mode: 'continuable', label: 'restart child' } } as unknown as SessionEvent,
    ]
    try { expect((await reader.read()).events).toEqual(migratedEvents) } finally { await reader.close() }
    const before = await pool.query('SELECT source_header FROM harness_session_format_predecessors WHERE session_id=$1', [id])
    expect(before.rowCount).toBe(0)
    const originalRows = await pool.query<{ id: string; sequence: string; event_type: string; payload: unknown; created_at: Date }>(
      'SELECT id,sequence,event_type,payload,created_at FROM harness_session_events WHERE session_id=$1 ORDER BY sequence', [id])

    const writer = await scope.run(principal, () => persistence.open(id, 'write'))
    try {
      expect(writer.header.version).toBe(SESSION_FORMAT_VERSION)
      expect((await writer.read()).events).toEqual(migratedEvents)
    } finally { await writer.close() }
    const archived = await pool.query<{ source_header: unknown }>(
      'SELECT source_header FROM harness_session_format_predecessors WHERE session_id=$1', [id])
    expect(archived.rows).toEqual([{ source_header: oldHeader }])
    const archivedEvents = await pool.query<{
      source_id: string
      source_sequence: string
      source_event_type: string
      source_payload: unknown
      source_created_at: Date
    }>(
      'SELECT source_id,source_sequence,source_event_type,source_payload,source_created_at FROM harness_session_format_predecessor_events WHERE session_id=$1 ORDER BY source_sequence', [id])
    expect(archivedEvents.rows).toHaveLength(oldEvents.length)
    expect(archivedEvents.rows.map(row => ({ id: row.source_id, seq: row.source_sequence, type: row.source_event_type,
      payload: row.source_payload, created_at: row.source_created_at }))).toEqual(originalRows.rows.map(row => ({
      id: row.id, seq: row.sequence, type: row.event_type, payload: row.payload, created_at: row.created_at,
    })))
    expect(archivedEvents.rows[2]?.source_payload).toEqual(opaque)
    const preservedChild = await pool.query<{ header: unknown; payload: unknown }>(
      `SELECT s.header,e.payload FROM harness_sessions s JOIN harness_session_events e
         ON e.session_id=s.id AND e.org_id=s.org_id AND e.user_id=s.user_id
        WHERE s.id=$1 AND e.sequence=0`, [childId])
    expect(preservedChild.rows).toEqual([{ header: childHeader, payload: descriptor }])
    const childAfterParentMigration = await scope.run(principal, () => persistence.stat(childId))
    expect(childAfterParentMigration?.formatStatus).toBe('migration-required')
    expect((await scope.run(principal, () => persistence.stat(id)))?.formatStatus).toBe('current')

    const restartedContext = new Context()
    const restartedScope = new HivemindExecutionScope(restartedContext)
    const restarted = new PostgresSessionPersistence(restartedContext, {
      connectionStringEnv: 'UNUSED_IN_INTEGRATION_TEST', schema: 'public', leaseTtlMs: 30_000, maxConnections: 2,
    }, pool)
    const reopened = await restartedScope.run(principal, () => restarted.open(id, 'read'))
    try { expect((await reopened.read()).events).toEqual(migratedEvents) } finally {
      await reopened.close()
      await restartedContext.fiber.dispose()
    }
  })
})
