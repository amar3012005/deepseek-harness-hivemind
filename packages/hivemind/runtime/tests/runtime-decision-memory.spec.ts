import { describe, it, expect, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { installRuntimeDecisionMemory } from '../src/runtime-decision-memory.ts'
function fixture(runtime = true) {
  const tools = new Map<string, ToolDefinition>()
  const events = [{ type:'hivemind/session-owner',data:{ id:runtime ? null : 'employee-id',slug:runtime ? 'runtime':'sofia',name:'Name',role:'Role' } }] as unknown as SessionEvent[]
  const agent = { id:'session-canary',session:{ header:{ agentPreset:runtime ? 'hivemind-hq':'hivemind-hyperagents' },snapshotEvents:()=>events },ctx:{ effect:(run:()=>void)=>run(),tools:{ register:(tool:ToolDefinition)=>{tools.set(tool.name,tool);return ()=>{}} } } } as unknown as Agent
  let handler:((input:{ agent:Agent;signal:AbortSignal })=>Promise<string>) | undefined
  const request=vi.fn(async (_agent: Agent, _input: unknown, _signal: AbortSignal)=>({ ok:true,memories:[] }))
  const ctx={ effect:(run:()=>void)=>run(),on:(_name:string,value:typeof handler)=>{handler=value;return ()=>{}} } as unknown as Context
  const install=installRuntimeDecisionMemory(ctx,request,async()=>{})
  install(agent)
  return { agent,tools,request,call:()=>handler!({ agent,signal:new AbortController().signal }) }
}
describe('Runtime decision memory',()=>{
  it('uses two scoped tools, fresh query-free reads and no employee access',async()=>{
    const f=fixture();expect([...f.tools.keys()]).toEqual(['runtime_user_agenda','runtime_uncertainties'])
    expect(JSON.parse(await f.call())).toEqual({ uncertainties:[],userAgenda:[] })
    expect(f.request.mock.calls[0]).toEqual([f.agent,{ action:'recall',kind:'uncertainty',agent_slug:'runtime',state:'open',limit:8 },expect.any(AbortSignal)])
    const employee=fixture(false);expect(employee.tools.size).toBe(0)
    await expect(employee.call()).rejects.toThrow('runtime_voice_room_required')
  })
  it('fails a missing read rather than treating it as an empty agenda',async()=>{
    const f=fixture();f.request.mockRejectedValueOnce(new Error('offline'))
    await expect(f.call()).rejects.toThrow('offline')
  })
})
