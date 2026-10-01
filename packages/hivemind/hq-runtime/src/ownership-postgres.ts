/** Tenant-authorized company HQ pointer over the existing native Session database. */
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Pool } from 'pg'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-hivemind-execution-scope'
import type {} from './ownership.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { HqActivity } from './continuity.ts'

/** Explicit deployment configuration for the native tenant database. */
export interface Config { connectionStringEnv: string; schema: string; maxConnections: number; statementTimeoutMs: number }
/** Owns no tasks, messages, or model execution; only the immutable company pointer. */
export default class PostgresHqOwnership extends Service {
  static inject = ['hivemindHqOwnership', 'hivemindExecutionScope']
  static Config: z<Config> = z.object({
    connectionStringEnv: z.string().required(), schema: z.string().required().pattern(/^[a-z_][a-z0-9_]*$/u),
    maxConnections: z.natural().min(1).required(), statementTimeoutMs: z.natural().min(1000).required(),
  })
  private readonly pool: Pool
  constructor(ctx: Context, config: Config, testPool?: Pool) {
    super(ctx, 'hivemindHqOwnershipPostgres')
    const url = process.env[config.connectionStringEnv]
    if (!testPool && !url) throw new Error('hq_ownership_database_required')
    this.pool = testPool ?? new Pool({ connectionString: url, max: config.maxConnections,
      options: `-c search_path=${config.schema},public -c statement_timeout=${config.statementTimeoutMs}` })
  }
  async [Service.init](): Promise<() => Promise<void>> {
    try {
      await this.pool.query('SELECT 1 FROM harness_company_hq LIMIT 0')
      const unregister = this.ctx.hivemindHqOwnership.register({
        claim: id => this.claim(id), find: () => this.find(),
        activity: (id, reviewed, limit) => this.activity(id, reviewed, limit),
      })
      return async () => { unregister(); await this.pool.end() }
    } catch (error) { await this.pool.end(); throw error }
  }
  /** Resolve ownership without activating or creating an employee session. */
  private async find(): Promise<SessionId | undefined> {
    const principal = this.ctx.hivemindExecutionScope.require()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.hivemind_org_id',$1,true),set_config('app.hivemind_user_id',$2,true)", [principal.orgId, principal.userId])
      const result = await client.query<{ session_id: string; user_id: string }>(
        `SELECT h.session_id,h.user_id FROM harness_company_hq h JOIN user_organizations m
         ON m.org_id=h.org_id AND m.user_id=$2 AND m.is_active AND m.deactivated_at IS NULL
         JOIN users u ON u.id=m.user_id AND u.deleted_at IS NULL WHERE h.org_id=$1`, [principal.orgId, principal.userId])
      const owner = result.rows[0]
      if (owner && owner.user_id !== principal.userId) throw new Error('hq_company_runtime_requires_owner_access')
      await client.query('COMMIT')
      return owner ? SessionId(owner.session_id) : undefined
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error }
    finally { client.release() }
  }
  /** Project saved outcome references, retaining per-session sequence positions. */
  private async activity(sessionId: SessionId, reviewed: Readonly<Record<string, number>>, limit: number):
  Promise<{ items: HqActivity[]; hasMore: boolean }> {
    if (await this.find() !== sessionId) throw new Error('hq_canonical_runtime_required')
    const principal = this.ctx.hivemindExecutionScope.require()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.hivemind_org_id',$1,true),set_config('app.hivemind_user_id',$2,true)", [principal.orgId, principal.userId])
      const result = await client.query<{
        session_id: string
        sequence: string
        title: string
        payload: { time: number; data: JsonValue }
        artifacts: JsonValue[]
      }>(
        `SELECT e.session_id,e.sequence,COALESCE(s.title,'Employee work') AS title,e.payload,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('sequence',a.sequence,'type',a.event_type,'id',COALESCE(a.payload->'data'->>'artifactId',a.payload->'data'->'file'->>'artifactId',a.payload->'data'->'pdf'->>'artifactId'))) FROM harness_session_events a
            WHERE a.session_id=e.session_id AND a.sequence<=e.sequence
              AND a.sequence>COALESCE((SELECT max(p.sequence) FROM harness_session_events p
                WHERE p.session_id=e.session_id AND p.event_type='turn/end' AND p.sequence<e.sequence),-1)
              AND a.event_type IN ('hivemind/artifact-created','hivemind/generation-created')), '[]') AS artifacts
         FROM harness_session_events e JOIN harness_sessions s ON s.id=e.session_id
         WHERE e.org_id=$1 AND e.user_id=$2 AND e.session_id<>$3 AND e.event_type='turn/end'
           AND e.sequence>COALESCE(($4::jsonb->>e.session_id)::bigint,-1)
           AND (COALESCE((SELECT p.payload->'data'->>'agentPreset' FROM harness_session_events p
             WHERE p.session_id=s.id AND p.event_type='agent-preset/selected' ORDER BY p.sequence DESC LIMIT 1),
             s.header->>'agentPreset') IN ('hivemind-hyperagents','hyperagents','hyperagents-compressed')
             OR s.header->>'parentSession'=$3)
         ORDER BY e.created_at,e.session_id,e.sequence LIMIT $5`, [principal.orgId, principal.userId, sessionId, JSON.stringify(reviewed), limit + 1])
      await client.query('COMMIT')
      return { items: result.rows.slice(0,limit).map(row => ({ sessionId: row.session_id, sequence: Number(row.sequence), title: row.title,
        time: row.payload.time, outcome: row.payload.data, artifacts: row.artifacts })), hasMore: result.rows.length>limit }
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error }
    finally { client.release() }
  }
  /** Atomically retain one canonical root without accepting model-supplied tenant identifiers. */
  async claim(sessionId: SessionId): Promise<void> {
    const principal = this.ctx.hivemindExecutionScope.require()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.hivemind_org_id',$1,true),set_config('app.hivemind_user_id',$2,true)",
        [principal.orgId, principal.userId])
      const authorized = await client.query(`SELECT 1 FROM harness_sessions s
        JOIN users u ON u.id=s.user_id AND u.deleted_at IS NULL
        JOIN user_organizations m ON m.org_id=s.org_id AND m.user_id=s.user_id AND m.is_active AND m.deactivated_at IS NULL
        WHERE s.id=$1 AND s.org_id=$2 AND s.user_id=$3 AND s.status='active'
        AND COALESCE((SELECT e.payload->'data'->>'agentPreset' FROM harness_session_events e
          WHERE e.session_id=s.id AND e.event_type='agent-preset/selected' ORDER BY e.sequence DESC LIMIT 1),s.header->>'agentPreset')='hivemind-hq'`,
      [sessionId, principal.orgId, principal.userId])
      if (!authorized.rowCount) throw new Error('hq_owned_active_root_required')
      // A unique organization key arbitrates concurrent humans and runner replicas.
      await client.query(`INSERT INTO harness_company_hq(org_id,user_id,session_id) VALUES($1,$2,$3)
        ON CONFLICT(org_id) DO NOTHING`, [principal.orgId, principal.userId, sessionId])
      const owner = await client.query<{ session_id: string; user_id: string }>(
        'SELECT session_id,user_id FROM harness_company_hq WHERE org_id=$1', [principal.orgId])
      if (owner.rows[0]?.session_id !== sessionId || owner.rows[0]?.user_id !== principal.userId) {
        throw new Error('hq_company_already_has_canonical_runtime')
      }
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error }
    finally { client.release() }
  }
}
