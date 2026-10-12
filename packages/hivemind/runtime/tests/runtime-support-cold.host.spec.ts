import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect,it,vi } from 'vitest'
import { MockAdapter,textResponse,toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { installRuntimeSupportReport } from '../src/nightly-support.ts'
import { installRuntimeDecisionMemory } from '../src/runtime-decision-memory.ts'

async function mount(root:string,adapter:MockAdapter){
  const ctx=new Context()
  await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence,{ root });await ctx.plugin(AgentLoop,{ agents:[] })
  ctx.llm.registerAdapter(['mock'],adapter)
  const request=vi.fn(async()=>({ ok:true,memories:[] }))
  installRuntimeDecisionMemory(ctx,async()=>({ ok:true,memories:[] }),async()=>{})
  installRuntimeSupportReport(ctx,request)
  return { ctx,request }
}

it.each(['fresh','runtime','lead'] as const)('exposes Runtime support reporting on the very first %s model request without a warmup step',async(kind)=>{
  const root=await mkdtemp(join(tmpdir(),'runtime-cold-'))
  let active:Context|undefined
  try{
    const id=SessionId('runtime-'+kind)
    if(kind!=='fresh'){
      const first=await mount(root,new MockAdapter([]));active=first.ctx
      const handle=await first.ctx.agents.create({ sessionId:id,meta:{ agentPreset:'hivemind-hq' },setup:(_ctx,agent)=>{
        agent.session.append('hivemind/session-owner',{ id:null,slug:kind,name:'Runtime',role:'AI Chief of Staff' })
      } })
      await handle.dispose();await first.ctx.fiber.dispose();active=undefined
    }
    const adapter=new MockAdapter([toolCallResponse('cold-read','runtime_support_report',{ operation:'status',occurrence:'2026-10-09T00:00:00.000Z' }),textResponse('done')])
    const { ctx,request }=await mount(root,adapter);active=ctx
    const handle=kind==='fresh'
      ? await ctx.agents.create({ sessionId:id,meta:{ agentPreset:'hivemind-hq' },agentOptions:{ provider:'mock',model:'mock' } })
      : await ctx.agents.resume({ resumeSessionId:id,agentOptions:{ provider:'mock',model:'mock' } })
    handle.agent.followup(createUserMessage({ source:{ kind:'user' },content:[{ type:'text',text:'Inspect my nightly report status.' }] }))
    await vi.waitFor(()=>expect(request).toHaveBeenCalledOnce())
    await vi.waitFor(()=>expect(handle.agent.status).toBe('idle'))
    const names=adapter.requests[0]!.tools!.map(tool=>tool.name)
    expect(names).toContain('runtime_support_report')
    expect(handle.agent.session.snapshotEvents().filter(event=>event.type==='hivemind/session-owner'&&event.data.slug==='runtime')).toHaveLength(1)
    await handle.dispose()
  }finally{await active?.fiber.dispose();await rm(root,{ recursive:true,force:true })}
})

it.each(['employee','brain','child'] as const)('never discloses Runtime support tool in an initial %s request',async(kind)=>{
  const root=await mkdtemp(join(tmpdir(),'runtime-excluded-'))
  const adapter=new MockAdapter([textResponse('done')]);const { ctx,request }=await mount(root,adapter)
  try{
    const handle=await ctx.agents.create({ sessionId:SessionId('excluded-'+kind),meta:{ agentPreset:kind==='brain'?'hivemind-brain':'hivemind-hq',...(kind==='child'?{ parentSession:SessionId('parent') }: {}) },agentOptions:{ provider:'mock',model:'mock' },setup:(_ctx,agent)=>{
      if(kind==='employee')agent.session.append('hivemind/session-owner',{ id:'employee',slug:'sofia',name:'Sofia',role:'Employee' })
    } })
    handle.agent.followup(createUserMessage({ source:{ kind:'user' },content:[{ type:'text',text:'Hello.' }] }))
    await vi.waitFor(()=>expect(adapter.requests).toHaveLength(1));await vi.waitFor(()=>expect(handle.agent.status).toBe('idle'))
    expect(adapter.requests[0]!.tools?.map(tool=>tool.name)??[]).not.toContain('runtime_support_report')
    expect(adapter.requests[0]!.tools?.map(tool=>tool.name)??[]).not.toContain('runtime_uncertainties')
    expect(request).not.toHaveBeenCalled();await handle.dispose()
  }finally{await ctx.fiber.dispose();await rm(root,{ recursive:true,force:true })}
})
