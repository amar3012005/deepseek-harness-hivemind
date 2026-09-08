/** Tenant-scoped PostgreSQL provider for the SessionPersistence service. */
import { createHash, randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset as SessionLogOffsetType } from '@deepseek-ai/dsh-session'
import type HivemindExecutionScope from '@deepseek-ai/dsh-hivemind-execution-scope'
import type { HivemindPrincipal } from '@deepseek-ai/dsh-hivemind-execution-scope'
import {
  SessionAlreadyExistsError, SessionAlreadyOwnedError, SessionHandleClosedError,
  SessionOwnershipLostError, SessionPersistence, SessionPersistenceNotFoundError,
  SessionPersistenceRevision, SessionReadOnlyError, assertContiguous, assertStoredId,
  assertVersion, materializeAppendBatch, materializeCreateHeader, validateStoredEvents,
} from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionAccess, SessionHandle, SessionHandleAppendOptions, SessionHandleFlushOptions,
  SessionHandleReadOptions, SessionHandleReadResult, SessionPersistenceCreateOptions,
  SessionPersistenceListOptions, SessionPersistenceOpenOptions, SessionPersistenceSnapshot,
  SessionPersistenceStatOptions,
} from '@deepseek-ai/dsh-session-persistence'

export interface Config { connectionStringEnv: string; leaseTtlMs: number; maxConnections: number }
export const Config: z<Config> = z.object({
  connectionStringEnv: z.string().required(), leaseTtlMs: z.natural().min(1000).required(),
  maxConnections: z.natural().min(1).required(),
})
interface SessionRow extends QueryResultRow {
  header: SessionHeader
  inherited_event_count: string | number
  event_count: string | number
  revision: string | number
}
interface Owner { holder: string; hash: string; fence: number }
function connectionString(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`session-persistence-postgres: ${name} is required`)
  return value
}
function inheritedCut(header: SessionHeader, value: number | undefined): SessionLogOffsetType {
  const cut = SessionLogOffset(value ?? 0)
  if ((header.isSeeded && cut === 0) || (!header.isSeeded && cut !== 0)) throw new TypeError('inheritedEventCount must be positive exactly when header.isSeeded is true')
  return cut
}
function checkAbort(signal?: AbortSignal): void { signal?.throwIfAborted() }
function newOwner(): Owner {
  const holder = randomUUID()
  return { holder, hash: createHash('sha256').update(holder).digest('hex'), fence: 1 }
}
function scopeParams(scope: HivemindPrincipal, id?: SessionId): unknown[] {
  return id === undefined ? [scope.orgId, scope.userId] : [scope.orgId, scope.userId, id]
}

class PostgresHandle implements SessionHandle {
  private closedState = false
  private chain: Promise<unknown> = Promise.resolve()
  constructor(private readonly store: PostgresSessionPersistence, private readonly scope: HivemindPrincipal,
    readonly id: SessionId, readonly header: SessionHeader, readonly inheritedEventCount: SessionLogOffsetType,
    readonly access: SessionAccess, private readonly ownerState?: Owner) {}
  private run<T>(operation: string, action: () => Promise<T>): Promise<T> {
    if (this.closedState) return Promise.reject(new SessionHandleClosedError(this.id, operation))
    const result = this.chain.then(action)
    this.chain = result.catch(() => undefined)
    return result
  }
  read(offset = 0, length = Number.MAX_SAFE_INTEGER, options?: SessionHandleReadOptions): Promise<SessionHandleReadResult> {
    return this.run('read', async () => {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) throw new TypeError('read offset and length must be non-negative safe integers')
      checkAbort(options?.signal)
      return this.store.read(this.scope, this.id, offset, length)
    })
  }
  append(events: readonly SessionEvent[], options?: SessionHandleAppendOptions): Promise<void> {
    if (this.access !== 'write') return Promise.reject(new SessionReadOnlyError(this.id, 'append'))
    const batch = materializeAppendBatch(events)
    return this.run('append', async () => {
      checkAbort(options?.signal)
      if (this.ownerState === undefined) throw new SessionOwnershipLostError(this.id)
      await this.store.append(this.scope, this.id, this.ownerState, batch)
    })
  }
  flush(options?: SessionHandleFlushOptions): Promise<void> {
    if (this.access !== 'write') return Promise.reject(new SessionReadOnlyError(this.id, 'flush'))
    return this.run('flush', async () => {
      checkAbort(options?.signal)
      if (this.ownerState === undefined) throw new SessionOwnershipLostError(this.id)
      await this.store.renew(this.scope, this.id, this.ownerState)
    })
  }
  close(): Promise<void> {
    if (this.closedState) return Promise.resolve()
    this.closedState = true
    return this.chain.then(async () => {
      if (this.ownerState !== undefined) await this.store.release(this.scope, this.id, this.ownerState)
      this.store.closed(this)
    })
  }
  async [Symbol.asyncDispose](): Promise<void> { await this.close() }
}

/** PostgreSQL implementation using canonical HIVE tables and transaction-local RLS scope. */
export class PostgresSessionPersistence extends SessionPersistence {
  static Config = Config
  static inject = ['hivemindExecutionScope']
  override readonly name = 'session-persistence-postgres'
  private readonly pool: Pool
  private readonly handles = new Set<PostgresHandle>()
  private readonly executionScope: HivemindExecutionScope
  constructor(ctx: Context, readonly config: Config, testPool?: Pool) {
    super(ctx)
    this.executionScope = ctx.hivemindExecutionScope
    this.pool = testPool ?? new Pool({ connectionString: connectionString(config.connectionStringEnv), max: config.maxConnections })
  }
  protected async* [Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    await this.pool.query('SELECT 1 FROM harness_sessions LIMIT 0')
    yield async () => {
      await Promise.allSettled([...this.handles].map(handle => handle.close()))
      await this.pool.end()
    }
  }
  /** Verify database reachability without inventing a tenant principal. */
  async health(): Promise<void> { await this.pool.query('SELECT 1') }
  private expiry(): Date { return new Date(Date.now() + this.config.leaseTtlMs) }
  private capture(): HivemindPrincipal { return Object.freeze({ ...this.executionScope.require() }) }
  private async transaction<T>(scope: HivemindPrincipal, action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.hivemind_org_id',$1,true),set_config('app.hivemind_user_id',$2,true)", [scope.orgId, scope.userId])
      const value = await action(client)
      await client.query('COMMIT')
      return value
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally { client.release() }
  }
  private query<T extends QueryResultRow>(scope: HivemindPrincipal, sql: string, values: unknown[]): Promise<QueryResult<T>> {
    return this.transaction(scope, client => client.query<T>(sql, values))
  }
  async create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    checkAbort(options?.signal)
    const scope = this.capture()
    const meta = materializeCreateHeader(header)
    const cut = inheritedCut(meta, options?.inheritedEventCount)
    const claim = newOwner()
    try {
      await this.transaction(scope, async (client) => {
        await client.query(`INSERT INTO harness_sessions (id,org_id,user_id,project_id,profile,variation,status,header,inherited_event_count,event_count,revision)
          VALUES ($1,$2,$3,$4,$5,$6,'active',$7::jsonb,$8,0,0)`, [meta.id,scope.orgId,scope.userId,scope.projectId??null,scope.profile,scope.variation,JSON.stringify(meta),cut])
        await client.query(`INSERT INTO harness_session_leases (id,session_id,org_id,user_id,holder_id,token_hash,fencing_token,acquired_at,heartbeat_at,expires_at,released_at)
          VALUES ($1,$2,$3,$4,$5,$6,1,now(),now(),$7,NULL)`, [randomUUID(),meta.id,scope.orgId,scope.userId,claim.holder,claim.hash,this.expiry()])
      })
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new SessionAlreadyExistsError(meta.id)
      throw error
    }
    return this.track(new PostgresHandle(this,scope,meta.id,meta,cut,'write',claim))
  }
  async open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    checkAbort(options?.signal)
    const scope = this.capture()
    const row = await this.row(scope, id)
    if (row === undefined) throw new SessionPersistenceNotFoundError(id)
    await this.read(scope,id,0,Number.MAX_SAFE_INTEGER)
    let claim: Owner|undefined
    if (access === 'write') {
      claim = newOwner()
      const result = await this.query<{ fencing_token: string | number }>(scope,
        `UPDATE harness_session_leases
          SET holder_id=$4,token_hash=$5,fencing_token=fencing_token+1,acquired_at=now(),heartbeat_at=now(),
            expires_at=$6,released_at=NULL
          WHERE session_id=$3 AND org_id=$1 AND user_id=$2
            AND (released_at IS NOT NULL OR expires_at<=now())
          RETURNING fencing_token`, [...scopeParams(scope, id), claim.holder, claim.hash, this.expiry()])
      const fence = result.rows[0]?.fencing_token
      if (fence === undefined) throw new SessionAlreadyOwnedError(id)
      claim.fence = Number(fence)
    }
    return this.track(new PostgresHandle(this, scope, id, materializeCreateHeader(row.header),
      SessionLogOffset(Number(row.inherited_event_count)), access, claim))
  }
  async flush(): Promise<void> {
    const results = await Promise.allSettled([...this.handles]
      .filter(handle => handle.access === 'write').map(handle => handle.flush()))
    const failures: unknown[] = []
    for (const result of results) if (result.status === 'rejected') failures.push(result.reason)
    if (failures.length > 0) throw new AggregateError(failures, 'session persistence flush failed')
  }
  async stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined> {
    checkAbort(options?.signal)
    const row = await this.row(this.capture(), id)
    return row === undefined ? undefined : this.snapshot(row)
  }
  async list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]> {
    checkAbort(options?.signal)
    const scope = this.capture()
    const result = await this.query<SessionRow>(scope,
      'SELECT header,inherited_event_count,event_count,revision FROM harness_sessions WHERE org_id=$1 AND user_id=$2',
      scopeParams(scope))
    return result.rows.map(row => this.snapshot(row))
  }
  private snapshot(row: SessionRow): SessionPersistenceSnapshot {
    return {
      header: materializeCreateHeader(row.header), eventCount: Number(row.event_count),
      revision: SessionPersistenceRevision(String(row.revision)),
    }
  }
  private async row(scope: HivemindPrincipal, id: SessionId): Promise<SessionRow | undefined> {
    const result = await this.query<SessionRow>(scope,
      'SELECT header,inherited_event_count,event_count,revision FROM harness_sessions WHERE org_id=$1 AND user_id=$2 AND id=$3',
      scopeParams(scope, id))
    const row = result.rows[0]
    if (row !== undefined) assertStoredId(id, row.header)
    return row
  }
  async read(scope: HivemindPrincipal, id: SessionId, offset: number, length: number): Promise<SessionHandleReadResult> {
    const row = await this.row(scope, id)
    if (row === undefined) throw new SessionPersistenceNotFoundError(id)
    assertVersion(row.header)
    const result = await this.query<{ sequence: string | number; event_type: string; payload: SessionEvent }>(scope,
      `SELECT sequence,event_type,payload FROM harness_session_events
        WHERE org_id=$1 AND user_id=$2 AND session_id=$3 AND sequence >= $4 ORDER BY sequence LIMIT $5`,
      [...scopeParams(scope, id), offset, length])
    const events = result.rows.map((item) => {
      if (item.payload.seq !== Number(item.sequence) || item.payload.type !== item.event_type) {
        throw new Error(`stored session "${id}" event projection mismatch`)
      }
      return item.payload
    })
    validateStoredEvents(row.header, events)
    return { eventState: 'shared-frozen', events }
  }
  async append(scope: HivemindPrincipal, id: SessionId, claim: Owner, events: readonly SessionEvent[]): Promise<void> {
    await this.transaction(scope, async (client) => {
      const owned = await client.query(
        `UPDATE harness_session_leases SET heartbeat_at=now(),expires_at=$6
          WHERE org_id=$1 AND user_id=$2 AND session_id=$3 AND token_hash=$4 AND fencing_token=$5
            AND released_at IS NULL AND expires_at>now() RETURNING fencing_token`,
        [...scopeParams(scope, id), claim.hash, claim.fence, this.expiry()])
      if (owned.rows[0] === undefined) throw new SessionOwnershipLostError(id)
      const locked = await client.query<SessionRow>(
        `SELECT header,inherited_event_count,event_count,revision FROM harness_sessions
          WHERE org_id=$1 AND user_id=$2 AND id=$3 FOR UPDATE`, scopeParams(scope, id))
      const row = locked.rows[0]
      if (row === undefined) throw new SessionPersistenceNotFoundError(id)
      assertContiguous(id, events, Number(row.event_count))
      for (const event of events) {
        await client.query(
          `INSERT INTO harness_session_events
            (session_id,org_id,user_id,sequence,event_type,payload,created_at)
            VALUES ($1,$2,$3,$4,$5,$6::jsonb,to_timestamp($7/1000.0))`,
          [id, scope.orgId, scope.userId, event.seq, event.type, JSON.stringify(event), event.time])
      }
      if (events.length > 0) {
        await client.query(
          `UPDATE harness_sessions SET event_count=event_count+$4,revision=revision+1,updated_at=now()
            WHERE org_id=$1 AND user_id=$2 AND id=$3`, [...scopeParams(scope, id), events.length])
      }
    })
  }
  async renew(scope: HivemindPrincipal, id: SessionId, claim: Owner): Promise<void> {
    const result = await this.query(scope,
      `UPDATE harness_session_leases SET heartbeat_at=now(),expires_at=$6
        WHERE org_id=$1 AND user_id=$2 AND session_id=$3 AND token_hash=$4 AND fencing_token=$5
          AND released_at IS NULL AND expires_at>now() RETURNING fencing_token`,
      [...scopeParams(scope, id), claim.hash, claim.fence, this.expiry()])
    if (result.rows[0] === undefined) throw new SessionOwnershipLostError(id)
  }
  async release(scope: HivemindPrincipal, id: SessionId, claim: Owner): Promise<void> {
    await this.query(scope,
      `UPDATE harness_session_leases SET released_at=now()
        WHERE org_id=$1 AND user_id=$2 AND session_id=$3 AND token_hash=$4 AND fencing_token=$5`,
      [...scopeParams(scope, id), claim.hash, claim.fence])
  }
  closed(handle: PostgresHandle): void { this.handles.delete(handle) }
  private track(handle: PostgresHandle): PostgresHandle { this.handles.add(handle); return handle }
}
export default PostgresSessionPersistence
