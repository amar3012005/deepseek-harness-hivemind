/** Exact Cloudflare Think action contracts, progressively mounted in the requesting agent. */
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import '@deepseek-ai/dsh-attachment'
import { actionContracts, executeAction, type ActionConfig } from './cloudflare-actions.ts'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/cordis' {
  interface Context {
    hivemindActionToolkits: { load(agent: Agent, skill: string): Promise<readonly string[]> }
  }
}

const groups: Record<string, readonly string[]> = {
  'browser-use': ['browser_markdown', 'browser_extract', 'browser_links', 'browser_scrape', 'browser_capture'],
  'parallel-search': ['parallel_search'],
}

/** Reuse the MCP finalizer so PNG results enter native durable attachment storage. */
export function mountActionToolkits(ctx: Context, config: ActionConfig): void {
  if (!config.accountId || !config.browserToken) return
  const states = new WeakMap<Agent, { names: Set<string>; schemas: ToolSchema[]; disposers: (() => void)[] }>()
  const disposers = new Set<() => void>()
  const load = async (agent: Agent, skill: string, persist = true): Promise<readonly string[]> => {
    const names = groups[skill]
    if (!names) return []
    let state = states.get(agent)
    if (!state) {
      state = { names: new Set(), schemas: [], disposers: [] }
      states.set(agent, state)
      const current = state
      const dispose = agent.ctx.systemPrompt.tools(() => ({ schemas: current.schemas }))
      disposers.add(dispose)
    }
    const listed = actionContracts
    const selected = names.map((name) => {
      const tool = listed.find(candidate => candidate.name === name)
      if (!tool) throw new Error(`Cloudflare action toolkit is missing ${name}`)
      return tool
    })
    for (const tool of selected) {
      if (state.names.has(tool.name)) continue
      const definition: ToolDefinition = {
        name: tool.name, description: tool.description, parameters: tool.parameters,
        output: {
          schema: { type: 'object', additionalProperties: true, properties: {} },
          render: (_args, value) => [
            { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) },
            ...(value && typeof value === 'object' && !Array.isArray(value) && value.preview ? [{ type: 'image' as const, attachment: value.preview as unknown as ImageAttachmentRef }] : []),
          ],
        },
        isConcurrencySafe: () => true,
        async execute(input, execution) {
          if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Action arguments must be an object')
          const args = input as Record<string, JsonValue>
          const result = await executeAction(config, tool.name, args, execution.signal)
          if (result instanceof Uint8Array) {
            const store = execution.agent?.ctx.get('attachments') ?? ctx.get('attachments')
            if (!store) throw new Error('No native attachment store is mounted')
            const [preview] = await store.saveImages([{ data: result, mediaType: 'image/png', name: String(args.title ?? 'Website screenshot') + '.png' }])
            if (!preview) throw new Error('Screenshot storage did not return a receipt')
            return { id: preview.attachmentId, url: args.url, title: args.title ?? 'Website screenshot', contentType: 'image/png', preview: preview as unknown as JsonValue }
          }
          return result
        },
      }
      const dispose = agent.ctx.tools.register(definition)
      disposers.add(dispose)
      state.disposers.push(dispose)
      state.names.add(tool.name)
      state.schemas.push({ name: tool.name, description: tool.description ?? tool.name, parameters: structuredClone(tool.parameters) })
    }
    if (persist) agent.session.append('hivemind/browser-capability-lease', {
      leaseId: randomUUID(), provider: 'cloudflare-action-toolkit', scope: 'agent', operation: 'inspect',
      expiresAt: Date.now() + 30 * 60 * 1000,
      tools: state.schemas.map(tool => ({ name: tool.name, originalName: tool.name,
        description: tool.description, parameters: tool.parameters })),
    })
    return names
  }
  ctx.provide('hivemindActionToolkits', { load })
  ctx.on('tools/post-execute', async (execution, result, next) => {
    const decision = await next()
    if (execution.name === 'skill' && execution.agent && !result.isError && decision.kind === 'accept' && result.value && typeof result.value === 'object' && !Array.isArray(result.value)) {
      const skill = result.value.name
      if (typeof skill === 'string' && groups[skill]) await load(execution.agent, skill)
    }
    return decision
  })
  ctx.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
    if (agent && !states.has(agent)) {
      const receipt = agent.session.snapshotEvents().findLast(event => event.type === 'hivemind/browser-capability-lease' && event.data.provider === 'cloudflare-action-toolkit')
      if (receipt?.type === 'hivemind/browser-capability-lease' && receipt.data.expiresAt > Date.now()) {
        for (const [skill, names] of Object.entries(groups)) {
          if (names.every(name => receipt.data.tools.some(tool => tool.name === name))) await load(agent, skill, false)
        }
      }
    }
    return next()
  })
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
  }, 'hivemind-action-toolkit.lifecycle')
}
