import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import ExecutionScope from '@deepseek-ai/dsh-hivemind-execution-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { memoryPlugin, type SaveRequest } from '../src/index.ts'

const owner = { orgId: 'org-1', userId: 'user-1', profile: 'hivemind-chat' as const, variation: 'test' }

async function fixture() {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(ExecutionScope)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const authorizationGate = vi.fn(async (_execution: unknown, next: () => Promise<unknown>) => next())
  ctx.on('tools/pre-execute', authorizationGate as never)
  const saved = vi.fn(async (_agent: Agent, _request: SaveRequest, _signal: AbortSignal, _execution: unknown) => ({ status: 'saved', memory_id: 'receipt-1' }))
  const plugin = memoryPlugin({ defaultLimit: 5 }, {
    context: async () => ({}), entities: async () => ({}), recall: async () => ({}), profiles: async () => ({}), save: saved,
  })
  await ctx.plugin(plugin)
  const session = Session.create(SessionId('memory-approval-fixture'))
  const inbox: UserMessage[] = []
  const agent = {
    id: session.id, session, inbox: { nextTurn: [], nextStep: inbox },
    steer: (message: UserMessage) => { inbox.push(message) }, inject: vi.fn(),
  } as unknown as Agent
  ctx.agents.enter(agent, undefined)
  const callId = ToolCallId('memory-save-call')
  const args = { operation: 'save', save: { title: 'Confirmed priority', content: 'Release existing customer work first.' } }
  const execute = () => ctx.hivemindExecutionScope.run(owner, () => ctx.tools.execute({ agent, signal: new AbortController().signal, callId, rootCallId: callId, name: 'hivemind_meta', arguments: args }))
  const operationId = () => session.snapshotEvents().findLast(event => event.type === 'hivemind/memory-save-checkpoint')?.data.operationId
  const decide = (destination: 'decline' | 'personal' | 'organization' | 'project') => ctx.hivemindExecutionScope.run(owner, async () => {
    const id = operationId()
    if (!id) throw new Error('saved operation missing')
    return ctx.hivemindMemoryApproval.decideSave(agent, callId, id, destination)
  })
  const resume = async () => {
    const message = inbox.shift()!
    session.append('user/message', message, { surfaceOp: 'append' })
    await ctx.waterfall('agent/pre-step', { agent, signal: new AbortController().signal, turn: 2, step: 1, messages: [] }, async () => ({ kind: 'enter' as const, messages: [] }))
  }
  return { ctx, agent, session, saved, execute, decide, resume, inbox, authorizationGate }
}

describe('durable HIVE-MIND memory save approvals', () => {
  it('flushes approval state, resumes the exact request, and de-duplicates terminal execution', async () => {
    const f = await fixture()
    try {
      await expect(f.execute()).resolves.toMatchObject({ isError: false, concludesTurn: true, value: { pending: true } })
      expect(f.ctx.sessionProjections.snapshot(f.session).values.hivemindMemorySaveApprovals?.active).toHaveLength(1)
      expect(f.saved).not.toHaveBeenCalled()
      await f.decide('personal')
      expect(f.inbox).toHaveLength(1)
      await f.resume()
      expect(f.saved).toHaveBeenCalledOnce()
      expect(f.authorizationGate.mock.calls.filter(([exec]) => (exec as { name?: string }).name === 'hivemind_meta')).toHaveLength(2)
      expect(f.saved.mock.calls[0]?.[1]).toMatchObject({ title: 'Confirmed priority', scope: 'personal', idempotencyKey: expect.stringMatching(/^saveop:/) })
      expect(f.ctx.sessionProjections.snapshot(f.session).values.hivemindMemorySaveApprovals?.settled).toMatchObject([{ status: 'completed' }])
      await f.decide('personal')
      expect(f.saved).toHaveBeenCalledOnce()
    } finally { await f.ctx.fiber.dispose() }
  })

  it('declines without a provider write and rejects a foreign tenant', async () => {
    const f = await fixture()
    try {
      await f.execute()
      await expect(f.ctx.hivemindExecutionScope.run({ ...owner, orgId: 'other-org' }, async () => {
        const checkpoint = f.session.snapshotEvents().findLast(event => event.type === 'hivemind/memory-save-checkpoint')!
        return f.ctx.hivemindMemoryApproval.decideSave(f.agent, ToolCallId(checkpoint.data.callId), checkpoint.data.operationId!, 'personal')
      })).rejects.toThrow('active saved operation and tenant must match')
      await f.decide('decline')
      expect(f.saved).not.toHaveBeenCalled()
      expect(f.ctx.sessionProjections.snapshot(f.session).values.hivemindMemorySaveApprovals?.settled).toMatchObject([{ status: 'declined' }])
    } finally { await f.ctx.fiber.dispose() }
  })
})
