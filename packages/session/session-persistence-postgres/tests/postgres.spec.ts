import { Context } from '@deepseek-ai/cordis'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await pool.query(`
      DROP TABLE IF EXISTS harness_session_events, harness_session_leases, harness_sessions CASCADE;
      CREATE TABLE harness_sessions (
        id varchar(180) PRIMARY KEY, org_id uuid NOT NULL, user_id uuid NOT NULL, project_id uuid,
        profile varchar(64) NOT NULL, variation varchar(16) NOT NULL, status varchar(24) NOT NULL DEFAULT 'active',
        header jsonb NOT NULL, inherited_event_count bigint NOT NULL DEFAULT 0, event_count bigint NOT NULL DEFAULT 0,
        revision bigint NOT NULL DEFAULT 0, title varchar(500), created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz,
        UNIQUE (id, org_id, user_id)
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
    const ctx = new Context()
    scope = new HivemindExecutionScope(ctx)
    persistence = new PostgresSessionPersistence(ctx, {
      connectionStringEnv: 'UNUSED_IN_INTEGRATION_TEST', schema: 'public', leaseTtlMs: 30_000, maxConnections: 2,
    }, pool)
  })

  afterAll(async () => { await pool.end() })

  it('fails closed without scope and isolates every list/stat operation', async () => {
    await expect(persistence.list()).rejects.toThrow(/scope is unavailable/u)
    const mine = await scope.run(principal, () => persistence.create(header('tenant-session')))
    await mine.close()
    expect(await scope.run(principal, () => persistence.list())).toHaveLength(1)
    expect(await scope.run(other, () => persistence.list())).toEqual([])
    expect(await scope.run(other, () => persistence.stat(SessionId('tenant-session')))).toBeUndefined()
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
})
