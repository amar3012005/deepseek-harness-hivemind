import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
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
import { MockAdapter,textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { installEmployeeInputBlocker } from '../src/delegated-blocker.ts'

async function mount(root:string,adapter:MockAdapter,rejected=false){
  const ctx=new Context();await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence,{ root });await ctx.plugin(AgentLoop,{ agents:[] })
  ctx.llm.registerAdapter(['mock'],adapter)
  // The production delivery hook checks authority before pinning this event.
  // This host-only test pin isolates schema ordering from external Core fixtures.
  ctx.on('agent/pre-step',async({ agent,turn,messages },next)=>{
    const result=await next();if(rejected)return { kind:'reject' };if(messages.some(m=>m.source.kind==='hivemind-agent-message'))agent.session.append('hivemind/employee-work-origin',{ turn,rootId:'chief',taskId:'task-1' })
    return result
  })
  installEmployeeInputBlocker(ctx);return ctx
}

it.each(['fresh','cold'] as const)('native %s inbox claim exposes blocker in the first real request and ends disclosure with that turn',async(kind)=>{
  const root=await mkdtemp(join(tmpdir(),'employee-input-cold-'));const id=SessionId('employee-input');let active:Context|undefined

  try{
    if(kind==='cold'){const first=await mount(root,new MockAdapter([]));active=first;const h=await first.agents.create({ sessionId:id,setup:(_ctx,agent)=>{agent.session.append('hivemind/session-owner',{ id:'employee',slug:'label-analyst',name:'Label Analyst',role:'Employee' })} });await first.sessions.flush(h.agent.session);await h.dispose();await first.fiber.dispose();active=undefined}
    const adapter=new MockAdapter([textResponse('Need the exact reference code.'),textResponse('Hello directly.')]);const ctx=await mount(root,adapter);active=ctx
    const handle=kind==='fresh'?await ctx.agents.create({ sessionId:id,agentOptions:{ provider:'mock',model:'mock' } }):await ctx.agents.resume({ resumeSessionId:id,agentOptions:{ provider:'mock',model:'mock' } })
    handle.agent.followup(createUserMessage({ source:{ kind:'hivemind-agent-message',messageId:'host-assignment',senderId:SessionId('chief'),senderSessionId:SessionId('chief') },content:[{ type:'text',text:JSON.stringify({ text:'HQ_EMPLOYEE_ASSIGNMENT={"rootId":"chief","taskId":"task-1"}' }) }] }))
    await vi.waitFor(()=>expect(adapter.requests).toHaveLength(1));await vi.waitFor(()=>expect(handle.agent.status).toBe('idle'))
    expect(adapter.requests[0]!.tools?.map(t=>t.name)).toContain('hivemind_employee_blocker')
    expect(handle.agent.ctx.tools.schemas(handle.agent).map(t=>t.name)).not.toContain('hivemind_employee_blocker')
    handle.agent.followup(createUserMessage({ source:{ kind:'user' },content:[{ type:'text',text:'Hello directly.' }] }))
    await vi.waitFor(()=>expect(adapter.requests).toHaveLength(2));await vi.waitFor(()=>expect(handle.agent.status).toBe('idle'))
    expect(adapter.requests[1]!.tools?.map(t=>t.name)??[]).not.toContain('hivemind_employee_blocker')
    await handle.dispose();expect(ctx.tools.schemas().map(t=>t.name)).not.toContain('hivemind_employee_blocker')
  }finally{await active?.fiber.dispose();await rm(root,{ recursive:true,force:true })}
})


it('clears scoped disclosure on rejected admission, a new direct-human turn, and disposal',async()=>{
  const root=await mkdtemp(join(tmpdir(),'employee-input-denied-')),adapter=new MockAdapter([]),ctx=await mount(root,adapter,true)
  try{
    const handle=await ctx.agents.create({ sessionId:SessionId('employee-denied'),agentOptions:{ provider:'mock',model:'mock' } })
    const message=createUserMessage({ source:{ kind:'hivemind-agent-message',messageId:'candidate',senderId:SessionId('chief'),senderSessionId:SessionId('chief') },content:[{ type:'text',text:JSON.stringify({ text:'HQ_EMPLOYEE_ASSIGNMENT={"rootId":"chief","taskId":"task-1"}' }) }] })
    handle.agent.followup(message)
    await vi.waitFor(()=>expect(handle.agent.session.ownEvents().some(e=>e.type==='turn/end')).toBe(true))
    expect(adapter.requests).toHaveLength(0)
    expect(handle.agent.ctx.tools.schemas(handle.agent).map(t=>t.name)).not.toContain('hivemind_employee_blocker')
    agentEvents(ctx,handle.agent).emit('agent/inbox/claimed',{ message,turn:3 })
    expect(handle.agent.ctx.tools.schemas(handle.agent).map(t=>t.name)).toContain('hivemind_employee_blocker')
    agentEvents(ctx,handle.agent).emit('agent/inbox/claimed',{ message:createUserMessage({ source:{ kind:'user' },content:[{ type:'text',text:'Direct human work' }] }),turn:4 })
    expect(handle.agent.ctx.tools.schemas(handle.agent).map(t=>t.name)).not.toContain('hivemind_employee_blocker')
    agentEvents(ctx,handle.agent).emit('agent/inbox/claimed',{ message,turn:5 })
    expect(handle.agent.ctx.tools.schemas(handle.agent).map(t=>t.name)).toContain('hivemind_employee_blocker')
    await handle.dispose()
    expect(ctx.tools.schemas(handle.agent).map(t=>t.name)).not.toContain('hivemind_employee_blocker')
  }finally{await ctx.fiber.dispose();await rm(root,{ recursive:true,force:true })}
})
