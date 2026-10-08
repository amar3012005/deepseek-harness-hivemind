import { describe,it,expect } from 'vitest'
import { questionAnswerText,persistQuestionRespondent,validateQuestionRoom } from '../src/question-respondent.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
const actor={ userId:'e30e6761-d7ee-4843-92c9-a3b6ea4451ab',orgId:'f6b3e87a-6861-4584-93eb-83b6d5224559',name:'Admin B',role:'admin' as const }
function fixture(){
  const events:unknown[]=[]
  const agent={ id:'session-test',session:{ snapshotEvents:()=>events,append:(type:string,data:unknown)=>events.push({ type,data }) } } as unknown as Agent
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

import { Context,Service } from '@deepseek-ai/cordis'
import { registerQuestionRespondents } from '../src/question-respondent.ts'
class SubmissionSessions extends Service {
  static inject=[]
  flushed=false
  constructor(ctx:Context){super(ctx,'sessions')}
  async flush(){this.flushed=true;return true}
}
it('executes the Cordis-injected admission listener before resumption and rejects denied principals without writing',async()=>{
  const ctx=new Context();await ctx.plugin(SubmissionSessions)
  const { input,agent,events }=fixture();let allowed=false;const seen:string[]=[]
  await registerQuestionRespondents(ctx,{
    authorize:async (pending)=>{expect(pending.agentId).toBe(agent.id);if(!allowed)throw Error('active_admin_required');return { agent,actor }},
    admitted:(_agent,respondent,id)=>{
      expect((ctx.sessions as unknown as SubmissionSessions).flushed).toBe(true)
      expect(respondent).toEqual(actor);seen.push(id)
    },
  })
  await expect(ctx.parallel('typert/remote-event-result-admission',{ ...input,event:'user-questions/request' })).rejects.toThrow()
  expect(events).toHaveLength(0);expect(seen).toHaveLength(0)
  allowed=true
  await ctx.parallel('typert/remote-event-result-admission',{ ...input,event:'user-questions/request' })
  expect(events).toHaveLength(1);expect(seen).toHaveLength(1)
  await ctx.parallel('typert/remote-event-result-admission',{ ...input,event:'some/other-event' })
  expect(events).toHaveLength(1)
  await ctx.fiber.dispose()
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
