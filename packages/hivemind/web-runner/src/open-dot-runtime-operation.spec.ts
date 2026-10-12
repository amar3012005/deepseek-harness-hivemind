import { describe, it, expect } from 'vitest'
import { createHash, createHmac } from 'node:crypto'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { createOpenDotRuntimeOperationHandler, verifyOpenDotRuntimeOperation, OPEN_DOT_RUNTIME_OPERATION_PATH } from './open-dot-runtime-operation.ts'
const secret = 'test-only-purpose-bound-secret-32-bytes'
const id = '12345678-1234-4234-8234-123456789abc'
const body = { organization_id:id,user_id:id,employee_id:id,dot_id:'dot_example',dispatch_message_id:id,operation:'message',message_key:'m',recipient:'Runtime',kind:'update',text:'Done',artifact_ids:[] }
function sign(raw:string, overrides = {}, key = secret, header = {alg:'HS256',typ:'JWT'}) {
 const encode = (v:unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
 const claims = {iss:'hivemind-control-plane',aud:'hivemind-open-dot-runtime-bridge',sub:id,org_id:id,profile:'hivemind-chat',variation:'harness',jti:id,body_sha256:createHash('sha256').update(raw).digest('hex'),iat:1000,exp:1030,employee_id:id,dot_id:'dot_example',dispatch_message_id:id,operation:'message',...overrides}
 const input = `${encode(header)}.${encode(claims)}`
 return `Bearer ${input}.${createHmac('sha256',key).update(input).digest('base64url')}`
}
describe('purpose-bound operation receiver',()=> {
 it('projects only approved args',()=> {const raw=JSON.stringify(body); expect(verifyOpenDotRuntimeOperation(raw,sign(raw),secret,1000000)).toEqual({principal:{organizationId:id,userId:id},employeeId:id,dotId:'dot_example',dispatchMessageId:id,operation:'message',approvedargs:{message_key:'m',recipient:'Runtime',kind:'update',text:'Done',artifact_ids:[]}})})
 for (const [name,patch] of Object.entries({audience:{aud:'other'},expired:{exp:990,iat:980},org:{org_id:'22345678-1234-4234-8234-123456789abc'},longLifetime:{exp:1031},extraClaim:{root_session_id:id}})) it(`rejects ${name}`,()=>{const raw=JSON.stringify(body);expect(()=>verifyOpenDotRuntimeOperation(raw,sign(raw,patch),secret,1000000)).toThrow()})
 it('rejects changed body, wrong key and extra/prototype fields',()=>{const raw=JSON.stringify(body);for(const value of [raw+' ',JSON.stringify({...body,session_id:id}),raw.slice(0,-1)+',"__proto__":{}}'])expect(()=>verifyOpenDotRuntimeOperation(value,sign(raw),secret,1000000)).toThrow();expect(()=>verifyOpenDotRuntimeOperation(raw,sign(raw,{},'wrong'),secret,1000000)).toThrow()})
 it('bounds args and supports blocker',()=>{const raw=JSON.stringify({...body,text:'x'.repeat(12001)});expect(()=>verifyOpenDotRuntimeOperation(raw,sign(raw),secret,1000000)).toThrow();const b=JSON.stringify({organization_id:id,user_id:id,employee_id:id,dot_id:'dot_example',dispatch_message_id:id,operation:'blocker',blocker_key:'b',question:'Need decision'});expect(verifyOpenDotRuntimeOperation(b,sign(b,{operation:'blocker'}),secret,1000000).operation).toBe('blocker')})
 it('does not call provider for invalid auth and sanitizes provider failure',async()=>{
  let calls=0
  const server=createServer(createOpenDotRuntimeOperationHandler({async execute(){calls++;throw new Error('secret provider details')}},{secret,now:()=>1000000}));server.listen(0,'127.0.0.1');await once(server,'listening')
  try {const address=server.address() as {port:number};const url=`http://127.0.0.1:${address.port}${OPEN_DOT_RUNTIME_OPERATION_PATH}`;const raw=JSON.stringify(body)
   let response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:sign(raw,{},'wrong')},body:raw});expect(response.status).toBe(401);expect(calls).toBe(0)
   response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:sign(raw)},body:raw});expect(response.status).toBe(503);expect(await response.text()).toBe('{"error":"open_dot_runtime_unavailable"}');expect(calls).toBe(1)
  }finally{server.close();server.closeAllConnections()}
 })
 it('returns durable receipt and forwards request cancellation',async()=>{
  let finish!:()=>void; let observed!:AbortSignal
  const started = new Promise<void>(resolve=>{finish=resolve})
  const server=createServer(createOpenDotRuntimeOperationHandler({async execute(_input,signal){observed=signal;finish();await once(signal,'abort');return {accepted:true,receipt_id:'persisted_receipt',delivery_state:'delivered'}}},{secret,now:()=>1000000}));server.listen(0,'127.0.0.1');await once(server,'listening')
  try {const address=server.address() as {port:number};const raw=JSON.stringify(body);const req=request({host:'127.0.0.1',port:address.port,path:OPEN_DOT_RUNTIME_OPERATION_PATH,method:'POST',headers:{'content-type':'application/json',authorization:sign(raw)} });req.on('error',()=>{});req.end(raw);await started;req.destroy();await once(observed,'abort');expect(observed.aborted).toBe(true)
  }finally{server.close();server.closeAllConnections()}
 })
 it('accepts the exact persisted receipt without adding authority fields',async()=>{
  const receipt={accepted:true as const,receipt_id:'persisted_receipt',delivery_state:'delivered'}
  const server=createServer(createOpenDotRuntimeOperationHandler({async execute(){return receipt}},{secret,now:()=>1000000}));server.listen(0,'127.0.0.1');await once(server,'listening')
  try {const address=server.address() as {port:number};const raw=JSON.stringify(body);const response=await fetch(`http://127.0.0.1:${address.port}${OPEN_DOT_RUNTIME_OPERATION_PATH}`,{method:'POST',headers:{'content-type':'application/json',authorization:sign(raw)},body:raw});expect(response.status).toBe(200);expect(await response.json()).toEqual(receipt)
  }finally{server.close();server.closeAllConnections()}
 })

})
