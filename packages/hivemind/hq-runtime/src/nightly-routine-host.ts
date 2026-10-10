/** Explicit one-organization activation over native Schedule; no timer, force-wake or global idle lock. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule'
import type {} from '@deepseek-ai/dsh-hivemind-execution-scope'
import { z } from 'zod'
const requestSchema=z.object({ orgId:z.uuid(),userId:z.uuid(),sessionId:z.string().regex(/^session-[a-z0-9-]{1,120}$/u),operation:z.enum(['inspect','ensure','upgrade']) }).strict()
const contextSchema=z.object({ org_id:z.uuid(),session_id:z.string(),time_zone:z.string(),time_zone_source:z.enum(['organization','default_utc']),support_configured:z.boolean() }).strict()
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Fresh Core canonical Runtime and organization timezone attestation. @mode serial */
    'hivemind/nightly-routine-context'(input:{ agent:Agent;signal:AbortSignal }):Promise<unknown>
  }
}
export function authorizeNightlyRoutine(authorization:string|undefined,secret:string,payload:unknown,now=Date.now()):boolean {
  try {
    if(!authorization?.startsWith('Bearer ')||Buffer.byteLength(secret)<32)return false
    const parts=authorization.slice(7).split('.');if(parts.length!==3)return false
    const [head,claimsPart,supplied]=parts as [string,string,string]
    const expected=createHmac('sha256',secret).update(`${head}.${claimsPart}`).digest('base64url')
    const a=Buffer.from(supplied),b=Buffer.from(expected);if(a.length!==b.length||!timingSafeEqual(a,b))return false
    const header=JSON.parse(Buffer.from(head,'base64url').toString('utf8')) as Record<string,unknown>
    const claims=JSON.parse(Buffer.from(claimsPart,'base64url').toString('utf8')) as Record<string,unknown>
    const input=requestSchema.parse(payload),at=Math.floor(now/1000)
    return header['alg']==='HS256'&&header['typ']==='JWT'&&claims['iss']==='hivemind-control-plane'&&claims['aud']==='hivemind-nightly-routine'
      &&claims['sub']===input.userId&&claims['org_id']===input.orgId&&claims['body_sha256']===createHash('sha256').update(JSON.stringify(payload)).digest('hex')
      &&typeof claims['iat']==='number'&&Number.isInteger(claims['iat'])&&claims['iat']<=at+5
      &&typeof claims['exp']==='number'&&Number.isInteger(claims['exp'])&&claims['exp']>at&&claims['exp']>claims['iat']&&claims['exp']-claims['iat']<=30
  }catch{return false}
}
export function nightlyRoutineRequest(timeZone:string) {
  new Intl.DateTimeFormat('en',{ timeZone }).format()
  return { title:'Nightly report',daily:{ time:'00:00:00',time_zone:timeZone },prompt:
    'Load hivemind-nightly-routine-check. Use this ORIGINAL native scheduled occurrence and evidence window even if queued behind other work. Ask EVERY active authorized HyperAgent through ordinary queued native messages about daily work, tool-call failures, schema errors, task/work blockers and evidenced performance problems, expected/observed behavior, recovery, prevention and structured evidence; include Runtime own findings using scoped evidence; missing evidence or replies are missing coverage. Keep the detailed report private, and submit bounded sanitized technical details and enumerated categories/counts through runtime_support_report, then check its actual delivery status. No repairs, private content export, arbitrary recipient, company-memory writes, external access changes or cancellation are authorized. Native Schedule queues this followup without interrupting current work.' }
}
export function installNightlyRoutineHost(ctx:Context,secret:string,allowedOrgIds:readonly string[]):void {
  ctx.effect(()=>ctx.webServer.register({ kind:'exact',path:'/internal/hivemind/nightly-routine',handler:async(req,res)=>{
    const reply=(status:number,value:unknown)=>{res.writeHead(status,{ 'content-type':'application/json','cache-control':'no-store' });res.end(JSON.stringify(value))}
    if(req.method!=='POST'){reply(405,{ error:'method_not_allowed' });return}
    try {
      const chunks:Buffer[]=[];let bytes=0
      for await(const chunk of req){const data=Buffer.from(chunk as Uint8Array);bytes+=data.length;if(bytes>4096)throw Error('body_too_large');chunks.push(data)}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
      if(!authorizeNightlyRoutine(req.headers.authorization,secret,body)){reply(401,{ error:'unauthorized' });return}
      const input=requestSchema.parse(body)
      if(!allowedOrgIds.includes(input.orgId)){reply(403,{ error:'nightly_organization_not_enabled' });return}
      const principal={ orgId:input.orgId,userId:input.userId,profile:'hivemind-chat' as const,variation:'harness' }
      const result=await ctx.hivemindExecutionScope.run(principal,async()=>{
        const resolved=await ctx.sessionController.resolveAgent(SessionId(input.sessionId));if('error'in resolved)throw resolved.error
        const proof=contextSchema.parse(await ctx.serial('hivemind/nightly-routine-context',{ agent:resolved.agent,signal:AbortSignal.timeout(8000) }))
        if(proof.org_id!==input.orgId||proof.session_id!==input.sessionId)throw Error('nightly_scope_mismatch')
        const request=nightlyRoutineRequest(proof.time_zone),key='nightly-routine-check-v1'
        const id=`schedule-${createHash('sha256').update(`${input.sessionId}\0${key}`).digest('hex')}`
        const existing=(await ctx.schedule.catalog()).find(record=>record.id===id&&record.sessionId===input.sessionId)
        if(existing?.status==='inactive')throw Error('nightly_inactive_schedule_requires_explicit_resume')
        if(existing&&existing.kind!=='daily')throw Error('nightly_existing_schedule_requires_explicit_edit')
        // An instruction upgrade never edits the user's saved recurrence or zone.
        if(existing&&input.operation==='ensure'&&(existing.time!=='00:00:00.000'||existing.timeZone!==proof.time_zone))throw Error('nightly_existing_schedule_requires_explicit_edit')
        let record:ScheduleCatalogEntry|undefined=existing
        if(input.operation==='upgrade'){
          if(!existing)throw Error('nightly_existing_schedule_required')
          const { sessionId,status,lastDelivery,...expected }=existing
          const result=await ctx.schedule.update({ sessionId,id:existing.id,expected,title:request.title,prompt:request.prompt })
          if(!('record'in result))throw Error('nightly_schedule_compare_update_failed')
          record={ ...result.record,sessionId,status,...(lastDelivery===undefined?{}:{ lastDelivery }) }
        }else if(input.operation==='ensure'){
          if(existing&&(existing.title!==request.title||existing.prompt!==request.prompt))throw Error('nightly_existing_schedule_requires_explicit_edit')
          const ensured=await ctx.schedule.ensure(SessionId(input.sessionId),key,request)
          record=existing??{ ...ensured,sessionId:SessionId(input.sessionId),status:'active' as const }
        }
        return { status:record?'configured':'not_configured',schedule:record??null,time_zone:proof.time_zone,time_zone_source:proof.time_zone_source,support_configured:proof.support_configured,queued_native_delivery:true }
      })
      reply(200,result)
    }catch{reply(503,{ error:'nightly_routine_unavailable',configured:false })}
  } }))
}
