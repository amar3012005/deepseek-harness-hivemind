import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import PostgresSessionPersistence from '../../../session/session-persistence-postgres/src/index.ts'
import { createRequire } from 'node:module'
const { Pool }=createRequire(new URL('../../../session/session-persistence-postgres/package.json',import.meta.url))('pg')
import WebServer from '../../../host/webserver/src/index.ts'
import * as LifecycleHost from '../../hq-runtime/src/lifecycle-host.ts'
import SubagentService from '@deepseek-ai/dsh-subagent'
import Storage from '@deepseek-ai/dsh-storage'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import ScheduleService from '@deepseek-ai/dsh-schedule'
import HivemindExecutionScope from '@deepseek-ai/dsh-hivemind-execution-scope'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import TeamService from '../../../experimental/agent-team/src/index.ts'
import * as HqRuntime from '../../hq-runtime/src/index.ts'
import HqControl from '../../hq-runtime/src/control.ts'
import HqOwnership from '../../hq-runtime/src/ownership.ts'
import PermissionPresetService from '../../../interaction/permission-presets/src/index.ts'
import LocalAttachmentStore from '../../../attachment/attachment-local/src/index.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { createSessionTestController } from '../../../api/session-controller/tests/test-remote.ts'
import { installExternalRoomPersistence } from '../../../api/session-controller/src/external-room.ts'
import { createOpenDotRoomProvider, installOpenDotRuntimeScheduleWake } from '../src/open-dot-runtime.ts'

it('joins native Runtime assignment, real CP relay, Dot PostgreSQL output and native artifact acceptance', async () => {
  const ctx = new Context()
  const home = '/proof/workspace'; await mkdir(home,{recursive:true})
  const secret = process.env.HIVE_HARNESS_RUNNER_SERVICE_SECRET!
  const carrier = process.env.OPEN_DOT_RUNTIME_BRIDGE_TOKEN!
  if (!secret?.startsWith('fixture-only-') || !carrier?.startsWith('fixture-only-')) throw Error('Disposable credentials only')
  const base = new URL('http://127.0.0.1:25491')
  const principal = { orgId: '54f5568b-4d6a-4ae1-9a33-48cb2909d59b', userId: 'a4f5568b-4d6a-4ae1-9a33-48cb2909d59b', profile: 'hivemind-chat' as const, variation: 'harness' }
  const employeeId = '67503d34-97e9-49a8-8c52-8ee30cc7603e'
  const dotId = 'dot_0123456789abcdef'
  const signal = new AbortController().signal
  function jwt(runtime=false) {
    const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
    const at = Math.floor(Date.now()/1000)
    const input = encode({alg:'HS256',typ:'JWT'})+'.'+encode({iss:'hivemind-harness-runner',aud:'hivemind-control-plane-harness-proxy',sub:principal.userId,org_id:principal.orgId,profile:'hivemind-chat',variation:'harness',...(runtime?{operating_role:'runtime',operating_session:'session-root-opendot-e2e'}:{}),iat:at,exp:at+30,jti:randomUUID()})
    return input+'.'+createHmac('sha256',secret).update(input).digest('base64url')
  }
  const database='postgres://postgres:disposable-fixture-only@127.0.0.1:25493/hivemind_relay_fixture'
  const admin=new Pool({connectionString:database})
  await admin.query("\n      CREATE TABLE IF NOT EXISTS harness_sessions (\n        id varchar(180) PRIMARY KEY, org_id uuid NOT NULL, user_id uuid NOT NULL, project_id uuid,\n        scope_kind varchar(24) NOT NULL DEFAULT 'organization',\n        profile varchar(64) NOT NULL, variation varchar(16) NOT NULL, status varchar(24) NOT NULL DEFAULT 'active',\n        header jsonb NOT NULL, inherited_event_count bigint NOT NULL DEFAULT 0, event_count bigint NOT NULL DEFAULT 0,\n        revision bigint NOT NULL DEFAULT 0, title varchar(500), created_at timestamptz NOT NULL DEFAULT now(),\n        updated_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz,\n        UNIQUE (id, org_id, user_id),\n        CHECK ((scope_kind IN ('organization', 'personal') AND project_id IS NULL)\n          OR (scope_kind = 'project' AND project_id IS NOT NULL))\n      );\n      CREATE TABLE IF NOT EXISTS harness_session_events (\n        id bigserial PRIMARY KEY, session_id varchar(180) NOT NULL, org_id uuid NOT NULL, user_id uuid NOT NULL,\n        sequence bigint NOT NULL, event_type varchar(80) NOT NULL, payload jsonb NOT NULL,\n        created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(session_id, sequence),\n        FOREIGN KEY(session_id, org_id, user_id) REFERENCES harness_sessions(id, org_id, user_id)\n      );\n      CREATE TABLE IF NOT EXISTS harness_session_leases (\n        id uuid PRIMARY KEY, session_id varchar(180) UNIQUE NOT NULL, org_id uuid NOT NULL, user_id uuid NOT NULL,\n        holder_id text NOT NULL, token_hash char(64) UNIQUE NOT NULL, fencing_token bigint NOT NULL DEFAULT 0,\n        acquired_at timestamptz NOT NULL, heartbeat_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,\n        released_at timestamptz,\n        FOREIGN KEY(session_id, org_id, user_id) REFERENCES harness_sessions(id, org_id, user_id)\n      );\n    ")
  process.env.ROOT_JOINED_DATABASE_URL=database
  await ctx.plugin(HivemindExecutionScope)
  await ctx.hivemindExecutionScope.run(principal, async()=>{
  try {
    await mountAgentLoopTestDependencies(ctx)
    vi.spyOn(ctx.logger,'warn').mockImplementation((...args)=>{console.log('Native warning',...args)})
    await ctx.plugin(PostgresSessionPersistence,{connectionStringEnv:'ROOT_JOINED_DATABASE_URL',schema:'public',leaseTtlMs:30000,maxConnections:3,sharedOrganizationAgents:false})
    await ctx.plugin(AgentLoop,{agents:[]})
    await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(ToolJobs)
    await ctx.plugin(SubagentService)
    await ctx.plugin(LocalAttachmentStore,{dshHome:home})
    await ctx.plugin(Storage)
    const backend = new MemoryStorageBackend(new MemoryMediaPool())
    ctx.effect(()=>ctx.storage.backend.register('e2e',backend))
    const domain = new DomainFacility(ctx,{backend:'e2e'})
    ctx.effect(()=>{const off=ctx.storage.mount('domain',domain);ctx.provide('storageDomain',domain);return async()=>{await domain.closeAll();off()}})
    createSessionTestController(ctx,{defaultModelSelection:()=>({provider:'mock',model:'mock'}),cwd:home})
    await ctx.plugin(ScheduleService)
    ctx.provide('agentPresets',{composedPreset:()=>undefined,composeFrom:()=>undefined,serviceFor:(_agent:unknown,name:keyof Context)=>ctx.get(name)} as never)
    await ctx.plugin(TeamService)
    const adapter = new MockAdapter(Array.from({length:12},()=>textResponse('Saved result received; Runtime review is required.')))
    ctx.llm.registerAdapter(['mock'],adapter)
    const stored=await admin.query('SELECT 1 FROM harness_sessions WHERE id=$1',['session-root-opendot-e2e'])
    const root = stored.rows.length ? (await ctx.agentLoop.resume(ctx,{resumeSessionId:SessionId('session-root-opendot-e2e'),agentOptions:{cwd:home,provider:'mock',model:'mock'}})).agent : await ctx.agentLoop.create(SessionId('session-root-opendot-e2e'),{provider:'mock',model:'mock'},{cwd:home,agentPreset:'hivemind-hq'} as never)
    root.session.append('agent-preset/selected',{agentPreset:'hivemind-hq'})
    root.session.append('hivemind/session-owner',{id:null,slug:'runtime',name:'Runtime'})
    root.session.append('hivemind/hq-mode',{enabled:true,revision:1,changedAt:Date.now()})
    await ctx.sessions.flush(root.session)
    const task = ctx.agentTeams.listTasks(root).find(t=>t.id==='task-1') ?? await ctx.agentTeams.createTask(root,{subject:'Persisted native artifact',description:'Produce receipt.txt containing Native persisted Runtime artifact fixture.',writeScopes:[]})
    const tuple = {organizationId:principal.orgId,userId:principal.userId,employeeId,dotId,rootSessionId:String(root.id),taskId:String(task.id),taskRevision:2}
    const setup = await fetch(new URL('/fixture/setup',base),{method:'POST',headers:{authorization:'Bearer '+carrier,'content-type':'application/json'},body:JSON.stringify(tuple)})
    expect(setup.status,await setup.text()).toBe(200)
    ctx.provide('hivemindEmployeeDirectory',{profiles:async()=>{
      const res=await fetch(new URL('/internal/v1/harness-chat/core/v1/hyperagents/profiles',base),{headers:{authorization:'Bearer '+jwt()}})
      if(!res.ok)throw Error('Actual directory rejected '+res.status+': '+await res.text())
      return await res.json()
    }} as never)
    installExternalRoomPersistence(ctx)
    ctx.sessionController.registerExternalEmployeeRoomProvider(createOpenDotRoomProvider(ctx,base,secret))
    installOpenDotRuntimeScheduleWake(ctx,base,secret)
    ctx.on('api-session/user-authorship',()=>({userId:principal.userId,orgId:principal.orgId,name:'Fixture administrator',role:'owner'}))
    ctx.provide('shell',{sandboxMode:'workspace-write'} as never)
    ctx.provide('approval',{config:{policy:'ask'}} as never)
    await ctx.plugin(PermissionPresetService)
    await ctx.plugin(HqOwnership)
    ctx.hivemindHqOwnership.register({claim:async(id)=>{if(id!==root.id)throw Error('Foreign root');await ctx.sessions.flush(root.session)}})
    await ctx.plugin(HqControl)
    await ctx.plugin(HqRuntime)
    let call=0
    const execute=async(args:unknown)=>ctx.hivemindExecutionScope.run(principal,()=>ctx.tools.execute({name:'hivemind_hq_contract',callId:ToolCallId('e2e-'+(++call)),agent:root,signal,arguments:args}))
    if(task.status!=='completed'){
    const attach=await execute({action:'attach',task_id:task.id,due_at:'2026-10-12T20:26:24.591Z',acceptance_criteria:['Saved receipt.txt contains Native persisted Runtime artifact fixture.']})
    expect(attach).not.toMatchObject({isError:true})
    const assigned=await execute({action:'assign',task_id:task.id,employee_id:employeeId})
    if (assigned.isError) throw Error('Native assignment rejected: '+JSON.stringify(assigned)+' '+String((assigned as unknown as {error?:unknown}).error))
    await expect.poll(()=>root.session.ownEvents().filter(e=>e.type==='hivemind/room-message-received'),{timeout:45000}).not.toHaveLength(0)
    await root.whenIdle()
    const submission=root.session.ownEvents().findLast(e=>e.type==='hivemind/room-message-received' && e.data.artifactIds.length>0)
    expect(submission).toBeDefined()
    const producer=ctx.agentTeams.listMembers(root).find(m=>m.id===submission!.data.senderId)!
    const linked=await execute({action:'artifacts',task_id:task.id,producer:producer.name,artifact_ids:submission!.data.artifactIds})
    expect(linked.isError,JSON.stringify(linked)).toBe(false)
    const inspection=await execute({action:'inspect',task_id:task.id})
    expect(inspection.isError,JSON.stringify(inspection)).toBe(false)
    const evidence=inspection.value as {task_revision:number;evidence_hash:string;documents:{text:string}[]}
    const document=evidence.documents[0] as unknown as {attachment: Parameters<typeof ctx.attachments.readFileStream>[0]}
    const chunks:Uint8Array[]=[]
    for await(const chunk of ctx.attachments.readFileStream((document.attachment as unknown as {file: Parameters<typeof ctx.attachments.readFileStream>[0]}).file)) chunks.push(chunk)
    expect(Buffer.concat(chunks).toString('utf8')).toBe('Native persisted Runtime artifact fixture.\n')
    await expect(ctx.agentTeams.updateTask(root,{taskId:task.id,expectedRevision:evidence.task_revision,action:'complete'})).rejects.toThrow('accepted review')
    const decided=await execute({action:'decide',task_id:task.id,decision:'accepted',task_revision:evidence.task_revision,evidence_hash:evidence.evidence_hash,rationale:'Read the actual saved receipt.txt bytes and verified the required phrase.'})
    expect(decided).not.toMatchObject({isError:true})
    await ctx.agentTeams.updateTask(root,{taskId:task.id,expectedRevision:evidence.task_revision,action:'complete'})
    await ctx.sessions.flush(root.session)
    expect(ctx.agentTeams.getTask(root,task.id).status).toBe('completed')
    }
    await admin.query("ALTER TABLE digital_employees ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()")
    await admin.query("UPDATE digital_employees SET policy_rules=jsonb_set(policy_rules,'{native_lifecycle}',policy_rules->'native_lifecycle' || $2::jsonb) WHERE id=$1",[employeeId,JSON.stringify({revision:1,expires_at:null,onboarding_required:true,profile_stage:'responsibilities'})])
    await ctx.plugin(WebServer,{host:'127.0.0.1',port:25494})
    ctx.on('hivemind/employee-lifecycle-proof',async ({employeeId,signal})=>{
      const res=await fetch(new URL('/internal/v1/harness-chat/core/employee-lifecycle-proof',base),{method:'POST',headers:{authorization:'Bearer '+jwt(),'content-type':'application/json'},body:JSON.stringify({employee_id:employeeId}),signal})
      if(!res.ok)throw Error('Actual Core lifecycle proof rejected '+res.status+': '+await res.text())
      return res.json()
    })
    await ctx.plugin(LifecycleHost,{enabled:true,serviceSecretEnv:'HIVE_HARNESS_RUNNER_SERVICE_SECRET',sharedOrganizationAgents:false})
    const lifecycleBody={orgId:principal.orgId,userId:principal.userId,employeeId}
    const lifecycleInput=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url')+'.'+Buffer.from(JSON.stringify({iss:'hivemind-control-plane',aud:'hivemind-employee-lifecycle',sub:principal.userId,org_id:principal.orgId,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+30,body_sha256:createHash('sha256').update(JSON.stringify(lifecycleBody)).digest('hex')})).toString('base64url')
    const lifecycleToken=lifecycleInput+'.'+createHmac('sha256',secret).update(lifecycleInput).digest('base64url')
    const welcome=await fetch('http://127.0.0.1:25494/internal/hivemind/employee-lifecycle',{method:'POST',headers:{authorization:'Bearer '+lifecycleToken,'content-type':'application/json'},body:JSON.stringify(lifecycleBody)})
    expect(welcome.status,await welcome.text()).toBe(200)
    await root.whenIdle()
    await ctx.sessions.flush(root.session)
    expect(root.session.ownEvents().filter(e=>e.type==='hivemind/room-message-queued' && e.data.text.startsWith('Welcome to our team.'))).toHaveLength(1)
    const completedPersona='You are Disposable native employee, a research specialist for the authenticated company. Read relevant company context and private operating notes, deliver evidence with saved artifacts, report blockers to Runtime, and preserve existing approval boundaries.'
    const configured=await fetch(new URL('/internal/v1/harness-chat/core/employee-lifecycle',base),{method:'POST',headers:{authorization:'Bearer '+jwt(true),'content-type':'application/json'},body:JSON.stringify({operation:'configure',employee_id:employeeId,expected_profile_revision:1,persona:completedPersona,role:'Research'})})
    expect(configured.status,await configured.clone().text()).toBe(200)
    const configuredValue=await configured.json()
    expect(configuredValue.employee.persona).toBe(completedPersona)
    const joined=await fetch('http://127.0.0.1:25494/internal/hivemind/employee-lifecycle',{method:'POST',headers:{authorization:'Bearer '+lifecycleToken,'content-type':'application/json'},body:JSON.stringify(lifecycleBody)})
    expect(joined.status,await joined.text()).toBe(200)
    const repeated=await fetch('http://127.0.0.1:25494/internal/hivemind/employee-lifecycle',{method:'POST',headers:{authorization:'Bearer '+lifecycleToken,'content-type':'application/json'},body:JSON.stringify(lifecycleBody)})
    expect(repeated.status,await repeated.text()).toBe(200)
    const refreshed=await ctx.hivemindEmployeeDirectory.profiles(signal)
    expect(refreshed.profiles.find(p=>p['id']===employeeId)?.['persona']).toBe(completedPersona)
    expect(root.session.ownEvents().filter(e=>e.type==='hivemind/room-message-queued' && e.data.text.startsWith('Welcome to our team, '))).toHaveLength(1)
    await writeFile('/tmp/root-opendot-e2e-receipt.json',JSON.stringify({tuple,review:root.session.ownEvents().filter(e=>e.type==='hivemind/hq-task-review'),status:ctx.agentTeams.getTask(root,task.id).status,onboarding:{welcome:true,canonicalProfileSaved:true,profileRevision:configuredValue.employee.policyRules.native_lifecycle.profile_revision,joinedWelcomeOnce:true},scope:'native services, real CP and Dot HTTP/PostgreSQL; scripted models'},null,2))
  } finally { await ctx.fiber.dispose(); await admin.end() }
  })
},90000)
