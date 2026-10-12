import { createHmac, createHash } from 'node:crypto'
import { createServer, type RequestListener } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import ExecutionScope from '@deepseek-ai/dsh-hivemind-execution-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import { harness, agentFor } from '../../../schedule/schedule/tests/harness.ts'
import { apply, authorizeLifecycleCallback } from '../src/lifecycle-host.ts'
const secret='fixture-employee-lifecycle-service-secret-at-least-32'
const input={ orgId:'67503d34-97e9-49a8-8c52-8ee30cc7603e',userId:'54f5568b-4d6a-4ae1-9a33-48cb2909d59b',employeeId:'a4f5568b-4d6a-4ae1-9a33-48cb2909d59b' }
const contexts:Array<{ fiber:{ dispose():Promise<void> } }> = []
const servers:ReturnType<typeof createServer>[]=[]
afterEach(async()=>{for(const server of servers.splice(0)) await new Promise<void>(resolve=>server.close(()=>resolve()));for(const ctx of contexts.splice(0)) await ctx.fiber.dispose();delete process.env['EMPLOYEE_FIXTURE_SECRET']})
function token(body:unknown,extra:Record<string,unknown>={}) {
  const at=Math.floor(Date.now()/1000),encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url')
  const value={ iss:'hivemind-control-plane',aud:'hivemind-employee-lifecycle',sub:input.userId,org_id:input.orgId,body_sha256:createHash('sha256').update(JSON.stringify(body)).digest('hex'),iat:at,exp:at+30,...extra }
  const unsigned=`${encode({ alg:'HS256',typ:'JWT' })}.${encode(value)}`
  return `Bearer ${unsigned}.${createHmac('sha256',secret).update(unsigned).digest('base64url')}`
}
it('routes Open Dot creation welcome and full-profile proposal through the exact bound room',async()=>{
  const fixture=await harness();contexts.push(fixture.ctx);new ExecutionScope(fixture.ctx)
  const chief=agentFor(fixture.ctx,'dot-lifecycle-chief'),roomAgent=agentFor(fixture.ctx,'dot-lifecycle-room')
  fixture.resolve.mockResolvedValue({ agent:chief })
  const targetProfiles:Array<Record<string,unknown>>=[]
  const deliveries:Array<{ caller:unknown;message:Record<string,unknown> }>=[]
  const external={ kind:'external-persistent-assignee',id:SessionId('session-open-dot-fixture'),session:roomAgent.session,
    status:'idle',employeeId:input.employeeId,dotId:'dot_canary',organizationId:input.orgId,userId:input.userId,name:'Alex',role:'Research' }
  const profile={ id:input.employeeId,name:'Alex',slug:'alex',role_archetype:'Research',status:'active',
    policy_rules:{ open_dot_employee:{version:1,execution_backend:'open-dot',state:'bound',dot_id:'dot_canary'},
      native_lifecycle:{version:1,phase:'active',kind:'durable'} } }
  fixture.ctx.provide('hivemindEmployeeDirectory',{ profiles:async()=>({status:'ready',contract:'hivemind.hyperagent-profiles.v1',count:1,profiles:[profile]}) } as never)
  Object.assign(fixture.ctx.sessionController,{
    resolvePersistentEmployeeRoom:async(_id:string,target:Record<string,unknown>)=>{targetProfiles.push(target);return external},
    deliverAgentMessage:async(caller:unknown,message:Record<string,unknown>)=>{
      deliveries.push({caller,message});return {messageId:String(message['key']),targetSessionId:external.id,status:'accepted'}
    },
  })
  let step:'onboarding'|'profile'='onboarding'
  fixture.ctx.on('hivemind/employee-lifecycle-proof',async()=>({
    employeeId:input.employeeId,revision:1,kind:'durable',phase:'active',expiresAt:null,
    chief:{sessionId:chief.id,userId:input.userId},chiefs:[{sessionId:chief.id,userId:input.userId}],rooms:[],
    ...(step==='onboarding'
      ? {onboarding:{name:'Alex',role:'Research',creationHash:'c'.repeat(64)}}
      : {profileReview:{name:'Alex',role:'Research',persona:'Agreed to assess market evidence.',profileRevision:3,creationHash:'d'.repeat(64)}}),
  }))
  const server=createServer();servers.push(server)
  fixture.ctx.provide('webServer',{register:({handler,path}:{handler:RequestListener;path:string})=>{server.on('request',(req,res)=>{if(req.url===path)handler(req,res)});return()=>{}}} as never)
  process.env['EMPLOYEE_FIXTURE_SECRET']=secret;apply(fixture.ctx,{enabled:true,serviceSecretEnv:'EMPLOYEE_FIXTURE_SECRET'})
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const address=server.address();if(!address||typeof address==='string')throw Error('missing server')
  const call=()=>fetch('http://127.0.0.1:'+address.port+'/internal/hivemind/employee-lifecycle',{
    method:'POST',headers:{authorization:token(input),'content-type':'application/json'},body:JSON.stringify(input),
  })
  expect((await call()).status).toBe(200)
  expect(targetProfiles[0]).toMatchObject({id:input.employeeId,executionBackend:'open-dot',dotId:'dot_canary'})
  expect(deliveries[0]?.caller).toBe(chief)
  expect(deliveries[0]?.message).toMatchObject({target:input.employeeId,kind:'question',targetProfile:{executionBackend:'open-dot',dotId:'dot_canary'}})
  expect(String(deliveries[0]?.message['text'])).toContain('Runtime will save the canonical profile')
  step='profile'
  expect((await call()).status).toBe(200)
  expect(targetProfiles[1]).toMatchObject({id:input.employeeId,executionBackend:'open-dot',dotId:'dot_canary'})
  expect(deliveries[1]?.caller).toBe(chief)
  expect(deliveries[1]?.message).toMatchObject({target:input.employeeId,kind:'question'})
  expect(String(deliveries[1]?.message['text'])).toContain('Send your proposed full persona to Runtime')
  expect(String(deliveries[1]?.message['text'])).toContain('Do not claim it was saved')
})
it('binds lifecycle callbacks to exact body, purpose, administrator and short validity',()=>{
  expect(authorizeLifecycleCallback(token(input),secret,input)).toBe(true)
  expect(authorizeLifecycleCallback(token(input),secret,{ ...input,employeeId:input.userId })).toBe(false)
  expect(authorizeLifecycleCallback(token(input,{ aud:'hivemind-runtime-attention' }),secret,input)).toBe(false)
  expect(authorizeLifecycleCallback(token(input,{ exp:0 }),secret,input)).toBe(false)
})
it('creates one native deadline wake on retry and removes only Core-attested employee schedules',async()=>{
  const fixture=await harness();contexts.push(fixture.ctx)
  const scope=new ExecutionScope(fixture.ctx)
  const chief=agentFor(fixture.ctx,'fixture-chief'),roomA=agentFor(fixture.ctx,'fixture-employee-a'),roomB=agentFor(fixture.ctx,'fixture-employee-b'),unrelated=agentFor(fixture.ctx,'fixture-unrelated')
  fixture.resolve.mockImplementation(async id=>({ agent:[chief,roomA,roomB,unrelated].find(agent=>agent.id===id)! }))
  let phase='active', proofReads=0, archiveDuringWrite=false
  const expiresAt=new Date(Date.now()+3600000).toISOString()
  const originalOwner='14f5568b-4d6a-4ae1-9a33-48cb2909d59b'
  fixture.ctx.on('hivemind/employee-lifecycle-proof',async (request)=>{
    proofReads+=1;if(archiveDuringWrite && proofReads===2) phase='archived'
    expect(request.employeeId).toBe(input.employeeId)
    expect(scope.require().orgId).toBe(input.orgId);expect(scope.require().userId).toBe(input.userId)
    return { employeeId:input.employeeId,revision:1,kind:'temporary',phase,expiresAt,chief:{ sessionId:chief.id,userId:input.userId },chiefs:[{ sessionId:chief.id,userId:input.userId }],rooms:[{ sessionId:roomA.id,userId:input.userId },{ sessionId:roomB.id,userId:originalOwner }] }
  })
  const server=createServer();servers.push(server)
  fixture.ctx.provide('webServer',{ register:({ handler,path }:{ handler:RequestListener;path:string })=>{server.on('request',(req,res)=>{if(req.url===path)handler(req,res)});return()=>{}} } as never)
  process.env['EMPLOYEE_FIXTURE_SECRET']=secret
  apply(fixture.ctx,{ enabled:true,serviceSecretEnv:'EMPLOYEE_FIXTURE_SECRET' })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const address=server.address();if(!address||typeof address==='string') throw Error('missing test server')
  const call=()=>fetch(`http://127.0.0.1:${address.port}/internal/hivemind/employee-lifecycle`,{ method:'POST',headers:{ authorization:token(input),'content-type':'application/json' },body:JSON.stringify(input) })
  const one=await call();expect(one.status).toBe(200);const first=await one.json() as { scheduleId:string }
  const two=await call();expect(two.status).toBe(200);expect((await two.json() as { scheduleId:string }).scheduleId).toBe(first.scheduleId)
  expect(await fixture.service.list({ sessionId:chief.id })).toHaveLength(1)
  for(const agent of [roomA,roomB,unrelated]) await fixture.service.ensure(agent.id,`work-${agent.id}`,{ title:'Fixture work',after_seconds:3600,prompt:'Fixture only' })
  archiveDuringWrite=true;proofReads=0
  const raced=await call();expect(raced.status).toBe(503);expect(await fixture.service.list({ sessionId:chief.id })).toHaveLength(0)
  const archive=await call();expect(archive.status).toBe(200)
  expect(await fixture.service.list({ sessionId:roomA.id })).toHaveLength(0)
  expect(await fixture.service.list({ sessionId:roomB.id })).toHaveLength(0)
  expect(await fixture.service.list({ sessionId:unrelated.id })).toHaveLength(1)
  expect(await fixture.service.list({ sessionId:chief.id })).toHaveLength(0)
  expect(chief.session.header.id).toBe(SessionId('fixture-chief'))
})
it('admits setup through the attested Chief and rechecks closeout before delivery', async () => {
  const fixture=await harness();contexts.push(fixture.ctx)
  new ExecutionScope(fixture.ctx)
  const chief=agentFor(fixture.ctx,'setup-chief'),employee=agentFor(fixture.ctx,'setup-employee')
  fixture.ctx.provide('hivemindEmployeeDirectory',{ profiles:async()=>({status:'ready',contract:'hivemind.hyperagent-profiles.v1',count:1,profiles:[{id:input.employeeId,name:'Alex',role_archetype:'Specialist',status:'active',policy_rules:{native_lifecycle:{version:1,phase:'active',kind:'durable'}}}]}) } as never)
  fixture.resolve.mockResolvedValue({ agent:chief })
  const deliveries: Array<{ key:string;target:string;kind:string;text:string }> = []
  Object.assign(fixture.ctx.sessionController, {
    resolvePersistentEmployeeRoom:async(key:string,profile:{ id:string;name:string })=>{
      expect(key).toBe(input.employeeId);expect(profile.name).toBe('Alex');return employee
    },
    deliverAgentMessage:async(caller:unknown,message:{ key:string;target:string;kind:string;text:string })=>{
      expect(caller).toBe(chief);deliveries.push(message)
      return { messageId:message.key,targetSessionId:employee.id,status:'accepted' }
    },
  })
  let reads=0,race=false
  fixture.ctx.on('hivemind/employee-lifecycle-proof',async()=>({
    employeeId:input.employeeId,revision:1,kind:'durable',phase:race && ++reads===2?'closing':'active',expiresAt:null,
    chief:{ sessionId:chief.id,userId:input.userId },chiefs:[{ sessionId:chief.id,userId:input.userId }],rooms:[],
    onboarding:{ name:'Alex',role:'Specialist',creationHash:'a'.repeat(64) },
  }))
  const server=createServer();servers.push(server)
  fixture.ctx.provide('webServer',{ register:({ handler,path }:{ handler:RequestListener;path:string })=>{server.on('request',(req,res)=>{if(req.url===path)handler(req,res)});return()=>{}} } as never)
  process.env['EMPLOYEE_FIXTURE_SECRET']=secret
  apply(fixture.ctx,{ enabled:true,serviceSecretEnv:'EMPLOYEE_FIXTURE_SECRET' })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const address=server.address();if(!address||typeof address==='string')throw Error('missing server')
  const call=()=>fetch(`http://127.0.0.1:${address.port}/internal/hivemind/employee-lifecycle`,{
    method:'POST',headers:{ authorization:token(input),'content-type':'application/json' },body:JSON.stringify(input),
  })
  expect((await call()).status).toBe(200)
  expect(deliveries[0]).toMatchObject({ target:input.employeeId,kind:'question' })
  expect(deliveries[0]?.text).toContain('which responsibilities they want you to own')
  expect((await call()).status).toBe(200)
  expect(deliveries[1]?.key).toBe(deliveries[0]?.key)
  race=true;reads=0
  expect((await call()).status).toBe(503)
  expect(deliveries).toHaveLength(2)
})
it('asks Chief to confirm responsibilities before one welcome and persisted joining milestone',async()=>{
  const fixture=await harness();contexts.push(fixture.ctx);new ExecutionScope(fixture.ctx)
  const chief=agentFor(fixture.ctx,'profile-chief'),employee=agentFor(fixture.ctx,'profile-employee')
  fixture.ctx.provide('hivemindEmployeeDirectory',{ profiles:async()=>({status:'ready',contract:'hivemind.hyperagent-profiles.v1',count:1,profiles:[{id:input.employeeId,name:'Alex',role_archetype:'Research',status:'active',policy_rules:{native_lifecycle:{version:1,phase:'active',kind:'durable'}}}]}) } as never)
  fixture.resolve.mockResolvedValue({ agent:chief })
  const deliveries:Array<{ caller:unknown;key:string;text:string;target:string }>=[]
  Object.assign(fixture.ctx.sessionController,{
    resolvePersistentEmployeeRoom:async()=>employee,
    deliverAgentMessage:async(caller:unknown,message:{ key:string;text:string;target:string })=>{
      deliveries.push({ caller,...message });return { messageId:message.key,targetSessionId:employee.id,status:'accepted' }
    },
  })
  const profile={ name:'Alex',role:'Research',profileRevision:2,creationHash:'b'.repeat(64) }
  let review=true
  fixture.ctx.on('hivemind/employee-lifecycle-proof',async()=>({
    employeeId:input.employeeId,revision:1,kind:'durable',phase:'active',expiresAt:null,
    chief:{ sessionId:chief.id,userId:input.userId },chiefs:[{ sessionId:chief.id,userId:input.userId }],rooms:[],
    ...(review?{ profileReview:{ ...profile,persona:'Agreed responsibilities' } }:{ joined:{ ...profile,at:'2026-10-06T12:00:00.000Z' } }),
  }))
  const server=createServer();servers.push(server)
  fixture.ctx.provide('webServer',{ register:({ handler,path }:{ handler:RequestListener;path:string })=>{server.on('request',(req,res)=>{if(req.url===path)handler(req,res)});return()=>{}} } as never)
  process.env['EMPLOYEE_FIXTURE_SECRET']=secret;apply(fixture.ctx,{ enabled:true,serviceSecretEnv:'EMPLOYEE_FIXTURE_SECRET' })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const address=server.address();if(!address||typeof address==='string')throw Error('missing server')
  const call=()=>fetch(`http://127.0.0.1:${address.port}/internal/hivemind/employee-lifecycle`,{ method:'POST',headers:{ authorization:token(input),'content-type':'application/json' },body:JSON.stringify(input) })
  expect((await call()).status).toBe(200)
  expect(deliveries[0]).toMatchObject({ caller:employee,target:'runtime' })
  expect(deliveries[0]?.text).toContain('Agreed responsibilities')
  expect(employee.session.ownEvents().filter(event=>String(event.type)==='hivemind/employee-selection')).toHaveLength(0)
  review=false
  const flush = fixture.ctx.sessions.flush.bind(fixture.ctx.sessions)
  let flushAttempts=0
  fixture.ctx.sessions.flush=async (session)=>{flushAttempts++;return flushAttempts===1 ? false : flush(session)}
  expect((await call()).status).toBe(503)
  expect((await call()).status).toBe(200)
  expect(deliveries[1]).toMatchObject({ caller:chief,target:input.employeeId })
  expect(deliveries[1]?.text).toContain('inspect our actual company context')
  expect((await call()).status).toBe(200)
  expect(deliveries).toHaveLength(2)
  expect(flushAttempts).toBe(3)
  const joined=employee.session.ownEvents().filter(event=>String(event.type)==='hivemind/employee-selection')
  expect(joined).toHaveLength(1)
  expect(joined[0]?.data).toMatchObject({ name:'Alex',role:'Research',joining:{ at:'2026-10-06T12:00:00.000Z',profileRevision:2 } })
})
