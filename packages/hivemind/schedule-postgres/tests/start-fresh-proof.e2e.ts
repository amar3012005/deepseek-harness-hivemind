/** Real authenticated reset RPC, restricted PostgreSQL persistence and cold restoration. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { SessionId } from '@deepseek-ai/dsh-session'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { HivemindPrincipal } from '@deepseek-ai/dsh-hivemind-execution-scope'
import type {} from '../../hq-runtime/src/index.ts'
import { launchWebScaffold, type WebScaffold } from '../../../../apps/web/tests/scaffold.ts'
import * as ToolSchedule from '../../../schedule/tool-schedule/src/index.ts'

const url = process.env.DSH_SCHEDULE_TEST_URL
const suite = url === undefined ? describe.skip : describe
class CanaryModel extends LlmAdapter {
  requests: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Tenant scheduled work completed.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
suite('Start fresh native host composition', () => {
  const schema = `native_fresh_${randomUUID().replaceAll('-', '')}`
  const owner: HivemindPrincipal = {
    orgId: randomUUID(),
    userId: randomUUID(),
    profile: 'hivemind-chat',
    variation: 'harness',
  }
  const model = new CanaryModel()
  let admin: Pool, app: WebScaffold, root: string
  beforeAll(async () => {
    const parsed = new URL(url!)
    if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) || !['/session_persistence_test', '/schedule_test'].includes(parsed.pathname))
      throw new Error('Disposable local session_persistence_test or schedule_test database required')
    const bootstrap = new Pool({ connectionString: url })
    await bootstrap.query(`CREATE SCHEMA ${schema}`)
    await bootstrap.end()
    admin = new Pool({ connectionString: url, options: `-c search_path=${schema},public` })
    await admin.query(
      'DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname=\'codex_schedule_test\') THEN CREATE ROLE codex_schedule_test NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$',
    )
    // Match the authoritative production cascade contract, not the older schedule-only fixture.
    await admin.query((await readFile(new URL('./sessions.sql', import.meta.url), 'utf8')).replaceAll('REFERENCES harness_sessions(id, org_id, user_id)', 'REFERENCES harness_sessions(id, org_id, user_id) ON DELETE CASCADE'))
    await admin.query(await readFile(new URL('../../../session/session-persistence-postgres/migrations/session-format-predecessors.sql', import.meta.url), 'utf8'))
    await admin.query(await readFile(new URL('../migrations/schedule.sql', import.meta.url), 'utf8'))
    await admin.query(await readFile(new URL('../../hq-runtime/migrations/company-hq.sql', import.meta.url), 'utf8'))
    await admin.query(
      `GRANT USAGE ON SCHEMA ${schema} TO codex_schedule_test; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO codex_schedule_test; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO codex_schedule_test`,
    )
    await admin.query("ALTER TABLE user_organizations ADD COLUMN role text NOT NULL DEFAULT 'owner'")
    await admin.query('CREATE TABLE hyper_agent_operating_memories(id text,org_id uuid,author_user_id uuid,project_slug text)')
    await admin.query((await readFile(new URL('../../hq-runtime/migrations/fresh-private-memory.sql',import.meta.url),'utf8')).replaceAll('hivemind.',schema+'.'))
    await admin.query(`REVOKE DELETE ON hyper_agent_operating_memories FROM codex_schedule_test; GRANT EXECUTE ON FUNCTION ${schema}.reset_agent_operating_memory(uuid,uuid,text,boolean) TO codex_schedule_test`)
    await admin.query('INSERT INTO users VALUES($1,NULL)', [owner.userId])
    await admin.query('INSERT INTO user_organizations(user_id,org_id) VALUES($1,$2)', [owner.userId, owner.orgId])
    root = await mkdtemp(join(tmpdir(), 'schedule-native-'))
    const localUrl = new URL(url!)
    localUrl.searchParams.set('options', `-c role=codex_schedule_test -c search_path=${schema},public`)
    process.env.DSH_SCHEDULE_CANARY_DB = localUrl.toString()
    const overlay = join(root, 'cordis.yml')
    await writeFile(
      overlay,
      `- id: session-persistence-jsonl\n  disabled: true
- id: workspace
  disabled: true
- id: workspace-files
  disabled: true
- id: file-reference-local
  disabled: true
- id: directory-picker
  disabled: true
- id: plugin-inventory
  disabled: true
- id: open-in-app
  disabled: true
- id: ui-deliverables
  disabled: true
- id: ui-schedule
  disabled: false
- insert:
    - id: hivemind-employee-directory
      name: '@deepseek-ai/dsh-hivemind-employee-directory'
    - id: agent-team
      name: '@deepseek-ai/dsh-experimental-agent-team'
      config: {allowedRootPresets: [hivemind-hyperagents, hivemind-hq]}
    - id: hivemind-hq-ownership
      name: '@deepseek-ai/dsh-hivemind-hq-runtime/ownership'
    - id: hivemind-hq-ownership-postgres
      name: '@deepseek-ai/dsh-hivemind-hq-runtime/ownership-postgres'
      config: {connectionStringEnv: DSH_SCHEDULE_CANARY_DB, schema: ${schema}, maxConnections: 4, statementTimeoutMs: 15000}
    - id: hivemind-hq-control
      name: '@deepseek-ai/dsh-hivemind-hq-runtime/control'
    - id: ui-hivemind-hq
      name: '@deepseek-ai/dsh-client-ui-hivemind-hq'
    - id: hivemind-virtual-workspace
      name: '@deepseek-ai/dsh-hivemind-virtual-workspace'
    - id: hivemind-execution-scope
      name: '@deepseek-ai/dsh-hivemind-execution-scope'
    - id: session-persistence-postgres
      name: '@deepseek-ai/dsh-session-persistence-postgres'
      config: {connectionStringEnv: DSH_SCHEDULE_CANARY_DB, schema: ${schema}, leaseTtlMs: 30000, maxConnections: 4}
    - id: hivemind-schedule-postgres
      name: '@deepseek-ai/dsh-hivemind-schedule-postgres'
      config: {connectionStringEnv: DSH_SCHEDULE_CANARY_DB, schema: ${schema}, maxConnections: 4, statementTimeoutMs: 15000, maxTasksPerUser: 100}
    - id: schedule
      name: '@deepseek-ai/dsh-schedule'
      inject: [scheduleOwnership]
      config: {ownershipRequired: true}
`,
    )
    app = await launchWebScaffold({
      firstUse: true,
      extraOverlayPath: overlay,
      extraInstallAnchors: [fileURLToPath(new URL('../../../bundle/hivemind-web-app/package.json', import.meta.url))],
      agentPresets: {
        default: 'hivemind-hyperagents',
        definitions: [
          { id: 'hivemind-hyperagents', name: 'HyperAgents', plugins: [] },
          { id: 'hivemind-hq', name: 'HQ Runtime', plugins: [] },
        ],
      },
    })
    app.ctx.loader.builtins['tool-schedule'] = ToolSchedule
    app.ctx.effect(() => app.ctx.llm.registerAdapter(['tenant-canary'], model))
    app.ctx.effect(() => app.ctx.connection.rpc.registerAdmission((_request, next) =>
      app.ctx.hivemindExecutionScope.run(owner, next)))
  },120000)
  afterAll(async()=>{
    await app?.close()
    if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end()}
    if(root)await rm(root,{ recursive:true,force:true })
    delete process.env.DSH_SCHEDULE_CANARY_DB
  })
  it('clears live employee history and restores a sleeping canonical Runtime through the real RPC',async()=>{
    const ids=await app.ctx.hivemindExecutionScope.run(owner,async()=>{
      const persistence=app.ctx.sessionPersistence as typeof app.ctx.sessionPersistence & { employeeRoomId(key:string):Promise<SessionId> }
      const runtimeId=await persistence.employeeRoomId('runtime')
      const runtime=await app.ctx.sessionController.create({ sessionId:runtimeId, agentPreset:'hivemind-hq' })
      const employee=await app.ctx.sessionController.create({ sessionId:SessionId('fixture-employee'), agentPreset:'hivemind-hyperagents' })
      const loaded=await app.ctx.sessionController.resolveAgent(runtime.sessionId)
      if('error' in loaded)throw loaded.error
      loaded.agent.session.append('hivemind/hq-awakening-start',{ version:1,turn:1,startedAt:new Date().toISOString() })
      loaded.agent.session.append('hivemind/hq-awakening-checkpoint',{ stage:'conversation',turn:1,summary:'Previous awakening',receiptSeqs:[],blocked:false,recordedAt:new Date().toISOString(),cards:[] })
      await app.ctx.hivemindHqOwnership.claim(runtime.sessionId)
      await app.ctx.agentTeams.createTask(loaded.agent,{ subject:'Previous task',description:'Reset fixture task' })
      const child=await app.ctx.sessionController.resolveAgent(employee.sessionId)
      if('error' in child)throw child.error
      child.agent.session.append('session/title',{ title:'Old employee history',source:{ kind:'fallback' },messageSeqs:[] })
      expect(await app.ctx.sessions.flush(loaded.agent.session)).toBe(true)
      expect(await app.ctx.sessions.flush(child.agent.session)).toBe(true)
      await admin.query('INSERT INTO hyper_agent_operating_memories VALUES(\'private\',$1,$2,\'hyper-agents\')',[owner.orgId,owner.userId])
      return{ runtime:runtime.sessionId,employee:employee.sessionId }
    })
    const authenticatedUrl=app.ctx.connection.authenticatedUrl(app.baseUrl)
    const rpc=async(method:string,args:unknown)=>{
      const tokenized=new URL(authenticatedUrl)
      const index=await fetch(tokenized,{ redirect:'manual' })
      const cookie=index.headers.get('set-cookie')?.split(';')[0]
      if(!cookie)throw new Error('native browser authentication cookie missing')
      const response=await fetch(app.baseUrl+'/api/'+method,{ method:'POST',headers:{ 'content-type':'application/json',cookie,origin:app.baseUrl },body:JSON.stringify({ type:'client-request',rpcId:'fresh-proof-'+randomUUID(),method,payload:{ args } }) })
      return await response.json() as { result:{ ok:boolean;value:unknown } }
    }
    const result=await rpc('hivemindHq/startFresh',{ agentId:ids.runtime,request:{ confirmed:true } })
    if(!result.result.ok)throw new Error(JSON.stringify(result))
    expect(result.result).toMatchObject({ ok:true,value:{ sessions:2,memories:1 } })
    expect((await admin.query('SELECT count(*)::int AS count FROM hyper_agent_operating_memories')).rows[0].count).toBe(0)
    expect((await admin.query('SELECT id FROM harness_sessions')).rows.map(row=>row.id)).toEqual([ids.runtime])
    expect(await rpc('hivemindHq/tourState',{ agentId:ids.runtime })).toMatchObject({ result:{ ok:true,value:{ step:0,presentation:'active',awakening:'sleeping',running:false } } })
    await app.ctx.hivemindExecutionScope.run(owner,async()=>{
      const recreated=await app.ctx.sessionController.create({ sessionId:SessionId('fixture-employee'),agentPreset:'hivemind-hyperagents' })
      const loaded=await app.ctx.sessionController.resolveAgent(recreated.sessionId)
      if('error' in loaded)throw loaded.error
      expect(loaded.agent.session.snapshotEvents().some(event=>event.type==='session/title' && event.data.title==='Old employee history')).toBe(false)
      await app.ctx.sessionController.releaseOwnedSessions([ids.runtime,recreated.sessionId])
    })
    expect(await rpc('hivemindHq/tourState',{ agentId:ids.runtime })).toMatchObject({ result:{ ok:true,value:{ step:0,presentation:'active',awakening:'sleeping' } } })
  },120000)
})
