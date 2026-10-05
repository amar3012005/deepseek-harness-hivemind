/** Isolated native media receipt and attachment persistence proof; no provider request. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import PostgresSessionPersistence from '@deepseek-ai/dsh-session-persistence-postgres'
import ExecutionScope from '@deepseek-ai/dsh-hivemind-execution-scope'
import { Pool } from 'pg'
import { randomUUID, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
// Linux fixture uses real native locks, PostgreSQL leases, RLS and timer persistence.
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { LocalJobRegistry } from '@deepseek-ai/dsh-jobs-local'
import { JobId } from '@deepseek-ai/dsh-jobs'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { GenerationRegistry } from '../../artifact-renderer/src/generation.ts'
import { museImageProvider } from '../../artifact-renderer/src/muse-image-provider.ts'
import { registerMediaWorkflow } from '../../artifact-renderer/src/media-workflow.ts'
import { ConfirmedImageNoOutputError } from '../../artifact-renderer/src/image-provider.ts'

const postgresProof=process.env.RECOVERY_ADMIN_DB ? it : it.skip
postgresProof('persists native linked fallback receipts and retained real Muse bytes across PostgreSQL reopen', async () => {
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
  const id=SessionId('session-isolated-media-'+randomUUID())
  const bytes=await readFile('/fixture/muse-fallback-output.webp')
  let bridgeCalls=0
  const registry=new GenerationRegistry()
  registry.register({ id:'codex:gpt-image-2',format:'image',instructions:'Fixture primary',generate:async()=>{throw new ConfirmedImageNoOutputError('Fixture-only confirmed no-output; no production provider failure')} })
  registry.register(museImageProvider(10000,async({ payload })=>{
    if(!payload)return { ready:true }
    bridgeCalls++
    return { data:[{ b64_json:bytes.toString('base64'),media_type:'image/webp' }] }
  }),true)
  async function open() {
    const ctx=new Context();contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(ExecutionScope)
    await ctx.plugin(PostgresSessionPersistence,{ connectionStringEnv:'RECOVERY_FIXTURE_DB',schema,leaseTtlMs:30000,maxConnections:2 })
    await ctx.plugin(AgentLoop,{ agents:[] })
    ctx.llm.registerAdapter(['mock'],new MockAdapter([]))
    await ctx.plugin(LocalJobRegistry,{ maxConcurrentJobsPerOwner:2 })
    ctx.jobs.attachController('fixture-native-controller')
    await ctx.plugin(LocalAttachmentStore,{ dshHome:root })
    ctx.on('hivemind/media-owner',async()=>({ ...owner,sessionId:id }),{ global:true })
    registerMediaWorkflow(ctx,registry,'artifacts',{ maxBriefChars:1000,imageAttempts:1,retryBaseDelayMs:1,requireOwner:true,attachmentOnly:true })
    return ctx
  }
  try {
    const first=await open()
    const agent=(await first.hivemindExecutionScope.run(owner,()=>first.agents.create({ sessionId:id,meta:{ agentPreset:'hivemind-hyperagents' },agentOptions:{ provider:'mock',model:'mock' } }))).agent
    const args={ kind:'image',title:'Isolated retained Muse storage proof',brief:'Fixture replay of existing real Muse bytes, no new generation.',aspect_ratio:'1:1' }
    const run=async(input:Record<string,unknown>)=>{
      const tool=first.tools.get('hivemind_media_generate',agent)!
      const started=await tool.execute(input,{ agent,signal:AbortSignal.timeout(10000) } as never) as { job_id:string }
      return await first.jobs.wait(JobId(started.job_id),10000,agent)
    }
    const primary=await run(args);expect(primary.status).toBe('failed')
    const parent=JSON.parse(first.jobs.read(primary.id,agent).text).operation_id
    const fallback=await run({ ...args,fallback_from_operation:parent });expect(fallback.status,first.jobs.read(fallback.id,agent).text).toBe('completed')
    const created=agent.session.snapshotEvents().findLast(e=>e.type==='hivemind/generation-created')
    expect(created?.type).toBe('hivemind/generation-created')
    if(created?.type!=='hivemind/generation-created')throw Error('Missing native generation receipt')
    const ref=created.data.preview!;const firstImage=await first.attachments.readImage(ref)
    expect(firstImage.data.length).toBeGreaterThan(0)
    const savedHash=createHash('sha256').update(firstImage.data).digest('hex')
    await first.sessions.flush(agent.session);await first.fiber.dispose()
    const second=await open()
    const restored=(await second.hivemindExecutionScope.run(owner,()=>second.agents.resume({ resumeSessionId:id,agentOptions:{ provider:'mock',model:'mock' } }))).agent
    const starts=restored.session.snapshotEvents().filter(e=>e.type==='hivemind/media-workflow-started')
    const ends=restored.session.snapshotEvents().filter(e=>e.type==='hivemind/media-workflow-ended')
    expect(starts).toHaveLength(2);expect(ends).toHaveLength(2)
    expect(ends.map(e=>e.data.status)).toEqual(['failed','completed'])
    expect(JSON.parse(starts[1]!.data.request!).fallback_from_operation).toBe(parent)
    expect(starts[1]!.data.provider).toBe('openrouter:meta/muse-image')
    expect(createHash('sha256').update((await second.attachments.readImage(ref)).data).digest('hex')).toBe(savedHash)
    expect(bridgeCalls).toBe(1)
    const rows=(await admin.query('SELECT event_type FROM harness_session_events WHERE session_id=$1',[id])).rows
    expect(rows.filter(r=>r.event_type==='hivemind/media-workflow-started')).toHaveLength(2)
    expect(rows.filter(r=>r.event_type==='hivemind/media-workflow-ended')).toHaveLength(2)
    expect(rows.filter(r=>r.event_type==='hivemind/generation-created')).toHaveLength(1)
  } finally {for(const ctx of contexts)await ctx.fiber.dispose();await admin.end();await rm(root,{ recursive:true,force:true })}
},30000)
