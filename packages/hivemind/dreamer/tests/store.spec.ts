import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { Pool } from 'pg'
import { DreamStore } from '../src/store.ts'
import type { HivemindPrincipal } from '@deepseek-ai/dsh-hivemind-execution-scope'
const url = process.env.DSH_DREAM_TEST_URL
const suite = url ? describe : describe.skip
suite('PostgreSQL Dreamer isolation and durability', () => {
  const schema = `dream_${randomUUID().replaceAll('-', '')}`
  const a: HivemindPrincipal = { orgId: randomUUID(), userId: randomUUID(), profile: 'hivemind-chat', variation: 'harness' },
    b: HivemindPrincipal = { ...a, orgId: randomUUID(), userId: randomUUID() }
  let admin: Pool, pool: Pool, store: DreamStore
  beforeAll(async () => {
    const parsed = new URL(url!)
    if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.pathname !== '/dreamer_test')
      throw new Error('Disposable local dreamer_test required')
    admin = new Pool({ connectionString: url, options: `-c search_path=${schema},public` })
    await admin.query(
      `CREATE SCHEMA ${schema};DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='codex_dreamer_test') THEN CREATE ROLE codex_dreamer_test NOLOGIN NOSUPERUSER NOBYPASSRLS;END IF;END $$;`,
    )
    await admin.query(await readFile(new URL('./fixture.sql', import.meta.url), 'utf8'))
    await admin.query((await readFile(new URL('./migration.sql', import.meta.url), 'utf8')).replaceAll('hivemind.', `${schema}.`))
    for (const p of [a, b]) {
      await admin.query('INSERT INTO organizations(id) VALUES($1)', [p.orgId])
      await admin.query('INSERT INTO users(id) VALUES($1)', [p.userId])
      await admin.query('INSERT INTO user_organizations(user_id,org_id) VALUES($1,$2)', [p.userId, p.orgId])
    }
    await admin.query(
      `GRANT USAGE ON SCHEMA ${schema} TO codex_dreamer_test;GRANT ALL ON ALL TABLES IN SCHEMA ${schema} TO codex_dreamer_test;GRANT ALL ON ALL SEQUENCES IN SCHEMA ${schema} TO codex_dreamer_test`,
    )
    pool = new Pool({ connectionString: url, options: `-c search_path=${schema},public -c role=codex_dreamer_test` })
    store = new DreamStore(pool)
  })
  afterAll(async () => {
    await pool?.end()
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`)
      await admin.end()
    }
  })
  it('defaults off and creates a reserved company-visible project only on opt-in', async () => {
    expect(await store.setting(a)).toBeUndefined()
    const s = await store.setEnabled(a, true)
    expect(s.enabled).toBe(true)
    const project = (await admin.query('SELECT * FROM projects WHERE id=$1', [s.project_id])).rows[0]
    expect(project.name).toBe('Flashbacks')
    expect(project.policy).toBe('org_visible')
    expect((await store.setEnabled(a, true)).revision).toBe(s.revision)
  })
  it('enforces administrator writes and active membership', async () => {
    const member = { ...a, userId: randomUUID() }
    await admin.query('INSERT INTO users(id) VALUES($1)', [member.userId])
    await admin.query("INSERT INTO user_organizations(user_id,org_id,role) VALUES($1,$2,'member')", [member.userId, a.orgId])
    expect((await store.setting(member))?.enabled).toBe(true)
    await expect(store.setEnabled(member, false)).rejects.toThrow('admin_required')
    await expect(store.setting({ ...a, orgId: b.orgId })).rejects.toThrow('membership_required')
  })
  it('accepts exactly one durable run for duplicate occurrence deliveries', async () => {
    const setting = (await store.setting(a))!
    const key = `${a.orgId}:dreaming:100`
    const runs = await Promise.all([
      store.accept(a.orgId, key, key, 'dreaming', setting.revision),
      store.accept(a.orgId, key, key, 'dreaming', setting.revision),
    ])
    expect(runs[0]!.id).toBe(runs[1]!.id)
    expect(await store.get(b, runs[0]!.id)).toBeUndefined()
  })
  it('globally limits admission, keeps a single lease per tenant, and fences stale workers', async () => {
    const run = await store.claim(1, 10000)
    expect(run).toBeDefined()
    expect(await store.claim(1, 10000)).toBeUndefined()
    expect(await store.heartbeat(run!, 10000)).toBe(true)
    await expect(store.update({ ...run!, lease_token: 'old' }, { checkpoint: {} })).rejects.toThrow('lease_lost')
    await store.update(run!, { checkpoint: { summary: 'checked', next: 'follow temporal link', complete: false }, status: 'completed' })
    expect((await store.get(a, run!.id))?.checkpoint.summary).toBe('checked')
  })
  it('reads only company-visible evidence and follows same-tenant graph edges', async () => {
    const visible = randomUUID(),
      privateId = randomUUID(),
      foreign = randomUUID()
    for (const [id, org, scope] of [
      [visible, a.orgId, 'organization'],
      [privateId, a.orgId, 'personal'],
      [foreign, b.orgId, 'organization'],
    ])
      await admin.query('INSERT INTO memories(id,org_id,user_id,content,scope) VALUES($1,$2,$3,$4,$5)', [
        id,
        org,
        a.userId,
        'evidence',
        scope,
      ])
    expect(((await store.read(a, [visible, privateId, foreign])) as Array<{ id: string }>).map(x => x.id)).toEqual([visible])
    await admin.query("INSERT INTO relationships(from_id,to_id,type) VALUES($1,$2,'Derives')", [visible, foreign])
    expect(await store.walk(a, visible, 20)).toEqual([])
  })
  it('reclaims an expired run with its checkpoint, child identity and saved output receipt', async () => {
    const setting = (await store.setting(a))!,
      key = `${a.orgId}:dreaming:101`
    const accepted = await store.accept(a.orgId, key, key, 'dreaming', setting.revision)
    const run = (await store.claim(1, 10000))!
    await store.update(run, { checkpoint: { summary: 'Evidence collected', next: 'Continue next path', complete: false } })
    const source = randomUUID()
    await admin.query("INSERT INTO memories(id,org_id,user_id,content,scope,project_id) VALUES($1,$2,$3,'Derived fixture','project',$4)", [
      source,
      a.orgId,
      a.userId,
      setting.project_id,
    ])
    const candidate = {
      title: 'Repeat-safe dream',
      content: 'Supported connection',
      sourceIds: [source],
      entities: [],
      reasoningType: 'pattern' as const,
      confidence: 0.6,
    }
    const reserved = await store.reserveOutput(run, candidate)
    await store.outputSaved(run, reserved.key, source, { status: 'saved', memory_id: source })
    await admin.query("UPDATE harness_dream_runs SET lease_until=now()-interval '1 second' WHERE id=$1", [run.id])
    await admin.query("UPDATE harness_dream_due SET lease_until=now()-interval '1 second' WHERE org_id=$1", [a.orgId])
    const recovered = (await store.claim(1, 10000))!
    expect(recovered.id).toBe(accepted.id)
    expect(recovered.child_id).toBe(run.child_id)
    expect(recovered.checkpoint.summary).toBe('Evidence collected')
    expect(recovered.lease_token).not.toBe(run.lease_token)
    expect((await store.reserveOutput(recovered, candidate)).receipt).toEqual({ status: 'saved', memory_id: source })
    await expect(store.outputSaved(run, reserved.key, source, {})).rejects.toThrow('lease_lost')
    await store.update(recovered, { status: 'completed' })
  })
  it('refuses activation for a remote memory store without its read adapter', async () => {
    await admin.query("UPDATE organizations SET hosting_mode='self_host' WHERE id=$1", [b.orgId])
    expect(await store.supported(b)).toBe(false)
    await expect(store.setEnabled(b, true)).rejects.toThrow('residency_adapter_required')
    expect(await store.setting(b)).toBeUndefined()
  })
  it('turning off fences an active run and emits a cancellation receipt', async () => {
    const setting = (await store.setting(a))!,
      key = `${a.orgId}:dreaming:102`
    await store.accept(a.orgId, key, key, 'dreaming', setting.revision)
    const run = (await store.claim(1, 10000))!
    await store.setEnabled(a, false)
    expect(await store.heartbeat(run, 10000)).toBe(false)
    const stopped = (await store.get(a, run.id))!
    expect(stopped.status).toBe('failed')
    expect(stopped.callback_pending).toBe(true)
    expect(stopped.receipt_id).toBeTruthy()
    await expect(store.update(run, { status: 'completed' })).rejects.toThrow('lease_lost')
  })
  it('disables new occurrences and retains saved history', async () => {
    const s = await store.setEnabled(a, false)
    await expect(store.accept(a.orgId, `${a.orgId}:dreaming:200`, 'new', 'dreaming', s.revision)).rejects.toThrow('disabled')
    expect(await store.previous(a)).not.toEqual([])
  })
})
