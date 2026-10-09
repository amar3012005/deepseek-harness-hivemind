import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createToolResultMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.ts'

async function setup(actor: Record<string, unknown>, approvalRequired = false, approvalOutcome: 'allowed-once' | 'rejected' = 'allowed-once') {
  const tools = new Map<string, ToolDefinition>()
  const events: Array<{ type: string; data: unknown }> = []
  const injections: unknown[] = []
  const agent = {
    session: {
      append(type: string, data: unknown) { events.push({ type, data }) },
      snapshotEvents() { return [{ type: 'hivemind/run-plan', data: { runId: 'run-1', planId: 'plan-1', revision: 1, playbooks: [], workstreams: [{ id: 'work-1', objective: 'Review the market.', actor, ...(approvalRequired ? { approvalRequired: true } : {}) }] } }, ...events] },
    },
    inject(message: unknown) { injections.push(message) },
  } as unknown as Agent
  const ctx = new Context()
  ctx.provide('tools', { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {} } } as never)
  ctx.provide('hivemindEmployeeDirectory', { async profiles() { return { status: 'ready', contract: 'hivemind.hyperagent-profiles.v1', count: 1, profiles: [{ id: 'marta', name: 'Marta Silva', role_archetype: 'Risk lead', avatar_url: 'https://example.com/marta.png', persona: 'Challenge unsupported claims.', active_prompt_version: { version_label: 'v3' } }] } } } as never)
  ctx.provide('approval', { async request() { return approvalOutcome } } as never)
  apply(ctx)
  const tool = tools.get('hivemind_workstream')
  if (tool === undefined) throw new Error('workstream tool was not registered')
  return { ctx, tool, agent, events, injections }
}

describe('HIVE-MIND operating workstreams', () => {
  it('records adaptive main-runtime work after operating context without requiring a plan', async () => {
    const tools = new Map<string, ToolDefinition>()
    const events: Array<{ type: string; data: unknown }> = [{ type: 'hivemind/operating-context', data: { runId: 'run-adaptive', objective: 'Assess the market.' } }]
    const agent = {
      session: {
        append(type: string, data: unknown) { events.push({ type, data }) },
        snapshotEvents() { return events },
      },
      inject() {},
    } as unknown as Agent
    const ctx = new Context()
    ctx.provide('tools', { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {} } } as never)
    ctx.provide('hivemindEmployeeDirectory', { async profiles() { return { profiles: [] } } } as never)
    apply(ctx)
    const tool = tools.get('hivemind_workstream')!
    await tool.execute({ action: 'start', workstream_id: 'market-check', objective: 'Check current adoption evidence.' }, { agent, signal: new AbortController().signal } as never)
    await tool.execute({ action: 'complete', workstream_id: 'market-check', summary: 'Evidence checked.' }, { agent, signal: new AbortController().signal } as never)
    expect(events.slice(1)).toEqual([
      { type: 'hivemind/workstream-started', data: expect.objectContaining({ runId: 'run-adaptive', planId: 'adaptive:run-adaptive', planRevision: 0, workstreamId: 'market-check', objective: 'Check current adoption evidence.', actor: { kind: 'main' } }) },
      { type: 'hivemind/workstream-completed', data: { runId: 'run-adaptive', planId: 'adaptive:run-adaptive', workstreamId: 'market-check', summary: 'Evidence checked.', evidenceIds: [], artifactIds: [] } },
    ])
  })

  it('executes a planned employee inline through the parent agent with a frozen snapshot', async () => {
    const { tool, agent, events, injections } = await setup({ kind: 'inline_employee', employeeId: 'marta' })
    await tool.execute({ action: 'start', workstream_id: 'work-1' }, { agent, signal: new AbortController().signal } as never)
    await tool.execute({ action: 'complete', workstream_id: 'work-1', summary: 'Reviewed claims.', evidence_ids: ['e-1'], artifact_ids: ['a-1'] }, { agent, signal: new AbortController().signal } as never)
    expect(events).toEqual([
      { type: 'hivemind/workstream-started', data: expect.objectContaining({ planId: 'plan-1', workstreamId: 'work-1', actor: expect.objectContaining({ kind: 'inline_employee', employeeId: 'marta', employeeName: 'Marta Silva', avatarUrl: 'https://example.com/marta.png', profileVersion: 'v3', personaSha256: expect.any(String) }) }) },
      { type: 'hivemind/workstream-completed', data: { runId: 'run-1', planId: 'plan-1', workstreamId: 'work-1', summary: 'Reviewed claims.', evidenceIds: ['e-1'], artifactIds: ['a-1'] } },
    ])
    expect(JSON.stringify(injections)).toContain('Challenge unsupported claims.')
    expect(JSON.stringify(injections)).toContain('remain the parent HyperAgents runtime')
  })

  it('advances the native operating-plan todo as inline work completes', async () => {
    const { tool, agent, events } = await setup({ kind: 'main' })
    events.push({ type: 'todo/write', data: { todos: [
      { content: '[work-1] Review the market.', status: 'in_progress' },
      { content: '[work-2] Challenge the recommendation.', status: 'pending' },
    ] } })

    await tool.execute({ action: 'start', workstream_id: 'work-1' }, { agent, signal: new AbortController().signal } as never)
    await tool.execute({ action: 'complete', workstream_id: 'work-1', summary: 'Market reviewed.' }, { agent, signal: new AbortController().signal } as never)

    expect(events.findLast(event => event.type === 'todo/write')).toEqual({
      type: 'todo/write',
      data: { todos: [
        { content: '[work-1] Review the market.', status: 'completed' },
        { content: '[work-2] Challenge the recommendation.', status: 'in_progress' },
      ] },
    })
  })

  it('requires a real approval-service receipt before completing an approval-gated workstream', async () => {
    const { tool, agent, events } = await setup({ kind: 'inline_employee', employeeId: 'marta' }, true)
    await tool.execute({ action: 'start', workstream_id: 'work-1' }, { agent, signal: new AbortController().signal } as never)
    await expect(tool.execute({ action: 'complete', workstream_id: 'work-1', summary: 'Premature claim.' }, { agent, signal: new AbortController().signal } as never)).rejects.toThrow('requires a real allowed-once approval receipt')
    const approval = await tool.execute({ action: 'request_approval', workstream_id: 'work-1', approval_reason: 'Approve the corrected compliance recommendation.' }, { agent, signal: new AbortController().signal } as never)
    expect(approval).toMatchObject({ status: 'approved', outcome: 'allowed-once' })
    await tool.execute({ action: 'complete', workstream_id: 'work-1', summary: 'Approved recommendation.' }, { agent, signal: new AbortController().signal } as never)
    expect(events).toContainEqual({ type: 'hivemind/workstream-approval', data: expect.objectContaining({ runId: 'run-1', planId: 'plan-1', workstreamId: 'work-1', outcome: 'allowed-once' }) })
    expect(events.filter(event => event.type === 'hivemind/workstream-completed')).toHaveLength(1)
  })

  it('fails closed when the human rejects an approval-gated workstream', async () => {
    const { ctx, tool, agent, events } = await setup({ kind: 'main' }, true, 'rejected')
    events.push({ type: 'todo/write', data: { todos: [{ content: '[work-1] Review the market.', status: 'in_progress' }] } })
    const approval = await tool.execute({ action: 'request_approval', workstream_id: 'work-1', approval_reason: 'Approve release.' }, { agent, signal: new AbortController().signal } as never)
    expect(approval).toMatchObject({ status: 'not_approved', outcome: 'rejected' })
    expect(events.filter(event => event.type === 'hivemind/workstream-started')).toHaveLength(1)
    await expect(tool.execute({ action: 'complete', workstream_id: 'work-1', summary: 'Should not complete.' }, { agent, signal: new AbortController().signal } as never)).rejects.toThrow('requires a real allowed-once approval receipt')
    events.push({ type: 'turn/start', data: { turn: 1 } }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Approval remains pending.' }] } } })
    await ctx.emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
    await ctx.emit('session/event', agent.session as never, { type: 'turn/end', data: { turn: 1 } } as never)
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(events.filter(event => event.type === 'hivemind/workstream-completed')).toHaveLength(0)
    expect(events.findLast(event => event.type === 'todo/write')).toEqual({ type: 'todo/write', data: { todos: [{ content: '[work-1] Review the market.', status: 'in_progress' }] } })
    expect(events.filter(event => event.type === 'hivemind/run-evaluation')).toHaveLength(0)
  })

  it('continues once when tools finish but the operating outcome has not been delivered', async () => {
    const tools = new Map<string, ToolDefinition>()
    const events: Array<{ type: string; data: unknown }> = [
      { type: 'hivemind/run-plan', data: { runId: 'run-1', planId: 'plan-1', revision: 1, playbooks: [], workstreams: [] } },
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'tool/call', data: { callId: 'research-1', name: 'hivemind_research_gather' } },
    ]
    const steers: unknown[] = []
    const agent = {
      session: { append(type: string, data: unknown) { events.push({ type, data }) }, snapshotEvents() { return events } },
      steer(message: unknown) { steers.push(message) },
    } as unknown as Agent
    const ctx = new Context()
    ctx.provide('tools', { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {} } } as never)
    ctx.provide('hivemindEmployeeDirectory', { async profiles() { return { profiles: [] } } } as never)
    apply(ctx)

    await ctx.emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
    await ctx.emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })

    expect(steers).toHaveLength(1)
    expect(JSON.stringify(steers[0])).toContain('Continue the current operating plan')
  })

  it('continues instead of silently closing unfinished todos when visible prose arrives early', async () => {
    const events: Array<{ type: string; data: unknown }> = [
      { type: 'hivemind/run-plan', data: { runId: 'run-1', planId: 'plan-1', revision: 1, playbooks: [], workstreams: [] } },
      { type: 'todo/write', data: { todos: [{ content: 'Deliver the recommendation.', status: 'in_progress' }] } },
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Recommendation delivered.' }] } } },
    ]
    const steers: unknown[] = []
    const agent = {
      session: { append(type: string, data: unknown) { events.push({ type, data }) }, snapshotEvents() { return events } },
      steer(message: unknown) { steers.push(message) },
    } as unknown as Agent
    const ctx = new Context()
    ctx.provide('tools', { register() { return () => {} } } as never)
    ctx.provide('hivemindEmployeeDirectory', { async profiles() { return { profiles: [] } } } as never)
    apply(ctx)

    await ctx.emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })

    expect(steers).toHaveLength(1)
    expect(JSON.stringify(steers[0])).toContain('Finish or fail every remaining workstream and todo')
    expect(events.findLast(event => event.type === 'todo/write')).toEqual({
      type: 'todo/write',
      data: { todos: [{ content: 'Deliver the recommendation.', status: 'in_progress' }] },
    })
  })

  it('records research progress without completing work that may still need synthesis', async () => {
    const { ctx, agent, events } = await setup({ kind: 'main' })
    events.push({ type: 'todo/write', data: { todos: [
      { content: '[work-1] Review the market.', status: 'in_progress' },
      { content: '[work-2] Synthesize the recommendation.', status: 'pending' },
    ] } })
    await ctx.emit('session/event', agent.session as never, { type: 'hivemind/research-gathered', data: {
      runId: 'run-1', planId: 'plan-1', gatherId: 'gather-1', workstreamId: 'work-1', status: 'succeeded',
      objectives: [{ jobId: 'evidence-1' }, { jobId: 'evidence-2' }], sources: [],
    } } as never)
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(events).toContainEqual({ type: 'hivemind/workstream-progress', data: {
      runId: 'run-1', planId: 'plan-1', workstreamId: 'work-1',
      summary: 'Research gather returned 2 terminal evidence receipts; verify coverage before closing this workstream.',
    } })
    expect(events.findLast(event => event.type === 'todo/write')).toEqual({ type: 'todo/write', data: { todos: [
      { content: '[work-1] Review the market.', status: 'in_progress' },
      { content: '[work-2] Synthesize the recommendation.', status: 'pending' },
    ] } })
  })

  it('treats repeated terminal workstream calls as idempotent receipts', async () => {
    const { tool, agent, events } = await setup({ kind: 'main' })
    await tool.execute({ action: 'start', workstream_id: 'work-1' }, { agent, signal: new AbortController().signal } as never)
    await tool.execute({ action: 'complete', workstream_id: 'work-1', summary: 'Evidence synthesized.' }, { agent, signal: new AbortController().signal } as never)
    const repeated = await tool.execute({ action: 'complete', workstream_id: 'work-1', summary: 'Duplicate completion.' }, { agent, signal: new AbortController().signal } as never)

    expect(repeated).toMatchObject({ status: 'completed', already_terminal: true, plan_id: 'plan-1', workstream_id: 'work-1' })
    expect(events.filter(event => event.type === 'hivemind/workstream-completed')).toHaveLength(1)
  })

  it('treats repeated starts as one active workstream', async () => {
    const { tool, agent, events } = await setup({ kind: 'main' })
    await tool.execute({ action: 'start', workstream_id: 'work-1' }, { agent, signal: new AbortController().signal } as never)
    const repeated = await tool.execute({ action: 'start', workstream_id: 'work-1' }, { agent, signal: new AbortController().signal } as never)

    expect(repeated).toMatchObject({ status: 'running', already_started: true, plan_id: 'plan-1', workstream_id: 'work-1' })
    expect(events.filter(event => event.type === 'hivemind/workstream-started')).toHaveLength(1)
  })

  it('normalizes a plan-id echo to the sole unfinished workstream', async () => {
    const { tool, agent, events } = await setup({ kind: 'main' })
    await tool.execute({ action: 'start', workstream_id: 'work-1' }, { agent, signal: new AbortController().signal } as never)
    const progress = await tool.execute({
      action: 'complete',
      workstream_id: 'plan-1',
      summary: 'Gathering evidence.',
    }, { agent, signal: new AbortController().signal } as never)

    expect(progress).toMatchObject({ status: 'completed', plan_id: 'plan-1', workstream_id: 'work-1' })
    expect(events).toContainEqual({
      type: 'hivemind/workstream-completed',
      data: { runId: 'run-1', planId: 'plan-1', workstreamId: 'work-1', summary: 'Gathering evidence.', evidenceIds: [], artifactIds: [] },
    })
  })

  it('will not silently replace a planned real child with inline execution', async () => {
    const { tool, agent, events } = await setup({ kind: 'employee_subagent', employeeId: 'marta' })
    await expect(tool.execute({ action: 'start', workstream_id: 'work-1' }, { agent, signal: new AbortController().signal } as never)).rejects.toThrow('use hivemind_delegate_employee')
    expect(events).toEqual([])
  })

  it('rejects work outside the current plan', async () => {
    const { tool, agent, events } = await setup({ kind: 'main' })
    await expect(tool.execute({ action: 'start', workstream_id: 'unknown' }, { agent, signal: new AbortController().signal } as never)).rejects.toThrow('not in the current operating plan')
    expect(events).toEqual([])
  })

  it('observes real native browser, workflow, and approved-action receipts only after a plan exists', async () => {
    const tools = new Map<string, ToolDefinition>()
    const log: Array<{ type: string; data: Record<string, unknown> }> = [{ type: 'hivemind/run-plan', data: { runId: 'run-1', planId: 'plan-1', revision: 1, playbooks: [], workstreams: [] } }]
    const session = {
      append(type: string, data: Record<string, unknown>) { log.push({ type, data }) },
      snapshotEvents() { return log },
    }
    const ctx = new Context()
    ctx.provide('tools', { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {} } } as never)
    ctx.provide('hivemindEmployeeDirectory', { async profiles() { return { profiles: [] } } } as never)
    apply(ctx)
    const emit = (type: string, data: Record<string, unknown>) =>{  ctx.emit('session/event', session as never, { type, data } as never) }

    log.push({ type: 'tool/call', data: { callId: 'browser-1', name: 'browser_take_screenshot', arguments: '{}' } })
    emit('tool/result', { message: { toolCallId: 'browser-1', content: [{ type: 'tool-result', content: [{ type: 'image' }] }] } })
    log.push({ type: 'tool/call', data: { callId: 'artifact-1', name: 'image_generate', arguments: '{}' } })
    emit('tool/result', { message: { toolCallId: 'artifact-1', content: [{ type: 'tool-result', content: [{ type: 'image' }] }] } })
    emit('tool-workflow/run-start', { runId: 'flow-1', name: 'validate-evidence' })
    emit('tool-workflow/run-end', { runId: 'flow-1', stopReason: 'completed' })
    emit('approval/asked', { id: 'approval-1', callId: 'action-1', toolName: 'send_email' })
    emit('approval/decided', { id: 'approval-1', outcome: 'allowed-once' })
    log.push({ type: 'tool/call', data: { callId: 'action-1', name: 'send_email', arguments: '{}' } })
    emit('tool/result', { message: { toolCallId: 'action-1', content: [{ type: 'tool-result', content: [{ type: 'text', text: 'sent' }] }] } })
    emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await new Promise<void>(resolve => setTimeout(resolve, 0))

    expect(log.filter(event => event.type === 'hivemind/operating-receipt')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ receiptId: 'browser:browser-1', kind: 'browser', status: 'completed' }) }),
      expect.objectContaining({ data: expect.objectContaining({ receiptId: 'artifact:artifact-1', kind: 'artifact', status: 'completed' }) }),
      expect.objectContaining({ data: expect.objectContaining({ receiptId: 'workflow:flow-1', kind: 'workflow', status: 'running' }) }),
      expect.objectContaining({ data: expect.objectContaining({ receiptId: 'workflow:flow-1', kind: 'workflow', status: 'completed' }) }),
      expect.objectContaining({ data: expect.objectContaining({ receiptId: 'connected_action:action-1', kind: 'connected_action', status: 'completed' }) }),
    ])
    expect(log.at(-1)).toEqual(expect.objectContaining({ type: 'hivemind/run-evaluation', data: expect.objectContaining({ runId: 'run-1', planId: 'plan-1', receiptCounts: { browser: 1, artifact: 1, workflow: 2, connected_action: 1 } }) }))
  })

  it('leaves ordinary native tool receipts alone when no operating run exists', () => {
    const log: Array<{ type: string; data: Record<string, unknown> }> = []
    const session = { append(type: string, data: Record<string, unknown>) { log.push({ type, data }) }, snapshotEvents() { return log } }
    const ctx = new Context()
    ctx.provide('tools', { register() { return () => {} } } as never)
    ctx.provide('hivemindEmployeeDirectory', { async profiles() { return { profiles: [] } } } as never)
    apply(ctx)
    log.push({ type: 'tool/call', data: { callId: 'browser-1', name: 'browser_take_screenshot', arguments: '{}' } })
    ctx.emit('session/event', session as never, { type: 'tool/result', data: { message: { toolCallId: 'browser-1', content: [{ type: 'tool-result', content: [{ type: 'image' }] }] } } } as never)
    expect(log).toEqual([{ type: 'tool/call', data: { callId: 'browser-1', name: 'browser_take_screenshot', arguments: '{}' } }])
  })

  it('receives SessionStore append events without a synthetic event emission', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const observed: string[] = []
    ctx.on('session/event', (_session, event) => { observed.push(event.type) })
    ctx.provide('tools', { register() { return () => {} } } as never)
    ctx.provide('hivemindEmployeeDirectory', { async profiles() { return { profiles: [] } } } as never)
    apply(ctx)
    const session = ctx.sessions.create()
    session.append('hivemind/run-plan', { runId: 'run-live', planId: 'plan-live', revision: 1, objective: 'Capture a current product page', approach: 'Use the browser receipt', playbooks: [], workstreams: [] })
    const callId = 'browser-live' as never
    const call = session.append('tool/call', { turn: 1, step: 1, callId, name: 'browser_take_screenshot', arguments: '{}' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'Screenshot captured.' }], isError: false }),
    }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    expect(observed).toEqual(['hivemind/run-plan', 'tool/call', 'tool/result'])
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(session.snapshotEvents().find(event => event.type === 'hivemind/operating-receipt')).toMatchObject({
      data: { runId: 'run-live', planId: 'plan-live', receiptId: 'browser:browser-live', kind: 'browser', status: 'completed' },
    })
  })
})

it('uses attested Runtime native preset authority without requesting or fabricating human approval',async()=>{
  const { ctx,tool,agent,events }=await setup({ kind:'main' },true,'rejected')
  const approve=vi.spyOn(ctx.approval,'request')
  ctx.provide('hivemindHq',{ fullAccessAllowed:async()=>true } as never)
  const result=await tool.execute({ action:'request_approval',workstream_id:'work-1',approval_reason:'Existing Runtime mode authorizes bounded work.' },{ agent,signal:new AbortController().signal } as never)
  expect(result).toMatchObject({ status:'approved',outcome:'allowed-once' })
  expect(approve).not.toHaveBeenCalled()
  expect(events).toContainEqual({ type:'hivemind/workstream-approval',data:expect.objectContaining({ authority:'permission_preset' }) })
  expect(events.some(event=>event.type==='approval/decided')).toBe(false)
})
