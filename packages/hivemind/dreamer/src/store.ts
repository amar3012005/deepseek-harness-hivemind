/** PostgreSQL run coordination. Every content query derives org/user from a stored or authenticated principal. */
import { Pool, type PoolClient } from 'pg'
import type { HivemindPrincipal } from '@deepseek-ai/dsh-hivemind-execution-scope'
import type { DreamAccount, DreamGrant, DreamContract } from '@deepseek-ai/dsh-hivemind-connected-apps'
import { candidateKey, stableId, type Candidate } from './contract.ts'
export interface DreamSetting {
  org_id: string
  user_id: string
  enabled: boolean
  revision: number
  project_id: string | null
  synced_revision: number
}
export interface DreamRun {
  id: string
  org_id: string
  user_id: string
  revision: number
  occurrence_key: string
  occurrence_id: string
  trigger_id: string
  parent_id: string
  child_id: string
  status: string
  attempts: number
  checkpoint: { summary?: string; next?: string; complete?: boolean }
  lease_token: string | null
  output_ids: string[]
  receipt_id: string | null
  callback_pending: boolean
  project_id: string
}
export const visibleMemory =
  "(m.scope='organization' OR (m.scope='project' AND EXISTS(SELECT 1 FROM projects p WHERE p.org_id=m.org_id AND p.id=m.project_id AND p.policy='org_visible' AND p.status='active')))"
export class DreamStore {
  constructor(readonly pool: Pool) {}
  async scoped<T>(owner: Pick<HivemindPrincipal, 'orgId' | 'userId'>, action: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect()
    try {
      await db.query('BEGIN')
      await db.query("SELECT set_config('app.hivemind_org_id',$1,true),set_config('app.hivemind_user_id',$2,true)", [
        owner.orgId,
        owner.userId,
      ])
      const member = await db.query(
        'SELECT role FROM user_organizations m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 AND m.user_id=$2 AND m.is_active=true AND m.deactivated_at IS NULL AND u.deleted_at IS NULL',
        [owner.orgId, owner.userId],
      )
      if (member.rowCount !== 1) throw new Error('dreamer_membership_required')
      const result = await action(db)
      await db.query('COMMIT')
      return result
    } catch (error) {
      await db.query('ROLLBACK')
      throw error
    } finally {
      db.release()
    }
  }
  async connectorSettings(owner: HivemindPrincipal): Promise<{ enabled: boolean; revision: number; accounts: DreamAccount[] }> {
    return this.scoped(owner, async db => (await db.query<{ enabled: boolean; revision: number; accounts: DreamAccount[] }>(
      'SELECT enabled,revision,accounts FROM harness_dream_connector_settings WHERE org_id=$1 AND user_id=$2', [owner.orgId, owner.userId],
    )).rows[0] ?? { enabled: false, revision: 0, accounts: [] })
  }
  async setConnectors(owner: HivemindPrincipal, enabled: boolean, accounts: DreamAccount[]): Promise<void> {
    await this.scoped(owner, async (db) => { await db.query(
      `INSERT INTO harness_dream_connector_settings(org_id,user_id,enabled,accounts) VALUES($1,$2,$3,$4::jsonb)
       ON CONFLICT(org_id,user_id) DO UPDATE SET enabled=$3,accounts=$4::jsonb,revision=harness_dream_connector_settings.revision+1,updated_at=now()`,
      [owner.orgId, owner.userId, enabled, JSON.stringify(accounts)],
    ) })
  }
  async connectorGrants(owner: HivemindPrincipal): Promise<DreamGrant[]> {
    return this.scoped(owner, async (db) => {
      const rows = (await db.query<{ user_id: string; accounts: DreamAccount[] }>(
        `SELECT s.user_id,s.accounts FROM harness_dream_connector_settings s
         JOIN user_organizations m ON m.org_id=s.org_id AND m.user_id=s.user_id AND m.is_active=true AND m.deactivated_at IS NULL
         JOIN users u ON u.id=s.user_id AND u.deleted_at IS NULL
         WHERE s.org_id=$1 AND s.enabled=true ORDER BY s.user_id`, [owner.orgId],
      )).rows
      return rows.flatMap(row => row.accounts.map(account => ({ ...account, userId: row.user_id })))
    })
  }
  async connectorContracts(owner: HivemindPrincipal, toolkit: string, ttlMs: number): Promise<DreamContract[] | undefined> {
    return this.scoped(owner, async db => (await db.query<{ contracts: DreamContract[] }>(
      "SELECT contracts FROM harness_dream_connector_contracts WHERE org_id=$1 AND toolkit=$2 AND fetched_at>now()-($3::bigint*interval '1 millisecond')",
      [owner.orgId, toolkit, ttlMs],
    )).rows[0]?.contracts)
  }
  async cacheConnectorContracts(owner: HivemindPrincipal, toolkit: string, contracts: DreamContract[]): Promise<void> {
    await this.scoped(owner, async (db) => { await db.query(
      `INSERT INTO harness_dream_connector_contracts(org_id,toolkit,contracts) VALUES($1,$2,$3::jsonb)
       ON CONFLICT(org_id,toolkit) DO UPDATE SET contracts=$3::jsonb,fetched_at=now()`, [owner.orgId, toolkit, JSON.stringify(contracts)],
    ) })
  }
  async connectorEvidence(run: DreamRun, source: {
    id: string
    userId: string
    accountId: string
    title: string
    content: string
    provenance: unknown
  }): Promise<void> {
    await this.scoped({ orgId: run.org_id, userId: run.user_id }, async (db) => { await db.query(
      `INSERT INTO harness_dream_connector_evidence(org_id,id,run_id,user_id,account_id,title,content,provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       ON CONFLICT(org_id,id) DO NOTHING`, [run.org_id, source.id, run.id, source.userId, source.accountId, source.title, source.content, JSON.stringify(source.provenance)],
    ) })
  }
  async readConnectorEvidence(owner: HivemindPrincipal, ids: string[]): Promise<Array<{
    id: string
    title: string
    content: string
    provenance: Record<string, unknown>
  }>> {
    if (!ids.length) return []
    return this.scoped(owner, async db => (await db.query<{
      id: string
      title: string
      content: string
      provenance: Record<string, unknown>
    }>(
      `SELECT e.id,e.title,e.content,e.provenance FROM harness_dream_connector_evidence e
       JOIN harness_dream_connector_settings s ON s.org_id=e.org_id AND s.user_id=e.user_id AND s.enabled=true
       JOIN user_organizations m ON m.org_id=e.org_id AND m.user_id=e.user_id AND m.is_active=true AND m.deactivated_at IS NULL
       JOIN users u ON u.id=e.user_id AND u.deleted_at IS NULL
       WHERE e.org_id=$1 AND e.id=ANY($2::uuid[]) AND s.accounts @> jsonb_build_array(jsonb_build_object('id',e.account_id))`, [owner.orgId, ids],
    )).rows)
  }
  async supported(owner: HivemindPrincipal): Promise<boolean> {
    return this.scoped(
      owner,
      async db =>
        (
          await db.query(
            "SELECT 1 FROM organizations WHERE id=$1 AND COALESCE(hosting_mode,'managed')='managed' AND memory_storage_mode='hybrid'",
            [owner.orgId],
          )
        ).rowCount === 1,
    )
  }
  async setting(owner: HivemindPrincipal): Promise<DreamSetting | undefined> {
    return this.scoped(
      owner,
      async db => (await db.query<DreamSetting>('SELECT * FROM harness_dream_settings WHERE org_id=$1', [owner.orgId])).rows[0],
    )
  }
  async setEnabled(owner: HivemindPrincipal, enabled: boolean): Promise<DreamSetting> {
    return this.scoped(owner, async (db) => {
      const admin = await db.query("SELECT 1 FROM user_organizations WHERE org_id=$1 AND user_id=$2 AND role IN ('admin','owner')", [
        owner.orgId,
        owner.userId,
      ])
      if (admin.rowCount !== 1) throw new Error('dreamer_admin_required')
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`dream-settings:${owner.orgId}`])
      const prior = (await db.query<DreamSetting>('SELECT * FROM harness_dream_settings WHERE org_id=$1', [owner.orgId])).rows[0]
      if (prior?.enabled === enabled) return prior
      let projectId = prior?.project_id ?? null
      if (enabled) {
        const local = await db.query(
          "SELECT 1 FROM organizations WHERE id=$1 AND COALESCE(hosting_mode,'managed')='managed' AND memory_storage_mode='hybrid'",
          [owner.orgId],
        )
        if (local.rowCount !== 1) throw new Error('dreamer_residency_adapter_required')
        const project = await db.query<{ id: string; name: string; policy: string; description: string }>(
          "INSERT INTO projects(org_id,name,slug,description,policy,created_by,self_evolve_enabled,updated_at) VALUES($1,'Flashbacks','flashbacks','DSH Dreamer derived memories with source provenance.','org_visible',$2,false,now()) ON CONFLICT(org_id,slug) DO UPDATE SET slug=EXCLUDED.slug RETURNING id,name,policy,description",
          [owner.orgId, owner.userId],
        )
        const value = project.rows[0]
        if (!value) throw new Error('flashbacks_project_not_created')
        if (
          value.name !== 'Flashbacks' ||
          value.policy !== 'org_visible' ||
          value.description !== 'DSH Dreamer derived memories with source provenance.'
        )
          throw new Error('flashbacks_reserved_project_conflict')
        projectId = value.id
        await db.query(
          "INSERT INTO project_members(project_id,user_id,role,added_by) VALUES($1,$2,'owner',$2) ON CONFLICT(project_id,user_id) DO NOTHING",
          [projectId, owner.userId],
        )
      }
      const setting = (
        await db.query<DreamSetting>(
          'INSERT INTO harness_dream_settings(org_id,user_id,enabled,revision,project_id) VALUES($1,$2,$3,1,$4) ON CONFLICT(org_id) DO UPDATE SET user_id=$2,enabled=$3,revision=harness_dream_settings.revision+1,project_id=$4,updated_at=now() RETURNING *',
          [owner.orgId, owner.userId, enabled, projectId],
        )
      ).rows[0]
      if (!setting) throw new Error('dreamer_setting_not_saved')
      await db.query(
        'INSERT INTO harness_dream_due(org_id,user_id,needs_sync) VALUES($1,$2,true) ON CONFLICT(org_id) DO UPDATE SET user_id=$2,needs_sync=true,has_callbacks=true',
        [owner.orgId, owner.userId],
      )
      if (!enabled)
        await db.query(
          "UPDATE harness_dream_runs SET status='failed',receipt_id=COALESCE(receipt_id,gen_random_uuid()::text),callback_pending=true,error_code='disabled',lease_until=NULL WHERE org_id=$1 AND status IN ('queued','running')",
          [owner.orgId],
        )
      if (!enabled)
        await db.query('UPDATE harness_dream_due SET lease_until=NULL,has_work=false,has_callbacks=true WHERE org_id=$1', [owner.orgId])
      return setting
    })
  }
  /** An introduction is one durable occurrence per company, serialized with scheduled admission. */
  async ensureIntroduction(owner: HivemindPrincipal): Promise<void> {
    await this.scoped(owner, async (db) => {
      const setting = (await db.query<DreamSetting>('SELECT * FROM harness_dream_settings WHERE org_id=$1 FOR UPDATE', [owner.orgId])).rows[0]
      if (!setting?.enabled || !setting.project_id) return
      const prior = await db.query('SELECT 1 FROM harness_dream_runs WHERE org_id=$1 LIMIT 1', [owner.orgId])
      if (prior.rowCount) return
      const address = await this.sessionAddress(owner, db)
      const key = 'dreaming-introduction-v1'
      await db.query(`INSERT INTO harness_dream_runs(id,org_id,user_id,revision,occurrence_key,occurrence_id,trigger_id,parent_id,child_id,project_id)
        VALUES($1,$2,$3,$4,$5,$6,'introduction',$7,$8,$9) ON CONFLICT(org_id,occurrence_key) DO NOTHING`,
      [stableId(`${owner.orgId}:${key}`), owner.orgId, setting.user_id, setting.revision, key, stableId(`${owner.orgId}:welcome`), address.parentSessionId, address.childSessionId, setting.project_id])
      await db.query('UPDATE harness_dream_due SET has_work=true WHERE org_id=$1', [owner.orgId])
    })
  }
  async sessionCredits(owner: HivemindPrincipal, sessionId: string): Promise<number | undefined> {
    return this.scoped(owner, async (db) => {
      const allowed = await db.query(`SELECT 1 FROM harness_sessions WHERE org_id=$1 AND user_id=$2 AND id=$3
        UNION ALL SELECT 1 FROM harness_dream_runs WHERE org_id=$1 AND child_id=$3 LIMIT 1`, [owner.orgId, owner.userId, sessionId])
      if (!allowed.rowCount) return undefined
      const row = (await db.query<{ credits: string }>(`SELECT COALESCE(SUM(quantity),0)::text AS credits FROM usage_events
        WHERE org_id=$1 AND metric='credits_consumed' AND state='settled' AND metadata->>'session_id'=$2`, [owner.orgId, sessionId])).rows[0]
      return Number(row?.credits ?? 0)
    })
  }
  async accept(orgId: string, key: string, occurrenceId: string, triggerId: string, revision: number): Promise<DreamRun> {
    const indexed = (await this.pool.query<{ user_id: string }>('SELECT user_id FROM harness_dream_due WHERE org_id=$1', [orgId])).rows[0]
    if (!indexed) throw new Error('dreamer_disabled')
    return this.scoped({ orgId, userId: indexed.user_id }, async (db) => {
      const prior = (await db.query<DreamRun>('SELECT * FROM harness_dream_runs WHERE org_id=$1 AND occurrence_key=$2', [orgId, key]))
        .rows[0]
      if (prior) return prior
      const settings = (await db.query<DreamSetting>('SELECT * FROM harness_dream_settings WHERE org_id=$1 FOR UPDATE', [orgId])).rows[0]
      if (!settings?.enabled || settings.revision !== revision || !settings.project_id) throw new Error('dreamer_disabled_or_stale')
      const session = await this.sessionAddress({ orgId, userId: settings.user_id }, db)
      const id = stableId(`${orgId}:${key}`),
        parent = session.parentSessionId,
        child = session.childSessionId
      await db.query('UPDATE harness_dream_due SET has_work=true WHERE org_id=$1', [orgId])
      const accepted = (
        await db.query<DreamRun>(
          'INSERT INTO harness_dream_runs(id,org_id,user_id,revision,occurrence_key,occurrence_id,trigger_id,parent_id,child_id,project_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(org_id,occurrence_key) DO UPDATE SET occurrence_key=EXCLUDED.occurrence_key RETURNING *',
          [id, orgId, settings.user_id, revision, key, occurrenceId, triggerId, parent, child, settings.project_id],
        )
      ).rows[0]
      if (!accepted) throw new Error('dreamer_run_not_accepted')
      return accepted
    })
  }
  /** Reuse the earliest retained tenant conversation; occurrence receipts remain separate. */
  async sessionAddress(owner: Pick<HivemindPrincipal, 'orgId' | 'userId'>, db?: PoolClient): Promise<{ parentSessionId: string; childSessionId: string; mode: 'continuable' }> {
    const read = async (connection: PoolClient) => {
      const first = (await connection.query<{ parent_id: string; child_id: string }>(
        'SELECT parent_id,child_id FROM harness_dream_runs WHERE org_id=$1 ORDER BY created_at,id LIMIT 1', [owner.orgId],
      )).rows[0]
      return { parentSessionId: first?.parent_id ?? `session-${stableId(`dream-parent:${owner.orgId}`)}`,
        childSessionId: first?.child_id ?? `session-${stableId(`dream-child:${owner.orgId}`)}`, mode: 'continuable' as const }
    }
    return db ? read(db) : this.scoped(owner, read)
  }
  async get(owner: HivemindPrincipal, id: string): Promise<DreamRun | undefined> {
    return this.scoped(
      owner,
      async db => (await db.query<DreamRun>('SELECT * FROM harness_dream_runs WHERE org_id=$1 AND id=$2', [owner.orgId, id])).rows[0],
    )
  }
  async claim(limit: number, leaseMs: number): Promise<DreamRun | undefined> {
    const db = await this.pool.connect()
    try {
      await db.query('BEGIN')
      await db.query("SELECT set_config('app.hivemind_dream_scheduler','on',true)")
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['dreamer-capacity'])
      // The trusted index contains IDs/leases only; retrieve run content under its owner below.
      const active = await db.query('SELECT 1 FROM harness_dream_due WHERE lease_until>now()')
      if ((active.rowCount ?? 0) >= limit) {
        await db.query('COMMIT')
        return undefined
      }
      const row = (
        await db.query<{ org_id: string; user_id: string }>(
          'SELECT d.org_id,d.user_id FROM harness_dream_due d WHERE d.has_work AND (d.lease_until IS NULL OR d.lease_until<=now()) ORDER BY d.last_admitted_at NULLS FIRST,d.org_id FOR UPDATE SKIP LOCKED LIMIT 1',
        )
      ).rows[0]
      if (!row) {
        await db.query('COMMIT')
        return undefined
      }
      await db.query("SELECT set_config('app.hivemind_org_id',$1,true),set_config('app.hivemind_user_id',$2,true)", [
        row.org_id,
        row.user_id,
      ])
      const run = (
        await db.query<DreamRun>(
          "SELECT r.* FROM harness_dream_runs r JOIN harness_dream_settings s ON s.org_id=r.org_id AND s.enabled AND s.revision=r.revision WHERE r.org_id=$1 AND r.status IN ('queued','running') AND (r.lease_until IS NULL OR r.lease_until<=now()) ORDER BY r.created_at,r.id LIMIT 1 FOR UPDATE OF r",
          [row.org_id],
        )
      ).rows[0]
      await db.query('UPDATE harness_dream_due SET last_admitted_at=now() WHERE org_id=$1', [row.org_id])
      if (!run) {
        await db.query('UPDATE harness_dream_due SET has_work=false WHERE org_id=$1', [row.org_id])
        await db.query('COMMIT')
        return undefined
      }
      const session = await this.sessionAddress({ orgId: row.org_id, userId: row.user_id }, db)
      const token = stableId(`${run.id}:${Date.now()}:${Math.random()}`)
      await db.query(
        "UPDATE harness_dream_runs SET status='running',lease_token=$2,lease_until=now()+($3::int*interval '1 millisecond'),attempts=attempts+1,parent_id=$4,child_id=$5 WHERE id=$1",
        [run.id, token, leaseMs, session.parentSessionId, session.childSessionId],
      )
      await db.query("UPDATE harness_dream_due SET lease_token=$2,lease_until=now()+($3::int*interval '1 millisecond') WHERE org_id=$1", [
        row.org_id,
        token,
        leaseMs,
      ])
      await db.query('COMMIT')
      return { ...run, parent_id: session.parentSessionId, child_id: session.childSessionId, status: 'running', attempts: run.attempts + 1, lease_token: token }
    } catch (error) {
      await db.query('ROLLBACK')
      throw error
    } finally {
      db.release()
    }
  }
  async heartbeat(run: DreamRun, leaseMs: number): Promise<boolean> {
    return this.scoped({ orgId: run.org_id, userId: run.user_id }, async (db) => {
      const updated = await db.query(
        "UPDATE harness_dream_runs r SET lease_until=now()+($3::int*interval '1 millisecond') FROM harness_dream_settings s WHERE r.id=$1 AND r.lease_token=$2 AND r.status='running' AND s.org_id=r.org_id AND s.enabled AND s.revision=r.revision RETURNING r.id",
        [run.id, run.lease_token, leaseMs],
      )
      if (updated.rowCount !== 1) return false
      await db.query(
        "UPDATE harness_dream_due SET lease_until=now()+($3::int*interval '1 millisecond') WHERE org_id=$1 AND lease_token=$2",
        [run.org_id, run.lease_token, leaseMs],
      )
      return true
    })
  }
  async update(run: DreamRun, patch: { checkpoint?: unknown; status?: string; error?: string }): Promise<void> {
    await this.scoped({ orgId: run.org_id, userId: run.user_id }, async (db) => {
      const terminal = patch.status === 'completed' || patch.status === 'failed'
      const result = await db.query(
        "UPDATE harness_dream_runs SET checkpoint=COALESCE($3::jsonb,checkpoint),status=COALESCE($4,status),error_code=$5,receipt_id=CASE WHEN $6 THEN COALESCE(receipt_id,gen_random_uuid()::text) ELSE receipt_id END,callback_pending=callback_pending OR $6,updated_at=now(),lease_until=CASE WHEN $6 THEN NULL ELSE lease_until END WHERE id=$1 AND lease_token=$2 AND status='running' RETURNING id",
        [
          run.id,
          run.lease_token,
          patch.checkpoint === undefined ? null : JSON.stringify(patch.checkpoint),
          patch.status ?? null,
          patch.error ?? null,
          terminal,
        ],
      )
      if (result.rowCount !== 1) throw new Error('dreamer_lease_lost')
      if (terminal)
        await db.query('UPDATE harness_dream_due SET lease_until=NULL,has_callbacks=true WHERE org_id=$1 AND lease_token=$2', [
          run.org_id,
          run.lease_token,
        ])
    })
  }
  async previous(owner: HivemindPrincipal): Promise<unknown> {
    return this.scoped(
      owner,
      async db =>
        (
          await db.query(
            'SELECT id,status,checkpoint,output_ids,created_at,updated_at,error_code,parent_id,child_id FROM harness_dream_runs WHERE org_id=$1 ORDER BY created_at DESC LIMIT 10',
            [owner.orgId],
          )
        ).rows,
    )
  }
  async recent(owner: HivemindPrincipal, after: string | undefined, limit: number): Promise<unknown> {
    const [time, id] = after?.split('|') ?? []
    return this.scoped(
      owner,
      async db =>
        (
          await db.query(
            `SELECT m.id,m.title,left(m.content,6000) AS content,m.created_at,m.project_id,m.tags,(SELECT sm.metadata FROM source_metadata sm WHERE sm.memory_id=m.id) AS metadata FROM memories m WHERE m.org_id=$1 AND m.deleted_at IS NULL AND ${visibleMemory} AND ($2::timestamptz IS NULL OR (m.created_at,m.id)>($2::timestamptz,$4::uuid)) ORDER BY m.created_at,m.id LIMIT $3`,
            [owner.orgId, time ?? null, limit, id ?? '00000000-0000-0000-0000-000000000000'],
          )
        ).rows,
    )
  }
  async read(owner: HivemindPrincipal, ids: string[]): Promise<unknown[]> {
    return this.scoped(
      owner,
      async db =>
        (
          await db.query(
            `SELECT m.id,m.title,m.content,m.created_at,m.project_id,m.tags,(SELECT sm.metadata FROM source_metadata sm WHERE sm.memory_id=m.id) AS metadata FROM memories m WHERE m.org_id=$1 AND m.id=ANY($2::uuid[]) AND m.deleted_at IS NULL AND ${visibleMemory}`,
            [owner.orgId, ids],
          )
        ).rows,
    )
  }
  async walk(owner: HivemindPrincipal, id: string, limit: number): Promise<unknown> {
    return this.scoped(
      owner,
      async db =>
        (
          await db.query(
            `SELECT r.type,r.confidence,m.id,m.title,left(m.content,6000) AS content FROM relationships r JOIN memories a ON a.id=$2 AND a.org_id=$1 AND a.deleted_at IS NULL JOIN memories m ON m.id=CASE WHEN r.from_id=a.id THEN r.to_id ELSE r.from_id END WHERE (r.from_id=a.id OR r.to_id=a.id) AND m.org_id=$1 AND m.deleted_at IS NULL AND ${visibleMemory} AND (a.scope='organization' OR (a.scope='project' AND EXISTS(SELECT 1 FROM projects p WHERE p.id=a.project_id AND p.org_id=$1 AND p.policy='org_visible' AND p.status='active'))) ORDER BY r.created_at DESC LIMIT $3`,
            [owner.orgId, id, limit],
          )
        ).rows,
    )
  }
  async reserveOutput(run: DreamRun, candidate: Candidate): Promise<{ key: string; receipt: unknown | null }> {
    return this.scoped({ orgId: run.org_id, userId: run.user_id }, async (db) => {
      const owned = await db.query(
        "SELECT 1 FROM harness_dream_runs r JOIN harness_dream_settings s ON s.org_id=r.org_id AND s.enabled AND s.revision=r.revision WHERE r.id=$1 AND r.lease_token=$2 AND r.status='running'",
        [run.id, run.lease_token],
      )
      if (owned.rowCount !== 1) throw new Error('dreamer_lease_lost')
      const key = candidateKey(run.org_id, candidate)
      await db.query(
        'INSERT INTO harness_dream_outputs(org_id,idempotency_key,run_id,candidate) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(org_id,idempotency_key) DO UPDATE SET run_id=EXCLUDED.run_id WHERE harness_dream_outputs.receipt IS NULL',
        [run.org_id, key, run.id, JSON.stringify(candidate)],
      )
      const row = (
        await db.query<{ receipt: unknown }>('SELECT receipt FROM harness_dream_outputs WHERE org_id=$1 AND idempotency_key=$2', [
          run.org_id,
          key,
        ])
      ).rows[0]
      if (!row) throw new Error('dreamer_candidate_not_reserved')
      return { key, receipt: row.receipt }
    })
  }
  async outputSaved(run: DreamRun, key: string, memoryId: string, receipt: unknown): Promise<void> {
    await this.scoped({ orgId: run.org_id, userId: run.user_id }, async (db) => {
      const verified = await db.query(
        "SELECT 1 FROM memories WHERE id=$1 AND org_id=$2 AND project_id=$3 AND scope='project' AND deleted_at IS NULL",
        [memoryId, run.org_id, run.project_id],
      )
      if (verified.rowCount !== 1) throw new Error('flashbacks_destination_not_verified')
      await db.query('UPDATE harness_dream_outputs SET memory_id=$3,receipt=$4::jsonb WHERE org_id=$1 AND idempotency_key=$2', [
        run.org_id,
        key,
        memoryId,
        JSON.stringify(receipt),
      ])
      const updated = await db.query(
        "UPDATE harness_dream_runs SET output_ids=CASE WHEN $3=ANY(output_ids) THEN output_ids ELSE array_append(output_ids,$3) END WHERE id=$1 AND lease_token=$2 AND status='running' RETURNING id",
        [run.id, run.lease_token, memoryId],
      )
      if (updated.rowCount !== 1) throw new Error('dreamer_lease_lost')
    })
  }
}
