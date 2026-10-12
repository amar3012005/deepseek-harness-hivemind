import { Context, Service } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import ExecutionScope from '@deepseek-ai/dsh-hivemind-execution-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { memoryPlugin, type SaveRequest } from '../src/index.ts'

const owner = { orgId: 'org-1', userId: 'user-1', profile: 'hivemind-chat' as const, variation: 'test' }
class FullAccessControl extends Service {
  constructor(ctx: Context, readonly allowed: () => Promise<boolean>) { super(ctx, 'hivemindHq') }
  fullAccessAllowed() { return this.allowed() }
}

async function mount() {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(ExecutionScope)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.provide('permissionPresets', { current: () => 'workspace-write' })
  const save = vi.fn(async (_agent: Agent, _request: SaveRequest) => ({ status: 'saved' }))
  await ctx.plugin(memoryPlugin({ defaultLimit: 5 }, {
    context: async () => ({}), entities: async () => ({}), recall: async () => ({}),
    profiles: async () => ({}), save,
  }))
  const session = Session.create(SessionId('memory-full-access-fixture'))
  const agent = { id: session.id, session, inbox: { nextTurn: [], nextStep: [] }, steer: vi.fn(), inject: vi.fn() } as unknown as Agent
  ctx.agents.enter(agent, undefined)
  const args = { operation: 'save', save: { title: 'Confirmed direction', content: 'Prepare the internal customer brief.', scope: 'personal' } }
  const execute = () => ctx.hivemindExecutionScope.run(owner, () => ctx.tools.execute({ agent, signal: new AbortController().signal,
    name: 'hivemind_meta', callId: ToolCallId('save-call'), rootCallId: ToolCallId('save-call'), arguments: args }))
  const hq = async (allowed: () => Promise<boolean>) => ctx.plugin({ name: 'memory-full-access-provider', apply(scope: Context) { new FullAccessControl(scope, allowed) } })
  return { ctx, agent, session, save, execute, hq }
}

describe('memory save Full Access fast path', () => {
  it('uses explicit HQ authority without creating a pending approval', async () => {
    const f = await mount()
    try {
      const allowed = vi.fn(async () => true)
      await f.hq(allowed)
      await expect(f.execute()).resolves.toMatchObject({ isError: false, value: { status: 'saved' } })
      expect(allowed).toHaveBeenCalledOnce()
      expect(f.save).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ scope: 'personal' }), expect.any(AbortSignal), expect.any(Object))
      expect(f.ctx.sessionProjections.snapshot(f.session).values.hivemindMemorySaveApprovals?.settled).toMatchObject([{ status: 'completed' }])
    } finally { await f.ctx.fiber.dispose() }
  })

  it('keeps a checkpoint pending when HQ authority is absent', async () => {
    const f = await mount()
    try {
      await expect(f.execute()).resolves.toMatchObject({ concludesTurn: true, value: { pending: true } })
      expect(f.save).not.toHaveBeenCalled()
      expect(f.ctx.sessionProjections.snapshot(f.session).values.hivemindMemorySaveApprovals?.active).toMatchObject([{ status: 'pending' }])
    } finally { await f.ctx.fiber.dispose() }
  })
})
