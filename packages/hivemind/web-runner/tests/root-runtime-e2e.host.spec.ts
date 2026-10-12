import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import ScheduleService from '@deepseek-ai/dsh-schedule'
import HivemindExecutionScope from '@deepseek-ai/dsh-hivemind-execution-scope'
import { createHmac, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
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
  const home = await mkdtemp(join(tmpdir(), 'root-opendot-e2e-'))
  const secret = process.env.HIVE_HARNESS_RUNNER_SERVICE_SECRET!
  const carrier = process.env.OPEN_DOT_RUNTIME_BRIDGE_TOKEN!
  if (!secret?.startsWith('fixture-only-') || !carrier?.startsWith('fixture-only-')) throw Error('Disposable credentials only')
  const base = new URL('http://127.0.0.1:25491')
  const principal = { orgId: '54f5568b-4d6a-4ae1-9a33-48cb2909d59b', userId: 'a4f5568b-4d6a-4ae1-9a33-48cb2909d59b', profile: 'hivemind-chat' as const, variation: 'harness' }
  const employeeId = '67503d34-97e9-49a8-8c52-8ee30cc7603e'
  const dotId = 'dot_0123456789abcdef'
  const signal = new AbortController().signal
  function jwt() {
    const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
    const at = Math.floor(Date.now()/1000)
    const input = encode({alg:'HS256',typ:'JWT'})+'.'+encode({iss:'hivemind-harness-runner',aud:'hivemind-control-plane-harness-proxy',sub:principal.userId,org_id:principal.orgId,profile:'hivemind-chat',variation:'harness',iat:at,exp:at+30,jti:randomUUID()})
    return input+'.'+createHmac('sha256',secret).update(input).digest('base64url')
  }
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(HivemindExecutionScope)
    await ctx.plugin(JsonlSessionPersistence,{root:join(home,'sessions'),compression:'none'})
    await ctx.plugin(AgentLoop,{agents:[]})
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
    const root = await ctx.agentLoop.create(SessionId('session-root-opendot-e2e'),{provider:'mock',model:'mock'},{cwd:home,agentPreset:'hivemind-hq'} as never)
    root.session.append('agent-preset/selected',{agentPreset:'hivemind-hq'})
    root.session.append('hivemind/session-owner',{id:null,slug:'runtime',name:'Runtime'})
    root.session.append('hivemind/hq-mode',{enabled:true,revision:1,changedAt:Date.now()})
    await ctx.sessions.flush(root.session)
    const task = await ctx.agentTeams.createTask(root,{subject:'Persisted native artifact',description:'Produce receipt.txt containing Native persisted Runtime artifact fixture.',writeScopes:[]})
    const tuple = {organizationId:principal.orgId,userId:principal.userId,employeeId,dotId,rootSessionId:String(root.id),taskId:String(task.id),taskRevision:task.revision+1}
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
    const attach=await execute({action:'attach',task_id:task.id,due_at:new Date(Date.now()+3600000).toISOString(),acceptance_criteria:['Saved receipt.txt contains Native persisted Runtime artifact fixture.']})
    expect(attach).not.toMatchObject({isError:true})
    const assigned=await execute({action:'assign',task_id:task.id,employee_id:employeeId})
    expect(assigned).not.toMatchObject({isError:true})
    await expect.poll(()=>root.session.ownEvents().filter(e=>e.type==='hivemind/room-message-received'),{timeout:45000}).not.toHaveLength(0)
    await root.whenIdle()
    const inspection=await execute({action:'inspect',task_id:task.id})
    expect(inspection.isError,JSON.stringify(inspection)).toBe(false)
    const evidence=inspection.value as {task_revision:number;evidence_hash:string;documents:{text:string}[]}
    expect(evidence.documents.map(d=>d.text).join('\n')).toContain('Native persisted Runtime artifact fixture.')
    await expect(ctx.agentTeams.updateTask(root,{taskId:task.id,expectedRevision:evidence.task_revision,action:'complete'})).rejects.toThrow('accepted review')
    const decided=await execute({action:'decide',task_id:task.id,decision:'accepted',task_revision:evidence.task_revision,evidence_hash:evidence.evidence_hash,rationale:'Read the actual saved receipt.txt bytes and verified the required phrase.'})
    expect(decided).not.toMatchObject({isError:true})
    await ctx.agentTeams.updateTask(root,{taskId:task.id,expectedRevision:evidence.task_revision,action:'complete'})
    await ctx.sessions.flush(root.session)
    expect(ctx.agentTeams.getTask(root,task.id).status).toBe('completed')
    await writeFile('/tmp/root-opendot-e2e-receipt.json',JSON.stringify({tuple,assignment:assigned,evidence,decision:decided,status:'completed',scope:'native services, real CP and Dot HTTP/PostgreSQL; scripted models'},null,2))
  } finally { await ctx.fiber.dispose(); await rm(home,{recursive:true,force:true}) }
},90000)
