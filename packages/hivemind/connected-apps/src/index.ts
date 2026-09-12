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

function boundedStrings(value: unknown, limit: number, length: number): string[] {
  return stringArray(value).slice(0, limit).map(item => item.length > length ? `${item.slice(0, length)}…` : item)
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

function operationReceipts(value: unknown): JsonValue[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!record(item)) return []
    const tool = stringValue(item['tool'])
    const status = stringValue(item['status'])
    if (tool === undefined) return []
    return [{ tool, ...(status === undefined ? {} : { status }) }]
  })
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
    const app = stringValue(item['app'])
    const useCase = stringValue(item['use_case'])
    if (useCase === undefined) throw new TypeError('Each search query requires a non-empty use_case')
    const knownFields = stringValue(item['known_fields'])
    const scopedUseCase = app === undefined || useCase.toLocaleLowerCase().includes(app.toLocaleLowerCase())
      ? useCase
      : `${app}: ${useCase}`
    return knownFields === undefined ? { use_case: scopedUseCase } : { use_case: scopedUseCase, known_fields: knownFields }
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

function returnedWorkflowSessionId(value: unknown): string | undefined {
  if (!record(value)) return undefined
  const unwrapped = record(value['result']) ? value['result'] : value
  const data = record(unwrapped['data']) ? unwrapped['data'] : unwrapped
  if (record(data['session'])) {
    const sessionId = stringValue(data['session']['id']) ?? stringValue(data['session']['session_id'])
    if (sessionId !== undefined) return sessionId
  }
  return stringValue(data['session_id']) ?? stringValue(unwrapped['session_id'])
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

function workflowSessionId(args: Record<string, unknown>): string | undefined {
  const explicit = stringValue(args['session_id'])
  if (explicit !== undefined) return explicit
  return record(args['session']) ? stringValue(args['session']['id']) : undefined
}

function workflowStateKey(
  identity: { userId: string; orgId: string },
  execution: Pick<ToolExecution, 'agent'>,
  workflowId?: string,
): string {
  const conversationId = execution.agent?.session?.header.id
  const conversation = conversationId === undefined ? 'detached' : String(conversationId)
  return `${sessionKey(identity)}:${conversation}:${workflowId ?? 'current'}`
}

function legacySessionKey(identity: { userId: string; orgId: string }): string {
  return identity.orgId
}

function hasActiveAccount(value: unknown): boolean {
  if (!record(value)) return false
  const items = Array.isArray(value['items']) ? value['items'] : []
  return items.some(item => record(item) && /^(?:active|connected)$/i.test(stringValue(item['status']) ?? ''))
}

function activeConnectedAccounts(value: unknown): Record<string, string[]> {
  if (!record(value)) return {}
  const items = Array.isArray(value['items']) ? value['items'] : []
  const connected: Record<string, string[]> = {}
  for (const item of items) {
    if (!record(item) || !/^(?:active|connected)$/i.test(stringValue(item['status']) ?? '')) continue
    const id = stringValue(item['id'])
    const toolkit = record(item['toolkit'])
      ? stringValue(item['toolkit']['slug'])
      : stringValue(item['toolkit']) ?? stringValue(item['toolkit_slug'])
    if (id === undefined || toolkit === undefined) continue
    ;(connected[toolkit] ??= []).push(id)
  }
  return connected
}

function toolkitFromToolSlug(slug: string): string | undefined {
  const separator = slug.indexOf('_')
  return separator > 0 ? slug.slice(0, separator).toLowerCase() : undefined
}

function requiredMissingToolkits(value: unknown, statuses: Array<{ toolkit: string; connected: boolean }>): string[] {
  const missing = new Set(statuses.filter(item => !item.connected).map(item => item.toolkit.toLowerCase()))
  if (missing.size === 0) return []
  const required = new Set<string>()
  if (record(value)) {
    const unwrapped = record(value['data']) ? value['data'] : value
    const results = Array.isArray(unwrapped['results']) ? unwrapped['results'] : []
    for (const result of results) {
      if (!record(result)) continue
      // Related slugs are discovery candidates, not declared dependencies.
      // Requiring their connections here can block a valid primary workflow
      // on an unrelated optional integration suggested by Composio.
      for (const slug of stringArray(result['primary_tool_slugs'])) {
        const toolkit = toolkitFromToolSlug(slug)
        if (toolkit !== undefined) required.add(toolkit)
      }
    }
    // A search result may advertise toolkits for optional fallbacks whose
    // tools were not selected. Connection gating follows selected tool slugs,
    // the executable contract, instead of every advertised integration.
    if (required.size === 0) {
      for (const result of results) {
        if (!record(result)) continue
        for (const toolkit of stringArray(result['toolkits']).map(item => item.toLowerCase())) required.add(toolkit)
      }
    }
  }
  return [...required].filter(toolkit => missing.has(toolkit))
}

function copyPlanningFields(source: Record<string, unknown>, target: Record<string, JsonValue>): void {
  // The original discovery receipt is stored before this projection. The
  // active model needs the bounded next plan, not every optional/fallback
  // paragraph Composio generated for future branches.
  const steps = boundedStrings(source['recommended_plan_steps'], 3, 280)
  const pitfalls = boundedStrings(source['known_pitfalls'], 2, 240)
  const difficulty = jsonScalar(source['difficulty'])
  if (steps.length > 0) target['recommended_plan_steps'] = steps
  if (pitfalls.length > 0) target['known_pitfalls'] = pitfalls
  if (difficulty !== undefined) target['difficulty'] = difficulty
}

type ExecutionContract = {
  readonly tool_slug: string
  readonly required_fields: readonly string[]
  readonly properties: Record<string, JsonValue>
}

type RestoredWorkflowState = {
  selected: Set<string>
  contracts: Map<string, ExecutionContract>
}

function bridgeCall(event: unknown): { callId: string; args: Record<string, unknown> } | undefined {
  if (!record(event) || event['type'] !== 'tool/call' || !record(event['data'])
    || event['data']['name'] !== BRIDGE_TOOL) return undefined
  const callId = stringValue(event['data']['callId'])
  const raw = stringValue(event['data']['arguments'])
  if (callId === undefined || raw === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return record(parsed) ? { callId, args: parsed } : undefined
  } catch {
    return undefined
  }
}

function bridgeResult(event: unknown): { callId: string; value: Record<string, unknown> } | undefined {
  if (!record(event) || event['type'] !== 'tool/result' || !record(event['data']) || !record(event['data']['message'])) return undefined
  const message = event['data']['message']
  const source = record(message['source']) ? message['source'] : undefined
  const callId = stringValue(source?.['callId'])
  if (callId === undefined || !Array.isArray(message['content'])) return undefined
  for (const outer of message['content']) {
    if (!record(outer) || outer['type'] !== 'tool-result' || !Array.isArray(outer['content'])) continue
    for (const inner of outer['content']) {
      if (!record(inner) || inner['type'] !== 'text') continue
      const text = stringValue(inner['text'])
      if (text === undefined) continue
      try {
        const parsed: unknown = JSON.parse(text)
        if (record(parsed)) return { callId, value: parsed }
      } catch {
        continue
      }
    }
  }
  return undefined
}

function compactProperty(value: unknown): JsonValue | undefined {
  if (!record(value)) return undefined
  const compact: Record<string, JsonValue> = {}
  for (const key of ['type', 'format', 'description'] as const) {
    const entry = stringValue(value[key])
    if (entry !== undefined) compact[key] = key === 'description' && entry.length > 240
      ? `${entry.slice(0, 240)}…`
      : entry
  }
  if (Array.isArray(value['enum'])) compact['enum'] = value['enum'].filter(jsonScalar) as JsonValue[]
  if (record(value['items'])) {
    const items = compactProperty(value['items'])
    if (items !== undefined) compact['items'] = items
  }
  return Object.keys(compact).length === 0 ? undefined : compact
}

function schemaRecord(value: unknown): Record<string, unknown> | undefined {
  if (!record(value)) return undefined
  for (const key of ['input_schema', 'inputSchema', 'parameters', 'schema'] as const) {
    if (record(value[key])) return value[key]
  }
  return record(value['properties']) ? value : undefined
}

function executionContracts(value: unknown, selected?: ReadonlySet<string>): ExecutionContract[] {
  if (!record(value)) return []
  const unwrapped = record(value['result']) ? value['result'] : value
  const data = record(unwrapped['data']) ? unwrapped['data'] : unwrapped
  const containers: unknown[] = [data['tool_schemas']]
  if (Array.isArray(data['results'])) {
    for (const result of data['results']) if (record(result)) containers.push(result['tool_schemas'])
  }
  const contracts = new Map<string, ExecutionContract>()
  const add = (slug: string, raw: unknown): void => {
    if (selected !== undefined && !selected.has(slug)) return
    const schema = schemaRecord(raw)
    if (schema === undefined || !record(schema['properties'])) return
    const properties: Record<string, JsonValue> = {}
    for (const [name, property] of Object.entries(schema['properties'])) {
      const compact = compactProperty(property)
      if (compact !== undefined) properties[name] = compact
    }
    contracts.set(slug, {
      tool_slug: slug,
      required_fields: stringArray(schema['required']),
      properties,
    })
  }
  // A post-execute projection may receive an already projected search receipt.
  if (Array.isArray(data['execution_contracts'])) {
    for (const item of data['execution_contracts']) {
      if (!record(item)) continue
      const slug = stringValue(item['tool_slug'])
      if (slug !== undefined) add(slug, { properties: item['properties'], required: item['required_fields'] })
    }
  }
  for (const container of containers) {
    if (Array.isArray(container)) {
      for (const item of container) {
        if (!record(item)) continue
        const slug = stringValue(item['tool_slug']) ?? stringValue(item['name']) ?? stringValue(item['slug'])
        if (slug !== undefined) add(slug, item)
      }
    } else if (record(container)) {
      for (const [slug, raw] of Object.entries(container)) add(slug, raw)
    }
  }
  return [...contracts.values()]
}

function restoreWorkflowState(execution: Pick<ToolExecution, 'agent'>, requestedId?: string): RestoredWorkflowState | undefined {
  const events = execution.agent?.session?.snapshotEvents()
  if (events === undefined) return undefined
  const calls = new Map<string, Record<string, unknown>>()
  for (const event of events) {
    const call = bridgeCall(event)
    if (call !== undefined) calls.set(call.callId, call.args)
  }
  let searchIndex = -1
  let searchReceipt: Record<string, unknown> | undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const result = bridgeResult(events[index])
    if (result === undefined) continue
    const args = calls.get(result.callId)
    if (args?.['action'] !== 'search') continue
    const candidateId = returnedWorkflowSessionId(result.value) ?? workflowSessionId(args)
    if (requestedId !== undefined && candidateId !== requestedId) continue
    searchIndex = index
    searchReceipt = result.value
    break
  }
  if (searchReceipt === undefined) return undefined
  const selected = new Set<string>()
  const unwrapped = record(searchReceipt['result']) ? searchReceipt['result'] : searchReceipt
  const data = record(unwrapped['data']) ? unwrapped['data'] : unwrapped
  if (Array.isArray(data['results'])) {
    for (const item of data['results']) {
      if (!record(item)) continue
      for (const slug of [...stringArray(item['primary_tool_slugs']), ...stringArray(item['related_tool_slugs'])]) selected.add(slug)
    }
  }
  const restoredContracts = new Map(executionContracts(searchReceipt, selected).map(contract => [contract.tool_slug, contract]))
  for (let index = searchIndex + 1; index < events.length; index += 1) {
    const result = bridgeResult(events[index])
    if (result === undefined) continue
    const args = calls.get(result.callId)
    if (args?.['action'] === 'search') break
    if (args?.['action'] !== 'schemas') continue
    for (const contract of executionContracts(result.value, selected)) restoredContracts.set(contract.tool_slug, contract)
  }
  return { selected, contracts: restoredContracts }
}

function validateArguments(contract: ExecutionContract, args: Record<string, unknown>): void {
  for (const field of contract.required_fields) {
    if (!(field in args)) throw new TypeError(`Connected-app arguments missing required field: ${field}`)
  }
  for (const [field, value] of Object.entries(args)) {
    const property = contract.properties[field]
    if (!record(property)) throw new TypeError(`Connected-app argument is not in the authoritative schema: ${field}`)
    const type = stringValue(property['type'])
    const valid = type === undefined
      || (type === 'string' && typeof value === 'string')
      || (type === 'boolean' && typeof value === 'boolean')
      || (type === 'number' && typeof value === 'number')
      || (type === 'integer' && Number.isInteger(value))
      || (type === 'array' && Array.isArray(value))
      || (type === 'object' && record(value))
      || (type === 'null' && value === null)
    if (!valid) throw new TypeError(`Connected-app argument has invalid type for field: ${field}`)
  }
}

const PROVIDER_NOISE = new Set([
  'headers', 'raw', 'mimeType', 'mime_type', 'content_bytes', 'tool_schemas',
  'avatar_hash', 'image_original', 'image_24', 'image_32', 'image_48', 'image_72',
  'image_192', 'image_512', 'image_1024', 'status_emoji_display_info', 'cache_ts',
])

function compactProviderValue(value: unknown): JsonValue {
  if (typeof value === 'string') return value.length > 800 ? `${value.slice(0, 800)}…` : value
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 20).map(item => compactProviderValue(item))
  if (!record(value)) return String(value)
  const compact: Record<string, JsonValue> = {}
  let count = 0
  for (const [key, item] of Object.entries(value)) {
    if (PROVIDER_NOISE.has(key) || item === '' || item === undefined
      || (Array.isArray(item) && item.length === 0)
      || (record(item) && Object.keys(item).length === 0)) continue
    if (count++ >= 40) break
    compact[key] = compactProviderValue(item)
  }
  return compact
}

/** Bound a provider execution so MIME payloads and transport noise stay out of the transcript. */
export function compactComposioExecutionReceipt(value: unknown, receipt?: SpillRef): JsonValue {
  return {
    ...(record(value) ? compactProviderValue(value) as Record<string, JsonValue> : { result: compactProviderValue(value) }),
    ...(receipt === undefined ? {} : {
      source_receipt: { locator: receipt.locator, bytes: receipt.bytes, retrieval_hint: receipt.retrievalHint },
    }),
    projection_policy: 'Provider MIME payloads and transport headers omitted; long text and collections bounded.',
  }
}

/** Create a bounded model-visible projection while retaining the full receipt privately. */
export function compactComposioSearchReceipt(value: unknown, receipt?: SpillRef): Record<string, JsonValue> | undefined {
  if (!record(value)) return undefined
  const unwrapped = record(value['result']) ? value['result'] : value
  const data = record(unwrapped['data']) ? unwrapped['data'] : unwrapped
  const results = Array.isArray(data['results']) ? data['results'].flatMap((item) => {
    if (!record(item)) return []
    const result: Record<string, JsonValue> = {
      primary_tool_slugs: boundedStrings(item['primary_tool_slugs'], 4, 120),
      related_tool_slugs: boundedStrings(item['related_tool_slugs'], 4, 120),
      toolkits: boundedStrings(item['toolkits'], 4, 80),
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
    next_steps_guidance: boundedStrings(data['next_steps_guidance'], 2, 240),
    ...(receipt === undefined ? {} : {
      source_receipt: { locator: receipt.locator, bytes: receipt.bytes, retrieval_hint: receipt.retrievalHint },
    }),
    schema_policy: 'Use the exact execution_contracts below. If a selected slug has no contract, load its schema before execution. Never infer argument names.',
  }
  // Composio ranks primary slugs. Expose the exact contract for the first
  // bounded action of each atomic query; the remaining selected slugs stay
  // available for an explicit schemas call if the model justifiably chooses
  // another branch.
  const primary = new Set(results.flatMap((item) => {
    const slug = Array.isArray(item['primary_tool_slugs']) ? item['primary_tool_slugs'][0] : undefined
    return typeof slug === 'string' ? [slug] : []
  }))
  const contracts = executionContracts(value, primary)
  if (contracts.length > 0) compact['execution_contracts'] = contracts as unknown as JsonValue
  const operations = operationReceipts(value['operations'])
  if (operations.length > 0) compact['operations'] = operations
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
  const turns = new WeakMap<object, { turn: number; enabled: boolean; searches: number }>()
  const apiKey = config.apiKey?.trim()
  const composio = apiKey
    ? import('@composio/core').then(({ Composio }) => new Composio({ apiKey, allowTracking: false, disableVersionCheck: true }))
    : undefined
  type ComposioSession = Awaited<ReturnType<Composio['sessions']['create']>>
  const sessions = new Map<string, Promise<ComposioSession>>()
  const selectedTools = new Map<string, Set<string>>()
  const contracts = new Map<string, Map<string, ExecutionContract>>()

  async function getSession(identity: { userId: string; orgId: string }): Promise<ComposioSession> {
    if (composio === undefined) throw new Error('Connected tools are not configured on this runtime')
    const client = await composio
    const canonicalKey = sessionKey(identity)
    let key = canonicalKey
    let connectedAccounts: Record<string, string[]> = {}
    try {
      const accounts = await client.connectedAccounts.list({ userIds: [canonicalKey], statuses: ['ACTIVE'] })
      connectedAccounts = activeConnectedAccounts(accounts)
      // Existing local HIVE connections were historically created under the
      // organization id. Reuse that tenant-bounded subject only when the
      // authenticated user has no active canonical account. New connections
      // remain user-owned and automatically take precedence once present.
      if (!hasActiveAccount(accounts)) {
        const legacyKey = legacySessionKey(identity)
        const legacyAccounts = await client.connectedAccounts.list({ userIds: [legacyKey], statuses: ['ACTIVE'] })
        if (hasActiveAccount(legacyAccounts)) {
          key = legacyKey
          connectedAccounts = activeConnectedAccounts(legacyAccounts)
        }
      }
    } catch (error: unknown) {
      ctx.logger.warn(`hivemind-connected-apps: could not inspect legacy connection scope: ${String(error)}`)
    }
    let pending = sessions.get(key)
    if (pending === undefined) {
      pending = client.sessions.create(key, { mcp: true, connectedAccounts })
      sessions.set(key, pending)
      pending.catch(() => sessions.delete(key))
    }
    return pending
  }

  ctx.tools.register(defineTool({
    name: BRIDGE_TOOL,
    description: 'Tenant-scoped connected-app gateway. For a new external-app task, call search once with atomic queries, explicit outcomes, exact result limits, and session.generate_id=true. Then follow the returned plan and selected slugs. External writes require HIVE approval.',
    parameters: {
      action: { type: 'string', required: true, enum: ['search', 'schemas', 'manage_connection', 'wait_connection', 'execute'], description: 'Progressive Composio operation.' },
      queries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            app: { type: 'string', description: 'External app only when explicitly named or already established. Omit it when the user named only a service category so authenticated discovery can select an active provider.' },
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
        description: 'Required for search. Generate a new id or continue the current workflow id. Later actions may reuse the returned id here or in session_id.',
      },
      model: { type: 'string', description: 'Current client LLM model name, when known.' },
      search_strategy: { type: 'string', enum: ['auto', 'tool_search'], description: 'Use auto normally; retry with tool_search only when the returned plan or tools do not match.' },
      tool_slug: { type: 'string', description: 'Exact selected tool slug.' },
      tool_slugs: { type: 'array', items: { type: 'string' }, description: 'Selected tool slugs for schema loading.' },
      toolkits: { type: 'array', items: { type: 'string' }, description: 'Exact toolkits returned by search.' },
      session_id: { type: 'string', description: 'Search session id reused by later schema, connection, and execution operations.' },
      arguments: { type: 'object', additionalProperties: true, description: 'Selected tool arguments.' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, value: JsonValue) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, execution) {
      if (!connectedAppsEnabled(ctx, config.enabledByDefault === true)) throw new Error('Connected tools are disabled for this turn. Enable Tools and retry.')
      const identity = await ctx.hivemindIdentity.resolve(execution.signal)
      const session = await getSession(identity)
      if (args.action === 'search') {
        const turnState = execution.agent === undefined ? undefined : turns.get(execution.agent)
        if (turnState !== undefined) {
          if (turnState.searches > 0) throw new Error('Connected-app search already completed for this turn. Follow its result or wait for the user to continue.')
          turnState.searches += 1
        }
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
        const returnedWorkflowId = returnedWorkflowSessionId(result)
        const requestedWorkflowId = workflowSessionId(args)
        const stateKeys = new Set([
          workflowStateKey(identity, execution),
          workflowStateKey(identity, execution, returnedWorkflowId ?? requestedWorkflowId),
        ])
        const discoveredContracts = new Map(executionContracts(result, discovered).map(contract => [contract.tool_slug, contract]))
        for (const stateKey of stateKeys) {
          selectedTools.set(stateKey, new Set(discovered))
          contracts.set(stateKey, new Map(discoveredContracts))
        }
        const statuses = connectionStatuses(result)
        const missing = requiredMissingToolkits(result, statuses)
        if (missing.length > 0) {
          const workflowSessionId = returnedWorkflowId
          const managed = await session.execute('COMPOSIO_MANAGE_CONNECTIONS', {
            toolkits: missing,
            ...(workflowSessionId === undefined ? {} : { session_id: workflowSessionId }),
          })
          const redirectUrl = firstString(managed, ['redirect_url', 'redirectUrl', 'connection_url', 'url'])
          const toolkit = missing[0]
          if (toolkit === undefined) throw new Error('Connection search returned no missing toolkit')
          const label = titleCaseToolkit(toolkit)
          const operations = [
            { tool: 'COMPOSIO_SEARCH_TOOLS', status: 'completed' },
            { tool: 'COMPOSIO_MANAGE_CONNECTIONS', status: redirectUrl === undefined ? 'failed' : 'completed' },
          ]
          const projected = compactComposioSearchReceipt({ status: 'connection_required', operations, result })
          execution.concludeTurn()
          return {
            ...(record(projected) ? projected : {}),
            status: 'connection_required',
            operations,
            toolkit,
            app_label: label,
            logo_url: `https://logos.composio.dev/api/${encodeURIComponent(toolkit)}`,
            prompt: `Connect ${label} to continue, then return here.`,
            ...(redirectUrl === undefined ? {} : { redirect_url: redirectUrl }),
            ...(workflowSessionId === undefined ? {} : { session_id: workflowSessionId }),
          }
        }
        const operations = [{ tool: 'COMPOSIO_SEARCH_TOOLS', status: 'completed' }]
        const projected = compactComposioSearchReceipt({ status: 'ready', operations, result })
        return record(projected) ? projected : { status: 'ready', operations }
      }
      const key = workflowStateKey(identity, execution, workflowSessionId(args))
      const fallbackKey = workflowStateKey(identity, execution)
      let selectedForWorkflow = selectedTools.get(key) ?? selectedTools.get(fallbackKey)
      let contractsForWorkflow = contracts.get(key) ?? contracts.get(fallbackKey)
      if (selectedForWorkflow === undefined || contractsForWorkflow === undefined) {
        const restored = restoreWorkflowState(execution, workflowSessionId(args))
        if (restored !== undefined) {
          selectedForWorkflow = restored.selected
          contractsForWorkflow = restored.contracts
          selectedTools.set(key, restored.selected)
          contracts.set(key, restored.contracts)
          selectedTools.set(fallbackKey, restored.selected)
          contracts.set(fallbackKey, restored.contracts)
        }
      }
      const metaArguments: Record<string, unknown> = {}
      const continuationId = workflowSessionId(args)
      if (continuationId !== undefined) metaArguments['session_id'] = continuationId
      if (args.action === 'schemas') {
        const listed = stringArray(args.tool_slugs)
        const singular = stringValue(args.tool_slug)
        const slugs = listed.length > 0 ? listed : singular === undefined ? [] : [singular]
        if (slugs.length === 0) throw new TypeError('Schema request requires tool_slugs or one tool_slug')
        if (slugs.some(slug => !selectedForWorkflow?.has(slug))) {
          throw new Error('Schema request contains a tool not selected by the current search')
        }
        const result = await session.execute('COMPOSIO_GET_TOOL_SCHEMAS', { ...metaArguments, tool_slugs: slugs })
        const loaded = executionContracts(result, new Set(slugs))
        const workflowContracts = contractsForWorkflow ?? new Map<string, ExecutionContract>()
        for (const contract of loaded) workflowContracts.set(contract.tool_slug, contract)
        contracts.set(key, workflowContracts)
        contracts.set(fallbackKey, workflowContracts)
        return {
          status: 'ready',
          operations: [{ tool: 'COMPOSIO_GET_TOOL_SCHEMAS', status: 'completed' }],
          execution_contracts: loaded as unknown as JsonValue,
        }
      }
      if (args.action === 'manage_connection' || args.action === 'wait_connection') {
        const toolkits = stringArray(args.toolkits)
        if (toolkits.length === 0) throw new TypeError('Connection operation requires at least one toolkit')
        if (args.action === 'wait_connection' && continuationId === undefined) {
          throw new TypeError('Connection continuation requires the original search session_id')
        }
        const metaTool = args.action === 'manage_connection' ? 'COMPOSIO_MANAGE_CONNECTIONS' : 'COMPOSIO_WAIT_FOR_CONNECTIONS'
        const managed = await session.execute(metaTool, { ...metaArguments, toolkits })
        const statuses = connectionStatuses(managed)
        // A successful meta-tool invocation is not proof of OAuth completion.
        // Require affirmative evidence for every requested toolkit; unknown or
        // contradictory provider status must leave the workflow paused.
        const pending = toolkits.filter((toolkit) => {
          const matching = statuses.filter(item => item.toolkit.toLowerCase() === toolkit.toLowerCase())
          return matching.length === 0 || matching.some(item => !item.connected)
        })
        const redirectUrl = firstString(managed, ['redirect_url', 'redirectUrl', 'connection_url', 'url'])
        if (pending.length > 0) execution.concludeTurn()
        return {
          ...compactComposioExecutionReceipt(managed) as Record<string, JsonValue>,
          status: pending.length === 0 ? 'ready' : redirectUrl === undefined ? 'connection_pending' : 'connection_required',
          ...metaArguments as Record<string, JsonValue>,
          pending_toolkits: pending,
          ...(pending[0] === undefined ? {} : { toolkit: pending[0], app_label: titleCaseToolkit(pending[0]) }),
          ...(redirectUrl === undefined ? {} : { redirect_url: redirectUrl }),
          operations: [{ tool: metaTool, status: 'completed' }],
        }
      }
      if (args.action !== 'execute') throw new TypeError('Unsupported connected-app action')
      const slug = stringValue(args.tool_slug)
      if (slug === undefined) throw new TypeError('Execute requires tool_slug')
      if (META_TOOLS.has(slug)) throw new Error('Use the dedicated progressive action for Composio meta tools')
      if (!selectedForWorkflow?.has(slug)) throw new Error('Tool was not selected by the current conversation-scoped search')
      const contract = contractsForWorkflow?.get(slug)
      if (contract === undefined) throw new Error('Authoritative schema unavailable for selected tool; call schemas before execute')
      const executionArguments = args.arguments === undefined && contract.required_fields.length === 0
        ? {}
        : args.arguments
      if (!record(executionArguments)) throw new TypeError('Execute requires arguments matching the authoritative schema')
      validateArguments(contract, executionArguments)
      if (MUTATING_TOOL.test(slug)) {
        return { status: 'approval_required', mode: 'prepare', tool_slug: slug, arguments: executionArguments as JsonValue }
      }
      const providerResult = await session.execute(slug, executionArguments)
      return {
        ...compactComposioExecutionReceipt(providerResult) as Record<string, JsonValue>,
        status: 'ready',
        operations: [{ tool: slug, status: 'completed' }],
      }
    },
  }))

  ctx.on('agent/pre-step', async ({ agent, turn }, next) => {
    if (turns.get(agent)?.turn !== turn) {
      turns.set(agent, {
        turn,
        enabled: connectedAppsEnabled(ctx, config.enabledByDefault === true),
        searches: 0,
      })
    }
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
    const isBridgeExecution = execution.name === BRIDGE_TOOL
      && record(execution.arguments)
      && execution.arguments['action'] === 'execute'
    const isSearch = execution.name === SEARCH_TOOL || isBridgeSearch
    if ((!isSearch && !isBridgeExecution) || result.isError || decision.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
    const raw = plainText(decision.content ?? result.content)
    if (raw === undefined) return decision
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { return decision }
    if (isBridgeSearch && record(parsed) && parsed['status'] === 'connection_required' && !Object.hasOwn(parsed, 'result')) return decision
    const receipt = await saveReceipt(ctx, execution, raw)
    const compact = isSearch
      ? compactComposioSearchReceipt(parsed, receipt)
      : compactComposioExecutionReceipt(parsed, receipt)
    return compact === undefined ? decision : { kind: 'accept', content: [{ type: 'text', text: JSON.stringify(compact) }] }
  })
}
