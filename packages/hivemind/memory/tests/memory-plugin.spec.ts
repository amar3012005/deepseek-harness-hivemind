import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
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
    await fiber.dispose()
    expect(tools.get('hivemind_meta')).toBeUndefined()
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
