import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { registerRunnerDrainStatus } from '../src/runner-drain.ts'

const secret='fixture-only-service-secret-32-bytes-long'
function fixture(statuses=['running','idle','running']) {
  let handler: (req:IncomingMessage,res:ServerResponse)=>Promise<void>
  const list=vi.fn(()=>statuses.map(status=>({ status })))
  const register=(route:{ handler:typeof handler })=>{
    handler=route.handler
    return()=>{}
  }
  const ctx={ effect:(fn:()=>unknown)=>fn(),agents:{ list },webServer:{ register } }
  registerRunnerDrainStatus(ctx as unknown as Context,secret)
  async function call(auth:string|undefined=`Bearer ${secret}`,method='GET') {
    const res={ statusCode:0,setHeader:vi.fn(),end:vi.fn() }
    await handler!({ headers:{ authorization:auth },method } as IncomingMessage,res as unknown as ServerResponse)
    return { status:res.statusCode,body:JSON.parse(res.end.mock.calls[0]![0]),res }
  }
  return { call,list }
}
it('counts all active agents including direct and owned rooms',async()=>{
  const h=fixture();expect(await h.call()).toMatchObject({ status:200,body:{ active_turns:2 } })
  expect(h.list).toHaveBeenCalledOnce()
})
it('reports zero only when the native registry is idle',async()=>{
  expect(await fixture(['idle','idle']).call()).toMatchObject({ status:200,body:{ active_turns:0 } })
})
it('fails closed before revealing state without valid service authority',async()=>{
  const h=fixture();expect((await h.call('Bearer wrong')).status).toBe(401)
  expect((await h.call('')).status).toBe(401)
})
it('rejects mutation methods',async()=>{
  const h=fixture();expect((await h.call(`Bearer ${secret}`,'POST')).status).toBe(405);expect(h.list).not.toHaveBeenCalled()
})
it('does not report idle when the native registry fails',async()=>{
  const h=fixture();h.list.mockImplementation(()=>{throw Error('unavailable')})
  expect((await h.call()).status).toBe(503)
})
it('reads real native Runtime and direct HyperAgent activity across busy and idle states',async()=>{
  const { Context }=await import('@deepseek-ai/cordis')
  const { mountAgentLoopTestDependencies }=await import('@deepseek-ai/dsh-agent-loop-testkit')
  const { default:AgentLoop }=await import('@deepseek-ai/dsh-agent-loop')
  const { SessionId }=await import('@deepseek-ai/dsh-session')
  const { createUserMessage }=await import('@deepseek-ai/dsh-llm')
  const { MockAdapter }=await import('../../../core/agent-loop/tests/mock-adapter.ts')
  const ctx=new Context()
  try {
    await mountAgentLoopTestDependencies(ctx);await ctx.plugin(AgentLoop,{ agents:[] })
    const adapter=new MockAdapter(['hang','hang']);ctx.llm.registerAdapter(['mock'],adapter)
    const runtime=(await ctx.agents.create({ sessionId:SessionId('session-drain-runtime'),meta:{ agentPreset:'hivemind-hq' },agentOptions:{ provider:'mock',model:'mock' } })).agent
    const direct=(await ctx.agents.create({ sessionId:SessionId('session-drain-direct'),meta:{ agentPreset:'hivemind-hyperagents' },agentOptions:{ provider:'mock',model:'mock' } })).agent
    const h=fixture([]);h.list.mockImplementation(()=>ctx.agents.list())
    expect((await h.call()).body.active_turns).toBe(0)
    runtime.steer(createUserMessage({ source:{ kind:'user' },content:[{ type:'text',text:'Fixture work.' }] }))
    direct.steer(createUserMessage({ source:{ kind:'user' },content:[{ type:'text',text:'Fixture work.' }] }))
    await expect.poll(()=>adapter.requests.length).toBe(2)
    expect((await h.call()).body.active_turns).toBe(2)
    await ctx.fiber.dispose()
    expect((await h.call()).status).toBe(503)
  } finally {await ctx.fiber.dispose()}
})
