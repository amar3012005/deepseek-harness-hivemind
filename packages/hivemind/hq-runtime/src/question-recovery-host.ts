/** Exact unanswered legacy question recovery; no human answer or instruction is manufactured. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { authenticatedActorFromSource } from '@deepseek-ai/dsh-hivemind-execution-scope'
import { z } from 'zod'
import { authenticatedRoot } from './employee-room.ts'

const plugin = 'hivemind-hq/question-recovery'
const prefix = 'HQ_UNANSWERED_QUESTION_RECOVERY='
const request = z.object({ orgId:z.uuid(),userId:z.uuid(),sessionId:z.string().min(1).max(180),
  turn:z.number().int().positive(),callId:z.string().min(1).max(180),callSequence:z.number().int().nonnegative(),
  questionSha256:z.string().regex(/^[a-f0-9]{64}$/u) }).strict()
export type QuestionRecoveryRequest = z.infer<typeof request>
const hash = (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function ordered(value:unknown):unknown {return Array.isArray(value)?value.map(ordered):value!==null&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(name=>[name,ordered(Reflect.get(value,name))])):value}
export const questionRecoveryHash = (value:unknown) => hash(ordered(value))
export function authorizeQuestionRecovery(authorization:string|undefined,secret:string,payload:unknown,now=Date.now()):boolean {
  try {
    if(Buffer.byteLength(secret)<32 || !authorization?.startsWith('Bearer '))return false
    const [head,body,sig,...extra]=authorization.slice(7).split('.')
    if(!head || !body || !sig || extra.length)return false
    const expected=createHmac('sha256',secret).update(`${head}.${body}`).digest('base64url')
    if(sig.length!==expected.length || !timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return false
    const h=JSON.parse(Buffer.from(head,'base64url').toString()) as Record<string,unknown>
    const c=JSON.parse(Buffer.from(body,'base64url').toString()) as Record<string,unknown>
    const input=request.parse(payload),at=Math.floor(now/1000)
    return h['alg']==='HS256' && h['typ']==='JWT' && c['iss']==='hivemind-control-plane'
      && c['aud']==='hivemind-question-recovery' && c['sub']===input.userId && c['org_id']===input.orgId
      && c['body_sha256']===hash(payload) && typeof c['iat']==='number' && Number.isInteger(c['iat']) && c['iat']<=at+5
      && typeof c['exp']==='number' && Number.isInteger(c['exp']) && c['exp']>at && c['exp']>c['iat'] && c['exp']-c['iat']<=30
  }catch{return false}
}
function key(input:QuestionRecoveryRequest){return `${input.turn}:${input.callSequence}:${input.callId}:${input.questionSha256}`}
function marked(message:UserMessage,value:string){return message.source.kind==='plugin' && message.source.plugin===plugin
  && message.content.some(part=>part.type==='text'&&part.text.startsWith(prefix+value+'\n'))}
export function questionRecoverySeen(agent:Agent,input:QuestionRecoveryRequest):boolean {
  return agent.session.ownEvents().some(event=>(event.type==='user/message'&&marked(event.data,key(input)))
    || (event.type==='agent/inbox/spliced'&&event.data.inserted.some(message=>marked(message,key(input)))))
}
/** Derive all human-facing question text and its provenance exclusively from the immutable native log. */
export function savedQuestionRecovery(agent:Agent,input:QuestionRecoveryRequest) {
  const events=agent.session.ownEvents(),call=events.find(event=>event.seq===input.callSequence)
  if(call?.type!=='tool/call' || call.data.name!=='ask_user_question' || call.data.callId!==input.callId
    || call.data.turn!==input.turn)throw Error('exact_saved_question_required')
  let raw:unknown=call.data.arguments
  if(typeof raw==='string')raw=JSON.parse(raw)
  const args=z.object({
    questions:z.array(z.object({ id:z.string().min(1),question:z.string().min(1) }).passthrough()).min(1).max(20),
  }).strict().parse(raw)
  if(questionRecoveryHash(args)!==input.questionSha256)throw Error('saved_question_hash_mismatch')
  const start=events.find(event=>event.type==='turn/start'&&event.data.turn===input.turn)
  const end=events.find(event=>event.type==='turn/end'&&event.data.turn===input.turn)
  if(!start || end?.type!=='turn/end' || !((end.data.reason.kind==='aborted'&&end.data.reason.reason.kind==='user')
    || end.data.reason.kind==='interrupted'))throw Error('verified_interrupted_question_required')
  const results=events.filter(event=>event.type==='tool/result'&&event.data.message.content.some(part=>part.type==='tool-result'&&part.toolCallId===input.callId))
  if(results.some(event=>event.type==='tool/result'&&event.data.message.content.some(part=>part.type==='tool-result'&&part.toolCallId===input.callId&&!part.isError)))throw Error('question_already_answered')
  const original=events.findLast(event=>event.type==='user/message'&&event.seq>start.seq&&event.seq<call.seq&&event.data.source.kind!=='plugin')
  if(original?.type!=='user/message' || !['user','schedule'].includes(original.data.source.kind))throw Error('original_question_request_required')
  const actor=authenticatedActorFromSource(original.data.source)
  if(!actor || actor.orgId!==input.orgId || actor.userId!==input.userId)throw Error('original_authenticated_actor_required')
  if(events.some(event=>event.type==='user/message'&&event.seq>call.seq&&event.data.source.kind!=='plugin'))throw Error('new_human_context_supersedes_recovery')
  if(events.some(event=>event.type==='turn/start'&&event.seq>end.seq))throw Error('new_turn_supersedes_recovery')
  return { args,original:{ sequence:original.seq,messageId:original.data.id,source:original.data.source },endSequence:end.seq }
}
export async function restoreSavedQuestion(ctx:Context,agent:Agent,input:QuestionRecoveryRequest) {
  const authority=ctx.sessionPersistence as typeof ctx.sessionPersistence&{ validateAdministratorRoom?:(id:SessionId)=>Promise<void> }
  if(!authority.validateAdministratorRoom)throw Error('fresh_administrator_authority_required')
  const validateAdministratorRoom=authority.validateAdministratorRoom.bind(authority)
  await validateAdministratorRoom(SessionId(input.sessionId))
  const directory=ctx.agentPresets.serviceFor(agent,'hivemindEmployeeDirectory')??ctx.get('hivemindEmployeeDirectory')
  if(!directory)throw Error('fresh_administrator_authority_required')
  await directory.profiles(AbortSignal.timeout(8000))
  // A fresh scoped persistence read also rechecks the current organization/room access.
  const checked=await authenticatedRoot(ctx,input.sessionId,AbortSignal.timeout(8000))
  if(checked!==agent)throw Error('question_recovery_owner_changed')
  if(agent.session.ownEvents().some(event=>event.type==='user/message'&&marked(event.data,key(input))))return { status:'already_recorded' as const }
  return agent.runMaintenance(async (signal)=>{
    const releasePrefix='HQ_QUESTION_RECOVERY_RELEASE='+key(input)+'\n'
    const isRelease=(message:UserMessage)=>message.source.kind==='plugin'&&message.source.plugin===plugin
      &&message.content.some(part=>part.type==='text'&&part.text.startsWith(releasePrefix))
    const pending=()=>[...agent.inbox.nextTurn,...agent.inbox.nextStep]
    const unrelated=()=>pending().some(message=>!marked(message,key(input))&&!isRelease(message))
    if(unrelated())throw Error('question_recovery_requires_empty_business_inbox')
    const saved=savedQuestionRecovery(agent,input)
    await validateAdministratorRoom(SessionId(input.sessionId))
    signal.throwIfAborted()
    if(unrelated())throw Error('question_recovery_requires_empty_business_inbox')
    const text=prefix+key(input)+'\nAdministrative recovery of an unanswered question after a service interruption. This is host operating context, not a new human instruction or answer. The original triggering context remains unchanged in the saved log. Signed current administrator authority restores presentation only and does not grant business authority. Reissue ONLY this exact saved ask_user_question argument, then wait for the authentic person. Do not infer an answer, claim approval, change goals, delegate, send email, run business tools, or continue other work in this recovery turn.\nSaved provenance: '+JSON.stringify(saved.original)+'\nExact question arguments: '+JSON.stringify(saved.args)
    // A graceful shutdown can clear an injected inbox. Reconstruct from the same immutable call,
    // even if an earlier durable marker exists; only an admitted marker makes restoration final.
    if(!pending().some(message=>marked(message,key(input))))agent.inject(createUserMessage({ source:{ kind:'plugin',plugin },content:[{ type:'text',text }] }))
    if(!await ctx.sessions.flush(agent.session))throw Error('question_recovery_persistence_required')
    signal.throwIfAborted()
    if(unrelated()){
      for(const message of pending().filter(message=>marked(message,key(input))||isRelease(message)))agent.inbox.remove(message.id)
      await ctx.sessions.flush(agent.session)
      throw Error('new_human_context_supersedes_recovery')
    }
    savedQuestionRecovery(agent,input)
    for(const message of pending().filter(isRelease))agent.inbox.remove(message.id)
    // Native maintenance holds the wake until the exact context and release are durably flushed.
    agent.followup(createUserMessage({ source:{ kind:'plugin',plugin },content:[{ type:'text',text:releasePrefix+'Release the previously saved administrative question recovery context. Reissue its exact original question only; no human answer was supplied.' }] }))
    if(!await ctx.sessions.flush(agent.session)){
      for(const message of pending().filter(isRelease))agent.inbox.remove(message.id)
      throw Error('question_recovery_release_persistence_required')
    }
    signal.throwIfAborted()
    if(unrelated()){
      for(const message of pending().filter(message=>marked(message,key(input))||isRelease(message)))agent.inbox.remove(message.id)
      await ctx.sessions.flush(agent.session)
      throw Error('new_human_context_supersedes_recovery')
    }
    return { status:'accepted' as const,originalCallId:input.callId,originalSequence:input.callSequence,questionSha256:input.questionSha256 }
  })
}
/** A recovery turn may present the saved question; it cannot acquire business capabilities. */
function recoveryTurn(agent:Agent) {
  const events=agent.session.ownEvents(),start=events.findLast(event=>event.type==='turn/start')
  if(!start)return
  const messages=events.filter(event=>event.type==='user/message'&&event.seq>start.seq)
  if(messages.some(event=>event.type==='user/message'&&event.data.source.kind!=='plugin'))return
  const framed=messages.find(event=>event.type==='user/message'&&event.data.source.kind==='plugin'&&event.data.source.plugin===plugin
    && event.data.content.some(part=>part.type==='text'&&part.text.startsWith(prefix)))
  if(framed?.type!=='user/message')return
  const text=framed.data.content.find(part=>part.type==='text'&&part.text.startsWith(prefix))
  if(text?.type!=='text')return
  const line=text.text.split('\n').find(value=>value.startsWith('Exact question arguments: '))
  if(!line)return
  try{return { start,args:JSON.parse(line.slice('Exact question arguments: '.length)) as unknown }}catch{return}
}
export function questionRecoveryToolDenied(agent:Agent,name:string,args:unknown):boolean {
  const active=recoveryTurn(agent)
  return active!==undefined&&(name!=='ask_user_question'||questionRecoveryHash(args)!==questionRecoveryHash(active.args))
}
export function installQuestionRecoveryHost(ctx:Context,secret:string):void {
  ctx.effect(()=>ctx.tools.guard((execution)=>{
    if(execution.agent&&questionRecoveryToolDenied(execution.agent,execution.name,execution.arguments))return 'question_recovery_only: reissue only the exact saved question; no new human instruction, answer, permission, or business work was supplied.'
  }))
  ctx.effect(()=>ctx.webServer.register({ kind:'exact',path:'/internal/hivemind/question-recovery',handler:async(req,res)=>{
    const reply=(status:number,value:unknown)=>{res.writeHead(status,{ 'content-type':'application/json','cache-control':'no-store' });res.end(JSON.stringify(value))}
    if(req.method!=='POST'){reply(405,{ error:'method_not_allowed' });return}
    try {
      const chunks:Buffer[]=[];let bytes=0
      for await(const chunk of req){const b=Buffer.from(chunk as Uint8Array);bytes+=b.length;if(bytes>4096)throw Error('body_too_large');chunks.push(b)}
      const raw:unknown=JSON.parse(Buffer.concat(chunks).toString())
      if(!authorizeQuestionRecovery(req.headers.authorization,secret,raw)){reply(401,{ error:'unauthorized' });return}
      const input=request.parse(raw)
      await ctx.hivemindExecutionScope.run({ orgId:input.orgId,userId:input.userId,profile:'hivemind-chat',variation:'harness' },async()=>{
        const agent=await authenticatedRoot(ctx,input.sessionId,AbortSignal.timeout(8000))
        reply(202,await restoreSavedQuestion(ctx,agent,input))
      })
    }catch{if(!res.headersSent)reply(409,{ error:'saved_question_recovery_unavailable' })}
  } }),'Exact saved question recovery')
}
