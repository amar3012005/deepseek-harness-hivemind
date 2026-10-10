/** Tenant-authorized company HQ pointer over the existing native Session database. */
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Pool } from 'pg'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { organizationAgentScope } from '@deepseek-ai/dsh-hivemind-execution-scope'
import type {} from './ownership.ts'

/** Explicit deployment configuration for the native tenant database. */
export interface Config { sharedOrganizationAgents?:boolean
  connectionStringEnv: string
  schema: string
  maxConnections: number
  statementTimeoutMs: number }
/** Owns no tasks, messages, or model execution; only the immutable company pointer. */
export default class PostgresHqOwnership extends Service {
  static inject = ['hivemindHqOwnership', 'hivemindExecutionScope']
  static Config: z<Config> = z.object({
    sharedOrganizationAgents:z.boolean().default(false),
    connectionStringEnv: z.string().required(), schema: z.string().required().pattern(/^[a-z_][a-z0-9_]*$/u),
    maxConnections: z.natural().min(1).required(), statementTimeoutMs: z.natural().min(1000).required(),
  })
  private readonly pool: Pool
  constructor(ctx: Context, private readonly config: Config, testPool?: Pool) {
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
        claim: id => this.claim(id), freshTargets: id => this.freshTargets(id),
        resetFresh: (id, ids) => this.resetFresh(id, ids),
      })
      return async () => { unregister(); await this.pool.end() }
    } catch (error) { await this.pool.end(); throw error }
  }
  /** Capture only the requesting user's native employee rooms and their descendants. */
  async freshTargets(root: SessionId): Promise<SessionId[]> {
    let p = this.ctx.hivemindExecutionScope.require()
    const actorUserId=p.userId
    const client=await this.pool.connect()
    try {
      await client.query('BEGIN')
      if (this.config.sharedOrganizationAgents) p = await organizationAgentScope(client,p)
      await client.query("SELECT set_config('app.hivemind_org_id',$1,true),set_config('app.hivemind_user_id',$2,true)",[p.orgId,p.userId])
      const owner = await client.query('SELECT 1 FROM harness_company_hq h JOIN user_organizations m ON m.org_id=h.org_id AND m.user_id=$4 AND m.is_active AND m.deactivated_at IS NULL JOIN users u ON u.id=h.user_id AND u.deleted_at IS NULL WHERE h.org_id=$1 AND h.user_id=$2 AND h.session_id=$3', [p.orgId, p.userId, root, actorUserId])
      if (!owner.rowCount) throw new Error('fresh_reset_owned_runtime_required')
      const rows = await client.query<{ id: string; parent: string | null; preset: string }>(`SELECT s.id,s.header->>'parentSession' AS parent,
      COALESCE((SELECT e.payload->'data'->>'agentPreset' FROM harness_session_events e WHERE e.session_id=s.id AND e.org_id=s.org_id AND e.user_id=s.user_id AND e.event_type='agent-preset/selected' ORDER BY e.sequence DESC LIMIT 1),s.header->>'agentPreset') AS preset
      FROM harness_sessions s WHERE s.org_id=$1 AND s.user_id=$2`, [p.orgId,p.userId])
      const ids = new Set(rows.rows.filter(r => ['hivemind-hq','hivemind-hyperagents'].includes(r.preset)).map(r => r.id))
      for (let i=0;i<rows.rows.length;i++) {
        const before=ids.size
        for (const r of rows.rows) if (r.parent && ids.has(r.parent)) ids.add(r.id)
        if (before===ids.size) break
      }
      if (!ids.has(root)) throw new Error('fresh_reset_root_missing')
      await client.query('COMMIT')
      return [...ids].sort().map(SessionId)
    } catch(error) {await client.query('ROLLBACK').catch(() => undefined);throw error} finally {client.release()}
  }

  /** Human-only scoped reset; company memory, profiles and other users are untouched. */
  async resetFresh(root: SessionId, ids: readonly SessionId[]): Promise<{ sessions: number; memories: number }> {
    let p=this.ctx.hivemindExecutionScope.require()
    const actorUserId=p.userId
    const current=await this.freshTargets(root)
    if (JSON.stringify(current)!==JSON.stringify(ids)) throw new Error('fresh_reset_scope_changed')
    const client=await this.pool.connect()
    try {
      await client.query('BEGIN')
      if (this.config.sharedOrganizationAgents) p = await organizationAgentScope(client,p)
      await client.query("SELECT set_config('app.hivemind_org_id',$1,true),set_config('app.hivemind_user_id',$2,true)",[p.orgId,p.userId])
      const lock=await client.query('SELECT id FROM harness_sessions WHERE org_id=$1 AND user_id=$2 AND id=ANY($3::text[]) FOR UPDATE',[p.orgId,p.userId,ids])
      if (lock.rowCount!==ids.length) throw new Error('fresh_reset_scope_changed')
      const leased=await client.query('SELECT 1 FROM harness_session_leases WHERE session_id=ANY($1::text[]) AND released_at IS NULL AND expires_at>now() LIMIT 1',[ids])
      if (leased.rowCount) throw new Error('fresh_reset_sessions_still_owned')
      // The runner cannot delete this Core-owned table directly. A narrow database
      // capability authenticates the admin and canonical Runtime before clearing private history.
      await client.query("SELECT set_config('app.hivemind_user_id',$1,true)",[actorUserId])
      const memories=await client.query<{ removed: string }>(
        'SELECT reset_agent_operating_memory($1::uuid,$2::uuid,$3::text,$4::boolean) AS removed',
        [p.orgId,actorUserId,root,this.config.sharedOrganizationAgents === true])
      await client.query("SELECT set_config('app.hivemind_user_id',$1,true)",[p.userId])
      await client.query('DELETE FROM harness_session_events WHERE org_id=$1 AND user_id=$2 AND session_id=$3',[p.orgId,p.userId,root])
      // Native projection checkpoints bind to header.createdAt, not SQL revision.
      // This canonical ID now names a new empty lifecycle, so old cache rows must not match it.
      await client.query(`UPDATE harness_sessions SET event_count=0,revision=revision+1,
        header=jsonb_set(jsonb_set(header,'{agentPreset}','"hivemind-hq"'::jsonb),'{createdAt}',
          to_jsonb(GREATEST($4::bigint,COALESCE((header->>'createdAt')::bigint,0)+1))),updated_at=now()
        WHERE org_id=$1 AND user_id=$2 AND id=$3`,[p.orgId,p.userId,root,Date.now()])
      const sessions=await client.query('DELETE FROM harness_sessions WHERE org_id=$1 AND user_id=$2 AND id=ANY($3::text[]) AND id<>$4',[p.orgId,p.userId,ids,root])
      if (sessions.rowCount!==ids.length-1) throw new Error('fresh_reset_scope_changed')
      await client.query('COMMIT')
      return { sessions:ids.length,memories:Number(memories.rows[0]?.removed ?? 0) }
    } catch(error) { await client.query('ROLLBACK').catch(() => undefined);throw error } finally {client.release()}
  }
  /** Atomically retain one canonical root without accepting model-supplied tenant identifiers. */
  async claim(sessionId: SessionId): Promise<void> {
    let principal = this.ctx.hivemindExecutionScope.require()
    const actorUserId=principal.userId
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      if (this.config.sharedOrganizationAgents) principal = await organizationAgentScope(client,principal)
      await client.query("SELECT set_config('app.hivemind_org_id',$1,true),set_config('app.hivemind_user_id',$2,true)",
        [principal.orgId, principal.userId])
      const authorized = await client.query(`SELECT 1 FROM harness_sessions s
        JOIN users u ON u.id=s.user_id AND u.deleted_at IS NULL
        JOIN user_organizations m ON m.org_id=s.org_id AND m.user_id=$4 AND m.is_active AND m.deactivated_at IS NULL
        WHERE s.id=$1 AND s.org_id=$2 AND s.user_id=$3 AND s.status='active'
        AND COALESCE((SELECT e.payload->'data'->>'agentPreset' FROM harness_session_events e
          WHERE e.session_id=s.id AND e.event_type='agent-preset/selected' ORDER BY e.sequence DESC LIMIT 1),s.header->>'agentPreset')='hivemind-hq'`,
      [sessionId, principal.orgId, principal.userId, actorUserId])
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
