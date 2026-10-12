import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Pool, PoolClient } from 'pg'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import { organizationAgentScope, type HivemindPrincipal } from '@deepseek-ai/dsh-hivemind-execution-scope'
import type { ScheduleOwnership, ScheduleOwnershipPolicy, ScheduleTask } from '@deepseek-ai/dsh-schedule'

const currentPreset = `COALESCE((SELECT e.payload->'data'->>'agentPreset' FROM harness_session_events e
 WHERE e.session_id=s.id AND e.org_id=s.org_id AND e.user_id=s.user_id
 AND e.event_type='agent-preset/selected' ORDER BY e.sequence DESC LIMIT 1),s.header->>'agentPreset')`

interface SessionOwnerRow {
  id: string
  org_id: string
  user_id: string
  variation: string
  project_id: string | null
  preset: string
  status: string
}
interface Config { sharedOrganizationAgents: boolean; statementTimeoutMs: number; maxTasksPerUser: number }
class ScheduleAccessDenied extends Error {}

function denied(error: unknown): boolean {
  return error instanceof ScheduleAccessDenied || (error instanceof Error
    && ['organization_agent_admin_required', 'organization_agent_storage_scope_changed'].includes(error.message))
}

/** Request authorization for native Schedule management plus owner restoration for due work. */
export class PostgresScheduleOwnershipPolicy implements ScheduleOwnershipPolicy {
  constructor(private readonly ctx: Context, private readonly pool: Pool, private readonly config: Config) {}

  async bind(sessionId: SessionIdType): Promise<ScheduleOwnership> {
    const actor = this.ctx.hivemindExecutionScope.require()
    return this.transaction(actor, async (client) => {
      await this.requireMembership(client, actor)
      await this.setTenant(client, actor.orgId, actor.userId)
      let session = await this.findSession(client, sessionId, actor.orgId, actor.userId)
      let audience: ScheduleOwnership['audience']
      let ownerUserId = actor.userId
      if (session === undefined && this.config.sharedOrganizationAgents) {
        const shared = await organizationAgentScope(client, { ...actor, actorUserId: actor.userId })
        await this.setTenant(client, shared.orgId, shared.userId)
        session = await this.findSession(client, sessionId, shared.orgId, shared.userId)
        if (session !== undefined && (session.preset === 'hivemind-hyperagents' || session.preset === 'hivemind-hq')) {
          ownerUserId = shared.userId
          audience = 'team'
        }
      }
      if (session === undefined || session.status !== 'active') throw new ScheduleAccessDenied('schedule_session_not_owned')
      if (!['hivemind-hyperagents', 'hivemind-chat', 'hivemind-hq'].includes(session.preset)) {
        throw new ScheduleAccessDenied('schedule_preset_not_allowed')
      }
      audience ??= session.preset === 'hivemind-chat' ? 'personal' : 'team'
      if (ownerUserId !== actor.userId) audience = 'team'
      return Object.freeze({ orgId: actor.orgId, userId: ownerUserId, actorUserId: actor.userId, audience })
    })
  }

  async assertCanCreate(owner: ScheduleOwnership): Promise<void> {
    const principal = this.ctx.hivemindExecutionScope.require()
    await this.transaction(principal, async (client) => {
      await this.setTenant(client, owner.orgId, owner.userId)
      const result = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM harness_scheduled_tasks WHERE org_id=$1 AND user_id=$2',
        [owner.orgId, owner.userId])
      if (Number(result.rows[0]?.count ?? '0') >= this.config.maxTasksPerUser) {
        throw new Error('Schedule task limit reached')
      }
    })
  }

  async authorize(sessionId: SessionIdType, owner: ScheduleOwnership): Promise<boolean> {
    try {
      return isDeepStrictEqual(await this.bind(SessionId(sessionId)), owner)
    } catch (error) {
      if (denied(error)) return false
      throw error
    }
  }

  async visible(task: ScheduleTask): Promise<boolean> {
    if (task.ownership === undefined) return false
    return this.authorize(task.sessionId, task.ownership)
  }

  async runAsOwner<T>(task: ScheduleTask, work: () => Promise<T>): Promise<T> {
    const owner = task.ownership
    if (owner === undefined) throw new ScheduleAccessDenied('schedule_owner_missing')
    const scope = this.ctx.hivemindExecutionScope
    const actorPrincipal = await this.transaction({ orgId: owner.orgId, userId: owner.actorUserId,
      profile: 'hivemind-chat', variation: 'harness' }, async (client) => {
      const actor = { orgId: owner.orgId, userId: owner.actorUserId }
      await this.requireMembership(client, actor)
      // Authenticate the original human first, then resolve the canonical storage
      // principal through Core's shared-agent capability. The two identities are
      // deliberately distinct: RLS reads use the proven storage owner, while
      // delivery still runs under the original actor below.
      let storageUserId = owner.actorUserId
      if (this.config.sharedOrganizationAgents && owner.userId !== owner.actorUserId) {
        const storage = await organizationAgentScope(client, {
          ...actor, actorUserId: actor.userId, profile: 'hivemind-chat', variation: 'harness',
        })
        storageUserId = storage.userId
      }
      if (storageUserId !== owner.userId) throw new ScheduleAccessDenied('schedule_owner_binding_changed')
      await this.setTenant(client, owner.orgId, storageUserId)
      const result = await client.query<SessionOwnerRow>(
        `SELECT s.id,s.org_id,s.user_id,s.variation,s.project_id,s.status,${currentPreset} AS preset
         FROM harness_sessions s WHERE s.id=$1 AND s.org_id=$2 AND s.user_id=$3`,
        [task.sessionId, owner.orgId, owner.userId])
      const row = result.rows[0]
      if (row === undefined || row.status !== 'active'
        || !['hivemind-hyperagents', 'hivemind-chat', 'hivemind-hq'].includes(row.preset)) {
        throw new ScheduleAccessDenied('schedule_owner_session_revoked')
      }
      await client.query("SELECT set_config('app.hivemind_scheduler','on',true)")
      return Object.freeze({ orgId: owner.orgId, userId: owner.actorUserId, profile: 'hivemind-chat' as const,
        variation: row.variation, ...(row.project_id === null ? {} : { projectId: row.project_id }) })
    })
    const fresh = await this.bindAs(actorPrincipal, task.sessionId)
    if (!isDeepStrictEqual(fresh, owner)) throw new ScheduleAccessDenied('schedule_owner_binding_changed')

    const lock = await this.pool.connect()
    try {
      const acquired = await lock.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',
        [`hive-schedule-delivery:${owner.orgId}:${owner.userId}`])
      if (acquired.rows[0]?.locked !== true) throw new Error('schedule_delivery_owned_by_peer')
      await lock.query("SELECT set_config('app.hivemind_scheduler','on',false)")
      await lock.query("SELECT set_config('app.hivemind_org_id',$1,false),set_config('app.hivemind_user_id',$2,false)",
        [owner.orgId, owner.userId])
      const current = await lock.query<SessionOwnerRow & {
        record: unknown
        task_status: string
        revision: number
        actor_user_id: string
        audience: string
      }>(
        `SELECT t.session_id AS id,t.org_id,t.user_id,t.record,t.status AS task_status,t.revision,
          t.actor_user_id,t.audience,s.variation,s.project_id,s.status,${currentPreset} AS preset
         FROM harness_scheduled_tasks t JOIN harness_sessions s
          ON s.id=t.session_id AND s.org_id=t.org_id AND s.user_id=t.user_id
         WHERE t.id=$1 AND t.org_id=$2 AND t.user_id=$3`, [task.record.id, owner.orgId, owner.userId])
      const row = current.rows[0]
      if (row === undefined || row.task_status !== 'active' || row.revision !== task.revision
        || row.actor_user_id !== owner.actorUserId || row.audience !== owner.audience
        || !isDeepStrictEqual(row.record, task.record)) throw new Error('schedule_stale_replica_task')
      return await scope.run(actorPrincipal, work)
    } finally {
      await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',
        [`hive-schedule-delivery:${owner.orgId}:${owner.userId}`]).catch(() => undefined)
      await lock.query('RESET app.hivemind_scheduler; RESET app.hivemind_org_id; RESET app.hivemind_user_id; RESET statement_timeout')
        .catch(() => undefined)
      lock.release()
    }
  }

  private async bindAs(principal: HivemindPrincipal, sessionId: SessionIdType): Promise<ScheduleOwnership> {
    let owner: ScheduleOwnership | undefined
    await this.ctx.hivemindExecutionScope.run(principal, async () => { owner = await this.bind(SessionId(sessionId)) })
    if (owner === undefined) throw new ScheduleAccessDenied('schedule_owner_unavailable')
    return owner
  }

  private async findSession(client: PoolClient, id: string, orgId: string, userId: string): Promise<SessionOwnerRow | undefined> {
    const result = await client.query<SessionOwnerRow>(
      `SELECT s.id,s.org_id,s.user_id,s.variation,s.project_id,s.status,${currentPreset} AS preset
       FROM harness_sessions s WHERE s.id=$1 AND s.org_id=$2 AND s.user_id=$3`, [id, orgId, userId])
    return result.rows[0]
  }

  private async requireMembership(client: PoolClient, principal: Pick<HivemindPrincipal, 'orgId' | 'userId'>): Promise<void> {
    const result = await client.query(
      `SELECT 1 FROM user_organizations m JOIN users u ON u.id=m.user_id
       WHERE m.org_id=$1 AND m.user_id=$2 AND m.is_active=true AND m.deactivated_at IS NULL AND u.deleted_at IS NULL`,
      [principal.orgId, principal.userId])
    if (result.rowCount !== 1) throw new ScheduleAccessDenied('schedule_membership_revoked')
  }

  private async setTenant(client: PoolClient, orgId: string, userId: string): Promise<void> {
    await client.query("SELECT set_config('app.hivemind_org_id',$1,true),set_config('app.hivemind_user_id',$2,true),set_config('statement_timeout',$3,true)",
      [orgId, userId, String(this.config.statementTimeoutMs)])
  }

  private async transaction<T>(principal: HivemindPrincipal, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await this.setTenant(client, principal.orgId, principal.userId)
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally { client.release() }
  }
}
