import { describe,it,expect } from 'vitest'
import { questionAnswerText,persistQuestionRespondent,questionRespondentAdmission,validateQuestionRoom } from '../src/question-respondent.ts'
import { questionRespondentWitnessForReply } from '@deepseek-ai/dsh-hivemind-execution-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
const actor={ userId:'e30e6761-d7ee-4843-92c9-a3b6ea4451ab',orgId:'f6b3e87a-6861-4584-93eb-83b6d5224559',name:'Admin B',role:'admin' as const }
function fixture(){
  const events:unknown[]=[]
  const agent={ id:'session-test',session:{ snapshotEvents:()=>events,append:(type:string,data:unknown)=>events.push({ type,data,seq:events.length+1 }) } } as unknown as Agent
  const input={ eventId:'pending-native-event',agentId:agent.id,signal:new AbortController().signal,request:{ agent,callId:'actual-native-call',questions:[{ id:'finance',question:'Approve the internal reconciliation?' }] },value:{ answers:[{ id:'finance',selected:['Approve'] }],authenticatedActor:{ name:'Fake founder' } } }
  return { agent,input,events }
}
describe('authenticated native question respondent',()=>{
  it('persists authoritative B and exact pending IDs before continuation, without browser identity',async()=>{
    const { agent,input,events }=fixture();let flushed=false
    const id=await persistQuestionRespondent(input,actor,agent,async()=>{expect(events).toHaveLength(1);flushed=true;return true})
    expect(flushed).toBe(true);expect(id).toBeTruthy()
    const data=(events[0] as { data:{ source:unknown;content:{ text:string }[] } }).data
    expect(data.source).toMatchObject({ kind:'user',questionAnswer:true,questionCallId:'actual-native-call',questionEventId:'pending-native-event',authenticatedActor:actor })
    expect(data.content[0]?.text).toContain('Admin B');expect(data.content[0]?.text).not.toContain('Fake founder')
    expect(data.content[0]?.text).toContain('Keep the original requesting or reporting employee separate')
  })
  it('rejects a different pending agent and mismatched or duplicate question IDs before append',async()=>{
    const { agent,input,events }=fixture()
    await expect(persistQuestionRespondent({ ...input,agentId:'other' },actor,agent,async()=>true)).rejects.toThrow('pending_identity')
    expect(()=>questionAnswerText({ ...input,value:{ answers:[{ id:'other',selected:['Approve'] }] } },actor)).toThrow('question_answer_invalid')
    expect(()=>questionAnswerText({ ...input,value:{ answers:[{ id:'finance',selected:[] },{ id:'finance',selected:[] }] } },actor)).toThrow('question_answer_invalid')
    expect(events).toHaveLength(0)
  })
  it('does not accept a failed persistence or cancelled request',async()=>{
    const { agent,input }=fixture()
    await expect(persistQuestionRespondent(input,actor,agent,async()=>false)).rejects.toThrow('question_answer_not_persisted')
    const controller=new AbortController();controller.abort()
    await expect(persistQuestionRespondent({ ...input,signal:controller.signal },actor,agent,async()=>true)).rejects.toThrow()
  })
})

it('wraps the decoded native answer exactly once and saves a cold-replay witness only after native acceptance',async()=>{
  const { input,agent,events }=fixture();let allowed=false;let nextCalls=0;let flushes=0;const seen:string[]=[]
  const ctx={ agents:{ get:()=>agent },get:()=>({ snapshot:()=>({ values:{ userQuestions:{ active:[{ callId:'actual-native-call',questions:(input.request as { questions:unknown[] }).questions,state:'continued' }] } } }) }),
    sessions:{ flush:async()=>{flushes++;return true} } } as never
  const admission=questionRespondentAdmission(ctx,{
    authorize:async (pending)=>{expect(pending.agentId).toBe(agent.id);if(!allowed)throw Error('active_admin_required');return { agent,actor }},
    admitted:(_agent,respondent,id)=>{expect(respondent).toEqual(actor);seen.push(id)},
  })
  const request={ endpoint:'userQuestions/answer',payload:{ args:{ agentId:agent.id,callId:'actual-native-call',answer:input.value } },signal:input.signal,
    peer:{},request:new Request('https://example.test/api/userQuestions/answer',{ method:'POST' }) } as never
  const next=async()=>{nextCalls++;events.push({ type:'tool/call',seq:events.length+1,data:{ name:'ask_user_question',callId:'actual-native-call',arguments:{ questions:(input.request as { questions:unknown[] }).questions } } })
    events.push({ type:'user/message',seq:events.length+1,data:{ id:'native-reply',source:{ kind:'user-question-reply',callId:'actual-native-call',outcome:'answered' },content:[{ type:'text',text:JSON.stringify({ kind:'answer_to_pending_question',tool:'ask_user_question',callId:'actual-native-call',questions:(input.request as { questions:unknown[] }).questions,answers:(input.value as { answers:unknown[] }).answers }) }] } })
    return { ok:true as const,value:true } }
  await expect(admission(request,next)).rejects.toThrow('active_admin_required')
  expect(events).toHaveLength(0);expect(nextCalls).toBe(0)
  allowed=true
  expect(await admission(request,next)).toEqual({ ok:true,value:true })
  expect(nextCalls).toBe(1);expect(flushes).toBe(1);expect(seen).toHaveLength(1)
  const reply=events.find((event)=>{ const saved=event as { type?:string;data?:{ id?:string } };return saved.type==='user/message'&&saved.data?.id==='native-reply' })!
  expect(questionRespondentWitnessForReply(events as never,reply as never)).toMatchObject({ actor,id:seen[0] })
})

it('does not persist an actor witness when native answer returns false',async()=>{
  const { input,agent,events }=fixture();let flushes=0
  const ctx={ agents:{ get:()=>agent },get:()=>({ snapshot:()=>({ values:{ userQuestions:{ active:[{ callId:'actual-native-call',questions:(input.request as { questions:unknown[] }).questions,state:'continued' }] } } }) }),
    sessions:{ flush:async()=>{flushes++;return true} } } as never
  const admission=questionRespondentAdmission(ctx,{ authorize:async()=>({ agent,actor }),admitted:()=>{throw Error('not admitted')} })
  const request={ endpoint:'userQuestions/answer',payload:{ args:{ agentId:agent.id,callId:'actual-native-call',answer:input.value } },signal:input.signal,peer:{},request:new Request('https://example.test') } as never
  expect(await admission(request,async()=>({ ok:true,value:false }))).toEqual({ ok:true,value:false })
  expect(events).toHaveLength(0);expect(flushes).toBe(0)
})

it('reuses the exact submission after failed flush and refuses conflicting or cancelled retries',async()=>{
  const { agent,input,events }=fixture()
  await expect(persistQuestionRespondent(input,actor,agent,async()=>false)).rejects.toThrow('not_persisted')
  expect(events).toHaveLength(1)
  const first=(events[0] as { data:{ id:string } }).data.id
  expect(await persistQuestionRespondent(input,actor,agent,async()=>true)).toBe(first)
  expect(events).toHaveLength(1)
  await expect(persistQuestionRespondent(input,{ ...actor,userId:'other' },agent,async()=>true)).rejects.toThrow('submission_conflict')
  await expect(persistQuestionRespondent(
    { ...input,value:{ answers:[{ id:'finance',selected:['Decline'] }] } },actor,agent,async()=>true,
  )).rejects.toThrow('submission_conflict')
  expect(events).toHaveLength(1)
  const cancelled=new AbortController();cancelled.abort()
  await expect(persistQuestionRespondent(
    { ...input,request:{ ...input.request,signal:cancelled.signal } },actor,agent,async()=>true,
  )).rejects.toThrow()
  expect(events).toHaveLength(1)
})
it('binds the pending native room to fresh canonical organization and active employee authority',()=>{
  const { agent,input,events }=fixture()
  const snapshot={ header:{ id:agent.id,agentPreset:'hivemind-hq' },revision:'1' } as never
  const access={ actor,agent:{ orgId:actor.orgId,runtimeSessionId:agent.id,storageUserId:actor.userId } }
  expect(()=>validateQuestionRoom(input,access,snapshot,agent,actor)).not.toThrow()
  expect(()=>validateQuestionRoom(input,access,undefined,agent,actor)).toThrow('not_authorized')
  expect(()=>validateQuestionRoom(input,{ ...access,actor:{ ...actor,role:'member' } as never },snapshot,agent,actor)).toThrow('not_authorized')
  expect(()=>validateQuestionRoom(input,access,snapshot,agent,{ ...actor,orgId:'other' })).toThrow('not_authorized')
  expect(()=>validateQuestionRoom(input,{ ...access,agent:{ ...access.agent,runtimeSessionId:'other' } },snapshot,agent,actor)).toThrow('not_authorized')
  const employeeSnapshot={ header:{ id:agent.id,agentPreset:'hivemind-hyperagents' },revision:'1' } as never
  events.push({ type:'hivemind/session-owner',data:{ id:'employee-id' } })
  expect(()=>validateQuestionRoom(input,access,employeeSnapshot,agent,actor,[{ id:'employee-id',status:'ready' }])).not.toThrow()
  expect(()=>validateQuestionRoom(input,access,employeeSnapshot,agent,actor,[{ id:'employee-id',status:'archived' }])).toThrow('not_active')
  expect(()=>validateQuestionRoom(input,access,employeeSnapshot,agent,actor,[{ id:'another',status:'ready' }])).toThrow('not_active')
})
