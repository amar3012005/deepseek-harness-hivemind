/** Native skill loading over the official tools advertised by the configured Playwright MCP server. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { createMcpToolDefinition, createStreamableHttpTransport, listMcpTools } from '@deepseek-ai/dsh-mcp-client'
import { randomUUID } from 'node:crypto'

/** Register only a provider connection and native loading hooks; tools remain scoped to the requesting agent. */
export function mountPlaywrightToolkit(ctx: Context, url: string, headers: Record<string, string>): void {
  if (!url) return
  const states = new WeakMap<Agent, { client: Client; schemas: ToolSchema[] }>()
  const clients = new Set<Client>()
  const disposers = new Set<() => void>()
  const load = async (agent: Agent, persist = true): Promise<void> => {
    if (states.has(agent)) return
    const client = new Client({ name: 'hivemind-playwright-toolkit', version: '1.0.0' })
    await client.connect(createStreamableHttpTransport(url, headers))
    clients.add(client)
    const tools = await listMcpTools(client)
    if (!tools.length) throw new Error('The Playwright server returned no tools')
    const schemas: ToolSchema[] = []
    const registrations: (() => void)[] = []
    try {
      for (const tool of tools) {
        const definition = createMcpToolDefinition(client, agent.ctx, tool.name, tool.name,
          tool.description ?? tool.name, tool.inputSchema, undefined,
          tool.execution?.taskSupport === 'required', tool.annotations?.readOnlyHint === true,
          { registrationFailure: 'throw', serverName: 'playwright-action-toolkit', toolCallTimeoutMs: 60000 })
        const dispose = agent.ctx.tools.register(definition)
        registrations.push(dispose)
        schemas.push({ name: tool.name, description: tool.description ?? tool.name, parameters: structuredClone(tool.inputSchema) })
      }
      const dispose = agent.ctx.systemPrompt.tools(() => ({ schemas }))
      registrations.push(dispose)
    } catch (error) {
      for (const dispose of registrations) dispose()
      await client.close().catch(() => {})
      clients.delete(client)
      throw error
    }
    for (const dispose of registrations) disposers.add(dispose)
    states.set(agent, { client, schemas })
    if (persist) agent.session.append('hivemind/browser-capability-lease', {
      leaseId: randomUUID(), provider: 'playwright-action-toolkit', scope: 'agent', operation: 'interact',
      expiresAt: Date.now() + 30 * 60 * 1000,
      tools: schemas.map(tool => ({ name: tool.name, originalName: tool.name,
        description: tool.description, parameters: tool.parameters })),
    })
  }
  ctx.on('tools/post-execute', async (execution, result, next) => {
    const decision = await next()
    if (execution.name === 'skill' && execution.agent && !result.isError && decision.kind === 'accept' &&
      result.value && typeof result.value === 'object' && !Array.isArray(result.value) && result.value.name === 'playwright-browser') {
      await load(execution.agent)
    }
    return decision
  })
  ctx.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
    if (agent && !states.has(agent)) {
      const receipt = agent.session.snapshotEvents().findLast(event => event.type === 'hivemind/browser-capability-lease' &&
        event.data.provider === 'playwright-action-toolkit')
      if (receipt?.type === 'hivemind/browser-capability-lease' && receipt.data.expiresAt > Date.now()) await load(agent, false)
    }
    return next()
  })
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
    for (const client of clients) void client.close().catch(() => {})
  }, 'hivemind-playwright-toolkit.lifecycle')
}
