/** Progressive, native-schema access to one official Playwright MCP server. */

import { randomUUID } from 'node:crypto'
import { mountActionToolkits } from './action-toolkit.ts'
import { mountPlaywrightToolkit } from './playwright-toolkit.ts'
export { mountActionToolkits } from './action-toolkit.ts'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import '@deepseek-ai/dsh-system-prompt'
import {
  createMcpToolDefinition,
  createStreamableHttpTransport,
  listMcpTools,
  publicToolName,
} from '@deepseek-ai/dsh-mcp-client'
import type { McpListedTool, ToolBridgeOptions } from '@deepseek-ai/dsh-mcp-client'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecution, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable proof that an official browser MCP capability was revealed in one agent scope. */
    'hivemind/browser-capability-lease': {
      readonly leaseId: string
      readonly provider: string
      readonly scope: 'agent' | 'global'
      readonly operation: Operation
      readonly sourceUrl?: string
      readonly expiresAt: number
      readonly tools: readonly {
        readonly name: string
        readonly originalName: string
        readonly description: string
        readonly parameters: Record<string, unknown>
      }[]
    }
    /** Durable receipt for one bounded URL → title → screenshot capture. */
    'hivemind/browser-capture': {
      readonly captureId: string
      readonly provider: string
      readonly url: string
      readonly title?: string
      readonly status?: number
      readonly preview?: ImageAttachmentRef
    }
  }
}

export const name = 'hivemind-progressive-browser'
export const inject = ['tools', 'systemPrompt']

export interface Config {
  actionAccountId: string
  actionBrowserToken: string
  actionGatewayId: string
  actionGatewayToken: string
  url: string
  headers: Record<string, string>
  serverName: string
  cloudflareUrl: string
  cloudflareHeaders: Record<string, string>
  cloudflareServerName: string
  toolCallTimeoutMs: number
  leaseDurationMs: number
  captureSettleMs: number
}

export interface EndpointConfig {
  url: string
  headers: Record<string, string>
  serverName: string
}

export const Config: z<Config> = z.object({
  actionAccountId: z.string().default(''),
  actionBrowserToken: z.string().default(''),
  actionGatewayId: z.string().default('hivemind-prod'),
  actionGatewayToken: z.string().default(''),
  url: z.string().required(),
  headers: z.dict(String).default({}),
  serverName: z.string().default('singulance_browser'),
  cloudflareUrl: z.string().default(''),
  cloudflareHeaders: z.dict(String).default({}),
  cloudflareServerName: z.string().default('singulance_browser'),
  toolCallTimeoutMs: z.number().min(1).default(30_000),
  leaseDurationMs: z.number().min(1_000).max(30 * 60_000).default(5 * 60_000),
  captureSettleMs: z.number().min(0).max(10_000).default(1_500),
})

type Operation = 'capture' | 'inspect' | 'interact' | 'debug'
type Scope = 'new_page' | 'current_page'

interface Lease {
  id: string
  expiresAt: number
  operation: Operation
  scope: Scope
  sourceUrl?: string
  exposed: string[]
  provider: string
}

interface LeaseEventData {
  readonly leaseId: string
  readonly provider: string
  readonly operation: Operation
  readonly sourceUrl?: string
  readonly expiresAt: number
  readonly tools: readonly { readonly name: string; readonly originalName?: string }[]
}

const DIRECT_TOOLS: Record<Operation, readonly string[]> = {
  capture: ['browser_navigate', 'browser_snapshot', 'browser_take_screenshot'],
  inspect: ['browser_navigate', 'browser_snapshot'],
  // Keep the official, normal page-interaction surface available after a
  // scoped discovery. `browser_evaluate` and `browser_run_code_unsafe` stay
  // deliberately absent: they are arbitrary-code execution, not a normal
  // browser task capability.
  interact: [
    'browser_navigate', 'browser_navigate_back', 'browser_tabs', 'browser_snapshot',
    'browser_click', 'browser_drag', 'browser_drop', 'browser_hover',
    'browser_type', 'browser_fill_form', 'browser_press_key',
    'browser_select_option', 'browser_file_upload', 'browser_handle_dialog',
    'browser_resize', 'browser_close',
  ],
  debug: ['browser_navigate', 'browser_snapshot', 'browser_console_messages', 'browser_network_requests', 'browser_network_request'],
}

function object(value: JsonValue | undefined): Record<string, JsonValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('browser discovery arguments must be an object')
  return value as Record<string, JsonValue>
}

function nonEmpty(value: JsonValue | undefined, label: string, maxChars: number): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a non-empty string`)
  const output = value.trim()
  if (output.length > maxChars) throw new TypeError(`${label} exceeds ${maxChars} characters`)
  return output
}

function optionalUrl(value: JsonValue | undefined): string | undefined {
  if (value === undefined) return undefined
  const url = nonEmpty(value, 'source_url', 4_000)
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new TypeError('source_url must be an absolute HTTP(S) URL')
  return parsed.toString()
}

function operation(value: JsonValue | undefined): Operation {
  if (!['capture', 'inspect', 'interact', 'debug'].includes(String(value))) throw new TypeError('operation must be capture, inspect, interact, or debug')
  return value as Operation
}

function scope(value: JsonValue | undefined): Scope {
  if (value === undefined) return 'new_page'
  if (value !== 'new_page' && value !== 'current_page') throw new TypeError('scope must be new_page or current_page')
  return value
}

function nowLease(
  operation: Operation,
  scope: Scope,
  sourceUrl: string | undefined,
  exposed: string[],
  duration: number,
  provider: string,
): Lease {
  return {
    id: randomUUID(), expiresAt: Date.now() + duration, operation, scope, exposed,
    provider,
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
  }
}

function isPublicHttpUrl(value: string | undefined): boolean {
  if (value === undefined) return false
  const host = new URL(value).hostname.toLowerCase()
  // Browser Run is deliberately limited to public, newly-created pages. Keep
  // intranet, loopback, link-local, and IPv6 literals on the tenant-isolated
  // self-hosted provider rather than turning this routing decision into SSRF.
  if (host === 'localhost' || host === '::1' || host === '[::1]' || host.includes(':')) return false
  if (host === '0.0.0.0' || host.startsWith('127.') || host.startsWith('10.')
    || host.startsWith('192.168.') || host.startsWith('169.254.')) return false
  const octets = host.split('.')
  const first = Number(octets[0])
  const second = Number(octets[1])
  if (octets.length === 4 && first === 172 && second >= 16 && second <= 31) return false
  return true
}

function exactTools(available: readonly McpListedTool[], desired: readonly string[], scope: Scope): McpListedTool[] {
  const byName = new Map(available.map(tool => [tool.name, tool]))
  const names = scope === 'current_page' ? desired.filter(name => name !== 'browser_navigate') : desired
  const tools = names.map(name => byName.get(name)).filter((tool): tool is McpListedTool => tool !== undefined)
  if (tools.length === 0) throw new Error('the official browser MCP server did not advertise the required tools')
  return tools
}

function asLeaseEvent(value: unknown): LeaseEventData | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.leaseId !== 'string' || typeof record.provider !== 'string'
    || !['capture', 'inspect', 'interact', 'debug'].includes(String(record.operation))
    || typeof record.expiresAt !== 'number' || !Array.isArray(record.tools)) return undefined
  const tools = record.tools.flatMap((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return []
    const tool = item as Record<string, unknown>
    if (typeof tool.name !== 'string') return []
    return [{ name: tool.name, ...(typeof tool.originalName === 'string' ? { originalName: tool.originalName } : {}) }]
  })
  if (tools.length === 0) return undefined
  return {
    leaseId: record.leaseId,
    provider: record.provider,
    operation: record.operation as Operation,
    ...(typeof record.sourceUrl === 'string' ? { sourceUrl: record.sourceUrl } : {}),
    expiresAt: record.expiresAt,
    tools,
  }
}

function screenshotArguments(args: unknown): unknown {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return args
  const value = { ...args } as Record<string, unknown>
  // Some economical OpenAI-compatible models emit JSON boolean literals as
  // strings. Accept only the two lossless spellings at this provider boundary;
  // the model-visible schema remains the original MCP schema.
  if (value.fullPage === 'false') value.fullPage = false
  if (value.fullPage === 'true') value.fullPage = true
  return value
}

function navigateArguments(args: unknown, sourceUrl: string | undefined): unknown {
  if (sourceUrl === undefined || typeof args !== 'object' || args === null || Array.isArray(args)) return args
  const value = { ...args } as Record<string, unknown>
  // Discovery already resolved and authorized this exact URL. Reuse it when a
  // model calls the revealed navigate tool without repeating the field.
  if (typeof value.url !== 'string' || value.url.trim() === '') value.url = sourceUrl
  return value
}

function textBlocks(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || !('content' in value)) return []
  const content = (value as { content?: unknown }).content
  if (!Array.isArray(content)) return []
  return content.flatMap(block => typeof block === 'object' && block !== null
    && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string'
    ? [(block as { text: string }).text]
    : [])
}

function imageAttachment(value: unknown): ImageAttachmentRef | undefined {
  if (typeof value !== 'object' || value === null || !('content' in value)) return undefined
  const content = (value as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const item = block as { type?: unknown; attachment?: unknown }
    if (item.type === 'image' && typeof item.attachment === 'object' && item.attachment !== null) return item.attachment as ImageAttachmentRef
  }
  return undefined
}

function navigationFacts(value: unknown, fallbackUrl: string): { url: string; title?: string; status?: number } {
  for (const text of textBlocks(value)) {
    try {
      const parsed = JSON.parse(text) as { url?: unknown; title?: unknown; status?: unknown }
      return {
        url: typeof parsed.url === 'string' ? parsed.url : fallbackUrl,
        ...(typeof parsed.title === 'string' && parsed.title.trim() !== '' ? { title: parsed.title } : {}),
        ...(typeof parsed.status === 'number' ? { status: parsed.status } : {}),
      }
    } catch { /* A browser provider may return plain text; retain the requested URL. */ }
  }
  return { url: fallbackUrl }
}

/**
 * A compact discovery tool is the only browser tool initially visible. It
 * exposes original official MCP definitions afterward; it never wraps actions
 * in a generic execute schema or asks the model to invent selectors.
 */
export function apply(ctx: Context, config: Partial<Config> = {}): void {
  mountPlaywrightToolkit(ctx, config.url ?? '', config.headers ?? {})
  mountActionToolkits(ctx, { accountId: config.actionAccountId ?? '', browserToken: config.actionBrowserToken ?? '', gatewayId: config.actionGatewayId ?? 'hivemind-prod', gatewayToken: config.actionGatewayToken ?? '' })
  const resolved: Config = {
    actionAccountId: config.actionAccountId ?? '', actionBrowserToken: config.actionBrowserToken ?? '', actionGatewayId: config.actionGatewayId ?? 'hivemind-prod', actionGatewayToken: config.actionGatewayToken ?? '',
    url: config.url ?? '', headers: config.headers ?? {}, serverName: config.serverName ?? 'singulance_browser',
    cloudflareUrl: config.cloudflareUrl ?? '', cloudflareHeaders: config.cloudflareHeaders ?? {}, cloudflareServerName: config.cloudflareServerName ?? 'singulance_browser',
    toolCallTimeoutMs: config.toolCallTimeoutMs ?? 30_000, leaseDurationMs: config.leaseDurationMs ?? 5 * 60_000,
    captureSettleMs: config.captureSettleMs ?? 1_500,
  }
  if (resolved.url === '') throw new Error('hivemind-progressive-browser.url is required')

  const local: EndpointConfig = { url: resolved.url, headers: resolved.headers, serverName: resolved.serverName }
  const clients = new Map<string, { client: Client | undefined; connecting: Promise<Client> | undefined; endpoint: EndpointConfig }>()
  const leases = new WeakMap<object, {
    registered: Map<string, () => void>
    promptDispose?: () => void
    sessionId?: string
    lease?: Lease
  }>()
  const promptSchemasBySession = new Map<string, readonly ToolSchema[]>()
  const promptSchemasByAgent = new WeakMap<object, readonly ToolSchema[]>()
  const allRegistrations = new Set<() => void>()

  // ToolRuntime resolves an execution-local definition correctly, but a
  // standing preset assembly intentionally does not enumerate that local
  // registration. This provider is keyed by Cordis's assembly scope (the
  // Agent itself) and contributes only the schemas a discovery receipt put in
  // that scope. It never reveals a global MCP catalog.
  ctx.systemPrompt.tools((context) => {
    // The native Agent runtime supplies both `agent` and its scope. Diagnostic
    // assembly and lightweight test hosts supply only `scope`. They are two
    // object identities for the same session in a few Cordis boundaries, so
    // resolve the durable session key from either rather than depending on a
    // particular request-assembly representation.
    const scopedAgent = context.scope as Partial<Agent> | undefined
    const agent = context.agent ?? scopedAgent
    const sessionId = agent?.session?.id
    return {
      schemas: sessionId === undefined
        ? agent === undefined ? [] : [...promptSchemasByAgent.get(agent) ?? []]
        : [...promptSchemasBySession.get(sessionId) ?? []],
    }
  })

  const connect = async (endpoint: EndpointConfig): Promise<Client> => {
    const key = `${endpoint.serverName}:${endpoint.url}`
    const state = clients.get(key) ?? { endpoint, client: undefined, connecting: undefined }
    clients.set(key, state)
    if (state.client !== undefined) return state.client
    if (state.connecting !== undefined) return state.connecting
    state.connecting = (async () => {
      const next = new Client({ name: 'dsh-progressive-browser', version: '0.1.0' }, { capabilities: {} })
      try {
        await next.connect(createStreamableHttpTransport(endpoint.url, endpoint.headers))
        next.onclose = () => { if (state.client === next) state.client = undefined }
        state.client = next
        return next
      } catch (error) {
        await next.close().catch(() => {})
        throw error
      } finally {
        state.connecting = undefined
      }
    })()
    return state.connecting
  }

  const bridgeOptions = (endpoint: EndpointConfig): ToolBridgeOptions => ({
    registrationFailure: 'throw',
    serverName: endpoint.serverName,
    toolCallTimeoutMs: resolved.toolCallTimeoutMs,
    toolDescriptionSuffixes: {},
    recoverClient: async (failed, signal) => {
      if (signal.aborted) throw new Error('browser recovery canceled')
      const state = clients.get(`${endpoint.serverName}:${endpoint.url}`)
      if (state?.client === failed) {
        state.client = undefined
        await failed.close().catch(() => {})
      }
      return connect(endpoint)
    },
  })

  const unregister = (state: {
    registered: Map<string, () => void>
    promptDispose?: () => void
    sessionId?: string
  }): void => {
    for (const dispose of state.registered.values()) {
      dispose()
      allRegistrations.delete(dispose)
    }
    state.registered = new Map()
    state.promptDispose?.()
    delete state.promptDispose
    if (state.sessionId !== undefined) promptSchemasBySession.delete(state.sessionId)
  }

  const recordLease = (
    agent: ToolExecution['agent'] | undefined,
    lease: Lease,
    selected: readonly McpListedTool[],
  ): void => {
    agent?.session?.append('hivemind/browser-capability-lease', {
      leaseId: lease.id,
      provider: lease.provider,
      scope: agent === undefined ? 'global' : 'agent',
      operation: lease.operation,
      expiresAt: lease.expiresAt,
      ...(lease.sourceUrl === undefined ? {} : { sourceUrl: lease.sourceUrl }),
      tools: selected.map(tool => ({
        name: publicToolName(lease.provider, tool.name),
        originalName: tool.name,
        description: tool.description ?? tool.name,
        parameters: structuredClone(tool.inputSchema),
      })),
    })
  }

  const shouldUseLocalFallback = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error)
    // Do not replay invalid inputs or policy failures. These signatures are the
    // provider/session failures observed from Browser Run and are safe to retry
    // for the read-only public capture/inspection capability.
    return /(?:\b5\d\d\b|worker threw exception|unable to create new browser|streamable http|fetch failed|network error|econn)/i
      .test(message)
  }

  /**
   * Execute a bounded capture internally through the original MCP methods.
   * This keeps the model-facing contract small without replacing the native
   * browser lane: interactions and diagnostics still use discovery plus the
   * exact original schemas.
   */
  const capturePage = async (sourceUrl: string, execution: ToolRunContext): Promise<{
    provider: string
    url: string
    title?: string
    status?: number
    preview?: ImageAttachmentRef
  }> => {
    const cloudflareEligible = resolved.cloudflareUrl !== '' && isPublicHttpUrl(sourceUrl)
    let endpoint: EndpointConfig = cloudflareEligible
      ? { url: resolved.cloudflareUrl, headers: resolved.cloudflareHeaders, serverName: resolved.cloudflareServerName }
      : local
    // Execute the two original MCP operations internally rather than asking
    // the model to discover and call each mechanical operation separately.
    const call = async (target: EndpointConfig) => {
      const client = await connect(target)
      const available = await listMcpTools(client)
      const selected = exactTools(available, ['browser_navigate', 'browser_take_screenshot'], 'new_page')
      const definition = (rawName: string) => {
        const tool = selected.find(item => item.name === rawName)
        if (tool === undefined) throw new Error(`the official browser MCP server did not advertise ${rawName}`)
        return createMcpToolDefinition(client, ctx, publicToolName(target.serverName, rawName), rawName, tool.description ?? rawName,
          tool.inputSchema, undefined, tool.execution?.taskSupport === 'required', tool.annotations?.readOnlyHint === true, bridgeOptions(target))
      }
      const navigation = await definition('browser_navigate').execute({ url: sourceUrl }, execution)
      if (resolved.captureSettleMs > 0) await new Promise(resolve => setTimeout(resolve, resolved.captureSettleMs))
      const screenshotTool = definition('browser_take_screenshot')
      const screenshot = await screenshotTool.execute({}, execution)
      const screenshotValue = screenshot as JsonValue
      // We invoke the official MCP tools internally to keep this common path
      // to one model-visible receipt. That bypasses ToolRuntime's normal
      // completion hook, which is where raw MCP image bytes are admitted into
      // the durable attachment store. Run the definition's own finalizer with
      // its canonical fallback projection before extracting the image.
      const fallback = screenshotTool.output.render({}, screenshotValue)
      const content = screenshotTool.finalizeContent?.(execution, {
        isError: false,
        value: screenshotValue,
        content: fallback,
      }) ?? fallback
      const preview = imageAttachment({ content })
      return {
        provider: target.serverName, ...navigationFacts(navigation, sourceUrl),
        ...(preview === undefined ? {} : { preview }),
      }
    }
    try {
      return await call(endpoint)
    } catch (error) {
      if (!cloudflareEligible || !shouldUseLocalFallback(error)) throw error
      endpoint = local
      return call(endpoint)
    }
  }

  const guard = (
    definition: ToolDefinition,
    rawName: string,
    state: { lease?: Lease },
    fallback: (() => Promise<ToolDefinition>) | undefined,
    selected: readonly McpListedTool[],
  ): ToolDefinition => ({
    ...definition,
    async execute(args, execution) {
      if (state.lease === undefined || Date.now() >= state.lease.expiresAt || !state.lease.exposed.includes(rawName)) {
        throw new Error('browser capability lease expired; call hivemind_browser_discover again before continuing')
      }
      if (rawName === 'browser_take_screenshot' && resolved.captureSettleMs > 0) {
        await new Promise(resolve => setTimeout(resolve, resolved.captureSettleMs))
      }
      const input = rawName === 'browser_take_screenshot'
        ? screenshotArguments(args)
        : rawName === 'browser_navigate'
          ? navigateArguments(args, state.lease.sourceUrl)
          : args
      let value: Awaited<ReturnType<ToolDefinition['execute']>>
      try {
        value = await definition.execute(input, execution)
      } catch (error) {
        if (fallback === undefined || !shouldUseLocalFallback(error)) throw error
        // Browser Run is preferred for public pages, but it can fail after a
        // successful discovery when it cannot allocate a browser. Re-bind this
        // same official tool to the existing local Playwright provider and keep
        // the lease durable so the following Harness continuation stays there.
        value = await (await fallback()).execute(input, execution)
        state.lease.provider = local.serverName
        recordLease(execution.agent, state.lease, selected)
      }
      state.lease.expiresAt = Date.now() + resolved.leaseDurationMs
      return value
    },
  })

  const expose = async (owner: object, registry: Context['tools'], selected: McpListedTool[], nextLease: Lease, endpoint: EndpointConfig, agent = undefined as ToolExecution['agent']): Promise<void> => {
    const liveClient = await connect(endpoint)
    const state = leases.get(owner) ?? { registered: new Map<string, () => void>() }
    unregister(state)
    const next = new Map<string, () => void>()
    try {
      for (const tool of selected) {
        const publicName = publicToolName(endpoint.serverName, tool.name)
        const definition = createMcpToolDefinition(
          liveClient, ctx, publicName, tool.name, tool.description ?? tool.name,
          tool.inputSchema, undefined, tool.execution?.taskSupport === 'required',
          tool.annotations?.readOnlyHint === true, bridgeOptions(endpoint),
        )
        const fallback = endpoint.serverName === resolved.cloudflareServerName
          ? async () => createMcpToolDefinition(
            await connect(local), ctx, publicName, tool.name, tool.description ?? tool.name,
            tool.inputSchema, undefined, tool.execution?.taskSupport === 'required',
            tool.annotations?.readOnlyHint === true, bridgeOptions(local),
          )
          : undefined
        const dispose = registry.register(guard(definition, tool.name, state, fallback, selected))
        next.set(publicName, dispose)
        allRegistrations.add(dispose)
      }
    } catch (error) {
      for (const dispose of next.values()) {
        dispose()
        allRegistrations.delete(dispose)
      }
      throw error
    }
    state.registered = next
    if (agent !== undefined) {
      const schemas = selected.map(tool => ({
        name: publicToolName(endpoint.serverName, tool.name),
        description: tool.description ?? tool.name,
        parameters: structuredClone(tool.inputSchema),
      }))
      // The MCP definitions execute in this agent scope. Its prompt provider
      // must be mounted on the same Cordis scope: a global provider cannot
      // reliably identify an agent reconstructed for the next turn. The
      // session-keyed global fallback below supports diagnostic assemblers.
      const scopedPrompt = (agent.ctx as Partial<Context>).systemPrompt
      if (scopedPrompt !== undefined) {
        state.promptDispose = scopedPrompt.tools(() => ({ schemas }))
      }
      const sessionId = (agent as Partial<Agent>).session?.id
      if (sessionId === undefined) promptSchemasByAgent.set(agent, schemas)
      else {
        state.sessionId = sessionId
        promptSchemasBySession.set(sessionId, schemas)
      }
    }
    state.lease = nextLease
    leases.set(owner, state)
  }

  // Native Harness may rebuild an agent scope between a tool result and the
  // continuation that consumes it. The lease is therefore durable state, not
  // merely a registration on the previous scope. Rehydrate only the exact
  // tools the discovery receipt granted; never relist the complete browser
  // catalog into a later request.
  const restoredAgents = new WeakSet<object>()
  const restoreLease = async (agent: Agent): Promise<void> => {
    if (restoredAgents.has(agent)) return
    const events = agent.session.snapshotEvents() as ReadonlyArray<{ readonly type: string; readonly data: unknown }>
    const event = events.findLast(item => item.type === 'hivemind/browser-capability-lease')
    const persisted = asLeaseEvent(event?.data)
    if (persisted === undefined || Date.now() >= persisted.expiresAt) return
    const endpoint = persisted.provider === resolved.cloudflareServerName && resolved.cloudflareUrl !== ''
      ? { url: resolved.cloudflareUrl, headers: resolved.cloudflareHeaders, serverName: resolved.cloudflareServerName }
      : persisted.provider === local.serverName ? local : undefined
    if (endpoint === undefined) return
    const rawNames = persisted.tools.map(tool => tool.originalName ?? tool.name.split('__').at(-1) ?? '').filter(Boolean)
    const selected = exactTools(await listMcpTools(await connect(endpoint)), rawNames, persisted.sourceUrl === undefined ? 'current_page' : 'new_page')
    const lease: Lease = {
      id: persisted.leaseId,
      expiresAt: persisted.expiresAt,
      operation: persisted.operation,
      scope: persisted.sourceUrl === undefined ? 'current_page' : 'new_page',
      exposed: rawNames,
      provider: endpoint.serverName,
      ...(persisted.sourceUrl === undefined ? {} : { sourceUrl: persisted.sourceUrl }),
    }
    await expose(agent, agent.ctx.tools, selected, lease, endpoint, agent)
    restoredAgents.add(agent)
  }

  // Prompt assembly happens before `agent/pre-step` in the native Cordis
  // driver. Restoring only in that later hook leaves the first continuation
  // after discovery without callable browser schemas, even though the durable
  // lease exists. Restore at the beginning of prompt assembly so the native
  // scope registration and its schema are present in the very request that
  // follows discovery. Keep the pre-step hook below as a harmless execution
  // boundary backstop for agents reconstructed by another runtime surface.
  ctx.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
    if (agent !== undefined) await restoreLease(agent)
    return next()
  })

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    await restoreLease(agent)
    return next()
  })

  ctx.effect(() => () => {
    for (const dispose of allRegistrations) dispose()
    allRegistrations.clear()
    for (const state of clients.values()) void state.client?.close().catch(() => {})
    clients.clear()
  }, 'hivemind-progressive-browser.lifecycle')

  ctx.tools.register(defineTool({
    name: 'hivemind_browser_capture',
    description: 'Capture a public page at an already-known absolute URL and return its final URL, exact rendered title, HTTP status, and screenshot preview. This tool DOES NOT return readable page body text and CANNOT verify product, pricing, compliance, or positioning claims. Use it only for screenshots or titles. For claims requiring first-party page text, lease the browser capability and use hivemind_browser_discover with inspect to obtain the native browser snapshot, or use a source-reading research receipt. If the exact page URL is unknown but an official site origin is known, discover that root and inspect internal links; never invent a path.',
    parameters: {
      source_url: { type: 'string', required: true, description: 'Exact absolute HTTP(S) URL supplied by the user or an authoritative preceding research result.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [
        { type: 'text' as const, text: `Browser capture complete. URL: ${value.url}. Exact title: ${value.title ?? '(not supplied by page)'}. HTTP status: ${value.http_status ?? '(not supplied by provider)'}. Provider: ${value.provider}.${value.screenshot_attachment_id === undefined ? ' Screenshot is attached.' : ` Screenshot attachment id: ${value.screenshot_attachment_id}.`} No page body text was extracted; this receipt does not verify page claims. Do not repeat capture unless the user asks for a refresh. If source text is needed, use hivemind_browser_discover with inspect or another source-reading tool.` },
        ...(value.preview === undefined ? [] : [{ type: 'image' as const, attachment: value.preview as unknown as ImageAttachmentRef }]),
      ],
    },
    isConcurrencySafe: () => false,
    async execute(args, execution) {
      const sourceUrl = optionalUrl(args.source_url)
      if (sourceUrl === undefined) throw new Error('source_url is required')
      const captured = await capturePage(sourceUrl, execution)
      const captureId = randomUUID()
      execution.agent?.session.append('hivemind/browser-capture', {
        captureId, provider: captured.provider, url: captured.url,
        ...(captured.title === undefined ? {} : { title: captured.title }),
        ...(captured.status === undefined ? {} : { status: captured.status }),
        ...(captured.preview === undefined ? {} : { preview: captured.preview }),
      })
      return {
        status: 'completed', capture_id: captureId, provider: captured.provider, url: captured.url,
        ...(captured.title === undefined ? {} : { title: captured.title }),
        ...(captured.status === undefined ? {} : { http_status: captured.status }),
        // `output.render()` needs the original attachment reference, not a
        // serialised receipt summary. Passing only its metadata makes the
        // result text claim that a screenshot is attached while the native
        // conversation renderer has no attachment it can resolve.
        ...(captured.preview === undefined ? {} : {
          screenshot_attachment_id: captured.preview.attachmentId,
          preview: captured.preview as unknown as JsonValue,
        }),
      }
    },
    presentCall(args) { return { card: 'generic', title: 'Capture browser page', kind: 'read', rawInput: String(args.source_url ?? '') } },
  }))

  ctx.tools.register(defineTool({
    name: 'hivemind_browser_discover',
    description: 'Progressively expose the exact original Playwright MCP tools needed for one browser task. Use this before complex browser work. URL policy: use an exact URL supplied by the user; when only an unambiguous official site origin is known, navigate that root and inspect/click internal links to locate the requested page; never invent a path. If the site origin itself is unknown or the target is ambiguous, ask the user for a URL instead of spending a research/search call to guess one. Use governed research only when the user asks for external evidence, not as a browser-URL fallback. Choose operation based on the outcome: capture for a screenshot, inspect for rendered facts, interact for page controls, debug for browser diagnostics. Public capture and inspection automatically use the managed Cloudflare browser provider when configured; authenticated, private, interaction, and debug work remain on the self-hosted provider. This returns direct native browser tools with their official schemas; never guess selectors or use arbitrary scripts.',
    parameters: {
      intent: { type: 'string', required: true, description: 'The complete natural-language browser outcome.' },
      operation: { type: 'string', required: true, enum: ['capture', 'inspect', 'interact', 'debug'], description: 'The browser work category inferred from the user request.' },
      source_url: { type: 'string', description: 'Exact absolute URL from the user or a preceding authoritative web/research result.' },
      scope: { type: 'string', enum: ['new_page', 'current_page'], description: 'Use current_page only when the request explicitly refers to an already-open page.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => false,
    async execute(args, execution): Promise<Record<string, JsonValue>> {
      const input = object(args as JsonValue)
      const intent = nonEmpty(input.intent, 'intent', 8_000)
      const requestedOperation = operation(input.operation)
      const requestedScope = scope(input.scope)
      const sourceUrl = optionalUrl(input.source_url)
      if (requestedScope === 'new_page' && sourceUrl === undefined) {
        return {
          status: 'source_resolution_required', intent, operation: requestedOperation,
          next: 'Ask the user for an exact URL or an unambiguous official site origin. Do not use research/search to guess a page path. If a known official origin becomes available, call hivemind_browser_discover with that root URL, navigate it, take a snapshot, and follow an observed internal link.',
        }
      }
      const cloudflareEligible = resolved.cloudflareUrl !== '' && requestedScope === 'new_page'
        && isPublicHttpUrl(sourceUrl) && (requestedOperation === 'capture' || requestedOperation === 'inspect')
      let endpoint: EndpointConfig = cloudflareEligible
        ? { url: resolved.cloudflareUrl, headers: resolved.cloudflareHeaders, serverName: resolved.cloudflareServerName }
        : local
      let available: readonly McpListedTool[]
      try {
        available = await listMcpTools(await connect(endpoint))
      } catch (error) {
        // Public read work should prefer Browser Run, but a provider outage must
        // not strand an otherwise safe screenshot or rendered-page request.
        // The self-hosted MCP is the existing tenant-isolated fallback; writes,
        // private browsing, and interaction already select it above.
        if (!cloudflareEligible) throw error
        endpoint = local
        available = await listMcpTools(await connect(endpoint))
      }
      const selected = exactTools(available, DIRECT_TOOLS[requestedOperation], requestedScope)
      const nextLease = nowLease(
        requestedOperation,
        requestedScope,
        sourceUrl,
        selected.map(tool => tool.name),
        resolved.leaseDurationMs,
        endpoint.serverName,
      )
      const owner = execution.agent ?? ctx
      const registry = execution.agent?.ctx.tools ?? ctx.tools
      await expose(owner, registry, selected, nextLease, endpoint, execution.agent)
      const toolName = (rawName: string) => publicToolName(endpoint.serverName, rawName)
      // This receipt proves the scope that owns the newly revealed native
      // tools. It is deliberately compact: the model already receives the
      // tool list below, while the durable event lets the operating UI and
      // capability coordinator diagnose an invalid projection without
      // exposing provider details or replaying a full MCP catalog.
      recordLease(execution.agent, nextLease, selected)
      return {
        status: 'ready', lease_id: nextLease.id, operation: requestedOperation, source_url: sourceUrl ?? null, provider: endpoint.serverName,
        tools: selected.map(tool => ({ name: publicToolName(endpoint.serverName, tool.name), original_name: tool.name, description: tool.description ?? '' })),
        next: requestedScope === 'new_page'
          ? requestedOperation === 'capture'
            ? `Use ${toolName('browser_navigate')} with source_url and retain its exact rendered title, then call ${toolName('browser_take_screenshot')} without fullPage for a normal viewport capture. Do not take a snapshot unless the navigate receipt omits the title or a later interaction needs fresh element references.`
            : `Use ${toolName('browser_navigate')} with source_url, then ${toolName('browser_snapshot')} before any selector-based interaction.`
          : `Use the returned native browser tools against the current page. Take a fresh ${toolName('browser_snapshot')} before any selector-based interaction.`,
      }
    },
    presentCall() { return { card: 'generic', title: 'Discover browser tools', kind: 'read' } },
  }))
}
