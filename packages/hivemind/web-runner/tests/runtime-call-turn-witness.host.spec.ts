import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { expect,it,vi } from 'vitest'
import { MockAdapter,textResponse,toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { admittedVoiceCallRef,currentTurnActor,retainTurnConfirmationRef } from '../src/organization-agent-access.ts'
import type {} from '../../runtime/src/voice-outcome.ts'

it.each(['codex','grok'] as const)('keeps the exact %s call witness through a real same-turn context handoff, then clears it',async(provider)=>{
  const ctx=new Context()
  await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry)
  const loop=await ctx.plugin(AgentLoop,{ agents:[] })
  const adapter=new MockAdapter([toolCallResponse('first','probe',{}),toolCallResponse('second','probe',{}),textResponse('done'),toolCallResponse('later','probe',{}),textResponse('done')])
  ctx.llm.registerAdapter(['mock'],adapter)
  const actor={ userId:'64f5568b-4d6a-4ae1-9a33-48cb2909d59b',orgId:'67503d34-97e9-49a8-8c52-8ee30cc7603e',role:'admin' as const,name:'B' }
  const agent=await ctx.agentLoop.create(SessionId('call-turn-'+provider),{ provider:'mock',model:'mock' })
  const callId='exact-'+provider
  for(const id of [callId,'later-'+provider]) agent.session.append('hivemind/voice-call-ended',{ callId:id,provider,authenticatedActor:actor,initialCheckIn:false,interrupted:false,hadUserSpeech:true,transcript:'Confirmed synthetic direction.' })
  let turn:number|undefined,previousActor:typeof actor|undefined,reference:string|undefined
  const observed:(string|undefined)[]=[]
  const pre=ctx.on('agent/pre-step',async({ agent:subject,messages,turn:current },next)=>{
    if(subject.id!==agent.id)return next()
    const same=turn===current
    const author=currentTurnActor(messages,previousActor,same)
    if(author)expect(author).toEqual(actor)
    reference=admittedVoiceCallRef(messages,subject.session.snapshotEvents(),actor)
      ??retainTurnConfirmationRef(reference,previousActor,actor,same)
    previousActor=actor;turn=current
    return next()
  },{ global:true })
  const end=ctx.on('agent/turn-ended',({ agent:subject,turn:current })=>{if(subject.id===agent.id&&turn===current){reference=undefined;turn=undefined;previousActor=undefined}},{ global:true })
  const tool=ctx.tools.register(defineContentToolFixture({ name:'probe',description:'Test exact call evidence',parameters:{},async execute(){
    observed.push(reference)
    if(observed.length===1)agent.inject(createUserMessage({ source:{ kind:'plugin',plugin:'hivemind-playbooks',form:'recall' },content:[{ type:'text',text:'Benign operating-context handoff' }] }))
    return [{ type:'text',text:reference??'No admitted call evidence' }]
  } }))
  try{
    agent.followup(createUserMessage({ source:{ kind:'plugin',plugin:'hivemind-live-voice',form:'recall',voiceCallId:callId,authenticatedActor:actor },content:[{ type:'text',text:'Reconcile this exact ended call.' }] }))
    await vi.waitFor(()=>expect(agent.status).toBe('idle'))
    expect(observed).toEqual(['call:'+callId,'call:'+callId])
    expect(reference).toBeUndefined()
    agent.followup(createUserMessage({ source:{ kind:'plugin',plugin:'schedule',form:'recall',authenticatedActor:actor },content:[{ type:'text',text:'Later autonomous turn with no call approval.' }] }))
    await vi.waitFor(()=>expect(observed).toHaveLength(3))
    await vi.waitFor(()=>expect(agent.status).toBe('idle'))
    expect(observed[2]).toBeUndefined()
  }finally{tool();pre();end();await loop.dispose()}
})
