/** Isolated native AgentLoop/JSONL/Schedule persistence restart proof. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import PostgresSessionPersistence from '@deepseek-ai/dsh-session-persistence-postgres'
import PostgresScheduleBackend from '@deepseek-ai/dsh-hivemind-schedule-postgres'
import ExecutionScope from '@deepseek-ai/dsh-hivemind-execution-scope'
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import ScheduleService from '@deepseek-ai/dsh-schedule'
import { expect, it } from 'vitest'
// Linux fixture uses real native locks, PostgreSQL leases, RLS and timer persistence.
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { installServiceRecovery } from '../src/service-recovery.ts'

const postgresProof=process.env.RECOVERY_ADMIN_DB ? it : it.skip
postgresProof('restores a PostgreSQL crash-repaired native session and delivers exactly one durable recovery occurrence', async () => {
  const target=new URL(process.env.RECOVERY_ADMIN_DB!)
  if(target.hostname!=='fixture-pg'||target.pathname!=='/schedule_test'||target.username!=='postgres')throw Error('Disposable internal fixture-pg/schedule_test required')
  const root = await mkdtemp(join(tmpdir(), 'hq-pg-recovery-proof-'))
  const schema='recovery_proof'
  const owner={ orgId:randomUUID(), userId:randomUUID(), profile:'hivemind-chat' as const, variation:'harness' }
  const admin=new Pool({ connectionString:process.env.RECOVERY_ADMIN_DB,options:`-c search_path=${schema},public` })
  await admin.query(`CREATE SCHEMA ${schema}; CREATE ROLE recovery_fixture NOLOGIN NOSUPERUSER NOBYPASSRLS`)
  for (const path of ['../../schedule-postgres/tests/sessions.sql','../../schedule-postgres/migrations/schedule.sql','../migrations/company-hq.sql']) await admin.query(await readFile(new URL(path,import.meta.url),'utf8'))
  await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO recovery_fixture; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO recovery_fixture; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO recovery_fixture`)
  await admin.query('INSERT INTO users VALUES($1,NULL)',[owner.userId])
  await admin.query('INSERT INTO user_organizations(user_id,org_id) VALUES($1,$2)',[owner.userId,owner.orgId])
  const role=(await admin.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='recovery_fixture'")).rows[0];expect(role).toEqual({ rolsuper:false,rolbypassrls:false })
  const appURL=new URL(process.env.RECOVERY_ADMIN_DB!);appURL.searchParams.set('options',`-c role=recovery_fixture -c search_path=${schema},public`);process.env.RECOVERY_FIXTURE_DB=appURL.toString()
  const contexts: Context[] = []
  const id = SessionId('isolated-restart-owner')
  const adapter = new MockAdapter([textResponse('I’m continuing the saved work.')])
  async function open() {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(ExecutionScope)
    await ctx.plugin(PostgresSessionPersistence,{ connectionStringEnv:'RECOVERY_FIXTURE_DB',schema,leaseTtlMs:30000,maxConnections:2 })
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: join(root, 'schedule') })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    ctx.provide('sessionController', { resolveAgent: async () => {
      const agent = ctx.agents.get(id) ?? (await ctx.agents.resume({ resumeSessionId:id,agentOptions:{ provider:'mock',model:'mock' } })).agent
      return { agent }
    } } as never)
    await ctx.plugin(PostgresScheduleBackend,{ connectionStringEnv:'RECOVERY_FIXTURE_DB',schema,pollIntervalMs:100,retryIntervalMs:1000,batchSize:5,maxConnections:2,statementTimeoutMs:5000,maxTasksPerUser:10 })
    await ctx.plugin(ScheduleService,{ storage:'external' })
    installServiceRecovery(ctx)
    return ctx
  }
  try {
    const first = await open()
    const agent = (await first.hivemindExecutionScope.run(owner,()=>first.agents.create({ sessionId:id,meta:{ agentPreset:'hivemind-hq' } }))).agent
    agent.session.append('agent-preset/selected', { agentPreset: 'hivemind-hq' })
    agent.session.append('hivemind/hq-mode', { revision: 1, enabled: true, changedAt: Date.now() })
    agent.session.append('turn/start', { turn: 0 })
    agent.session.append('step/start', { turn: 0, step: 0 })
    await first.sessions.flush(agent.session)
    const prompt = '[HIVEMIND SERVICE RECOVERY]\n' + JSON.stringify({ sessionId: id, rootId: id, turn: 0, modeRevision: 1 }) + '\nResume saved work.'
    await admin.query('INSERT INTO harness_company_hq(org_id,user_id,session_id) VALUES($1,$2,$3)',[owner.orgId,owner.userId,id])
    const saved = await first.hivemindExecutionScope.run(owner,()=>first.schedule.ensure(id, 'hivemind-service-recovery-turn-0', {
      title:'Service interruption recovery',after_seconds:1,prompt,
    }))
    await first.fiber.dispose()
    const second = await open()
    const restored = (await second.hivemindExecutionScope.run(owner,()=>second.agents.resume({ resumeSessionId:id,agentOptions:{ provider:'mock',model:'mock' } }))).agent
    expect(restored.session.ownEvents().some(event => event.type === 'turn/end' && event.data.reason.kind === 'interrupted')).toBe(true)
    const inserted = Promise.withResolvers<undefined>()
    second.on('agent/inbox/inserted', ({ message }) => { if (message.source.kind === 'schedule') inserted.resolve(undefined) })
    {
      await Promise.race([inserted.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('no persisted recovery delivery')), 4000))])
      await second.sessions.flush(restored.session)
      const deliveries = restored.session.ownEvents().flatMap(event => event.type === 'agent/inbox/spliced'
        ? event.data.inserted.filter(message => message.source.kind === 'schedule') : [])
      expect(deliveries).toHaveLength(1)
      expect(deliveries[0]?.source.kind).toBe('schedule')
      await expect.poll(async () => (await second.hivemindExecutionScope.run(owner,()=>second.schedule.catalog())).find(row => row.id === saved.id)?.status).toBe('inactive')
      await expect.poll(() => restored.session.ownEvents().filter(event => event.type === 'assistant/message').length).toBe(1)
      expect(adapter.requests).toHaveLength(1)
      await restored.whenIdle()
      await second.fiber.dispose()
      const third = await open()
      const again = (await third.hivemindExecutionScope.run(owner,()=>third.agents.resume({ resumeSessionId:id,agentOptions:{ provider:'mock',model:'mock' } }))).agent
      expect((await third.hivemindExecutionScope.run(owner,()=>third.schedule.catalog())).find(row => row.id === saved.id)?.status).toBe('inactive')
      expect(again.session.ownEvents().filter(event => event.type === 'assistant/message')).toHaveLength(1)
      expect(adapter.requests).toHaveLength(1)
      const persisted=(await admin.query('SELECT event_type,payload FROM harness_session_events WHERE session_id=$1 ORDER BY sequence',[id])).rows
      expect(persisted.filter(row=>row.event_type==='assistant/message')).toHaveLength(1)
      expect(persisted.filter(row=>row.event_type==='agent/inbox/spliced').flatMap(row=>(row.payload.data.inserted as { source:{ kind:string } }[]).filter(message=>message.source.kind==='schedule'))).toHaveLength(1)
      expect((await admin.query('SELECT status FROM harness_scheduled_tasks WHERE id=$1',[saved.id])).rows[0].status).toBe('inactive')
    }
  } finally {
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
    await admin.end()
    await rm(root,{ recursive:true,force:true })
  }
}, 20000)
