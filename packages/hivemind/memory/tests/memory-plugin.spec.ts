import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { memoryPlugin, saveOperationId } from '../src/index.ts'

describe('hivemind-memory plugin lifecycle', () => {
  it('registers hivemind_meta in its Cordis effect and removes it on disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(memoryPlugin({ defaultLimit: 5 }, {
      context: async () => ({}),
      entities: async () => ({}),
      recall: async () => ({}),
      save: async () => ({}),
      profiles: async () => ({}),
      updateProfile: async () => ({ status: 'updated' }),
    }))

    const tools = fiber.ctx.tools
    expect(tools.get('hivemind_meta')).toBeDefined()
    expect(tools.get('hivemind_update_profile')).toBeDefined()
    await fiber.dispose()
    expect(tools.get('hivemind_meta')).toBeUndefined()
    expect(tools.get('hivemind_update_profile')).toBeUndefined()
  })

  it('uses a durable save-operation id that is independent of call id', () => {
    const agent = { session: { header: { id: 'session-1' }, append() {}, events: [] } }
    const request = { title: 'Note', content: 'Keep this', sourceType: 'conversation' as const }
    const first = saveOperationId({ agent, callId: 'call-a' } as never, request)
    const second = saveOperationId({ agent, callId: 'call-b' } as never, request)
    expect(first).toMatch(/^saveop:[a-f0-9]{64}$/)
    expect(first).toBe(second)
  })

  it('normalizes the historical flat recall shape without another model turn', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    const recall = vi.fn(async () => ({ status: 'ready' }))
    const fiber = await ctx.plugin(memoryPlugin({ defaultLimit: 5 }, {
      context: async () => ({}), entities: async () => ({}), recall,
      save: async () => ({}), profiles: async () => ({}),
    }))
    const meta = fiber.ctx.tools.get('hivemind_meta')!
    await expect(meta.execute({ operation: 'recall', query: 'Pinterest company analysis', limit: 5 }, {
      signal: new AbortController().signal,
    } as never)).resolves.toEqual({ status: 'ready' })
    expect(recall).toHaveBeenCalledWith({
      query: 'Pinterest company analysis', mode: 'memory', limit: 5,
    }, expect.any(AbortSignal), expect.any(Object))
    await fiber.dispose()
  })

  it('keeps the canonical nested recall shape unchanged', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    const recall = vi.fn(async () => ({ status: 'ready' }))
    const fiber = await ctx.plugin(memoryPlugin({ defaultLimit: 5 }, {
      context: async () => ({}), entities: async () => ({}), recall,
      save: async () => ({}), profiles: async () => ({}),
    }))
    const meta = fiber.ctx.tools.get('hivemind_meta')!
    await meta.execute({ operation: 'recall', recall: { query: 'Pinterest', limit: 3, entities: ['Pinterest'] } }, {
      signal: new AbortController().signal,
    } as never)
    expect(recall).toHaveBeenCalledWith({
      query: 'Pinterest', mode: 'memory', limit: 3, tags: ['entity:Pinterest'],
    }, expect.any(AbortSignal), expect.any(Object))
    await fiber.dispose()
  })
})
