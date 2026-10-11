import { Context, Service } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { memoryPlugin } from '../src/index.ts'

class FullAccessControl extends Service {
  constructor(ctx: Context, readonly allowed: () => Promise<boolean>) { super(ctx, 'hivemindHq') }
  fullAccessAllowed() { return this.allowed() }
}

async function mount() {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const current = vi.fn(() => 'workspace-write')
  ctx.provide('permissionPresets', { current })
  const ask = vi.fn(async (input: { questions: readonly { id: string }[] }) => ({
    answers: [{ id: input.questions[0]!.id, selected: ['Personal'] }],
  }))
  const park = vi.fn((_input: unknown, callId: string) => ({ pending: true as const, callId }))
  ctx.provide('userQuestions', { ask, park })
  const save = vi.fn(async () => ({ status: 'saved' }))
  await ctx.plugin(memoryPlugin({ defaultLimit: 5 }, {
    context: async () => ({}), entities: async () => ({}), recall: async () => ({}),
    profiles: async () => ({}), save,
  }))
  const events: Array<{ type: string; data: unknown }> = []
  const agent = { session: {
    header: { id: 'runtime-save' }, snapshotEvents: () => events,
    append(type: string, data: unknown) { events.push({ type, data }) },
  } } as unknown as Agent
  const signal = new AbortController().signal
  const execute = (title = 'Confirmed direction') => {
    const args = { operation: 'save', save: { title, content: 'Prepare the internal customer brief.', scope: 'personal' } }
    return ctx.tools.get('hivemind_meta')!.execute(args, { agent, signal, name: 'hivemind_meta',
      callId: ToolCallId(title), rootCallId: ToolCallId(title), arguments: args, concludeTurn: vi.fn(),
    } as never)
  }
  const hq = async (allowed: () => Promise<boolean>) => ctx.plugin({
    name: 'memory-full-access-provider', apply(scope: Context) { new FullAccessControl(scope, allowed) },
  })
  return { ctx, current, ask, park, save, events, execute, hq }
}

describe('Memory save optional HQ authority in native Cordis', () => {
  it('saves through one native destination approval when HQ is absent', async () => {
    const f = await mount()
    try {
      await expect(f.execute()).resolves.toMatchObject({ pending: true })
      expect(f.ask).not.toHaveBeenCalled()
      expect(f.park).toHaveBeenCalledOnce()
      expect(f.save).not.toHaveBeenCalled()
      expect(f.events.some(event => event.type === 'user-question/parked')).toBe(true)
    } finally { await f.ctx.fiber.dispose() }
  })

  it('uses attested HQ authority while preserving the prepared destination', async () => {
    const f = await mount()
    const allowed = vi.fn(async () => true)
    try {
      await f.hq(allowed)
      await expect(f.execute()).resolves.toEqual({ status: 'saved' })
      expect(allowed).toHaveBeenCalledOnce()
      expect(f.ask).not.toHaveBeenCalled()
      expect(f.save).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ scope: 'personal' }), expect.any(AbortSignal), expect.any(Object))
    } finally { await f.ctx.fiber.dispose() }
  })

  it('returns to native approval when HQ authority is withdrawn', async () => {
    const f = await mount()
    const allowed = vi.fn(async () => true)
    try {
      const provider = await f.hq(allowed)
      await f.execute('First direction')
      await provider.dispose()
      await f.execute('Second direction')
      expect(allowed).toHaveBeenCalledOnce()
      expect(f.ask).not.toHaveBeenCalled()
      expect(f.park).toHaveBeenCalledOnce()
      expect(f.save).toHaveBeenCalledOnce()
    } finally { await f.ctx.fiber.dispose() }
  })

  it('does not save after the native destination question is cancelled', async () => {
    const f = await mount()
    try {
      await f.hq(async () => false)
      await f.execute()
      const parked = f.events.find(event => event.type === 'user-question/parked')!.data as { callId: string; questions: { id: string }[] }
      f.events.push({ type: 'user/message', data: { source: { kind: 'user-question-reply', callId: parked.callId },
        content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: parked.questions[0]!.id, selected: [] }] }) }],
      } })
      await expect(f.execute()).resolves.toEqual({ operation: 'save', status: 'cancelled' })
      expect(f.save).not.toHaveBeenCalled()
      expect(f.events.at(-1)?.data).toMatchObject({ status: 'cancelled' })
    } finally { await f.ctx.fiber.dispose() }
  })

  it('propagates an HQ tenant or administrator rejection before saving', async () => {
    const f = await mount()
    try {
      await f.hq(async () => { throw Error('runtime_scope_changed') })
      await expect(f.execute()).rejects.toThrow('runtime_scope_changed')
      expect(f.ask).not.toHaveBeenCalled()
      expect(f.save).not.toHaveBeenCalled()
    } finally { await f.ctx.fiber.dispose() }
  })
})
