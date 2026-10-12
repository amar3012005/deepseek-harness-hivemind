import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { createMcpToolDefinition, listMcpTools } from '../src/mcp-adapter.ts'

describe('product MCP transport adapter', () => {
  it('discovers every page and rejects repeating cursors', async () => {
    const listTools = vi.fn().mockResolvedValueOnce({ tools: [{ name: 'a' }], nextCursor: 'next' })
      .mockResolvedValueOnce({ tools: [{ name: 'b' }] })
    expect(await listMcpTools({ listTools } as unknown as Client)).toEqual([{ name: 'a' }, { name: 'b' }])
    expect(listTools.mock.calls[1]).toEqual([{ cursor: 'next' }])
    listTools.mockReset().mockResolvedValue({ tools: [], nextCursor: 'repeat' })
    await expect(listMcpTools({ listTools } as unknown as Client)).rejects.toThrow('pagination cursor')
  })

  it.each([true, false])('retries a lost MCP session only when read-safe is %s', async (retrySafe) => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const request = vi.fn().mockRejectedValue(new Error('Session not found'))
    const recoveredRequest = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'done' }] })
    const recoverClient = vi.fn().mockResolvedValue({ request: recoveredRequest })
    ctx.tools.register(createMcpToolDefinition({ request } as unknown as Client, ctx,
      'fixture_read', 'read', 'Read fixture', { type: 'object', properties: {} }, undefined,
      false, retrySafe, { registrationFailure: 'throw', serverName: 'fixture',
        toolCallTimeoutMs: 5000, recoverClient }))
    const signal = new AbortController().signal
    const result = await ctx.tools.execute({ signal,
      callId: ToolCallId('adapter-read'), name: 'fixture_read', arguments: {} })
    expect(result.isError).toBe(!retrySafe)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]?.[2]).toMatchObject({ signal, timeout: 5000 })
    expect(recoverClient).toHaveBeenCalledTimes(retrySafe ? 1 : 0)
    expect(recoveredRequest).toHaveBeenCalledTimes(retrySafe ? 1 : 0)
    await ctx.fiber.dispose()
  })

  it('does not reconnect or repeat a request canceled during dispatch', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const controller = new AbortController()
    const request = vi.fn().mockImplementation(async () => {
      controller.abort()
      throw new Error('Session not found')
    })
    const recoverClient = vi.fn()
    ctx.tools.register(createMcpToolDefinition({ request } as unknown as Client, ctx,
      'fixture_cancel', 'read', 'Read fixture', { type: 'object', properties: {} }, undefined,
      false, true, { registrationFailure: 'throw', serverName: 'fixture',
        toolCallTimeoutMs: 5000, recoverClient }))
    const result = await ctx.tools.execute({ signal: controller.signal,
      callId: ToolCallId('adapter-cancel'), name: 'fixture_cancel', arguments: {} })
    expect(result.isError).toBe(true)
    expect(request).toHaveBeenCalledTimes(1)
    expect(recoverClient).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})
