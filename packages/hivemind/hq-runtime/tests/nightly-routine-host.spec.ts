import { it, expect } from 'vitest'
import { createHash, createHmac } from 'node:crypto'
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { authorizeNightlyRoutine, installNightlyRoutineHost, nightlyRoutineRequest } from '../src/nightly-routine-host.ts'
const secret='s'.repeat(48),org='8cf195d6-f2c8-453a-bd95-b8a3d70bf0b0',user='85601c95-b367-45b4-b66b-069b68c4dfd0',session='session-nightly-test'
const payload={ orgId:org,userId:user,sessionId:session,operation:'ensure' }
function token(value:unknown,override:Record<string,unknown>={}) {const enc=(v:unknown)=>Buffer.from(JSON.stringify(v)).toString('base64url'),now=Math.floor(Date.now()/1000);const text=enc({ alg:'HS256',typ:'JWT' })+'.'+enc({ iss:'hivemind-control-plane',aud:'hivemind-nightly-routine',sub:user,org_id:org,iat:now,exp:now+30,body_sha256:createHash('sha256').update(JSON.stringify(value)).digest('hex'),...override });return 'Bearer '+text+'.'+createHmac('sha256',secret).update(text).digest('base64url')}
type RecordValue={ sessionId:string;status:string;id:string;kind:string;title:string;prompt:string;time:string;timeZone:string }
function savedRecord(records: RecordValue[]): RecordValue {
  const value = records[0]
  if (!value) throw new Error('expected saved native schedule')
  return value
}
function setup(proof={ org_id:org,session_id:session,time_zone:'Europe/Berlin',time_zone_source:'organization',support_configured:false }, updateConflict=false) {
  let handler: (req:unknown,res:unknown)=>Promise<void>,ensureCalls=0;const records:RecordValue[]=[]
  const ctx={ effect:(fn:()=>void)=>fn(),webServer:{ register:(route:{ handler:(req:unknown,res:unknown)=>Promise<void> })=>{handler=route.handler;return()=>{}} },hivemindExecutionScope:{ run:async(_p:unknown,fn:()=>unknown)=>fn() },sessionController:{ resolveAgent:async()=>({ agent:{ id:session } }) },serial:async()=>proof,schedule:{ update:async(request:{ id:string;sessionId:string;expected:RecordValue;title:string;prompt:string })=>{const current=records[0];if(updateConflict)return { id:request.id,updated:false,code:'schedule_conflict' };if(!current||current.id!==request.id||current.sessionId!==request.sessionId)return { id:request.id,updated:false,code:'schedule_not_found' };expect(request.expected.title).toBe(current.title);expect(request.expected.prompt).toBe(current.prompt);current.title=request.title;current.prompt=request.prompt;return { id:current.id,updated:true,record:current }},catalog:async()=>records,ensure:async(id:string,key:string,request:ReturnType<typeof nightlyRoutineRequest>)=>{ensureCalls++;expect(id).toBe(session);expect(key).toBe('nightly-routine-check-v1');const existing=records[0];if(existing)return existing;const record={ sessionId:id,status:'active',id:'schedule-'+createHash('sha256').update(`${id}\0${key}`).digest('hex'),kind:'daily',title:request.title,prompt:request.prompt,time:'00:00:00.000',timeZone:request.daily.time_zone };records.push(record);return record} } } as unknown as Context
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
  const fixture=setup();await fixture.call();savedRecord(fixture.records).timeZone='Asia/Kolkata';expect((await fixture.call()).status).toBe(503);expect(fixture.count()).toBe(1)
})

it('preserves explicitly inactive native schedules rather than silently reporting activation',async()=>{
  const fixture=setup()
  await fixture.call()
  savedRecord(fixture.records).status='inactive'
  expect((await fixture.call()).status).toBe(503)
  expect(fixture.count()).toBe(1)
})

it('rejects changed daily wall-clock time without rewriting a saved schedule',async()=>{const fixture=setup();await fixture.call();savedRecord(fixture.records).time='08:00:00.000';expect((await fixture.call()).status).toBe(503);expect(fixture.count()).toBe(1)})

it('explicit upgrade renames the SAME native record through compare-and-update without changing time or creating a duplicate',async()=>{const f=setup();await f.call();const record=savedRecord(f.records),id=record.id;record.title='Nightly routine check';record.prompt='Load hivemind-nightly-routine-check. Legacy counts only.';const calls=f.count();const changed=await f.call({ ...payload,operation:'upgrade' });expect(changed.status).toBe(200);expect(f.count()).toBe(calls);expect(f.records).toHaveLength(1);expect(record.id).toBe(id);expect(record.title).toBe('Nightly report');expect(record.timeZone).toBe('Europe/Berlin');expect(record.time).toBe('00:00:00.000');expect(record.prompt).toContain('EVERY active authorized HyperAgent')})
it('upgrade cannot create missing records or resume inactive records',async()=>{const f=setup();expect((await f.call({ ...payload,operation:'upgrade' })).status).toBe(503);expect(f.count()).toBe(0);await f.call();savedRecord(f.records).status='inactive';expect((await f.call({ ...payload,operation:'upgrade' })).status).toBe(503)})

it('CAS conflict preserves the legacy record and inspect is mutation-free',async()=>{const f=setup(undefined,true);await f.call();const record=savedRecord(f.records);record.title='Nightly routine check';record.prompt='Legacy prompt';expect((await f.call({ ...payload,operation:'inspect' })).status).toBe(200);expect(record.title).toBe('Nightly routine check');expect((await f.call({ ...payload,operation:'upgrade' })).status).toBe(503);expect(record.prompt).toBe('Legacy prompt');expect(f.count()).toBe(1)})

it('instruction upgrade preserves the saved night time and zone even when organization settings have changed',async()=>{
  const f=setup();await f.call();const record=savedRecord(f.records),id=record.id
  record.time='22:30:00.000';record.timeZone='Asia/Kolkata';record.title='Nightly routine check';record.prompt='Legacy prompt'
  const inspected=await f.call({ ...payload,operation:'inspect' })
  expect(inspected.status).toBe(200);expect(inspected.body.schedule.timeZone).toBe('Asia/Kolkata')
  expect(record.prompt).toBe('Legacy prompt')
  const upgraded=await f.call({ ...payload,operation:'upgrade' })
  expect(upgraded.status).toBe(200);expect(upgraded.body.schedule.timeZone).toBe('Asia/Kolkata')
  expect(record.id).toBe(id);expect(record.time).toBe('22:30:00.000');expect(record.timeZone).toBe('Asia/Kolkata')
  expect(record.title).toBe('Nightly report');expect(f.count()).toBe(1);expect(f.records).toHaveLength(1)
})
