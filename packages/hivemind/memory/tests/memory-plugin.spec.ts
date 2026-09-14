import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { memoryPlugin } from '../src/index.ts'

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
})
