import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import Approval from '@deepseek-ai/dsh-user-approval'
import { createAssistantMessage, ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import ExecutionScope from '@deepseek-ai/dsh-hivemind-execution-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, TOOL_RUNTIME_SCHEDULER, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { expect, it, vi } from 'vitest'
import { RuntimeApprovalService, installRuntimeApprovalService } from '../src/runtime-approval-checkpoints.ts'

const principal = {
  orgId: 'org-1', userId: 'admin-1', profile: 'hivemind-chat' as const, variation: 'test',
  authenticatedActor: { orgId: 'org-1', userId: 'admin-1', name: 'Test Admin', role: 'admin' },
}

async function fixture(options: { policy?: 'ask' | 'never'; deny?: boolean; scoped?: boolean } = {}) {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(Sessions)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(ExecutionScope)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Approval, { policy: options.policy ?? 'ask' })
  const action = vi.fn(async (args: { value: string }) => ({ value: args.value }))
  const makeActionTool = (name: string): ToolDefinition => defineTool({
    name, description: 'Integration test protected action',
    parameters: { value: { type: 'string', required: true } },
    output: { schema: { type: 'object', properties: { value: { type: 'string', required: true } }, additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) { return action(args as { value: string }) },
  })
  const globalTool = makeActionTool('sensitive_action')
  ctx.tools.register(globalTool)
  ctx.on('tools/pre-execute', async (execution, next) => {
    if (options.deny && execution.name === 'sensitive_action') return { kind: 'deny', reason: 'Test native denial.' }
    if (execution.name === 'sensitive_action' || execution.name === 'scoped_action') {
      return { kind: 'ask', reason: 'This integration action requires approval.' }
    }
    return next()
  })
  installRuntimeApprovalService(ctx)
  const session = ctx.sessions.create(SessionId(`runtime-approval-${options.policy ?? 'ask'}-${options.scoped ? 'scoped' : 'global'}`))
  session.append('agent-preset/selected', { agentPreset: 'hivemind-hq' })
  session.append('hivemind/session-owner', { id: null, slug: 'runtime', name: 'Runtime', role: 'Chief' } as never)
  session.append('turn/start', { turn: 1 })
  vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(true)
  const inbox: UserMessage[] = []
  const agent = {
    id: session.id, session, options: {}, inbox: { nextTurn: inbox, nextStep: [] },
    steer(message: UserMessage) { inbox.push(message) }, inject() {},
  } as unknown as Agent
  let scope!: ReturnType<typeof createScope>
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, {
    inject: ['tools', 'sessions', 'sessionProjections', 'hivemindExecutionScope', 'agents'],
  }))
  ;(agent as { ctx?: Context }).ctx = scope.ctx
  ctx.agents.enter(agent, undefined)
  await agentEvents(ctx, agent).serial('agent/created', { source: 'startup' })
  if (options.scoped) agent.ctx.tools.register(makeActionTool('scoped_action'))
  await agentEvents(ctx, agent).waterfall('agent/pre-step', { signal: new AbortController().signal,
    turn: 1, step: 1, messages: [] }, async () => ({ kind: 'enter' as const, messages: [] }))
  const toolName = options.scoped ? 'scoped_action' : 'sensitive_action'
  const callId = ToolCallId('original-tool-call')
  session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
    content: [{ type: 'tool-call', id: callId, name: toolName, arguments: JSON.stringify({ value: 'exact saved value' }) }],
    source: { model: 'test' } as never,
  }) }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId, name: toolName, arguments: JSON.stringify({ value: 'exact saved value' }) })
  const execute = () => ctx.hivemindExecutionScope.run(principal, () => ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare({ agent,
    signal: new AbortController().signal, callId, rootCallId: callId, name: toolName,
    arguments: { value: 'exact saved value' }, allowParking: true, turn: 1, step: 1 }))
  return { ctx, agent, session, scope, inbox, action, globalTool, toolName, callId, execute,
    service: ctx.get('hivemindRuntimeApproval') as RuntimeApprovalService }
}

it('durably parks an asked global tool without a tool result, then resumes through native ToolRuntime', async () => {
  const f = await fixture()
  const restored = new Context()
  restored.provide('agents', { get: () => f.agent, roots: () => [f.agent] } as never)
  restored.provide('hivemindExecutionScope', f.ctx.hivemindExecutionScope as never)
  restored.provide('sessions', { flush: async () => true } as never)
  const restoredService = new RuntimeApprovalService(restored)
  try {
    const pending = await f.execute()
    expect(pending).toMatchObject({ kind: 'parked', approvalId: expect.any(String) })
    if (pending.kind !== 'parked') throw new Error('scheduler did not park the approval request')
    expect(f.action).not.toHaveBeenCalled()
    expect(f.session.snapshotEvents().some(event => event.type === 'tool/result'
      && event.data.message.toolCallId === f.callId)).toBe(false)
    expect(f.session.deriveMessages().flatMap(message => message.content).some(block => block.type === 'tool-call' && block.id === f.callId)).toBe(false)
    expect(f.session.snapshotEvents().some(event => event.type === 'tool/parked'
      && event.data.callId === f.callId && event.data.approvalId === pending.approvalId)).toBe(true)
    const item = f.ctx.hivemindExecutionScope.run(principal, () => restoredService.pending(f.agent)[0])
    expect(item).toBeDefined()
    if (!item) throw new Error('pending approval was not exposed')
    expect(item).toMatchObject({ callId: 'original-tool-call', toolName: 'sensitive_action', state: 'pending' })
    await f.ctx.hivemindExecutionScope.run(principal, () => restoredService.decide(f.agent, item.callId, item.approvalId, 'approve'))
    expect(f.inbox).toHaveLength(1)
    f.session.append('user/message', f.inbox.shift()!, { surfaceOp: 'append' })
    const resumed = await f.ctx.hivemindExecutionScope.run(principal, () => f.ctx.tools.execute({ agent: f.agent,
      callId: ToolCallId('resume-tool-call'), rootCallId: ToolCallId('resume-tool-call'), name: 'hivemind_resume_approval',
      arguments: { approval_id: item.approvalId }, signal: new AbortController().signal }))
    expect(resumed).toMatchObject({ isError: false, value: { status: 'completed', approval_id: item.approvalId,
      result: { value: 'exact saved value' } } })
    expect(f.action).toHaveBeenCalledExactlyOnceWith({ value: 'exact saved value' })
    expect(f.session.snapshotEvents().filter(event => event.type === 'hivemind/runtime-approval-checkpoint').at(-1)?.data)
      .toMatchObject({ callId: 'original-tool-call', toolName: 'sensitive_action', state: 'completed',
        arguments: { value: 'exact saved value' } })
    expect(f.ctx.tools.get('sensitive_action')).toBe(f.globalTool)
    expect(f.agent.ctx.tools.get('sensitive_action', f.agent)).toBe(f.globalTool)
  } finally { await restored.fiber.dispose(); await f.scope.dispose(); await f.ctx.fiber.dispose() }
})

it('leaves native deny and never policy authoritative', async () => {
  for (const options of [{ deny: true }, { policy: 'never' as const }]) {
    const f = await fixture(options)
    try {
      const result = await f.execute()
      expect(result.kind).toBe('post-result')
      if (result.kind === 'post-result') expect(result.result.isError).toBe(true)
      expect(f.action).not.toHaveBeenCalled()
      expect(f.session.snapshotEvents().some(event => event.type === 'hivemind/runtime-approval-checkpoint')).toBe(false)
    } finally { await f.scope.dispose(); await f.ctx.fiber.dispose() }
  }
})

it('restores a saved park in a fresh approval service and declines without running the protected tool', async () => {
  const f = await fixture()
  const restored = new Context()
  restored.provide('agents', { get: () => f.agent, roots: () => [f.agent] } as never)
  restored.provide('hivemindExecutionScope', f.ctx.hivemindExecutionScope as never)
  restored.provide('sessions', { flush: async () => true } as never)
  const restoredService = new RuntimeApprovalService(restored)
  try {
    const parked = await f.execute()
    expect(parked.kind).toBe('parked')
    const item = f.ctx.hivemindExecutionScope.run(principal, () => restoredService.pending(f.agent)[0])
    expect(item).toBeDefined()
    if (!item) throw new Error('restored approval service did not recover the durable parked request')
    await f.ctx.hivemindExecutionScope.run(principal, () => restoredService.decide(f.agent, item.callId, item.approvalId, 'decline'))
    expect(f.action).not.toHaveBeenCalled()
    expect(f.session.snapshotEvents().filter(event => event.type === 'hivemind/runtime-approval-checkpoint').at(-1)?.data)
      .toMatchObject({ callId: item.callId, approvalId: item.approvalId, state: 'declined', decision: 'decline' })
    expect(f.session.snapshotEvents().some(event => event.type === 'tool/result'
      && event.data.message.toolCallId === f.callId)).toBe(false)
    expect(f.inbox).toHaveLength(1)
    expect(f.inbox[0]?.source).toMatchObject({ kind: 'hivemind-runtime-approval', action: 'declined',
      approvalId: item.approvalId, callId: item.callId })
  } finally { await restored.fiber.dispose(); await f.scope.dispose(); await f.ctx.fiber.dispose() }
})

it('parks a scoped definition without shadowing or changing its schema', async () => {
  const f = await fixture({ scoped: true })
  try {
    const result = await f.execute()
    expect(result.kind).toBe('parked')
    expect(f.action).not.toHaveBeenCalled()
    expect(f.session.snapshotEvents().some(event => event.type === 'hivemind/runtime-approval-checkpoint')).toBe(true)
    expect(f.ctx.tools.get('scoped_action', f.agent)?.name).toBe('scoped_action')
  } finally { await f.scope.dispose(); await f.ctx.fiber.dispose() }
})
