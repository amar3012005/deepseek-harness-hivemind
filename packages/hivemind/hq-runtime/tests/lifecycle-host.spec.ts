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
  fixture.ctx.provide('webServer',{ register:({ handler }:{ handler:RequestListener })=>{server.on('request',handler!);return()=>{}} } as never)
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
  fixture.ctx.provide('webServer',{ register:({ handler }:{ handler:RequestListener })=>{server.on('request',handler!);return()=>{}} } as never)
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
  fixture.ctx.provide('webServer',{ register:({ handler }:{ handler:RequestListener })=>{server.on('request',handler);return()=>{}} } as never)
  process.env['EMPLOYEE_FIXTURE_SECRET']=secret;apply(fixture.ctx,{ enabled:true,serviceSecretEnv:'EMPLOYEE_FIXTURE_SECRET' })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const address=server.address();if(!address||typeof address==='string')throw Error('missing server')
  const call=()=>fetch(`http://127.0.0.1:${address.port}/internal/hivemind/employee-lifecycle`,{ method:'POST',headers:{ authorization:token(input),'content-type':'application/json' },body:JSON.stringify(input) })
  expect((await call()).status).toBe(200)
  expect(deliveries[0]).toMatchObject({ caller:employee,target:'runtime' })
  expect(deliveries[0]?.text).toContain('Agreed responsibilities')
  expect(employee.session.ownEvents().filter(event=>String(event.type)==='hivemind/employee-selection')).toHaveLength(0)
  review=false
  expect((await call()).status).toBe(200)
  expect(deliveries[1]).toMatchObject({ caller:chief,target:input.employeeId })
  expect(deliveries[1]?.text).toContain('inspect our actual company context')
  expect((await call()).status).toBe(200)
  expect(deliveries).toHaveLength(2)
  const joined=employee.session.ownEvents().filter(event=>String(event.type)==='hivemind/employee-selection')
  expect(joined).toHaveLength(1)
  expect(joined[0]?.data).toMatchObject({ name:'Alex',role:'Research',joining:{ at:'2026-10-06T12:00:00.000Z',profileRevision:2 } })
})
