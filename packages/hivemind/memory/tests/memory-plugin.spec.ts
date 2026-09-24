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
    }))

    const tools = fiber.ctx.tools
    expect(tools.get('hivemind_meta')).toBeDefined()
    expect(tools.get('hivemind_batch_save_memories')).toBeDefined()
    await fiber.dispose()
    expect(tools.get('hivemind_meta')).toBeUndefined()
    expect(tools.get('hivemind_batch_save_memories')).toBeUndefined()
  })

  it('normalizes historical flat entity and recall reads without another model turn', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    const entities = vi.fn(async () => ({ status: 'ready' }))
    const recall = vi.fn(async () => ({ status: 'ready' }))
    const fiber = await ctx.plugin(memoryPlugin({ defaultLimit: 5 }, {
      context: async () => ({}), entities, recall,
      save: async () => ({}), profiles: async () => ({}),
    }))
    const meta = fiber.ctx.tools.get('hivemind_meta')!
    await meta.execute({ operation: 'entities', query: 'Griseldis', limit: 5 }, {
      signal: new AbortController().signal,
    } as never)
    await meta.execute({ operation: 'recall', query: 'company decision', limit: 3 }, {
      signal: new AbortController().signal,
    } as never)
    expect(entities).toHaveBeenCalledWith({ query: 'Griseldis', limit: 5 }, expect.any(AbortSignal), expect.any(Object))
    expect(recall).toHaveBeenCalledWith({ query: 'company decision', mode: 'memory', limit: 3 }, expect.any(AbortSignal), expect.any(Object))
    await fiber.dispose()
  })

  it('repairs only an unambiguous missing read operation before schema validation', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    const entities = vi.fn(async () => ({ status: 'ready' }))
    const recall = vi.fn(async () => ({ status: 'ready' }))
    const fiber = await ctx.plugin(memoryPlugin({ defaultLimit: 5 }, {
      context: async () => ({}), entities, recall,
      save: async () => ({}), profiles: async () => ({}),
    }))
    const meta = fiber.ctx.tools.get('hivemind_meta')!
    await meta.execute({ entities: { query: 'a named subject' } }, { signal: new AbortController().signal } as never)
    await meta.execute({ recall: { query: 'What do you know about this subject?' } }, { signal: new AbortController().signal } as never)
    expect(entities).toHaveBeenCalledTimes(1)
    expect(recall).toHaveBeenCalledTimes(1)
    await expect(meta.execute({ entities: { query: 'a named subject' }, recall: { query: 'same' } }, {
      signal: new AbortController().signal,
    } as never)).rejects.toThrow('missing required property "operation"')
    await expect(meta.execute({ save: { title: 'No implicit write', content: 'No implicit write' } }, {
      signal: new AbortController().signal,
    } as never)).rejects.toThrow('missing required property "operation"')
    await fiber.dispose()
  })

  it('marks memory mutations exclusive and keeps reads parallel-safe', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(memoryPlugin({ defaultLimit: 5 }, {
      context: async () => ({}), entities: async () => ({}), recall: async () => ({}),
      save: async () => ({}), profiles: async () => ({}),
    }))
    expect(fiber.ctx.tools.get('hivemind_save_memory')?.isConcurrencySafe?.({})).toBe(false)
    expect(fiber.ctx.tools.get('hivemind_batch_save_memories')?.isConcurrencySafe?.({})).toBe(false)
    expect(fiber.ctx.tools.get('hivemind_meta')?.isConcurrencySafe?.({ operation: 'save' })).toBe(false)
    expect(fiber.ctx.tools.get('hivemind_meta')?.isConcurrencySafe?.({ operation: 'recall' })).toBe(true)
    await fiber.dispose()
  })

  it('normalizes exhaustive save entities into searchable entity tags', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    const save = vi.fn(async (_agent, request) => ({ status: 'completed', tags: request.tags }))
    const fiber = await ctx.plugin(memoryPlugin({ defaultLimit: 5 }, {
      context: async () => ({}), entities: async () => ({}), recall: async () => ({}),
      save, profiles: async () => ({}),
      prepareSave: (_agent, request) => ({ ...request, scope: 'organization' }),
    }))
    const expectedRequest = {
      title: 'Enterprise memory reliability',
      content: 'Authenticate memory access and preserve evidence receipts.',
      sourceType: 'documentation' as const,
      tags: [
        'kind:note', 'urgency:low', 'entity:enterprise-memory',
        'entity:authentication', 'entity:evidence-receipts',
      ],
      scope: 'organization' as const,
    }
    const agent = {
      session: {
        header: { id: 'session-1' },
        append() {},
        snapshotEvents: () => [{
          type: 'hivemind/memory-save',
          data: {
            operation_id: saveOperationId({ agent } as never, expectedRequest),
            status: 'approved',
            destination: 'organization',
          },
        }],
      },
    }
    const result = await fiber.ctx.tools.get('hivemind_save_memory')!.execute({
      title: 'Enterprise memory reliability',
      content: 'Authenticate memory access and preserve evidence receipts.',
      source_type: 'documentation',
      tags: ['kind:note', 'urgency:low'],
      entities: ['Enterprise Memory', 'Authentication', 'Evidence Receipts', 'Enterprise Memory'],
    }, {
      signal: new AbortController().signal,
      agent,
    } as never)
    expect(result).toMatchObject({
      tags: [
        'kind:note', 'urgency:low', 'entity:enterprise-memory',
        'entity:authentication', 'entity:evidence-receipts',
      ],
    })
    await fiber.dispose()
  })

  it.each([
    ['Your verification code', 'Use 482991 to sign in'],
    ['Password reset', 'Reset your password at https://example.com/reset-password?t=secret'],
    ['Security alert', 'Unrecognized login attempt from a new device'],
  ])('blocks authentication material before approval: %s', async (title, content) => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(memoryPlugin({ defaultLimit: 5 }, {
      context: async () => ({}), entities: async () => ({}), recall: async () => ({}),
      save: async () => ({}), profiles: async () => ({}),
    }))
    await expect(fiber.ctx.tools.get('hivemind_save_memory')!.execute({ title, content, source_type: 'text' }, {
      signal: new AbortController().signal,
      agent: { session: { header: { id: 'session-1' }, append() {}, snapshotEvents: () => [] } },
    } as never)).rejects.toThrow('authentication material')
    await fiber.dispose()
  })

  it('uses a durable save-operation id that is independent of call id', () => {
    const agent = { session: { header: { id: 'session-1' }, append() {}, events: [] } }
    const request = { title: 'Note', content: 'Keep this', sourceType: 'conversation' as const }
    const first = saveOperationId({ agent, callId: 'call-a' } as never, request)
    const second = saveOperationId({ agent, callId: 'call-b' } as never, request)
    expect(first).toMatch(/^saveop:[a-f0-9]{64}$/)
    expect(first).toBe(second)
  })
})
