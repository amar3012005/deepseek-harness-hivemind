import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { z } from 'zod'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.ts'

let server: Server
let url: string
let ctx: Context
let sequence = 0

function callId(): ToolCallId { sequence += 1; return ToolCallId(`progressive-browser-${sequence}`) }

beforeAll(async () => {
  server = createServer((request, response) => {
    const mcp = new McpServer({ name: 'official-shaped-browser', version: '1.0.0' }, { capabilities: { tools: {} } })
    // MCP's runtime accepts the schemas below. Its generic declaration is bound
    // to a different resolved Zod identity during monorepo composite builds.
    const registerTool = mcp.registerTool.bind(mcp) as (name: string, config: unknown, handler: (...args: never[]) => unknown) => unknown
    // The fixture executes through the MCP server's runtime validator. Cast only
    // its schema boundary: this monorepo currently resolves Zod through two
    // compatible-but-nominally-distinct package paths during composite builds.
    registerTool('browser_navigate', { description: 'Navigate', inputSchema: { url: z.string() } }, async ({ url }: { url: string }) => {
      if (request.url?.startsWith('/cloudflare/')) throw new Error('500 Unable to create new browser')
      return url.includes('blocked')
        ? ({ content: [{ type: 'text', text: JSON.stringify({ outcome: 'source_blocked', url, next: 'Resolve another authoritative source.' }) }] })
        : ({ content: [{ type: 'text', text: JSON.stringify({ outcome: 'ready', url, title: 'Example Product', status: 200 }) }] })
    })
    registerTool('browser_snapshot', { description: 'Snapshot', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'snapshot' }] }))
    registerTool('browser_take_screenshot', { description: 'Screenshot', inputSchema: { fullPage: z.boolean().optional() } }, async ({ fullPage }: { fullPage?: boolean }) => ({ content: [
      { type: 'text', text: `screenshot:${typeof fullPage}:${String(fullPage)}` },
      { type: 'image', mimeType: 'image/png', data: 'AQ==' },
    ] }))
    const transport = new StreamableHTTPServerTransport({})
    response.on('close', () => { void transport.close(); void mcp.close() })
    void mcp.connect(transport as Transport).then(() => transport.handleRequest(request, response))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture did not bind TCP')
  url = `http://127.0.0.1:${address.port}/mcp`
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.provide('attachments', {
    saveImages: async (images: readonly unknown[]) => images.map((_, index) => ({
      attachmentId: AttachmentId(`sha256:${String(index + 1).padStart(64, '0')}`),
      mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1,
    })),
  } as never)
  apply(ctx, { url, headers: {}, serverName: 'browser', toolCallTimeoutMs: 5_000, leaseDurationMs: 60_000, captureSettleMs: 0 })
})

afterAll(async () => {
  await ctx.fiber.dispose()
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
}, 20_000)

describe('progressive browser MCP', () => {
  it('keeps official browser tools out of the initial model surface', () => {
    expect(ctx.tools.get('hivemind_browser_discover')).toBeDefined()
    expect(ctx.tools.get('hivemind_browser_capture')).toBeDefined()
    expect(ctx.tools.get('mcp__browser__browser_navigate')).toBeUndefined()
  })

  it('captures a resolved public page through one stable receipt', async () => {
    const receipt = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: callId(),
      name: 'hivemind_browser_capture',
      arguments: { source_url: 'https://example.com/product' },
    })
    expect(receipt.isError, JSON.stringify(receipt)).toBe(false)
    expect(receipt.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringMatching(/Exact title: Example Product.*Screenshot attachment id: sha256:0{63}1/),
    })
    expect(receipt.content[1]).toMatchObject({
      type: 'image',
      attachment: { mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
    })
  }, 20_000)

  it('asks for a URL or official origin instead of spending research to guess a new-page target', async () => {
    const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: callId(), name: 'hivemind_browser_discover', arguments: { intent: 'find the latest product', operation: 'inspect' } })
    expect(result.isError).toBe(false)
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Ask the user for an exact URL') })
    expect(ctx.tools.get('mcp__browser__browser_navigate')).toBeUndefined()
  })

  it('falls back to self-hosted Playwright when Browser Run discovery fails', async () => {
    const fallback = new Context()
    await fallback.plugin(SystemPrompt)
    await fallback.plugin(ToolRuntime)
    apply(fallback, {
      url,
      headers: {},
      serverName: 'browser',
      cloudflareUrl: 'http://127.0.0.1:1/mcp',
      cloudflareHeaders: {},
      cloudflareServerName: 'cloudflare-browser',
      toolCallTimeoutMs: 5_000,
      leaseDurationMs: 60_000,
      captureSettleMs: 0,
    })
    try {
      const result = await fallback.tools.execute({
        signal: new AbortController().signal,
        callId: callId(),
        name: 'hivemind_browser_discover',
        arguments: { intent: 'capture a public page', operation: 'capture', source_url: 'https://example.com' },
      })
      expect(result.isError).toBe(false)
      expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('"provider":"browser"') })
      expect(fallback.tools.get('mcp__browser__browser_take_screenshot')).toBeDefined()
    } finally {
      await fallback.fiber.dispose()
    }
  }, 20_000)

  it('falls back to self-hosted Playwright when Browser Run fails after discovery', async () => {
    const fallback = new Context()
    await fallback.plugin(SystemPrompt)
    await fallback.plugin(ToolRuntime)
    apply(fallback, {
      url,
      headers: {},
      serverName: 'browser',
      cloudflareUrl: url.replace('/mcp', '/cloudflare/mcp'),
      cloudflareHeaders: {},
      cloudflareServerName: 'cloudflare-browser',
      toolCallTimeoutMs: 5_000,
      leaseDurationMs: 60_000,
      captureSettleMs: 0,
    })
    try {
      const discovered = await fallback.tools.execute({
        signal: new AbortController().signal,
        callId: callId(),
        name: 'hivemind_browser_discover',
        arguments: { intent: 'capture a public page', operation: 'capture', source_url: 'https://example.com' },
      })
      expect(discovered.isError).toBe(false)
      expect(discovered.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('"provider":"cloudflare-browser"') })
      const discovery = JSON.parse((discovered.content[0] as { type: 'text'; text: string }).text) as { tools: { name: string; original_name: string }[] }
      const navigateName = discovery.tools.find(tool => tool.original_name === 'browser_navigate')?.name
      expect(navigateName).toBeDefined()
      const receipt = await fallback.tools.execute({
        signal: new AbortController().signal,
        callId: callId(),
        name: navigateName!,
        arguments: { url: 'https://example.com' },
      })
      expect(receipt.isError, JSON.stringify(receipt)).toBe(false)
      expect(receipt.content[0]).toEqual({ type: 'text', text: JSON.stringify({ outcome: 'ready', url: 'https://example.com', title: 'Example Product', status: 200 }) })
    } finally {
      await fallback.fiber.dispose()
    }
  }, 20_000)

  it('reveals exact native schemas and executes an original official tool', async () => {
    const discovered = await ctx.tools.execute({ signal: new AbortController().signal, callId: callId(), name: 'hivemind_browser_discover', arguments: { intent: 'capture a product page', operation: 'capture', source_url: 'https://example.com/product' } })
    expect(discovered.isError).toBe(false)
    expect(discovered.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('mcp__browser__browser_navigate'),
    })
    const discovery = JSON.parse((discovered.content[0] as { type: 'text'; text: string }).text) as { next: string }
    expect(discovery.next).toContain('exact rendered title')
    expect(discovery.next).toContain('browser_take_screenshot')
    expect(discovery.next).not.toContain('then mcp__browser__browser_snapshot')
    const navigate = ctx.tools.get('mcp__browser__browser_navigate')
    expect(navigate?.parameters).toMatchObject({ properties: { url: { type: 'string' } } })
    expect(ctx.tools.get('mcp__browser__browser_take_screenshot')).toBeDefined()
    const receipt = await ctx.tools.execute({ signal: new AbortController().signal, callId: callId(), name: 'mcp__browser__browser_navigate', arguments: { url: 'https://example.com/product' } })
    expect(receipt.isError).toBe(false)
    expect(receipt.content[0]).toEqual({ type: 'text', text: JSON.stringify({ outcome: 'ready', url: 'https://example.com/product', title: 'Example Product', status: 200 }) })
  }, 20_000)

  it('passes a typed recoverable source failure through the native browser receipt', async () => {
    const receipt = await ctx.tools.execute({ signal: new AbortController().signal, callId: callId(), name: 'mcp__browser__browser_navigate', arguments: { url: 'https://blocked.example/product' } })
    expect(receipt.isError).toBe(false)
    expect(receipt.content[0]).toEqual({ type: 'text', text: JSON.stringify({ outcome: 'source_blocked', url: 'https://blocked.example/product', next: 'Resolve another authoritative source.' }) })
  }, 20_000)

  it('registers discovered tools in the executing agent scope', async () => {
    const scoped = new Map<string, ToolDefinition>()
    const existingGlobal = ctx.tools.get('mcp__browser__browser_navigate')
    const agent = {
      ctx: { tools: {
        register(tool: ToolDefinition) {
          scoped.set(tool.name, tool)
          return () => { scoped.delete(tool.name) }
        },
      } },
    }
    const discovered = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: callId(),
      name: 'hivemind_browser_discover',
      arguments: {
        intent: 'capture inside a progressively restricted agent',
        operation: 'capture',
        source_url: 'https://example.com/product',
      },
      agent,
    } as never)
    expect(discovered.isError).toBe(false)
    expect(scoped.get('mcp__browser__browser_navigate')?.parameters).toMatchObject({
      properties: { url: { type: 'string' } },
    })
    const assembly = await ctx.systemPrompt.assemble({ scope: agent as never })
    expect(assembly.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'mcp__browser__browser_navigate',
      'mcp__browser__browser_snapshot',
      'mcp__browser__browser_take_screenshot',
    ]))
    const navigate = await scoped.get('mcp__browser__browser_navigate')!.execute(
      {} as never,
      { signal: new AbortController().signal, callId: callId(), agent } as never,
    )
    expect(navigate).toMatchObject({ content: [{ type: 'text', text: JSON.stringify({ outcome: 'ready', url: 'https://example.com/product', title: 'Example Product', status: 200 }) }] })
    expect(scoped.has('mcp__browser__browser_take_screenshot')).toBe(true)
    const screenshot = await scoped.get('mcp__browser__browser_take_screenshot')!.execute(
      { fullPage: 'false' } as never,
      { signal: new AbortController().signal, callId: callId(), agent } as never,
    )
    expect(screenshot).toMatchObject({ content: expect.arrayContaining([{ type: 'text', text: 'screenshot:boolean:false' }]) })
    expect(scoped.get('mcp__browser__browser_navigate')).not.toBe(existingGlobal)
    expect(ctx.tools.get('mcp__browser__browser_navigate')).toBe(existingGlobal)
  }, 20_000)
})
