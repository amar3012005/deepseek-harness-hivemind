import { afterEach,describe,expect,it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime,{ LlmAdapter,LlmError,ToolCallId,createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions,StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore,{ SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime,{ defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as Retry from '../src/index.ts'

type Entry=Error|Iterable<StreamChunk>|AsyncIterable<StreamChunk>
class Adapter extends LlmAdapter {
  requests:GenerateOptions[]=[]
  constructor(private entries:Entry[]){super()}
  async *stream(options:GenerateOptions){this.requests.push(options);const entry=this.entries.shift();if(!entry)throw Error('script exhausted');if(entry instanceof Error)throw entry;yield*entry}
}
function text(value:string):StreamChunk[]{return[{ type:'block-start',index:0,blockType:'text' },{ type:'block-end',index:0,block:{ type:'text',text:value } },{ type:'finish',reason:{ kind:'stop' } }]}
function tool(id:string):StreamChunk[]{return[{ type:'block-start',index:0,blockType:'tool-call' },{ type:'block-end',index:0,block:{ type:'tool-call',id:ToolCallId(id),name:'read_fixture',arguments:'{}' } },{ type:'finish',reason:{ kind:'tool-calls' } }]}
async function* partial():AsyncGenerator<StreamChunk>{yield{ type:'block-start',index:0,blockType:'text' };yield{ type:'text-delta',index:0,text:'discard me' };yield{ type:'block-end',index:0,block:{ type:'text',text:'discard me' } };yield*tool('discarded');throw new LlmError('stream ended before terminal event','TRANSPORT')}
const contexts:Context[]=[]
afterEach(async()=>{await Promise.all(contexts.splice(0).map(ctx=>ctx.fiber.dispose()))})
async function harness(entries:Entry[],enabled=true,routes: Retry.StepFallbackConfig[] | undefined=undefined){
  const ctx=new Context();contexts.push(ctx)
  for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry])await ctx.plugin(plugin)
  await ctx.plugin(Retry,enabled?{ fallback:routes ?? { fromProvider:'primary',provider:'backup',model:'quick' } }:{})
  await ctx.plugin(AgentLoop,{ agents:[] })
  const adapter=new Adapter(entries);ctx.llm.registerAdapter(['primary','backup'],adapter)
  let toolExecutions=0;ctx.tools.register(defineContentToolFixture({ name:'read_fixture',description:'fixture',parameters:{},async execute(){toolExecutions++;return[{ type:'text',text:'saved evidence' }]} }))
  const agent=await ctx.agentLoop.create(SessionId(`fallback-${contexts.length}`),{ provider:'primary',model:'selected' })
  const send=async()=>{agent.followup(createUserMessage({ content:[{ type:'text',text:'continue' }],source:{ kind:'user' } }));await agent.whenIdle()}
  return{ ctx,agent,adapter,send,toolExecutions:()=>toolExecutions }
}
describe('independent native model-step fallback',()=>{
  it('supports both authorized directions without switching twice in one step', async () => {
    const routes = [{ fromProvider: 'primary', provider: 'backup', model: 'quick', maxTokens: 8192 }, { fromProvider: 'backup', provider: 'primary', model: 'selected', maxTokens: 4096 }]
    const h = await harness([new LlmError('budget', 'QUOTA'), new LlmError('other budget', 'QUOTA')], true, routes)
    await h.send()
    expect(h.adapter.requests.map(r => r.provider)).toEqual(['primary', 'backup'])
    expect(h.adapter.requests[1]?.maxTokens).toBe(8192)
    const reverse = await harness([new LlmError('budget', 'QUOTA'), text('recovered')], true, routes)
    reverse.agent.options.provider = 'backup'; reverse.agent.options.model = 'quick'
    await reverse.send()
    expect(reverse.adapter.requests.map(r => r.provider)).toEqual(['backup', 'primary'])
    expect(reverse.adapter.requests[1]?.maxTokens).toBe(4096)
  })

  it('recovers a budget failure, executes completed tools once, and returns to primary on the next step',async()=>{
    const h=await harness([tool('saved'),new LlmError('402 in_flight_budget_exhausted','QUOTA',{ status:402,providerRetryAfterMs:120000 }),tool('next'),text('accepted')]);await h.send()
    expect(h.adapter.requests.map(r=>r.provider)).toEqual(['primary','primary','backup','primary'])
    expect(h.toolExecutions()).toBe(2)
    const history=h.agent.session.deriveMessages();expect(history.filter(m=>m.source?.kind==='tool')).toHaveLength(2)
    expect(h.agent.session.snapshotEvents().filter(e=>e.type==='llm/fallback')).toHaveLength(1)
    expect(h.agent.options.provider).toBe('primary');expect(h.agent.options.model).toBe('selected')
    expect(h.agent.session.requestHeader()?.config.provider).toBe('primary')
  })
  it('also restores primary on the next turn after fallback ends the previous turn',async()=>{
    const h=await harness([new LlmError('budget','QUOTA'),text('recovered'),text('next turn')]);await h.send();await h.send()
    expect(h.adapter.requests.map(r=>r.provider)).toEqual(['primary','backup','primary'])
  })
  it('does not execute failed partial tool calls or retain failed text in model history',async()=>{
    const h=await harness([partial(),text('recovered')]);await h.send()
    expect(h.toolExecutions()).toBe(0)
    expect(JSON.stringify(h.agent.session.deriveMessages())).not.toContain('discard me')
    expect(JSON.stringify(h.adapter.requests.at(-1)?.messages)).not.toContain('discarded')
    expect(h.agent.session.snapshotEvents().filter(e=>e.type==='assistant/attempt')).toHaveLength(1)
  })
  it.each(['AUTH','INVALID_REQUEST','INVALID_TOOL_ARGUMENTS','CONTEXT_WINDOW_EXCEEDED','MISSING_CREDENTIAL'])('leaves %s to the native error/compaction owner',async (code)=>{
    const h=await harness([new LlmError('permanent',code)]);await h.send();expect(h.adapter.requests).toHaveLength(1);expect(h.agent.session.snapshotEvents().filter(e=>e.type==='llm/fallback')).toHaveLength(0)
  })
  it('replays a required route checkpoint on cold restore and returns the next step to primary',async()=>{
    const h=await harness([new LlmError('budget','QUOTA'),text('recovered')]);await h.send()
    const seed=JSON.parse(JSON.stringify(h.agent.session.snapshotEvents()))
    const fresh=await harness([],false)
    const restored=fresh.ctx.sessions.prepare(SessionId('restored-fallback'),{ seed })
    const state=fresh.ctx.sessionProjections.stateOf(restored,'llmStepFallback')
    expect(state?.primary.provider).toBe('primary')
    const fake={ id:restored.id,session:restored } as Agent
    const config=await agentEvents(fresh.ctx,fake).waterfall('agent/request',{ turn:2,step:1,signal:new AbortController().signal },async()=>({ provider:'backup',model:'quick' }))
    expect(config).toMatchObject({ provider:'primary',model:'selected' })
    expect(JSON.stringify(restored.deriveMessages())).not.toContain('llm/fallback')
  })
  it('keeps concurrent session fallback state isolated',async()=>{
    const one=await harness([new LlmError('budget','QUOTA'),text('one')]);const two=await harness([text('two')])
    await Promise.all([one.send(),two.send()])
    expect(one.adapter.requests.map(r=>r.provider)).toEqual(['primary','backup'])
    expect(two.adapter.requests.map(r=>r.provider)).toEqual(['primary'])
  })
  it('does not loop when the independent route also fails',async()=>{
    const h=await harness([new LlmError('budget','QUOTA'),new LlmError('fallback budget','QUOTA')]);await h.send();expect(h.adapter.requests).toHaveLength(2)
  })
  it('remains disabled without explicit independently authorized configuration',async()=>{
    const h=await harness([new LlmError('budget','QUOTA')],false);await h.send();expect(h.adapter.requests).toHaveLength(1)
  })
})
