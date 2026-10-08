/** Server-authenticated authorship for native question submissions. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import type { OrganizationAgentAccess } from './organization-agent-access.ts'
import type { AuthenticatedActor } from '@deepseek-ai/dsh-hivemind-execution-scope'

export interface QuestionSubmission {
  eventId: string
  agentId: string
  request: object
  value: unknown
  signal: AbortSignal
}
const object = (value:unknown):value is Record<string,unknown> => value!==null && typeof value==='object' && !Array.isArray(value)
/** Validate only the native pending question's IDs; Client identity fields are never copied. */
export function questionAnswerText(input:QuestionSubmission,actor:AuthenticatedActor):{ callId:string;text:string } {
  const request=input.request as Record<string,unknown>
  const subject=request['agent'] as Agent|undefined
  if(!subject || subject.id!==input.agentId || typeof request['callId']!=='string' || !request['callId']) throw Error('question_answer_pending_identity_invalid')
  if(!Array.isArray(request['questions']) || !object(input.value) || !Array.isArray(input.value['answers'])) throw Error('question_answer_invalid')
  const questions=request['questions']
  const answers=input.value['answers']
  if(questions.length===0 || answers.length!==questions.length) throw Error('question_answer_invalid')
  const seen=new Set<string>()
  const accepted=answers.map((answer)=> {
    if(!object(answer) || typeof answer['id']!=='string' || seen.has(answer['id'])) throw Error('question_answer_invalid')
    seen.add(answer['id'])
    const question=questions.find(q=>object(q)&&q['id']===answer['id'])
    if(!object(question) || typeof question['question']!=='string' || !Array.isArray(answer['selected']) || !answer['selected'].every(x=>typeof x==='string') || (answer['custom']!==undefined && typeof answer['custom']!=='string')) throw Error('question_answer_invalid')
    return { id:answer['id'],question:question['question'],selected:answer['selected'],...(answer['custom']===undefined?{}:{ custom:answer['custom'] }) }
  })
  return { callId:request['callId'],text:`Authenticated question respondent: ${JSON.stringify({ name:actor.name,userId:actor.userId,orgId:actor.orgId,role:actor.role })}. This human submitted answers only to the following pending questions. Keep the original requesting or reporting employee separate from this respondent; do not attribute employee recommendations to this human.\n${JSON.stringify(accepted)}` }
}
/** Persist the actual human submission before the pending native tool can resume. */
export async function persistQuestionRespondent(
  input:QuestionSubmission,actor:AuthenticatedActor,agent:Agent,flush:(agent:Agent)=>Promise<boolean>,
):Promise<string> {
  input.signal.throwIfAborted()
  if(agent.id!==input.agentId) throw Error('question_answer_pending_identity_invalid')
  const { callId,text }=questionAnswerText(input,actor)
  const pendingSignal=(input.request as { signal?:AbortSignal }).signal
  pendingSignal?.throwIfAborted()
  const prior=agent.session.snapshotEvents().filter((event)=>{
    if(event.type!=='user/message')return false
    const source:unknown=event.data.source
    return object(source) && source['kind']==='user' && source['questionEventId']===input.eventId && source['questionCallId']===callId
  })
  if(prior.length>1)throw Error('question_answer_submission_conflict')
  let message
  if(prior[0]?.type==='user/message') {
    message=prior[0].data
    const source:unknown=message.source
    const previous=object(source)?source['authenticatedActor']:undefined
    if(!object(previous) || previous['userId']!==actor.userId || previous['orgId']!==actor.orgId ||
      message.content.length!==1 || message.content[0]?.type!=='text' || message.content[0].text!==text) {
      throw Error('question_answer_submission_conflict')
    }
  } else {
    message=createUserMessage({ content:[{ type:'text',text }],source:{ kind:'user',questionCallId:callId,
      questionEventId:input.eventId,questionAnswer:true,questionAnswerSubmission:true,authenticatedActor:actor } })
    agent.session.append('user/message',message,{ surfaceOp:'append' })
  }
  if(!await flush(agent))throw Error('question_answer_not_persisted')
  input.signal.throwIfAborted()
  pendingSignal?.throwIfAborted()
  return message.id
}

/** Install the awaited native result hook under the Session service's declared DI scope. */
export async function registerQuestionRespondents(ctx:Context,options:{
  authorize:(input:QuestionSubmission)=>Promise<{ agent:Agent;actor:AuthenticatedActor }|undefined>
  admitted:(agent:Agent,actor:AuthenticatedActor,messageId:string)=>void
}):Promise<void> {
  await ctx.inject(['sessions'],questionCtx=>questionCtx.effect(()=>questionCtx.on('typert/remote-event-result-admission',async (input)=>{
    if(input.event!=='user-questions/request')return
    const authority=await options.authorize(input)
    if(!authority)return
    const id=await persistQuestionRespondent(input,authority.actor,authority.agent,async agent=>questionCtx.sessions.flush(agent.session))
    options.admitted(authority.agent,authority.actor,id)
  })))
}

/** Validate the exact visible native root against fresh authoritative organization/profile state. */
export function validateQuestionRoom(input:QuestionSubmission,access:OrganizationAgentAccess,
  snapshot:SessionPersistenceSnapshot|undefined,agent:Agent,expected:{ orgId:string;userId:string },
  profiles?:readonly Record<string,unknown>[]):void {
  if(access.actor.orgId!==expected.orgId || access.actor.userId!==expected.userId ||
    access.agent.orgId!==expected.orgId || !['admin','owner'].includes(access.actor.role)) {
    throw Error('question_answer_session_not_authorized')
  }
  if(!snapshot || snapshot.header.id!==input.agentId || agent.id!==input.agentId ||
    (input.request as { agent?:unknown }).agent!==agent || snapshot.header.parentSession!==undefined) {
    throw Error('question_answer_session_not_authorized')
  }
  const selected=agent.session.snapshotEvents().findLast(event=>event.type==='agent-preset/selected')
  const preset=selected?.type==='agent-preset/selected'?selected.data.agentPreset:snapshot.header.agentPreset
  if(preset==='hivemind-hq') {
    if(access.agent.runtimeSessionId!==input.agentId)throw Error('question_answer_session_not_authorized')
    return
  }
  if(preset!=='hivemind-hyperagents')throw Error('question_answer_session_not_authorized')
  const owner=agent.session.snapshotEvents().findLast(event=>String(event.type)==='hivemind/session-owner')?.data as unknown
  const id=object(owner)?owner['id']:undefined
  const profile=profiles?.find(profile=>profile['id']===id)
  if(typeof id!=='string' || !profile || typeof profile['status']!=='string' || ['archived','deleted','terminated','suspended'].includes(profile['status'])) {
    throw Error('question_answer_employee_not_active')
  }
}
