import { it, expect } from 'vitest'
import { createHash, createHmac } from 'node:crypto'
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { authorizeNightlyRoutine, installNightlyRoutineHost, nightlyRoutineRequest } from '../src/nightly-routine-host.ts'
const secret='s'.repeat(48),org='8cf195d6-f2c8-453a-bd95-b8a3d70bf0b0',user='85601c95-b367-45b4-b66b-069b68c4dfd0',session='session-nightly-test'
const payload={ orgId:org,userId:user,sessionId:session,operation:'ensure' }
function token(value:unknown,override:Record<string,unknown>={}) {const enc=(v:unknown)=>Buffer.from(JSON.stringify(v)).toString('base64url'),now=Math.floor(Date.now()/1000);const text=enc({ alg:'HS256',typ:'JWT' })+'.'+enc({ iss:'hivemind-control-plane',aud:'hivemind-nightly-routine',sub:user,org_id:org,iat:now,exp:now+30,body_sha256:createHash('sha256').update(JSON.stringify(value)).digest('hex'),...override });return 'Bearer '+text+'.'+createHmac('sha256',secret).update(text).digest('base64url')}
type RecordValue={ sessionId:string;status:string;id:string;kind:string;title:string;prompt:string;timeZone:string }
function setup(proof={ org_id:org,session_id:session,time_zone:'Europe/Berlin',time_zone_source:'organization',support_configured:false }) {
  let handler: (req:unknown,res:unknown)=>Promise<void>,ensureCalls=0;const records:RecordValue[]=[]
  const ctx={ effect:(fn:()=>void)=>fn(),webServer:{ register:(route:{ handler:(req:unknown,res:unknown)=>Promise<void> })=>{handler=route.handler;return()=>{}} },hivemindExecutionScope:{ run:async(_p:unknown,fn:()=>unknown)=>fn() },sessionController:{ resolveAgent:async()=>({ agent:{ id:session } }) },serial:async()=>proof,schedule:{ catalog:async()=>records,ensure:async(id:string,key:string,request:ReturnType<typeof nightlyRoutineRequest>)=>{ensureCalls++;expect(id).toBe(session);expect(key).toBe('nightly-routine-check-v1');const existing=records[0];if(existing)return existing;const record={ sessionId:id,status:'active',id:'schedule-'+createHash('sha256').update(`${id}\0${key}`).digest('hex'),kind:'daily',title:request.title,prompt:request.prompt,timeZone:request.daily.time_zone };records.push(record);return record} } } as unknown as Context
  installNightlyRoutineHost(ctx,secret,[org])
  return { records,count:()=>ensureCalls,async call(body:unknown=payload,authorization=token(body)){let status=0,text='';const req=Object.assign(Readable.from([JSON.stringify(body)]),{ method:'POST',headers:{ authorization } }),res={ writeHead:(n:number)=>{status=n},end:(s:string)=>{text=s} };await handler!(req,res);return{ status,body:JSON.parse(text) }} }
}
it('binds short-lived signed requests to exact body, organization and audience',()=>{
  expect(authorizeNightlyRoutine(token(payload),secret,payload)).toBe(true)
  for(const auth of [undefined,token(payload,{ aud:'other' }),token(payload,{ exp:0 }),token(payload,{ sub:'other' })])expect(authorizeNightlyRoutine(auth,secret,payload)).toBe(false)
  expect(authorizeNightlyRoutine(token(payload),secret,{ ...payload,timeZone:'UTC' })).toBe(false)
})
it('uses authoritative wall-clock midnight without a new timer or forced agent work',()=>{
  const request=nightlyRoutineRequest('Europe/Berlin');expect(request.daily).toEqual({ time:'00:00:00',time_zone:'Europe/Berlin' });expect(request.prompt).toContain('ORIGINAL native scheduled occurrence');expect(request.prompt).toContain('without interrupting current work');expect(()=>nightlyRoutineRequest('bad/zone')).toThrow()
})
it('inspect does not create; ensure is per-room deterministic and reuses the same native record',async()=>{
  const fixture=setup();expect((await fixture.call({ ...payload,operation:'inspect' })).body.status).toBe('not_configured');expect(fixture.count()).toBe(0)
  const first=await fixture.call(),second=await fixture.call()
  expect(first.status).toBe(200)
  expect(second.body.schedule.id).toBe(first.body.schedule.id)
  expect(fixture.records).toHaveLength(1)
  expect(first.body.support_configured).toBe(false)
})
it('blocks an unenabled organization and fresh attestation mismatch before schedule mutation',async()=>{
  const fixture=setup();const other={ ...payload,orgId:'46af5800-3610-4b5a-9c14-ba7d97bef744' };expect((await fixture.call(other,token(other,{ org_id:other.orgId }))).status).toBe(403);expect(fixture.count()).toBe(0)
  const wrong=setup({ org_id:org,session_id:'session-other',time_zone:'UTC',time_zone_source:'default_utc',support_configured:false });expect((await wrong.call()).status).toBe(503);expect(wrong.count()).toBe(0)
})
it('does not silently duplicate or rewrite a committed schedule after timezone changes',async()=>{
  const fixture=setup();await fixture.call();fixture.records[0].timeZone='Asia/Kolkata';expect((await fixture.call()).status).toBe(503);expect(fixture.count()).toBe(1)
})

it('preserves explicitly inactive native schedules rather than silently reporting activation',async()=>{
  const fixture=setup()
  await fixture.call()
  fixture.records[0].status='inactive'
  expect((await fixture.call()).status).toBe(503)
  expect(fixture.count()).toBe(1)
})
