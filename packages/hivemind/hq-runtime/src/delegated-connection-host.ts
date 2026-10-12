/** Signed provider-completion notice; the native saved blocker remains authority. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { authenticatedRoot } from './employee-room.ts'
import { notifyDelegatedConnection } from './delegated-blocker.ts'
const request = z.object({
  orgId:z.uuid(),userId:z.uuid(),rootId:z.string().min(1).max(180),employeeId:z.uuid(),
  blockerId:z.string().min(1).max(180),workflowSessionId:z.string().min(1).max(180),
}).strict()
export function authorizeConnectionCompletion(authorization: string | undefined, secret: string, payload: unknown, now = Date.now()) {
  try {
    if (Buffer.byteLength(secret)<32 || !authorization?.startsWith('Bearer ')) return false
    const parts=authorization.slice(7).split('.')
    if (parts.length!==3) return false
    const [header,claimsPart,sig]=parts as [string,string,string]
    const expected=createHmac('sha256',secret).update(`${header}.${claimsPart}`).digest('base64url')
    if(sig.length!==expected.length || !timingSafeEqual(Buffer.from(sig),Buffer.from(expected))) return false
    const h=JSON.parse(Buffer.from(header,'base64url').toString()) as Record<string,unknown>
    const c=JSON.parse(Buffer.from(claimsPart,'base64url').toString()) as Record<string,unknown>
    const input=request.parse(payload),at=Math.floor(now/1000)
    return h['alg']==='HS256' && h['typ']==='JWT' && c['iss']==='hivemind-control-plane' && c['aud']==='hivemind-delegated-connection'
      && c['sub']===input.userId && c['org_id']===input.orgId && c['body_sha256']===createHash('sha256').update(JSON.stringify(payload)).digest('hex')
      && typeof c['iat']==='number' && Number.isInteger(c['iat']) && c['iat']<=at+5
      && typeof c['exp']==='number' && Number.isInteger(c['exp']) && c['exp']>at && c['exp']>c['iat'] && c['exp']-c['iat']<=30
  } catch {return false}
}
export function installConnectionCompletionHost(ctx: Context, secret: string) {
  ctx.effect(()=>ctx.webServer.register({ kind:'exact',path:'/internal/hivemind/delegated-connection',handler:async(req,res)=>{
    const reply=(status:number,value:unknown)=>{res.writeHead(status,{ 'content-type':'application/json','cache-control':'no-store' });res.end(JSON.stringify(value))}
    if(req.method!=='POST'){reply(405,{ error:'method_not_allowed' });return}
    try {
      const chunks:Buffer[]=[];let bytes=0
      for await(const chunk of req){const b=Buffer.from(chunk as Uint8Array);bytes+=b.length;if(bytes>8192)throw Error('oversized');chunks.push(b)}
      const raw:unknown=JSON.parse(Buffer.concat(chunks).toString())
      if(!authorizeConnectionCompletion(req.headers.authorization,secret,raw)){reply(401,{ error:'unauthorized' });return}
      const input=request.parse(raw),signal=AbortSignal.timeout(15000)
      await ctx.hivemindExecutionScope.run({ orgId:input.orgId,userId:input.userId,profile:'hivemind-chat',variation:'harness' },async()=>{
        const canonical = async () => {
          const proof=await ctx.serial('hivemind/employee-lifecycle-proof',{ employeeId:input.employeeId,signal }) as { employeeId?:string;phase?:string;chief?:{ sessionId?:string } }
          if(proof.employeeId!==input.employeeId || proof.phase!=='active' || proof.chief?.sessionId!==input.rootId) throw Error('canonical_runtime_required')
        }
        await canonical()
        const root=await authenticatedRoot(ctx,input.rootId,signal)
        const result=await notifyDelegatedConnection(ctx,root,input.blockerId,input.workflowSessionId,signal,canonical)
        reply(result.status==='accepted'?202:409,result)
      })
    }catch{if(!res.headersSent)reply(503,{ error:'delegated_connection_unavailable' })}
  } }),'Verified delegated connection completion')
}
