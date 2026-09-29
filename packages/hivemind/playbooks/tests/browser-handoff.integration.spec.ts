import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { z } from 'zod'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply as applyBrowser } from '../../progressive-browser/src/index.ts'
import { apply as applyPlaybooks } from '../src/index.ts'

let server: Server
let url: string

beforeAll(async () => {
  server = createServer((request, response) => {
    const mcp = new McpServer({ name: 'browser-handoff', version: '1.0.0' }, { capabilities: { tools: {} } })
    const registerTool = mcp.registerTool.bind(mcp) as (name: string, config: unknown, handler: (...args: never[]) => unknown) => unknown
    registerTool('browser_navigate', { description: 'Navigate.', inputSchema: { url: z.string() } }, async ({ url }: { url: string }) => ({ content: [{ type: 'text', text: `navigated ${url}` }] }))
    registerTool('browser_snapshot', { description: 'Read the rendered document.', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'Example Domain' }] }))
    registerTool('browser_take_screenshot', { description: 'Capture a screenshot.', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'image receipt' }] }))
    const transport = new StreamableHTTPServerTransport({})
    response.on('close', () => { void transport.close(); void mcp.close() })
    void mcp.connect(transport as Transport).then(() => transport.handleRequest(request, response))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture did not bind TCP')
  url = `http://127.0.0.1:${address.port}/mcp`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
})

describe('HyperAgents progressive browser handoff', () => {
  it('projects and executes discovered native browser tools in the next model step', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    applyBrowser(ctx, { url, headers: {}, serverName: 'singulance_browser', toolCallTimeoutMs: 5_000, leaseDurationMs: 60_000, captureSettleMs: 0 })
    let beforePlaybookTools: string[] = []
    ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      beforePlaybookTools = assembly.tools.map(tool => tool.name)
      const result = await next()
      return result
    })
    // Playbooks only reads memory when an operating-context tool is called;
    // the browser handoff itself must work without company retrieval.
    applyPlaybooks(ctx as never, { progressiveToolDisclosure: true })
    const events: Array<{ type: string; data: unknown }> = []
    const agent = {
      session: {
        id: 'browser-handoff',
        append(type: string, data: unknown) { events.push({ type, data }); return { seq: events.length } },
        snapshotEvents() { return events },
      },
    } as unknown as Agent
    let scope!: ReturnType<typeof createScope>
    await ctx.plugin(Object.assign((inner: Context) => {
      scope = createScope(inner, agent)
    }, { inject: ['systemPrompt', 'tools'] }))
    ;(agent as unknown as { ctx: Context }).ctx = scope.ctx.extend({ agent })

    await ctx.systemPrompt.assemble({ agent, scope: agent })
    const browserLane = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'browser-handoff-lease' as never,
      name: 'hivemind_capabilities',
      arguments: { operation: 'lease', capabilities: ['browser'] },
      agent,
    })
    expect(browserLane.isError, JSON.stringify(browserLane)).toBe(false)
    const discovery = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'browser-handoff-discovery' as never,
      name: 'hivemind_browser_discover',
      arguments: { intent: 'capture the exact page title', operation: 'capture', source_url: 'https://example.com/' },
      agent,
    })
    expect(discovery.isError, JSON.stringify(discovery)).toBe(false)
    const lease = events.find(event => event.type === 'hivemind/browser-capability-lease')
    expect(lease?.data).toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({ name: 'mcp__singulance_browser__browser_navigate', parameters: expect.objectContaining({ type: 'object' }) }),
        expect.objectContaining({ name: 'mcp__singulance_browser__browser_snapshot', parameters: expect.objectContaining({ type: 'object' }) }),
      ]),
    })
    expect(ctx.tools.schemas(agent).map(tool => tool.name)).toEqual(expect.arrayContaining([
      'mcp__singulance_browser__browser_navigate',
      'mcp__singulance_browser__browser_snapshot',
    ]))

    const continuation = await ctx.systemPrompt.assemble({ agent, scope: agent })
    expect(beforePlaybookTools).toEqual(expect.arrayContaining([
      'mcp__singulance_browser__browser_navigate',
      'mcp__singulance_browser__browser_snapshot',
    ]))
    expect(continuation.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'mcp__singulance_browser__browser_navigate',
      'mcp__singulance_browser__browser_snapshot',
      'mcp__singulance_browser__browser_take_screenshot',
    ]))
    expect(continuation.tools.map(tool => tool.name)).not.toContain('hivemind_browser_discover')
    const snapshot = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'browser-handoff-snapshot' as never,
      name: 'mcp__singulance_browser__browser_snapshot',
      arguments: {},
      agent,
    })
    expect(snapshot.isError, JSON.stringify(snapshot)).toBe(false)
    expect(snapshot.content).toEqual([{ type: 'text', text: 'Example Domain' }])
    await ctx.fiber.dispose()
  }, 20_000)
})
