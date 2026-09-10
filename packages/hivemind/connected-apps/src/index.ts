/** Tenant-scoped progressive Composio capability for HIVE-MIND. */

import type { Context } from '@deepseek-ai/cordis'
import type { Composio } from '@composio/core'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-hivemind-identity'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'
import type { PostToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

export const name = 'hivemind-connected-apps'
export const inject = ['tools', 'hivemindIdentity']

const SEARCH_TOOL = 'mcp__composio__COMPOSIO_SEARCH_TOOLS'
const COMPOSIO_TOOL_PREFIX = 'mcp__composio__'
const CONNECTED_WORKFLOWS_SKILL = 'composio-connected-workflows'
const PLUGINS_SETTINGS_NAMESPACE = 'hivemind-plugins'
const BRIDGE_TOOL = 'hivemind_connected_task'
const META_TOOLS = new Set([
  'COMPOSIO_SEARCH_TOOLS',
  'COMPOSIO_GET_TOOL_SCHEMAS',
  'COMPOSIO_MANAGE_CONNECTIONS',
  'COMPOSIO_WAIT_FOR_CONNECTIONS',
])
const MUTATING_TOOL = /(?:SEND|CREATE|POST|PUBLISH|UPDATE|EDIT|DELETE|REMOVE|INVITE|PAY|TRANSFER|UPLOAD|WRITE|ADD|CANCEL|SCHEDULE)/i

export interface Config {
  /** Server-side Composio project credential. */
  apiKey?: string
  /** Default capability latch when the host UI has not published a setting. */
  enabledByDefault?: boolean
}

export const Config: z<Config> = z.object({
  apiKey: z.string(),
  enabledByDefault: z.boolean().default(false),
})

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap(item => typeof item === 'string' ? [item] : []) : []
}

function firstString(value: unknown, keys: readonly string[], depth = 0): string | undefined {
  if (depth > 8) return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstString(item, keys, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (!record(value)) return undefined
  for (const key of keys) {
    const found = stringValue(value[key])
    if (found !== undefined) return found
  }
  for (const item of Object.values(value)) {
    const found = firstString(item, keys, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

function connectionStatuses(value: unknown, depth = 0): Array<{ toolkit: string; connected: boolean }> {
  if (depth > 8) return []
  if (Array.isArray(value)) return value.flatMap(item => connectionStatuses(item, depth + 1))
  if (!record(value)) return []
  const toolkit = stringValue(value['toolkit']) ?? stringValue(value['toolkit_slug'])
  const hasActive = value['has_active_connection']
  if (toolkit !== undefined && typeof hasActive === 'boolean') return [{ toolkit, connected: hasActive }]
  const status = stringValue(value['status']) ?? stringValue(value['connection_status'])
  if (toolkit !== undefined && status !== undefined) return [{ toolkit, connected: /^(?:active|connected)$/i.test(status) }]
  return Object.values(value).flatMap(item => connectionStatuses(item, depth + 1))
}

function titleCaseToolkit(toolkit: string): string {
  return toolkit.split(/[-_\s]+/).filter(Boolean).map(part => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`).join(' ')
}

interface SearchQuery {
  use_case: string
  known_fields?: string
}

function searchQueries(value: unknown): SearchQuery[] {
  if (!Array.isArray(value)) throw new TypeError('Search requires queries with one atomic use_case per external-app action')
  const queries = value.map((item) => {
    if (!record(item)) throw new TypeError('Each search query must be an object')
    const useCase = stringValue(item['use_case'])
    if (useCase === undefined) throw new TypeError('Each search query requires a non-empty use_case')
    const knownFields = stringValue(item['known_fields'])
    return knownFields === undefined ? { use_case: useCase } : { use_case: useCase, known_fields: knownFields }
  })
  if (queries.length === 0 || queries.length > 8) throw new TypeError('Search requires between 1 and 8 atomic queries')
  return queries
}

function searchSession(value: unknown): { generate_id: true } | { id: string } {
  if (!record(value)) throw new TypeError('Search requires session: { generate_id: true } or session: { id }')
  const id = stringValue(value['id'])
  if (id !== undefined) return { id }
  if (value['generate_id'] === true) return { generate_id: true }
  throw new TypeError('Search session must generate a new id or continue an existing id')
}

function jsonScalar(value: unknown): JsonValue | undefined {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null
    ? value
    : undefined
}

function plainText(content: readonly ContentBlock[]): string | undefined {
  return content.length === 1 && content[0]?.type === 'text' ? content[0].text : undefined
}

function connectedAppsEnabled(ctx: Context, fallback: boolean): boolean {
  const section = ctx.get('settings')?.get(PLUGINS_SETTINGS_NAMESPACE)
  if (record(section) && typeof section['pluginsEnabled'] === 'boolean') return section['pluginsEnabled']
  return fallback
}

function isConnectedAppInvocation(toolName: string, args: unknown): boolean {
  return toolName === BRIDGE_TOOL
    || toolName.startsWith(COMPOSIO_TOOL_PREFIX)
    || (toolName === 'skill' && record(args) && args['name'] === CONNECTED_WORKFLOWS_SKILL)
}

function sessionKey(identity: { userId: string; orgId: string }): string {
  // Composio connected accounts are user-owned. Core and the control plane keep
  // the organization scope and policy check; changing this key would strand an
  // existing authenticated user's connected account in a new Composio identity.
  return `hivemind:${identity.userId}`
}

function copyPlanningFields(source: Record<string, unknown>, target: Record<string, JsonValue>): void {
  const steps = stringArray(source['recommended_plan_steps'])
  const pitfalls = stringArray(source['known_pitfalls'])
  const difficulty = jsonScalar(source['difficulty'])
  if (steps.length > 0) target['recommended_plan_steps'] = steps
  if (pitfalls.length > 0) target['known_pitfalls'] = pitfalls
  if (difficulty !== undefined) target['difficulty'] = difficulty
}

/** Create a bounded model-visible projection while retaining the full receipt privately. */
export function compactComposioSearchReceipt(value: unknown, receipt: SpillRef): JsonValue | undefined {
  if (!record(value)) return undefined
  const unwrapped = record(value['result']) ? value['result'] : value
  const data = record(unwrapped['data']) ? unwrapped['data'] : unwrapped
  const results = Array.isArray(data['results']) ? data['results'].flatMap((item) => {
    if (!record(item)) return []
    const result: Record<string, JsonValue> = {
      primary_tool_slugs: stringArray(item['primary_tool_slugs']),
      related_tool_slugs: stringArray(item['related_tool_slugs']),
      toolkits: stringArray(item['toolkits']),
    }
    const useCase = stringValue(item['use_case'])
    if (useCase !== undefined) result['use_case'] = useCase
    copyPlanningFields(item, result)
    return [result]
  }) : []
  const statuses = Array.isArray(data['toolkit_connection_statuses']) ? data['toolkit_connection_statuses'].flatMap((item) => {
    if (!record(item)) return []
    const toolkit = stringValue(item['toolkit'])
    if (toolkit === undefined) return []
    const status: Record<string, JsonValue> = { toolkit, has_active_connection: item['has_active_connection'] === true }
    const message = stringValue(item['status_message'])
    if (message !== undefined) status['status_message'] = message
    return [status]
  }) : []
  let session: Record<string, JsonValue> | undefined
  if (record(data['session'])) {
    session = { generate_id: data['session']['generate_id'] === true }
    const id = stringValue(data['session']['id'])
    const instructions = stringValue(data['session']['instructions'])
    if (id !== undefined) session['id'] = id
    if (instructions !== undefined) session['instructions'] = instructions
  }
  if (results.length === 0 && statuses.length === 0 && session === undefined) return undefined
  const compact: Record<string, JsonValue> = {
    success: data['success'] !== false,
    results,
    toolkit_connection_statuses: statuses,
    ...(session === undefined ? {} : { session }),
    next_steps_guidance: stringArray(data['next_steps_guidance']),
    source_receipt: { locator: receipt.locator, bytes: receipt.bytes, retrieval_hint: receipt.retrievalHint },
    schema_policy: 'Load schemas only for selected tool slugs. Execute only slugs returned by this search.',
  }
  const outerStatus = stringValue(value['status'])
  const toolkit = stringValue(value['toolkit'])
  const redirectUrl = stringValue(value['redirect_url']) ?? stringValue(value['redirectUrl'])
  const prompt = stringValue(value['prompt'])
  if (outerStatus !== undefined) compact['status'] = outerStatus
  if (toolkit !== undefined) compact['toolkit'] = toolkit
  if (redirectUrl !== undefined) compact['redirect_url'] = redirectUrl
  if (prompt !== undefined) compact['prompt'] = prompt
  copyPlanningFields(data, compact)
  return compact
}

async function saveReceipt(ctx: Context, execution: ToolExecution, content: string): Promise<SpillRef | undefined> {
  const sessionId = execution.agent?.session.header.id
  const spillStore = ctx.get('spillStore')
  if (sessionId === undefined || spillStore === undefined) return undefined
  const input: SaveTextSpill = {
    owner: { sessionId },
    source: { kind: 'tool', toolName: execution.name, callId: execution.callId, label: 'result' },
    suggestedName: 'composio-search-tools.json',
    content,
  }
  try {
    return await spillStore.saveText(input)
  } catch (error: unknown) {
    ctx.logger.warn(`hivemind-connected-apps: could not persist discovery receipt: ${String(error)}`)
    return undefined
  }
}

/** Register the compact progressive Composio router and its policy guards. */
export function apply(ctx: Context, config: Config = {}): void {
  const turns = new WeakMap<object, { turn: number; enabled: boolean }>()
  const apiKey = config.apiKey?.trim()
  const composio = apiKey
    ? import('@composio/core').then(({ Composio }) => new Composio({ apiKey, allowTracking: false, disableVersionCheck: true }))
    : undefined
  type ComposioSession = Awaited<ReturnType<Composio['sessions']['create']>>
  const sessions = new Map<string, Promise<ComposioSession>>()
  const selectedTools = new Map<string, Set<string>>()

  async function getSession(identity: { userId: string; orgId: string }): Promise<ComposioSession> {
    if (composio === undefined) throw new Error('Connected tools are not configured on this runtime')
    const client = await composio
    const key = sessionKey(identity)
    let pending = sessions.get(key)
    if (pending === undefined) {
      pending = client.sessions.create(key, { mcp: true })
      sessions.set(key, pending)
      pending.catch(() => sessions.delete(key))
    }
    return pending
  }

  ctx.tools.register(defineTool({
    name: BRIDGE_TOOL,
    description: 'Tenant-scoped connected-app gateway. For a new external-app task, call search once with atomic queries, explicit outcomes and constraints, and session.generate_id=true. Then follow the returned plan and selected slugs. External writes require HIVE approval.',
    parameters: {
      action: { type: 'string', required: true, enum: ['search', 'schemas', 'manage_connection', 'wait_connection', 'execute'], description: 'Progressive Composio operation.' },
      queries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            use_case: { type: 'string', required: true, description: 'Normalized complete use case for one atomic app action. Name the app; include operation, filters, ordering, limit, and required output fields. Do not include personal identifiers.' },
            known_fields: { type: 'string', description: 'Optional comma-separated key:value identifiers or settings. Keep to 1-2 short items.' },
          },
          additionalProperties: false,
        },
        description: 'Required for search. Independent app/API actions and hidden prerequisites are separate queries.',
      },
      session: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Existing Composio workflow session id when continuing the same use case.' },
          generate_id: { type: 'boolean', description: 'True for the first search of a new workflow or after a user pivots.' },
        },
        additionalProperties: false,
        description: 'Required for search. Generate a new id or continue the current workflow id.',
      },
      model: { type: 'string', description: 'Current client LLM model name, when known.' },
      search_strategy: { type: 'string', enum: ['auto', 'tool_search'], description: 'Use auto normally; retry with tool_search only when the returned plan or tools do not match.' },
      tool_slug: { type: 'string', description: 'Exact selected tool slug.' },
      tool_slugs: { type: 'array', items: { type: 'string' }, description: 'Selected tool slugs for schema loading.' },
      toolkits: { type: 'array', items: { type: 'string' }, description: 'Exact toolkits returned by search.' },
      session_id: { type: 'string', description: 'Search session id used by connection meta tools.' },
      arguments: { type: 'object', additionalProperties: true, description: 'Selected tool arguments.' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, value: JsonValue) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, execution) {
      if (!connectedAppsEnabled(ctx, config.enabledByDefault === true)) throw new Error('Connected tools are disabled for this turn. Enable Tools and retry.')
      const identity = await ctx.hivemindIdentity.resolve(execution.signal)
      const key = sessionKey(identity)
      const session = await getSession(identity)
      if (args.action === 'search') {
        const queries = searchQueries(args.queries)
        const workflowSession = searchSession(args.session)
        const searchStrategy = stringValue(args.search_strategy)
        if (searchStrategy !== undefined && searchStrategy !== 'auto' && searchStrategy !== 'tool_search') throw new TypeError('Unsupported Composio search strategy')
        const model = stringValue(args.model)
        const result = await session.execute('COMPOSIO_SEARCH_TOOLS', {
          queries,
          session: workflowSession,
          ...(model === undefined ? {} : { model }),
          ...(searchStrategy === undefined ? {} : { search_strategy: searchStrategy }),
        })
        const container: unknown = record(result) && record(result['data']) ? result['data'] : result
        const discovered = new Set<string>()
        if (record(container) && Array.isArray(container['results'])) {
          for (const item of container['results']) {
            if (!record(item)) continue
            for (const slug of [...stringArray(item['primary_tool_slugs']), ...stringArray(item['related_tool_slugs'])]) discovered.add(slug)
          }
        }
        selectedTools.set(key, discovered)
        const statuses = connectionStatuses(result)
        const missing = [...new Set(statuses.filter(item => !item.connected).map(item => item.toolkit.toLowerCase()))]
        if (missing.length > 0) {
          const workflowSessionId = firstString(result, ['id', 'session_id'])
          const managed = await session.execute('COMPOSIO_MANAGE_CONNECTIONS', {
            toolkits: missing,
            ...(workflowSessionId === undefined ? {} : { session_id: workflowSessionId }),
          })
          const redirectUrl = firstString(managed, ['redirect_url', 'redirectUrl', 'connection_url', 'url'])
          const toolkit = missing[0]
          if (toolkit === undefined) throw new Error('Connection search returned no missing toolkit')
          const label = titleCaseToolkit(toolkit)
          return {
            status: 'connection_required',
            toolkit,
            app_label: label,
            logo_url: `https://logos.composio.dev/api/${encodeURIComponent(toolkit)}`,
            prompt: `Connect ${label} to continue, then return here.`,
            ...(redirectUrl === undefined ? {} : { redirect_url: redirectUrl }),
            ...(workflowSessionId === undefined ? {} : { session_id: workflowSessionId }),
            result: result as unknown as JsonValue,
          }
        }
        return { status: 'ready', result: result as unknown as JsonValue }
      }
      const metaArguments: Record<string, unknown> = {}
      if (stringValue(args.session_id) !== undefined) metaArguments['session_id'] = args.session_id
      if (args.action === 'schemas') {
        const slugs = stringArray(args.tool_slugs)
        if (slugs.length === 0 || slugs.some(slug => !selectedTools.get(key)?.has(slug))) {
          throw new Error('Schema request contains a tool not selected by the current search')
        }
        return { status: 'ready', result: await session.execute('COMPOSIO_GET_TOOL_SCHEMAS', { ...metaArguments, tool_slugs: slugs }) as unknown as JsonValue }
      }
      if (args.action === 'manage_connection' || args.action === 'wait_connection') {
        const toolkits = stringArray(args.toolkits)
        if (toolkits.length === 0) throw new TypeError('Connection operation requires at least one toolkit')
        const metaTool = args.action === 'manage_connection' ? 'COMPOSIO_MANAGE_CONNECTIONS' : 'COMPOSIO_WAIT_FOR_CONNECTIONS'
        return { status: 'ready', result: await session.execute(metaTool, { ...metaArguments, toolkits }) as unknown as JsonValue }
      }
      if (args.action !== 'execute') throw new TypeError('Unsupported connected-app action')
      const slug = stringValue(args.tool_slug)
      if (slug === undefined || !record(args.arguments)) throw new TypeError('Execute requires tool_slug and arguments')
      if (META_TOOLS.has(slug)) throw new Error('Use the dedicated progressive action for Composio meta tools')
      if (!selectedTools.get(key)?.has(slug)) throw new Error('Tool was not selected by the current tenant-scoped search')
      if (MUTATING_TOOL.test(slug)) {
        return { status: 'approval_required', mode: 'prepare', tool_slug: slug, arguments: args.arguments as JsonValue }
      }
      return { status: 'ready', result: await session.execute(slug, args.arguments) as unknown as JsonValue }
    },
  }))

  ctx.on('agent/pre-step', async ({ agent, turn }, next) => {
    if (turns.get(agent)?.turn !== turn) turns.set(agent, { turn, enabled: connectedAppsEnabled(ctx, config.enabledByDefault === true) })
    return next()
  })
  ctx.on('tools/pre-execute', async (execution, next) => {
    if (!isConnectedAppInvocation(execution.name, execution.arguments)) return next()
    const enabled = execution.agent !== undefined
      && (turns.get(execution.agent)?.enabled
        ?? connectedAppsEnabled(ctx, config.enabledByDefault === true))
    return enabled ? next() : { kind: 'deny', reason: 'Connected tools are disabled for this turn. Enable Tools and retry.' }
  })
  ctx.on('tools/post-execute', async (execution, result, next): Promise<PostToolDecision> => {
    const decision = await next()
    const isBridgeSearch = execution.name === BRIDGE_TOOL
      && record(execution.arguments)
      && execution.arguments['action'] === 'search'
    const isSearch = execution.name === SEARCH_TOOL || isBridgeSearch
    if (!isSearch || result.isError || decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
    const raw = plainText(decision.content ?? result.content)
    if (raw === undefined) return decision
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { return decision }
    const receipt = await saveReceipt(ctx, execution, raw)
    if (receipt === undefined) return decision
    const compact = compactComposioSearchReceipt(parsed, receipt)
    return compact === undefined ? decision : { kind: 'accept', content: [{ type: 'text', text: JSON.stringify(compact) }] }
  })
}
