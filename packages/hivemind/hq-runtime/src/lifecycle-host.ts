/** Core-attested lifecycle effects use native Schedule, never model-generated scopes. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-hivemind-execution-scope'
import type {} from '@deepseek-ai/dsh-schedule'
import type {} from '@deepseek-ai/dsh-api-session-controller'
export const name = 'hivemind-employee-lifecycle-host'
export const inject = ['webServer', 'hivemindExecutionScope', 'schedule', 'sessionController']
export interface Config { enabled: boolean; serviceSecretEnv: string }
export const Config: Schema<Config> = Schema.object({ enabled: Schema.boolean().default(false), serviceSecretEnv: Schema.string().default('HIVE_HARNESS_RUNNER_SERVICE_SECRET') })
const requestSchema = z.object({ orgId:z.uuid(), userId:z.uuid(), employeeId:z.uuid() }).strict()
const roomSchema = z.object({ sessionId:z.string().min(1).max(180), userId:z.uuid() }).strict()
const proofSchema = z.object({ employeeId:z.uuid(),revision:z.number().int().positive(),kind:z.enum(['durable','temporary']),phase:z.enum(['active','closing','archived']),expiresAt:z.string().nullable(),rooms:z.array(roomSchema).max(1000),chiefs:z.array(roomSchema).max(1000),chief:roomSchema.nullable(),onboarding:z.object({ name:z.string().min(1).max(100),role:z.string().min(1).max(40),creationHash:z.string().regex(/^[a-f0-9]{64}$/u) }).strict().optional() }).strict()
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Read only Core's current administrator-authorized registry attestation. @mode serial */
    'hivemind/employee-lifecycle-proof'(
      input: { employeeId: string; signal: AbortSignal },
    ): Promise<unknown>
  }
}
export function authorizeLifecycleCallback(
  authorization: string | undefined, secret: string | undefined, payload: unknown, now=Date.now(),
): boolean {
  if (!secret || Buffer.byteLength(secret)<32 || !authorization?.startsWith('Bearer ')) return false
  try {
    const parts=authorization.slice(7).split('.')
    if(parts.length!==3) return false
    const [headerPart,claimsPart,supplied]=parts as [string,string,string]
    const expected=createHmac('sha256',secret).update(`${headerPart}.${claimsPart}`).digest('base64url')
    const a=Buffer.from(supplied), b=Buffer.from(expected)
    if(a.length!==b.length || !timingSafeEqual(a,b)) return false
    const header=JSON.parse(Buffer.from(headerPart,'base64url').toString('utf8')) as Record<string,unknown>
    const claims=JSON.parse(Buffer.from(claimsPart,'base64url').toString('utf8')) as Record<string,unknown>
    const input=requestSchema.parse(payload), at=Math.floor(now/1000)
    return header['alg']==='HS256' && header['typ']==='JWT' && claims['iss']==='hivemind-control-plane'
      && claims['aud']==='hivemind-employee-lifecycle' && claims['sub']===input.userId && claims['org_id']===input.orgId
      && typeof claims['iat']==='number' && Number.isInteger(claims['iat']) && claims['iat']<=at+5
      && typeof claims['exp']==='number' && Number.isInteger(claims['exp']) && claims['exp']>at && claims['exp']>claims['iat'] && claims['exp']-claims['iat']<=30
      && claims['body_sha256']===createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  } catch {return false}
}
async function readBody(req:IncomingMessage) {
  const chunks:Buffer[]=[];let bytes=0
  for await(const chunk of req) { const data=Buffer.from(chunk as Uint8Array);bytes+=data.length;if(bytes>8192) throw Error('body_too_large');chunks.push(data) }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}
const reply=(res:ServerResponse,status:number,value:unknown)=>{res.writeHead(status,{ 'content-type':'application/json','cache-control':'no-store' });res.end(JSON.stringify(value))}
export function apply(ctx:Context,config:Config):void {
  if(!config.enabled) return
  const secret=process.env[config.serviceSecretEnv]
  if(!secret || Buffer.byteLength(secret)<32) throw Error('employee_lifecycle_service_secret_required')
  ctx.effect(()=>ctx.webServer.register({ kind:'exact',path:'/internal/hivemind/employee-lifecycle',handler:async(req,res)=>{
    if(req.method!=='POST') {reply(res,405,{ error:'method_not_allowed' });return}
    try {
      const body=await readBody(req)
      if(!authorizeLifecycleCallback(req.headers.authorization,secret,body)) {reply(res,401,{ error:'unauthorized' });return}
      const input=requestSchema.parse(body)
      const principal={ orgId:input.orgId,userId:input.userId,profile:'hivemind-chat' as const,variation:'harness' }
      await ctx.hivemindExecutionScope.run(principal,async()=>{
        // Fresh Core read rechecks active administrator membership and returns
        // only persisted tenant-owned rooms; request body never selects a scope.
        const proof=proofSchema.parse(await ctx.serial('hivemind/employee-lifecycle-proof',{ employeeId:input.employeeId,signal:AbortSignal.timeout(8000) }))
        if(proof.employeeId!==input.employeeId) throw Error('employee_lifecycle_scope_mismatch')
        if(proof.phase==='archived') {
          let removed=0
          for(const room of proof.rooms) await ctx.hivemindExecutionScope.run({ ...principal,userId:room.userId },async()=>{
            for(const wake of await ctx.schedule.list({ sessionId:SessionId(room.sessionId) })) {
              await ctx.schedule.delete({ sessionId:SessionId(room.sessionId),id:wake.id });removed+=1
            }
          })
          for(const chief of proof.chiefs) await ctx.hivemindExecutionScope.run({ ...principal,userId:chief.userId },async()=>{
            const id=`schedule-${createHash('sha256').update(`${chief.sessionId}\0employee-closeout-${input.employeeId}`).digest('hex')}`
            for(const wake of await ctx.schedule.list({ sessionId:SessionId(chief.sessionId) })) if(wake.id===id) {
              await ctx.schedule.delete({ sessionId:SessionId(chief.sessionId),id:wake.id });removed+=1
            }
          })
          reply(res,200,{ status:'ready',employeeId:input.employeeId,revision:proof.revision,removedSchedules:removed });return
        }
        if (proof.phase === 'active' && proof.onboarding !== undefined) {
          if (!proof.chief || proof.chief.userId !== input.userId) throw Error('employee_onboarding_chief_required')
          const signal = AbortSignal.timeout(15000)
          const chief = await ctx.sessionController.resolveAgent(SessionId(proof.chief.sessionId))
          if ('error' in chief) throw chief.error
          await ctx.sessionController.resolvePersistentEmployeeRoom(input.employeeId, {
            id: input.employeeId, name: proof.onboarding.name, role: proof.onboarding.role,
          }, signal)
          // Binding a room is not permission to start it after a concurrent closeout.
          const current = proofSchema.parse(await ctx.serial('hivemind/employee-lifecycle-proof', {
            employeeId: input.employeeId, signal,
          }))
          if (current.phase !== 'active' || current.revision !== proof.revision
            || current.chief?.sessionId !== proof.chief.sessionId
            || current.onboarding?.creationHash !== proof.onboarding.creationHash) throw Error('employee_lifecycle_changed')
          await ctx.sessionController.deliverAgentMessage(chief.agent, {
            key: `employee-setup-${input.employeeId}-${proof.onboarding.creationHash}`,
            target: input.employeeId, kind: 'question',
            targetProfile: { id: input.employeeId, name: proof.onboarding.name, role: proof.onboarding.role },
            text: 'Welcome to our team. Please introduce yourself and ask our administrator which responsibilities they want you to own. Once they answer, confirm and save what you agreed. Your existing permissions stay the same.',
          }, signal)
        }
        if(proof.kind==='temporary' && proof.phase==='active') {
          if(!proof.chief || proof.chief.userId!==input.userId || !proof.expiresAt || !Number.isFinite(Date.parse(proof.expiresAt))) throw Error('employee_closeout_chief_required')
          const wake=await ctx.schedule.ensure(SessionId(proof.chief.sessionId),`employee-closeout-${input.employeeId}`,{
            title:'Review temporary employee closeout',at:new Date(Math.max(Date.parse(proof.expiresAt),Date.now()+1000)).toISOString(),
            prompt:`A temporary employee reached its saved deadline: ${input.employeeId}. Inspect its registry state and saved work. Begin closeout, review submitted artifacts, and retain private learning and handoff before archival. Do not assign new business work.`,
          })
          // Archive may have completed its cleanup while this request was creating
          // the wake. Reconcile after the native write; unknown authority removes it.
          try {
            const current=proofSchema.parse(await ctx.serial('hivemind/employee-lifecycle-proof',{ employeeId:input.employeeId,signal:AbortSignal.timeout(8000) }))
            if(current.employeeId!==input.employeeId || current.phase!=='active' || current.revision!==proof.revision
              || current.chief?.sessionId!==proof.chief.sessionId || current.expiresAt!==proof.expiresAt) throw Error('employee_lifecycle_changed')
          } catch {
            await ctx.schedule.delete({ sessionId:SessionId(proof.chief.sessionId),id:wake.id })
            throw Error('employee_lifecycle_changed')
          }
          reply(res,200,{ status:'ready',employeeId:input.employeeId,revision:proof.revision,scheduleId:wake.id });return
        }
        reply(res,200,{ status:'ready',employeeId:input.employeeId,revision:proof.revision })
      })
    } catch {reply(res,503,{ error:'employee_lifecycle_activation_unavailable' })}
  } }),'employee-lifecycle.host')
}
