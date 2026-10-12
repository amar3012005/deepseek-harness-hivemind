/** Product transport ownership; canonical results remain owned by native DSH. */
import type { Context } from '@deepseek-ai/cordis'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { z } from 'zod'
import { createMcpToolDefinition as nativeDefinition } from '@deepseek-ai/dsh-mcp-client'
export { publicToolName } from '@deepseek-ai/dsh-mcp-client/src/tools.ts'

export type McpListedTool = Awaited<ReturnType<Client['listTools']>>['tools'][number]
export interface ToolBridgeOptions {
  registrationFailure: 'throw'
  serverName: string
  toolCallTimeoutMs: number
  toolDescriptionSuffixes?: Record<string, string>
  recoverClient?: (failed: Client, signal: AbortSignal) => Promise<Client>
}
export function createStreamableHttpTransport(url: string, headers: Record<string, string>): Transport {
  const underlying = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } })
  // SDK exposes a required getter returning undefined before initialization,
  // while its Transport interface declares an exact optional string.
  const transport: Transport = {
    start: () => underlying.start(),
    send: (message, options) => underlying.send(message, options),
    close: () => underlying.close(),
    setProtocolVersion: version => underlying.setProtocolVersion(version),
  }
  underlying.onclose = () => transport.onclose?.()
  underlying.onerror = error => transport.onerror?.(error)
  underlying.onmessage = message => transport.onmessage?.(message)
  Object.defineProperty(transport, 'sessionId', { get: () => underlying.sessionId })
  return transport
}
export async function listMcpTools(client: Client): Promise<McpListedTool[]> {
  const tools: McpListedTool[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await client.listTools(cursor === undefined ? undefined : { cursor })
    tools.push(...page.tools)
    cursor = page.nextCursor
    if (cursor !== undefined) {
      if (seen.has(cursor)) throw new Error('MCP discovery repeated a pagination cursor')
      seen.add(cursor)
    }
  } while (cursor !== undefined)
  return tools
}
export function createMcpToolDefinition(client: Client, ctx: Context, name: string, rawName: string,
  description: string, inputSchema: Record<string, unknown>, outputSchema: unknown,
  taskRequired: boolean, retrySafe: boolean, options: ToolBridgeOptions) {
  return nativeDefinition(ctx, { name, rawName, description, inputSchema, outputSchema, taskRequired,
    async call(args, execution) {
      // Native DSH owns output validation; avoid the SDK's separate cached schema validator.
      const call = (active: Client) => active.request({ method: 'tools/call', params: { name: rawName, arguments: args } }, z.record(z.string(), z.unknown()),
        { signal: execution.signal, timeout: options.toolCallTimeoutMs })
      try { return await call(client) } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (execution.signal.aborted || !retrySafe || options.recoverClient === undefined
          || !(/\bSession not found\b/i.test(message) || /Streamable HTTP error.*\b(?:502|503|504)\b/i.test(message))) throw error
        return call(await options.recoverClient(client, execution.signal))
      }
    },
  })
}
