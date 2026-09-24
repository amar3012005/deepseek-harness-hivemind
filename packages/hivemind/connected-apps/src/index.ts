/** Tenant-scoped progressive Composio capability for HIVE-MIND. */

import type { Context } from '@deepseek-ai/cordis'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Composio } from '@composio/core'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-hivemind-identity'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'
import Ajv, { type ValidateFunction } from 'ajv'
import type { PostToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-questions'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

interface ComposioRouterSessionEventData {
  readonly version: 1
  readonly userKey: string
  readonly subject: string
  readonly routerSessionId: string
}

interface ConnectedReceiptEventData {
  readonly version: 1
  readonly workflowSessionId?: string
  readonly tool: string
  readonly receipt: JsonValue
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Authenticated Composio router session bound to one HIVE conversation.
     * Log-only: it restores provider state after runner restart and never
     * enters derived model history.
     */
    'hivemind/composio-session': ComposioRouterSessionEventData
    /** Compact replayable connected-app evidence retained across turns. */
    'hivemind/connected-receipt': ConnectedReceiptEventData
  }
}

export const name = 'hivemind-connected-apps'
export const inject = ['tools', 'hivemindIdentity', 'userQuestions']

const SEARCH_TOOL = 'mcp__composio__COMPOSIO_SEARCH_TOOLS'
const COMPOSIO_TOOL_PREFIX = 'mcp__composio__'
const CONNECTED_WORKFLOWS_SKILL = 'composio-connected-workflows'
const PLUGINS_SETTINGS_NAMESPACE = 'hivemind-plugins'
const BRIDGE_TOOL = 'hivemind_connected_task'
const WORKFLOW_CONTEXT_SOURCE = 'dsh-hivemind-connected-apps/workflow'
const RECEIPT_CONTEXT_SOURCE = 'dsh-hivemind-connected-apps/receipt'
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
  /** Public HIVE chat URL used as the post-authorization return location. */
  connectionCallbackBaseUrl?: string
  /** Freshness window for unsuccessful discovery within the same workflow. */
  discoveryCacheTtlMs?: number
  /** Consecutive unsuccessful searches allowed before returning existing evidence. */
  maxUnmatchedSearches?: number
  /** Discovery-only calls per workflow before provider execution must advance it. */
  maxDiscoverySearches?: number
  /** Authenticated Core origin used for durable private provider receipts. */
  serviceApiBase?: string
  /** Extra http origins allowed only for the local Compose runner. */
  serviceHttpOrigins?: string[]
  /** Environment variable holding the runner-to-Core HMAC secret. */
  serviceSecretEnv?: string
  /** Refuse provider execution when the durable receipt service is not configured. */
  durableReceiptsRequired?: boolean
}

export const Config: z<Config> = z.object({
  apiKey: z.string(),
  enabledByDefault: z.boolean().default(false),
  connectionCallbackBaseUrl: z.string(),
  discoveryCacheTtlMs: z.number().min(1).default(300_000),
  maxUnmatchedSearches: z.number().min(1).default(2),
  maxDiscoverySearches: z.number().min(1).default(2),
  serviceApiBase: z.string(),
  serviceHttpOrigins: z.array(String).default([]),
  serviceSecretEnv: z.string(),
  durableReceiptsRequired: z.boolean().default(false),
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

function safeHttpsUrl(value: unknown): string | undefined {
  const candidate = stringValue(value)
  if (candidate === undefined) return undefined
  try {
    const parsed = new URL(candidate)
    return parsed.protocol === 'https:' ? parsed.href : undefined
  } catch {
    return undefined
  }
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

/**
 * A spill location is implementation-private.  It must never become a model
 * instruction or a browser-fetch target; callers can retain the opaque id for
 * a future authorized receipt-reader service without learning where it lives.
 */
interface PrivateReceiptReference {
  readonly receipt_id: string
  readonly bytes: number
}

function privateReceiptReference(receipt: SpillRef | PrivateReceiptReference): Record<string, JsonValue> {
  if ('receipt_id' in receipt) return { receipt_id: receipt.receipt_id, bytes: receipt.bytes }
  return {
    receipt_id: createHash('sha256').update(String(receipt.locator)).digest('hex'),
    bytes: receipt.bytes,
  }
}

function allowedServiceBase(value: unknown, allowedOrigins: string[] = []): URL | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  let url: URL
  try { url = new URL(value) } catch { throw new TypeError('Connected receipt service API base is invalid') }
  const loopback = (url.protocol === 'http:' || url.protocol === 'https:')
    && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
  const compose = url.protocol === 'http:' && (url.hostname === 'control-plane' || url.hostname === 'hivemind-control-plane')
  const allowlisted = allowedOrigins.some((origin) => {
    try { return new URL(origin).origin === url.origin } catch { return false }
  })
  if (url.protocol !== 'https:' && !loopback && !compose && !allowlisted) {
    throw new TypeError('Connected receipt service API base must use HTTPS, loopback, or an allowlisted Compose origin')
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new TypeError('Connected receipt service API base must contain only an origin')
  }
  return new URL(url.origin)
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

async function scopedServiceToken(
  ctx: Context,
  config: Config,
  execution: Pick<ToolExecution, 'signal'>,
): Promise<{ token: string; base: URL } | undefined> {
  const base = allowedServiceBase(config.serviceApiBase, config.serviceHttpOrigins)
  if (base === undefined) return undefined
  const envName = config.serviceSecretEnv?.trim() || 'HIVE_HARNESS_RUNNER_SERVICE_SECRET'
  const secret = process.env[envName]
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error(`Connected receipt service secret ${envName} is unavailable or too short`)
  }
  const principal = await ctx.hivemindIdentity.resolve(execution.signal)
  const now = Math.floor(Date.now() / 1000)
  const claims = {
    iss: 'hivemind-harness-runner', aud: 'hivemind-control-plane-harness-proxy',
    sub: principal.userId, org_id: principal.orgId, profile: 'hivemind-chat',
    iat: now, exp: now + 30, jti: randomUUID(),
  }
  const input = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url(claims)}`
  return { token: `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`, base }
}

/** Admit a billable Harness operation before the provider dispatches. */
async function admitHarnessCredit(
  ctx: Context,
  config: Config,
  execution: Pick<ToolExecution, 'signal'> & { readonly callId: string },
  input: { readonly sessionId: string; readonly turnId: number; readonly kind: 'composio_execution' | 'no_tool_turn' | 'turn_admission'; readonly tool?: string },
): Promise<void> {
  const service = await scopedServiceToken(ctx, config, execution)
  if (service === undefined) return
  const response = await fetch(new URL('/internal/v1/harness-chat/credit-operations', service.base), {
    method: 'POST', headers: { authorization: `Bearer ${service.token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      session_id: input.sessionId, turn_id: input.turnId, call_id: execution.callId, kind: input.kind,
      ...(input.tool === undefined ? {} : { tool: input.tool }),
    }),
    signal: execution.signal,
  })
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  if (response.status === 402 || body['code'] === 'credits_exhausted' || body['code'] === 'plan_limit_exceeded') {
    const error = new Error('HIVE-MIND credits are exhausted for this turn') as Error & { code: string }
    error.code = 'plan_limit_exceeded'
    throw error
  }
  if (!response.ok || body['admitted'] !== true) throw new Error(`Harness credit admission failed: ${typeof body['error'] === 'string' ? body['error'] : response.status}`)
}

function flattenedRequestedProjection(value: unknown, requested: ReadonlySet<string>): Record<string, JsonValue> {
  const collected = new Map<string, JsonValue[]>()
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) { for (const item of candidate) visit(item); return }
    if (!record(candidate)) return
    for (const [key, item] of Object.entries(candidate)) {
      if (requested.has(key)) {
        const values = collected.get(key) ?? []
        values.push(compactProviderValue(item))
        collected.set(key, values)
      }
      visit(item)
    }
  }
  visit(value)
  return Object.fromEntries([...collected].map(([key, values]) => [key, values.length === 1 ? (values.at(0) ?? null) : values]))
}

function normalizedToolkitName(value: string): string {
  return value.toLocaleLowerCase().replaceAll(/[^a-z0-9]/g, '')
}

interface ToolkitConnection {
  readonly slug: string
  readonly name: string
  readonly logo?: string
  readonly connected: boolean
}

function exactToolkit(value: unknown, requestedApp: string): ToolkitConnection {
  if (!record(value) || !Array.isArray(value['items'])) throw new Error(`Composio did not return toolkit metadata for ${requestedApp}`)
  const expected = normalizedToolkitName(requestedApp)
  const matches = value['items'].flatMap((item): ToolkitConnection[] => {
    if (!record(item)) return []
    const slug = stringValue(item['slug'])
    const name = stringValue(item['name'])
    if (slug === undefined || name === undefined
      || (normalizedToolkitName(slug) !== expected && normalizedToolkitName(name) !== expected)) return []
    const connection = record(item['connection']) ? item['connection'] : undefined
    const logo = safeHttpsUrl(item['logo'])
    return [{
      slug,
      name,
      ...(logo === undefined ? {} : { logo }),
      connected: connection?.['isActive'] === true,
    }]
  })
  const [match] = matches
  if (match === undefined || matches.length !== 1) throw new Error(`Composio could not resolve one exact toolkit for ${requestedApp}`)
  return match
}

function catalogToolkits(value: unknown): ToolkitConnection[] {
  if (!record(value) || !Array.isArray(value['items'])) return []
  const seen = new Set<string>()
  return value['items'].flatMap((item): ToolkitConnection[] => {
    if (!record(item)) return []
    const slug = stringValue(item['slug'])
    const name = stringValue(item['name'])
    if (slug === undefined || name === undefined || seen.has(slug)) return []
    seen.add(slug)
    const connection = record(item['connection']) ? item['connection'] : undefined
    const logo = safeHttpsUrl(item['logo'])
    return [{ slug, name, ...(logo === undefined ? {} : { logo }), connected: connection?.['isActive'] === true }]
  })
}

function connectorCatalogResponse(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

function connectionCallbackUrl(baseUrl: string | undefined, execution: Pick<ToolExecution, 'agent'>): string | undefined {
  const sessionId = execution.agent?.session?.header.id
  if (baseUrl === undefined || sessionId === undefined) return undefined
  const base = safeHttpsUrl(baseUrl)
  if (base === undefined) throw new TypeError('Connected-app callback base URL must use HTTPS')
  const url = new URL(base)
  url.pathname = `${url.pathname.replace(/\/$/, '')}/session/${encodeURIComponent(String(sessionId))}`
  url.searchParams.set('hivemind_connection', 'complete')
  url.searchParams.set('hivemind_session', String(sessionId))
  return url.href
}

interface SearchQuery {
  use_case: string
  known_fields?: string
}

function requestedResultFields(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.flatMap((item) => {
    if (!record(item)) return []
    return stringArray(item['result_fields']).map(field => field.trim()).filter(Boolean)
  }))]
}

function requestedApps(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set()
  return new Set(value.flatMap((item) => {
    if (!record(item)) return []
    const app = stringValue(item['app'])
    return app === undefined ? [] : [normalizedToolkitName(app)]
  }))
}

function searchResultMatchesApps(value: unknown, apps: ReadonlySet<string>): boolean {
  if (!record(value) || apps.size === 0) return true
  const primaryToolkits = stringArray(value['primary_tool_slugs']).flatMap((slug) => {
    const toolkit = toolkitFromToolSlug(slug)
    return toolkit === undefined ? [] : [normalizedToolkitName(toolkit)]
  })
  // Primary slugs are the executable selection and therefore authoritative.
  // The broader toolkit list may name the requested app as subject matter even
  // when Composio selected an implementation owned by another provider.
  const toolkits = new Set(primaryToolkits.length > 0
    ? primaryToolkits
    : stringArray(value['toolkits']).map(normalizedToolkitName))
  return toolkits.size > 0 && [...toolkits].every(toolkit => apps.has(toolkit))
}

/**
 * Keep semantic discovery inside an explicitly named app boundary. Composio may
 * suggest a third-party toolkit with similar capabilities; that is useful for
 * provider-neutral requests, but must never create an authorization prompt for
 * a different app than the one the user named.
 */
function scopeSearchResult(value: unknown, apps: ReadonlySet<string>): { value: unknown; rejected: boolean } {
  if (!record(value) || apps.size === 0) return { value, rejected: false }
  if (record(value['result'])) {
    const scoped = scopeSearchResult(value['result'], apps)
    return scoped.rejected ? { value: { ...value, result: scoped.value }, rejected: true } : { value, rejected: false }
  }
  if (record(value['data'])) {
    const scoped = scopeSearchResult(value['data'], apps)
    return scoped.rejected ? { value: { ...value, data: scoped.value }, rejected: true } : { value, rejected: false }
  }
  if (!Array.isArray(value['results'])) return { value, rejected: false }
  const results = value['results'].filter(item => searchResultMatchesApps(item, apps))
  if (results.length === value['results'].length) return { value, rejected: false }
  const statuses = Array.isArray(value['toolkit_connection_statuses'])
    ? value['toolkit_connection_statuses'].filter((item) => {
      if (!record(item)) return false
      const toolkit = stringValue(item['toolkit'])
      return toolkit !== undefined && apps.has(normalizedToolkitName(toolkit))
    })
    : value['toolkit_connection_statuses']
  return {
    value: {
      ...value,
      results,
      ...(statuses === undefined ? {} : { toolkit_connection_statuses: statuses }),
    },
    rejected: true,
  }
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

function restoredRouterSession(
  execution: Pick<ToolExecution, 'agent'>,
  userKey: string,
): Pick<ComposioRouterSessionEventData, 'subject' | 'routerSessionId'> | undefined {
  const events = execution.agent?.session?.snapshotEvents()
  if (events === undefined) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'hivemind/composio-session' || event.data.userKey !== userKey) continue
    return { subject: event.data.subject, routerSessionId: event.data.routerSessionId }
  }
  return undefined
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
  const steps = stringArray(source['recommended_plan_steps'])
  const pitfalls = stringArray(source['known_pitfalls'])
  const difficulty = jsonScalar(source['difficulty'])
  if (steps.length > 0) target['recommended_plan_steps'] = steps
  if (pitfalls.length > 0) target['known_pitfalls'] = pitfalls
  if (difficulty !== undefined) target['difficulty'] = difficulty
}

type ExecutionContract = {
  readonly tool_slug: string
  /** Provider contract fingerprint; a changed value replaces any cached contract. */
  readonly schema_hash: string
  readonly tool_version?: string
  readonly required_fields: readonly string[]
  readonly properties: Record<string, JsonValue>
  readonly schema_keywords?: Record<string, JsonValue>
}

type RestoredWorkflowState = {
  selected: Set<string>
  plannedReads: Set<string>
  contracts: Map<string, ExecutionContract>
  resultFields: string[]
}

/** Provider plans are hints, never executable contracts. Only bounded read tools
 * from the selected toolkit may become schema-eligible; writes still require
 * a fresh explicit selection through search and native approval. */
function plannedReadTools(value: unknown): Set<string> {
  if (!record(value)) return new Set()
  const unwrapped = record(value['result']) ? value['result'] : value
  const data = record(unwrapped['data']) ? unwrapped['data'] : unwrapped
  const results = Array.isArray(data['results']) ? data['results'] : []
  const planned = new Set<string>()
  for (const item of results) {
    if (!record(item)) continue
    const primary = stringArray(item['primary_tool_slugs'])[0]
    const toolkit = primary === undefined ? undefined : toolkitFromToolSlug(primary)
    if (toolkit === undefined) continue
    for (const step of stringArray(item['recommended_plan_steps']).slice(0, 8)) {
      for (const match of step.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) {
        const slug = match[0]
        if (planned.size >= 8 || slug === primary || META_TOOLS.has(slug) || MUTATING_TOOL.test(slug)
          || toolkitFromToolSlug(slug) !== toolkit) continue
        planned.add(slug)
      }
    }
  }
  return planned
}

function bridgeCall(event: unknown): { callId: string; args: Record<string, unknown>; turn?: number } | undefined {
  if (!record(event) || event['type'] !== 'tool/call' || !record(event['data'])
    || event['data']['name'] !== BRIDGE_TOOL) return undefined
  const callId = stringValue(event['data']['callId'])
  const raw = stringValue(event['data']['arguments'])
  if (callId === undefined || raw === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    const turn = typeof event['data']['turn'] === 'number' ? event['data']['turn'] : undefined
    return record(parsed) ? { callId, args: parsed, ...(turn === undefined ? {} : { turn }) } : undefined
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

/** A completed governed write is terminal for the same native retry identity. */
function completedWriteForIdempotencyKey(
  events: readonly unknown[],
  idempotencyKey: string,
): Record<string, unknown> | undefined {
  const calls = new Map<string, Record<string, unknown>>()
  for (const event of events) {
    const call = bridgeCall(event)
    if (call !== undefined) {
      calls.set(call.callId, call.args)
      continue
    }
    const result = bridgeResult(event)
    if (result === undefined) continue
    const owner = calls.get(result.callId)
    if (owner?.['action'] !== 'execute' || stringValue(result.value['status']) !== 'ready') continue
    if (stringValue(result.value['idempotency_key']) === idempotencyKey) return result.value
  }
  return undefined
}

function terminalBridgeApprovalResult(event: unknown): { callId: string } | undefined {
  if (!record(event) || event['type'] !== 'tool/result' || !record(event['data']) || !record(event['data']['message'])) return undefined
  const message = event['data']['message']
  const source = record(message['source']) ? message['source'] : undefined
  const callId = stringValue(source?.['callId'])
  if (callId === undefined || !Array.isArray(message['content'])) return undefined
  for (const outer of message['content']) {
    if (!record(outer) || outer['type'] !== 'tool-result' || outer['isError'] !== true || !Array.isArray(outer['content'])) continue
    for (const inner of outer['content']) {
      if (!record(inner) || inner['type'] !== 'text') continue
      const value = stringValue(inner['text']) ?? ''
      if (/^Error: (?:the user rejected tool |approval for tool .* was cancelled)/.test(value)) return { callId }
    }
  }
  return undefined
}

interface UnfinishedWorkflowProjection {
  readonly turn: number
  readonly workflowId: string
  readonly status: string
  readonly queries: JsonValue[]
  readonly toolkits: string[]
  readonly selectedToolSlugs: string[]
  readonly contracts: ExecutionContract[]
  readonly pagination?: JsonValue
  readonly paginationPages?: number
}

const MAX_DURABLE_PAGINATION_PAGES = 5

/** Find a provider-declared continuation cursor without interpreting provider-specific payloads. */
function paginationProjection(value: unknown): Record<string, JsonValue> | undefined {
  const visit = (candidate: unknown, depth: number): Record<string, JsonValue> | undefined => {
    if (depth > 4 || !record(candidate)) return undefined
    for (const [key, entry] of Object.entries(candidate)) {
      if (/^(?:next_)?(?:cursor|page_token|pageToken|nextPageToken)$/i.test(key)
        && (typeof entry === 'string' || typeof entry === 'number') && String(entry).length > 0) {
        return { cursor: String(entry), cursor_field: key }
      }
    }
    for (const entry of Object.values(candidate)) {
      const nested = visit(entry, depth + 1)
      if (nested !== undefined) return nested
    }
    return undefined
  }
  return visit(value, 0)
}

function workflowToolkits(value: Record<string, unknown>): string[] {
  const found = new Set<string>([
    ...stringArray(value['pending_toolkits']),
    ...stringArray(value['connected_toolkits']),
  ])
  const toolkit = stringValue(value['toolkit'])
  if (toolkit !== undefined) found.add(toolkit)
  const unwrapped = record(value['result']) ? value['result'] : value
  const data = record(unwrapped['data']) ? unwrapped['data'] : unwrapped
  for (const item of Array.isArray(data['results']) ? data['results'] : []) {
    if (!record(item)) continue
    for (const entry of stringArray(item['toolkits'])) found.add(entry)
    for (const slug of stringArray(item['primary_tool_slugs'])) {
      const inferred = toolkitFromToolSlug(slug)
      if (inferred !== undefined) found.add(inferred)
    }
  }
  return [...found]
}

function workflowQueries(args: Record<string, unknown>): JsonValue[] {
  if (!Array.isArray(args['queries'])) return []
  return args['queries'].flatMap((item): JsonValue[] => {
    if (!record(item)) return []
    const app = stringValue(item['app'])
    const useCase = stringValue(item['use_case'])
    const knownFields = stringValue(item['known_fields'])
    const resultFields = stringArray(item['result_fields'])
    if (useCase === undefined) return []
    return [{
      ...(app === undefined ? {} : { app }),
      use_case: useCase,
      ...(knownFields === undefined ? {} : { known_fields: knownFields }),
      ...(resultFields.length === 0 ? {} : { result_fields: resultFields }),
    }]
  })
}

/** Reconstruct one unfinished workflow solely from durable tool calls and receipts. */
function unfinishedWorkflow(
  events: readonly unknown[],
  currentTurn: number,
): UnfinishedWorkflowProjection | undefined {
  const calls = new Map<string, NonNullable<ReturnType<typeof bridgeCall>>>()
  let pending: UnfinishedWorkflowProjection | undefined
  for (const event of events) {
    const call = bridgeCall(event)
    if (call !== undefined) {
      calls.set(call.callId, call)
      continue
    }
    const terminalApproval = terminalBridgeApprovalResult(event)
    if (terminalApproval !== undefined) {
      const owner = calls.get(terminalApproval.callId)
      if (owner?.args['action'] === 'execute') pending = undefined
      continue
    }
    const result = bridgeResult(event)
    if (result === undefined) continue
    const owner = calls.get(result.callId)
    if (owner === undefined) continue
    const action = stringValue(owner.args['action'])
    const status = stringValue(result.value['status']) ?? ''
    const workflowId = returnedWorkflowSessionId(result.value) ?? workflowSessionId(owner.args)
    if (action === 'search') {
      if (workflowId === undefined || !['ready', 'connection_required', 'connection_pending'].includes(status)) {
        if (pending?.workflowId === workflowId) pending = undefined
        continue
      }
      const workflowContracts = executionContracts(result.value)
      pending = {
        turn: owner.turn ?? 0,
        workflowId,
        status,
        queries: workflowQueries(owner.args),
        toolkits: workflowToolkits(result.value),
        selectedToolSlugs: workflowContracts.map(contract => contract.tool_slug),
        contracts: workflowContracts,
      }
      continue
    }
    if (pending === undefined || (workflowId !== undefined && workflowId !== pending.workflowId)) continue
    if (action === 'wait_connection') {
      const toolkits = workflowToolkits(result.value)
      pending = { ...pending, status, toolkits: toolkits.length > 0 ? toolkits : pending.toolkits }
      continue
    }
    if (action === 'execute' && status === 'ready') {
      const pagination = paginationProjection(result.value['pagination'])
      const pages = (pending.paginationPages ?? 0) + 1
      pending = pagination === undefined || pages >= MAX_DURABLE_PAGINATION_PAGES
        ? undefined
        : { ...pending, status: 'pagination_pending', pagination, paginationPages: pages }
    }
  }
  return pending !== undefined && pending.turn < currentTurn ? pending : undefined
}

function workflowContextMessage(state: UnfinishedWorkflowProjection) {
  const waiting = state.status === 'connection_required' || state.status === 'connection_pending'
  const projection = {
    session_id: state.workflowId,
    status: state.status,
    queries: state.queries,
    toolkits: state.toolkits,
    selected_tool_slugs: state.selectedToolSlugs,
    execution_contracts: state.contracts,
    ...(state.pagination === undefined ? {} : {
      pagination: state.pagination,
      pagination_pages: state.paginationPages,
    }),
    next_action: waiting ? 'wait_connection' : state.pagination === undefined ? 'execute_selected_tool' : 'continue_page',
  }
  return createUserMessage({
    content: [{
      type: 'text',
      text: `## Unfinished connected-app workflow\nThis state is reconstructed from durable receipts in this conversation. If the current request continues it, resume this session without repeating search, checking status separately, or using HIVE memory for connected-app evidence. If the user changed tasks, leave it pending.\n${JSON.stringify(projection)}`,
    }],
    source: { kind: 'plugin', plugin: WORKFLOW_CONTEXT_SOURCE, form: 'recall' },
  })
}

const WORKFLOW_CONTINUATION_REQUEST = new RegExp(
  String.raw`\b(?:continue|resume|retry|try again|next page|more results|show more|keep going|proceed|`
    + String.raw`finish (?:it|that)|complete (?:it|that)|same (?:task|request|search|workflow)|`
    + String.raw`i (?:connected|authorized)|connection (?:is )?(?:done|ready))\b`,
  'iu',
)

/** Return only the current human-authored request, never a plugin projection. */
function latestUserRequest(messages: readonly unknown[] | undefined): string | undefined {
  if (messages === undefined) return undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!record(message) || message['role'] !== 'user' || !record(message['source'])
      || message['source']['kind'] !== 'user' || !Array.isArray(message['content'])) continue
    const text = message['content'].flatMap(item => record(item) && item['type'] === 'text'
      && typeof item['text'] === 'string' ? [item['text']] : []).join('\n').trim()
    if (text !== '') return text
  }
  return undefined
}

/**
 * Durable workflow state is advisory across turns. A new human request must
 * never inherit a provider cursor or execution contract merely because an old
 * read exposed pagination. Automatic auth-return turns have no human message
 * and still resume; human-authored turns require an explicit continuation.
 */
function shouldProjectWorkflow(messages: readonly unknown[] | undefined): boolean {
  const request = latestUserRequest(messages)
  return request === undefined || WORKFLOW_CONTINUATION_REQUEST.test(request)
}

function discoveryKey(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

// Only committed negative results are reusable. Active connection state and
// provider reads are never authorized from this discovery cache.
function previousUnmatchedDiscovery(
  execution: Pick<ToolExecution, 'agent'>,
  workflowId: string | undefined,
  routerId: string,
  scope: string | undefined,
  ttlMs: number,
): Record<string, unknown>[] {
  if (workflowId === undefined) return []
  const calls = new Map<string, Record<string, unknown>>()
  const found: Record<string, unknown>[] = []
  for (const event of execution.agent?.session.snapshotEvents() ?? []) {
    const call = bridgeCall(event)
    if (call !== undefined) calls.set(call.callId, call.args)
    const result = bridgeResult(event)
    if (result === undefined) continue
    const args = calls.get(result.callId)
    if ((returnedWorkflowSessionId(result.value) ?? (args === undefined ? undefined : workflowSessionId(args))) !== workflowId) continue
    if (args?.['action'] === 'execute' || args?.['action'] === 'manage_connection' || args?.['action'] === 'wait_connection') {
      found.length = 0
      continue
    }
    if (args?.['action'] !== 'search') continue
    const metadata = result.value['discovery']
    if (!record(metadata) || metadata['version'] !== 1 || metadata['router_id'] !== routerId
      || (scope !== undefined && metadata['scope'] !== scope)) continue
    const at = metadata['recorded_at']
    if (typeof at !== 'number' || Date.now() < at || Date.now() - at >= ttlMs) continue
    if (result.value['status'] === 'ready' && scope !== undefined) found.length = 0
    if ((result.value['status'] === 'no_matching_tool' || (scope === undefined && result.value['status'] === 'ready'))
      && metadata['cache_hit'] !== true) found.push(result.value)
  }
  return found
}

function compactSchemaValue(value: unknown): JsonValue | undefined {
  const scalar = jsonScalar(value)
  if (scalar !== undefined) return scalar
  if (Array.isArray(value)) return value.flatMap((item): JsonValue[] => {
    const compact = compactSchemaValue(item)
    return compact === undefined ? [] : [compact]
  })
  if (!record(value)) return undefined
  const compact: Record<string, JsonValue> = {}
  for (const [key, item] of Object.entries(value)) {
    // These are JSON Schema annotations, not executable validation. The full
    // provider schema remains available in the private source receipt.
    if (key === 'examples' || key === '$comment') continue
    const nested = compactSchemaValue(item)
    if (nested !== undefined) compact[key] = nested
  }
  return compact
}

function compactProperty(value: unknown): JsonValue | undefined {
  if (!record(value)) return undefined
  return compactSchemaValue(value)
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
    const rawSchema = record(raw) ? raw : {}
    const properties: Record<string, JsonValue> = {}
    for (const [name, property] of Object.entries(schema['properties'])) {
      const compact = compactProperty(property)
      if (compact !== undefined) properties[name] = compact
    }
    const toolVersion = stringValue(rawSchema['tool_version'])
      ?? stringValue(rawSchema['toolVersion'])
      ?? stringValue(rawSchema['version'])
    contracts.set(slug, {
      tool_slug: slug,
      schema_hash: stringValue(rawSchema['schema_hash'])
        ?? stringValue(rawSchema['schemaHash'])
        ?? createHash('sha256').update(JSON.stringify({ slug, schema })).digest('hex'),
      ...(toolVersion === undefined ? {} : { tool_version: toolVersion }),
      required_fields: stringArray(schema['required']),
      properties,
      schema_keywords: JSON.parse(JSON.stringify(Object.fromEntries(
        Object.entries(schema).filter(([key]) => key !== 'properties' && key !== 'required'
          && key !== 'schema_hash' && key !== 'schemaHash'
          && key !== 'tool_version' && key !== 'toolVersion' && key !== 'version'),
      ))) as Record<string, JsonValue>,
    })
  }
  // A post-execute projection may receive an already projected search receipt.
  if (Array.isArray(data['execution_contracts'])) {
    for (const item of data['execution_contracts']) {
      if (!record(item)) continue
      const slug = stringValue(item['tool_slug'])
      if (slug !== undefined) add(slug, {
        ...(record(item['schema_keywords']) ? item['schema_keywords'] : {}),
        ...(stringValue(item['schema_hash']) === undefined ? {} : { schema_hash: item['schema_hash'] }),
        ...(stringValue(item['tool_version']) === undefined ? {} : { tool_version: item['tool_version'] }),
        properties: item['properties'], required: item['required_fields'],
      })
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
  let workflowId = requestedId
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const result = bridgeResult(events[index])
    if (result === undefined) continue
    const args = calls.get(result.callId)
    if (args?.['action'] !== 'search') continue
    const candidateId = returnedWorkflowSessionId(result.value) ?? workflowSessionId(args)
    if (workflowId !== undefined && candidateId !== workflowId) continue
    workflowId = candidateId
    break
  }
  if (workflowId === undefined) return undefined
  const selected = new Set<string>()
  const plannedReads = new Set<string>()
  const restoredContracts = new Map<string, ExecutionContract>()
  const resultFields = new Set<string>()
  let foundSearch = false
  for (let index = 0; index < events.length; index += 1) {
    const result = bridgeResult(events[index])
    if (result === undefined) continue
    const args = calls.get(result.callId)
    if (args?.['action'] === 'search') {
      const candidateId = returnedWorkflowSessionId(result.value) ?? workflowSessionId(args)
      if (candidateId !== workflowId) continue
      foundSearch = true
      for (const field of requestedResultFields(args['queries'])) resultFields.add(field)
      const unwrapped = record(result.value['result']) ? result.value['result'] : result.value
      const data = record(unwrapped['data']) ? unwrapped['data'] : unwrapped
      if (Array.isArray(data['results'])) {
        for (const item of data['results']) {
          if (!record(item)) continue
          const primary = stringArray(item['primary_tool_slugs'])[0]
          if (primary !== undefined) selected.add(primary)
        }
      }
      for (const slug of plannedReadTools(result.value)) plannedReads.add(slug)
      for (const contract of executionContracts(result.value, selected)) restoredContracts.set(contract.tool_slug, contract)
      continue
    }
    if (args?.['action'] !== 'schemas' || workflowSessionId(args) !== workflowId) continue
    const eligible = new Set([...selected, ...plannedReads])
    for (const contract of executionContracts(result.value, eligible)) {
      restoredContracts.set(contract.tool_slug, contract)
      selected.add(contract.tool_slug)
    }
  }
  return foundSearch ? { selected, plannedReads, contracts: restoredContracts, resultFields: [...resultFields] } : undefined
}

const argumentSchemaValidator = new Ajv({ allErrors: true, strict: false, validateFormats: false })
const argumentValidators = new WeakMap<ExecutionContract, ValidateFunction>()

function validateArguments(contract: ExecutionContract, args: Record<string, unknown>): void {
  let validate = argumentValidators.get(contract)
  if (validate === undefined) {
    validate = argumentSchemaValidator.compile({
      ...contract.schema_keywords,
      type: contract.schema_keywords?.['type'] ?? 'object',
      properties: contract.properties,
      required: contract.required_fields,
      additionalProperties: contract.schema_keywords?.['additionalProperties'] ?? false,
    })
    argumentValidators.set(contract, validate)
  }
  if (validate(args)) return
  const details = argumentSchemaValidator.errorsText(validate.errors, { separator: '; ' })
  throw new TypeError(`Connected-app arguments do not match the authoritative schema: ${details}`)
}

const PROVIDER_NOISE = new Set([
  'headers', 'raw', 'mimeType', 'mime_type', 'content_bytes', 'tool_schemas',
  'avatar_hash', 'image_original', 'image_24', 'image_32', 'image_48', 'image_72',
  'image_192', 'image_512', 'image_1024', 'status_emoji_display_info', 'cache_ts',
])

/** Keep authentication content out of the model projection and rendered chat.
 * The complete tenant-scoped provider receipt remains private and durable. */
function containsAuthenticationMaterial(value: string): boolean {
  return [
    /\b(?:one[- ]time (?:pass(?:word|code)|code)|otp|verification code|security code|login code|sign[- ]in code|2fa code|mfa code)\b/i,
    /\b(?:reset|recover|change)\s+(?:your\s+)?password\b/i,
    /https?:\/\/\S*(?:reset[-_/]?password|password[-_/]?reset|verify[-_]?(?:account|email)|magic[-_/]?link)\S*/i,
    /\b(?:new|unrecognized|unrecognised|suspicious)\s+(?:sign[- ]?in|login|authentication)(?:\s+(?:attempt|alert|activity))?\b/i,
  ].some(pattern => pattern.test(value))
}

function isMimeTransportTree(value: unknown): boolean {
  if (!record(value)) return false
  const mime = stringValue(value['mimeType']) ?? stringValue(value['mime_type'])
  if (mime === undefined) return false
  const transportKeys = new Set(['mimeType', 'mime_type', 'headers', 'parts', 'body', 'filename', 'partId', 'part_id'])
  if (Object.entries(value).some(([key, item]) => !transportKeys.has(key)
    && item !== '' && item !== undefined && item !== null)) return false
  return Object.hasOwn(value, 'headers') || Object.hasOwn(value, 'parts')
    || (record(value['body']) && (Object.hasOwn(value['body'], 'data') || Object.hasOwn(value['body'], 'size')))
}

function compactProviderValue(value: unknown): JsonValue {
  if (typeof value === 'string') {
    if (containsAuthenticationMaterial(value)) return '[Authentication-related content redacted]'
    return value.length > 800 ? `${value.slice(0, 800)}…` : value
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 20).map(item => compactProviderValue(item))
  if (!record(value)) return String(value)
  const compact: Record<string, JsonValue> = {}
  let count = 0
  for (const [key, item] of Object.entries(value)) {
    if (PROVIDER_NOISE.has(key) || item === '' || item === undefined
      || isMimeTransportTree(item)
      || (Array.isArray(item) && item.length === 0)
      || (record(item) && Object.keys(item).length === 0)) continue
    if (count++ >= 40) break
    compact[key] = compactProviderValue(item)
  }
  return compact
}

function projectRequestedFields(value: unknown, requested: ReadonlySet<string>): JsonValue | undefined {
  if (Array.isArray(value)) {
    const projected = value.flatMap((item): JsonValue[] => {
      const nested = projectRequestedFields(item, requested)
      return nested === undefined ? [] : [nested]
    })
    return projected.length === 0 ? undefined : projected
  }
  if (!record(value)) return undefined
  const projected: Record<string, JsonValue> = {}
  for (const [key, item] of Object.entries(value)) {
    if (requested.has(key)) {
      projected[key] = compactProviderValue(item)
      continue
    }
    const nested = projectRequestedFields(item, requested)
    if (nested !== undefined && (!Array.isArray(nested) || nested.length > 0)
      && (!record(nested) || Object.keys(nested).length > 0)) projected[key] = nested
  }
  return Object.keys(projected).length === 0 ? undefined : projected
}

function presentRequestedFields(value: unknown, requested: ReadonlySet<string>, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) presentRequestedFields(item, requested, found)
    return found
  }
  if (!record(value)) return found
  for (const [key, item] of Object.entries(value)) {
    if (requested.has(key)) found.add(key)
    presentRequestedFields(item, requested, found)
  }
  return found
}

/** Bound a provider execution so MIME payloads and transport noise stay out of the transcript. */
export function compactComposioExecutionReceipt(
  value: unknown,
  receipt?: SpillRef | PrivateReceiptReference,
  resultFields: readonly string[] = [],
): JsonValue {
  const requested = new Set(resultFields)
  const present = requested.size === 0 ? new Set<string>() : presentRequestedFields(value, requested)
  const compact = requested.size === 0
    ? compactProviderValue(value)
    : projectRequestedFields(value, requested) ?? {}
  const missing = [...requested].filter(field => !present.has(field))
  const pagination = paginationProjection(value)
  return {
    ...(record(compact) ? compact : { result: compact }),
    ...(receipt === undefined ? {} : {
      source_receipt: privateReceiptReference(receipt),
    }),
    projection_policy: requested.size === 0
      ? 'Duplicated MIME transport trees and transport headers omitted; readable evidence retained, while long text and collections are bounded. The original receipt is preserved separately when source_receipt is present.'
      : 'Only the exact requested result fields are projected. Missing requested fields are reported explicitly; unrelated provider payload is never substituted.',
    ...(missing.length === 0 ? {} : { missing_result_fields: missing }),
    ...(pagination === undefined ? {} : { pagination }),
  }
}

/** Create a bounded model-visible projection while retaining the full receipt privately. */
export function compactComposioSearchReceipt(
  value: unknown,
  receipt?: SpillRef | PrivateReceiptReference,
): Record<string, JsonValue> | undefined {
  if (!record(value)) return undefined
  const unwrapped = record(value['result']) ? value['result'] : value
  const data = record(unwrapped['data']) ? unwrapped['data'] : unwrapped
  const results = Array.isArray(data['results']) ? data['results'].flatMap((item) => {
    if (!record(item)) return []
    const result: Record<string, JsonValue> = {
      primary_tool_slugs: boundedStrings(item['primary_tool_slugs'], 1, 120),
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
  if (!Array.isArray(data['results']) && statuses.length === 0 && session === undefined) return undefined
  const compact: Record<string, JsonValue> = {
    success: data['success'] !== false,
    results,
    toolkit_connection_statuses: statuses,
    ...(session === undefined ? {} : { session }),
    next_steps_guidance: boundedStrings(data['next_steps_guidance'], 2, 240),
    ...(receipt === undefined ? {} : {
      source_receipt: privateReceiptReference(receipt),
    }),
    schema_policy: 'Use exact execution contracts. For a read-only next tool explicitly named in recommended_plan_steps, load its authoritative schema in this workflow before executing it. Unrelated or write tools need a fresh search selection. Never infer argument names.',
  }
  const workflowSessionId = returnedWorkflowSessionId(value)
  if (workflowSessionId !== undefined) compact['session_id'] = workflowSessionId
  // Composio ranks primary slugs. Expose and authorize only the first bounded
  // action of each atomic query. A different branch needs a fresh, justified
  // discovery result rather than widening the active workflow contract.
  const primary = new Set(results.flatMap((item) => {
    const slug = Array.isArray(item['primary_tool_slugs']) ? item['primary_tool_slugs'][0] : undefined
    return typeof slug === 'string' ? [slug] : []
  }))
  const contracts = executionContracts(value, primary)
  if (contracts.length > 0) compact['execution_contracts'] = contracts as unknown as JsonValue
  const operations = operationReceipts(value['operations'])
  if (Array.isArray(value['operations'])) compact['operations'] = operations
  const outerStatus = stringValue(value['status'])
  const toolkit = stringValue(value['toolkit'])
  const redirectUrl = stringValue(value['redirect_url']) ?? stringValue(value['redirectUrl'])
  const prompt = stringValue(value['prompt'])
  if (outerStatus !== undefined) compact['status'] = outerStatus
  if (toolkit !== undefined) compact['toolkit'] = toolkit
  if (redirectUrl !== undefined) compact['redirect_url'] = redirectUrl
  if (prompt !== undefined) compact['prompt'] = prompt
  for (const key of ['next_action', 'next_action_guidance', 'discovery', 'session_id'] as const) {
    const entry = value[key]
    if (entry !== undefined) compact[key] = entry as JsonValue
  }
  copyPlanningFields(data, compact)
  return compact
}

function appendConnectedReceipt(
  execution: Pick<ToolExecution, 'agent'>,
  tool: string,
  receipt: JsonValue,
  workflowSessionId?: string,
): void {
  execution.agent?.session.append('hivemind/connected-receipt', {
    version: 1,
    tool,
    receipt,
    ...(workflowSessionId === undefined ? {} : { workflowSessionId }),
  })
}

function latestConnectedReceipt(agent: ToolExecution['agent']): ConnectedReceiptEventData | undefined {
  const events = agent?.session.snapshotEvents()
  if (events === undefined) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'hivemind/connected-receipt') return event.data
  }
  return undefined
}

function connectedReceiptContextMessage(receipt: ConnectedReceiptEventData) {
  return createUserMessage({
    content: [{
      type: 'text',
      text: `## Most recent connected-app receipt\nThis compact evidence was durably retained from a prior completed connected-app operation. Use it when the current request refers to those results; do not repeat the provider read merely to reconstruct context.\n${JSON.stringify(receipt)}`,
    }],
    source: { kind: 'plugin', plugin: RECEIPT_CONTEXT_SOURCE, form: 'recall' },
  })
}

async function saveReceipt(
  ctx: Context,
  config: Config,
  execution: ToolExecution,
  content: string,
  suggestedName = 'composio-search-tools.json',
  options: {
    readonly provider?: string
    readonly tool?: string
    readonly contractVersion?: string
    readonly allowedFields?: readonly string[]
    readonly approvedProjection?: Record<string, JsonValue>
  } = {},
): Promise<PrivateReceiptReference | SpillRef | undefined> {
  const sessionId = execution.agent?.session.header.id
  if (sessionId === undefined) return undefined
  const service = await scopedServiceToken(ctx, config, execution)
  if (service !== undefined) {
    let rawReceipt: JsonValue
    try { rawReceipt = JSON.parse(content) as JsonValue } catch { rawReceipt = content }
    const response = await fetch(new URL('/internal/v1/harness-chat/receipts', service.base), {
      method: 'POST',
      headers: { authorization: `Bearer ${service.token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        session_id: String(sessionId), call_id: execution.callId,
        provider: options.provider ?? 'composio', tool: options.tool ?? execution.name,
        ...(options.contractVersion === undefined ? {} : { contract_version: options.contractVersion }),
        raw_receipt: rawReceipt,
        allowed_fields: options.allowedFields ?? [],
        approved_projection: options.approvedProjection ?? {},
        projection_policy: 'selected-contract-v1',
      }),
      signal: execution.signal,
    })
    const body = await response.json().catch(() => ({})) as Record<string, unknown>
    if (!response.ok || typeof body['receipt_id'] !== 'string' || typeof body['bytes'] !== 'number') {
      throw new Error(`Connected receipt store failed: ${typeof body['error'] === 'string' ? body['error'] : response.status}`)
    }
    return { receipt_id: body['receipt_id'], bytes: body['bytes'] }
  }
  if (config.durableReceiptsRequired === true) {
    throw new Error('Connected receipt service is required but not configured')
  }
  const spillStore = ctx.get('spillStore')
  if (spillStore === undefined) return undefined
  const input: SaveTextSpill = {
    owner: { sessionId },
    source: { kind: 'tool', toolName: execution.name, callId: execution.callId, label: 'result' },
    suggestedName,
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
  const turns = new WeakMap<object, {
    turn: number
    enabled: boolean
    searchFingerprints: Set<string>
    billableCalls: number
    workflowId?: string
  }>()
  const apiKey = config.apiKey?.trim()
  const composio = apiKey
    ? import('@composio/core').then(({ Composio }) => new Composio({ apiKey, allowTracking: false, disableVersionCheck: true }))
    : undefined
  type ComposioSession = Awaited<ReturnType<Composio['sessions']['create']>>
  const sessions = new Map<string, Promise<ComposioSession>>()
  const selectedTools = new Map<string, Set<string>>()
  const plannedReads = new Map<string, Set<string>>()
  const contracts = new Map<string, Map<string, ExecutionContract>>()
  const resultFields = new Map<string, string[]>()

  async function getSession(identity: { userId: string; orgId: string }, execution: Pick<ToolExecution, 'agent'>): Promise<ComposioSession> {
    if (composio === undefined) throw new Error('Connected tools are not configured on this runtime')
    const client = await composio
    const canonicalKey = sessionKey(identity)
    const conversationId = execution.agent?.session?.header.id
    const cacheKey = `${canonicalKey}:${conversationId === undefined ? 'detached' : String(conversationId)}`
    let pending = sessions.get(cacheKey)
    if (pending === undefined) {
      pending = (async () => {
        const restored = restoredRouterSession(execution, canonicalKey)
        if (restored !== undefined) {
          try {
            return await client.sessions.use(restored.routerSessionId, { mcp: true })
          } catch (error: unknown) {
            ctx.logger.warn(`hivemind-connected-apps: could not restore Composio session; creating a successor: ${String(error)}`)
          }
        }
        let subject = restored?.subject ?? canonicalKey
        let connectedAccounts: Record<string, string[]> = {}
        try {
          const accounts = await client.connectedAccounts.list({ userIds: [subject], statuses: ['ACTIVE'] })
          connectedAccounts = activeConnectedAccounts(accounts)
          // Existing HIVE connections were historically created under the
          // organization id. Use that bounded subject only for a first session
          // whose canonical user has no active account.
          if (restored === undefined && !hasActiveAccount(accounts)) {
            const legacyKey = legacySessionKey(identity)
            const legacyAccounts = await client.connectedAccounts.list({ userIds: [legacyKey], statuses: ['ACTIVE'] })
            if (hasActiveAccount(legacyAccounts)) {
              subject = legacyKey
              connectedAccounts = activeConnectedAccounts(legacyAccounts)
            }
          }
        } catch (error: unknown) {
          ctx.logger.warn(`hivemind-connected-apps: could not inspect connection scope: ${String(error)}`)
        }
        const callbackUrl = connectionCallbackUrl(config.connectionCallbackBaseUrl, execution)
        const created = await client.sessions.create(subject, {
          mcp: true,
          connectedAccounts,
          ...(callbackUrl === undefined ? {} : { manageConnections: { enable: true, callbackUrl } }),
        })
        if (execution.agent !== undefined) {
          execution.agent.session.append('hivemind/composio-session', {
            version: 1,
            userKey: canonicalKey,
            subject,
            routerSessionId: created.sessionId,
          })
        }
        return created
      })()
      sessions.set(cacheKey, pending)
      pending.catch(() => sessions.delete(cacheKey))
    }
    return pending
  }

  // Browser connector discovery is an authenticated, bounded catalog query.
  // It intentionally shares the user-level Composio session cache but returns
  // neither tool schemas nor provider logs, and it is never model context.
  const inject = (ctx as unknown as { inject?: unknown }).inject
  if (typeof inject === 'function') {
    (inject as (services: readonly string[], callback: (value: unknown) => void) => void).call(ctx, ['webServer', 'connection'], (services) => {
      const runtime = services as {
        webServer: { register(input: { kind: 'exact'; path: string; handler(req: IncomingMessage, res: ServerResponse): Promise<void> }): () => void }
        connection: { principal(input: { headers: { host?: string; cookie?: string } }): Record<string, string> | undefined }
      }
      ctx.effect(() => runtime.webServer.register({
        kind: 'exact',
        path: '/api/hivemind/connectors',
        handler: async (req, res) => {
          if (req.method !== 'GET') {
            connectorCatalogResponse(res, 405, { ok: false, diagnostic: 'method_not_allowed' })
            return
          }
          const host = typeof req.headers['x-forwarded-host'] === 'string'
            ? req.headers['x-forwarded-host'].split(',', 1)[0]?.trim()
            : req.headers.host
          const principal = runtime.connection.principal({ headers: {
            ...(host === undefined ? {} : { host }),
            ...(req.headers.cookie === undefined ? {} : { cookie: req.headers.cookie }),
          } })
          const userId = principal === undefined ? undefined : stringValue(principal.user_id)
          const orgId = principal === undefined ? undefined : stringValue(principal.org_id)
          if (principal?.profile !== 'hivemind-chat' || userId === undefined || orgId === undefined) {
            connectorCatalogResponse(res, 401, { ok: false, diagnostic: 'authentication_required' })
            return
          }
          const query = new URL(req.url ?? '/', 'http://hivemind.local').searchParams.get('q')?.trim().slice(0, 64) ?? ''
          if (query === '') {
            connectorCatalogResponse(res, 400, { ok: false, diagnostic: 'query_required' })
            return
          }
          try {
            const session = await getSession({ userId, orgId }, {})
            const catalog = await session.toolkits({ search: query, limit: 8 })
            connectorCatalogResponse(res, 200, {
              ok: true,
              connectors: catalogToolkits(catalog).map(item => ({
                slug: item.slug, name: item.name, connected: item.connected,
                ...(item.logo === undefined ? {} : { logo: item.logo }),
              })),
            })
          } catch {
            connectorCatalogResponse(res, 503, { ok: false, diagnostic: 'connector_catalog_unavailable' })
          }
        },
      }), 'hivemind-connected-apps: authenticated connector catalog')
    })
  }

  async function awaitConnection(
    execution: ToolExecution,
    input: {
      toolkit: string
      appLabel: string
      redirectUrl: string
      logoUrl: string
      workflowSessionId: string
    },
    verifyConnection: () => Promise<boolean>,
  ): Promise<boolean> {
    const questionId = `hivemind-connected-app-authorization:${input.workflowSessionId}:${input.toolkit}`
    const connect = `Connect ${input.appLabel}`
    const continueLabel = `I've connected ${input.appLabel} — continue`
    const presentation = encodeURIComponent(JSON.stringify({
      version: 1,
      appLabel: input.appLabel,
      toolkit: input.toolkit,
      redirectUrl: input.redirectUrl,
      logoUrl: input.logoUrl,
      connectLabel: connect,
      continueLabel,
    }))
    for (;;) {
      let answer
      try {
        answer = await ctx.userQuestions.ask({
          questions: [{
            id: questionId,
            question: `Connect ${input.appLabel} to continue, then return here.`,
            detail: `Authorize in a new tab, then continue this request.\n\n<!-- hivemind-connected-app-authorization:${presentation} -->`,
            options: [
              { label: connect, description: `Authorize ${input.appLabel} in a new tab.` },
              { label: continueLabel, description: 'Verify the connection and continue this request.' },
            ],
          }],
          ...(execution.agent === undefined ? {} : { agent: execution.agent }),
          signal: execution.signal,
        })
      } catch (error: unknown) {
        const code = record(error) ? stringValue(error['code']) : undefined
        // Stopping or navigating away from an awaiting-input run is a clean
        // pause. The caller settles a durable connection_required receipt so
        // replay shows the actionable card instead of a failed tool row.
        if (execution.signal.aborted || code === 'ASK_ABORTED') return false
        throw error
      }
      const selected = answer.answers.find(item => item.id === questionId)?.selected ?? []
      // Capable clients keep Connect non-settling. A generic client may return
      // it as an answer; keep the same tool call paused in that fallback.
      if (!selected.includes(continueLabel)) continue
      if (await verifyConnection()) return true
    }
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: BRIDGE_TOOL,
    description: 'Tenant-scoped connected-app gateway. Start external-app work with atomic search queries, explicit outcomes, exact result limits, and session.generate_id=true. Follow recommended_plan_steps: for an explicitly planned read tool, call schemas with its exact slug in the same session, then execute using that contract. Never execute a plan hint directly or guess tools. External writes require HIVE approval.',
    parameters: {
      action: { type: 'string', required: true, enum: ['connection_status', 'search', 'schemas', 'manage_connection', 'wait_connection', 'execute'], description: 'Use connection_status only for a pure status check of explicitly named apps. Use search for real app work.' },
      apps: { type: 'array', items: { type: 'string' }, description: 'One to four explicit app names for connection_status. Resolved against authenticated toolkit metadata, never semantic tool search.' },
      queries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            app: { type: 'string', description: 'External app only when explicitly named or already established. Omit it when the user named only a service category so authenticated discovery can select an active provider.' },
            use_case: { type: 'string', required: true, description: 'Normalized complete use case for one atomic app action. Name the app; include operation, filters, ordering, limit, and required output fields. Do not include personal identifiers.' },
            known_fields: { type: 'string', description: 'Optional comma-separated key:value identifiers or settings. Keep to 1-2 short items.' },
            result_fields: {
              type: 'array', items: { type: 'string' },
              description: 'Exact provider response keys required in the final answer. Used only to project execution evidence; omitted from Composio search. Omit when the response keys are unknown.',
            },
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
      tool_slugs: { type: 'array', items: { type: 'string' }, description: 'Selected tool slugs or exact read-only slugs from recommended_plan_steps for schema loading.' },
      toolkits: { type: 'array', items: { type: 'string' }, description: 'Exact toolkits returned by search.' },
      session_id: { type: 'string', description: 'Search session id reused by later schema, connection, and execution operations.' },
      arguments: { type: 'object', additionalProperties: true, description: 'Selected tool arguments.' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, value: JsonValue) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, execution) {
      if (!connectedAppsEnabled(ctx, config.enabledByDefault === true)) throw new Error('Connected tools are disabled for this turn. Enable Tools and retry.')
      const identity = await ctx.hivemindIdentity.resolve(execution.signal)
      const session = await getSession(identity, execution)
      if (args.action === 'connection_status') {
        const apps = stringArray(args.apps)
        if (apps.length === 0 || apps.length > 4) throw new TypeError('Connection status requires between 1 and 4 explicit app names')
        const resolved = await Promise.all(apps.map(async app => exactToolkit(
          await session.toolkits({ search: app, limit: 8 }), app,
        )))
        const disconnected = resolved.filter(item => !item.connected)
        if (disconnected.length === 0) {
          const selected = resolved[0]
          if (selected === undefined) throw new Error('Connected toolkit selection unexpectedly became empty')
          return {
            status: 'ready',
            toolkit: selected.slug,
            app_label: selected.name,
            logo_url: selected.logo ?? `https://logos.composio.dev/api/${encodeURIComponent(selected.slug)}`,
            connected_toolkits: resolved.map(item => item.slug),
            toolkit_connection_statuses: resolved.map(item => ({
              toolkit: item.slug, app_label: item.name, has_active_connection: true, status_message: 'ACTIVE',
            })),
            next_action: 'continue_current_request',
            next_action_guidance: 'Connection is active. If connection status was the entire user request, answer it now. Otherwise continue the same user request with connected-app search; do not end the turn, ask the user to repeat it, or switch to HIVE memory.',
          }
        }
        const selected = disconnected[0]
        if (selected === undefined) throw new Error('Disconnected toolkit selection unexpectedly became empty')
        // A status check is observational. Only a requested connected-app task
        // or an explicit manage_connection action may initiate authorization.
        return {
          status: 'not_connected',
          toolkit: selected.slug,
          app_label: selected.name,
          logo_url: selected.logo ?? `https://logos.composio.dev/api/${encodeURIComponent(selected.slug)}`,
          connected_toolkits: resolved.filter(item => item.connected).map(item => item.slug),
          disconnected_toolkits: disconnected.map(item => item.slug),
          toolkit_connection_statuses: resolved.map(item => ({
            toolkit: item.slug, app_label: item.name, has_active_connection: item.connected,
            status_message: item.connected ? 'ACTIVE' : 'NOT_CONNECTED',
          })),
          next_action: 'report_connection_status',
          next_action_guidance: 'Report the inactive connection without initiating authorization. If the user also requested an app task, explain that it needs a connection and ask whether to connect; do not treat a status check as consent.',
        }
      }
      if (args.action === 'search') {
        const turnState = execution.agent === undefined ? undefined : turns.get(execution.agent)
        const queries = searchQueries(args.queries)
        const workflowSession = searchSession(args.session)
        const searchStrategy = stringValue(args.search_strategy)
        if (searchStrategy !== undefined && searchStrategy !== 'auto' && searchStrategy !== 'tool_search') throw new TypeError('Unsupported Composio search strategy')
        const requestedWorkflowId = workflowSessionId(args)
        if (turnState?.workflowId !== undefined && requestedWorkflowId === undefined) {
          throw new Error('Continue progressive connected-app discovery with the returned session id')
        }
        if (turnState?.workflowId !== undefined && requestedWorkflowId !== turnState.workflowId) {
          throw new Error('Connected-app search session does not match the active workflow')
        }
        const scope = discoveryKey({ apps: [...requestedApps(args.queries)].sort(), known: queries.map(query => query.known_fields ?? '').sort() })
        const queryKey = discoveryKey({ queries, searchStrategy: searchStrategy ?? 'auto' })
        const discoveryOnly = previousUnmatchedDiscovery(
          execution, requestedWorkflowId, session.sessionId, undefined, config.discoveryCacheTtlMs ?? 300_000,
        )
        if (requestedWorkflowId !== undefined && discoveryOnly.length >= (config.maxDiscoverySearches ?? 2)) {
          return {
            status: 'discovery_exhausted',
            session: { id: requestedWorkflowId },
            results: [],
            operations: [],
            next_action: 'use_existing_evidence',
            next_action_guidance: 'Discovery has not advanced to provider execution. Use the selected tools and exact contracts already returned if they can resolve the task. Otherwise explain the missing capability or identifier using existing evidence. These searches do not prove the provider cannot support the operation. Do not repeat discovery or connect an unrelated app.',
          }
        }
        const prior = previousUnmatchedDiscovery(
          execution, requestedWorkflowId, session.sessionId, scope, config.discoveryCacheTtlMs ?? 300_000,
        )
        const maxUnmatched = config.maxUnmatchedSearches ?? 2
        const duplicate = prior.find(value => record(value['discovery']) && value['discovery']['query_key'] === queryKey)
        const cached = duplicate ?? (prior.length >= maxUnmatched ? prior.at(-1) : undefined)
        if (cached !== undefined) {
          return {
            ...cached,
            next_action: 'report_discovery_limit',
            next_action_guidance: 'These searches found no matching tool. Explain this limitation using the existing evidence; this does not prove the provider cannot support it. Retry discovery only after new identifiers, execution evidence, account changes, or a new task. Do not connect an unrelated app.',
            discovery: { ...(record(cached['discovery']) ? cached['discovery'] : {}), cache_hit: true },
            operations: [],
          } as Record<string, JsonValue>
        }
        const fingerprint = JSON.stringify({ queries, workflowSession, searchStrategy: searchStrategy ?? 'auto' })
        if (turnState?.searchFingerprints.has(fingerprint)) {
          throw new Error('Connected-app search repeated without new evidence; refine the query or follow the current plan')
        }
        const model = stringValue(args.model)
        const result = await session.execute('COMPOSIO_SEARCH_TOOLS', {
          queries,
          session: workflowSession,
          ...(model === undefined ? {} : { model }),
          ...(searchStrategy === undefined ? {} : { search_strategy: searchStrategy }),
        })
        const sourceReceipt = await saveReceipt(
          ctx, config, execution, JSON.stringify(result), 'composio-search-tools.json',
          { tool: 'COMPOSIO_SEARCH_TOOLS' },
        )
        const scoped = scopeSearchResult(result, requestedApps(args.queries))
        const scopedResult = scoped.value
        const container: unknown = record(scopedResult) && record(scopedResult['data']) ? scopedResult['data'] : scopedResult
        if ([scopedResult, container].some(value => record(value) && (value['successful'] === false || value['success'] === false))) {
          throw new Error('Composio discovery failed; no capability conclusion was recorded. Retry after the provider error is resolved.')
        }
        turnState?.searchFingerprints.add(fingerprint)
        const discovered = new Set<string>()
        if (record(container) && Array.isArray(container['results'])) {
          for (const item of container['results']) {
            if (!record(item)) continue
            const primary = stringArray(item['primary_tool_slugs'])[0]
            if (primary !== undefined) discovered.add(primary)
          }
        }
        const returnedWorkflowId = returnedWorkflowSessionId(scopedResult)
        const activeWorkflowId = returnedWorkflowId ?? requestedWorkflowId
        if (turnState !== undefined && turnState.workflowId === undefined && activeWorkflowId !== undefined) {
          turnState.workflowId = activeWorkflowId
        }
        const stateKeys = new Set([
          workflowStateKey(identity, execution),
          workflowStateKey(identity, execution, returnedWorkflowId ?? requestedWorkflowId),
        ])
        const discoveredContracts = new Map(executionContracts(scopedResult, discovered).map(contract => [contract.tool_slug, contract]))
        const planned = plannedReadTools(scopedResult)
        for (const stateKey of stateKeys) {
          const selected = selectedTools.get(stateKey) ?? new Set<string>()
          for (const slug of discovered) selected.add(slug)
          selectedTools.set(stateKey, selected)
          const availableReads = plannedReads.get(stateKey) ?? new Set<string>()
          for (const slug of planned) availableReads.add(slug)
          plannedReads.set(stateKey, availableReads)
          const available = contracts.get(stateKey) ?? new Map<string, ExecutionContract>()
          for (const [slug, contract] of discoveredContracts) available.set(slug, contract)
          contracts.set(stateKey, available)
          const requested = new Set(resultFields.get(stateKey) ?? [])
          for (const field of requestedResultFields(args.queries)) requested.add(field)
          resultFields.set(stateKey, [...requested])
        }
        const statuses = connectionStatuses(scopedResult)
        const missing = requiredMissingToolkits(scopedResult, statuses)
        if (missing.length > 0) {
          const workflowSessionId = returnedWorkflowId
          const managed = await session.execute('COMPOSIO_MANAGE_CONNECTIONS', {
            toolkits: missing,
            ...(workflowSessionId === undefined ? {} : { session_id: workflowSessionId }),
          })
          const redirectUrl = safeHttpsUrl(firstString(managed, ['redirect_url', 'redirectUrl', 'connection_url', 'url']))
          const toolkit = missing[0]
          if (toolkit === undefined) throw new Error('Connection search returned no missing toolkit')
          const label = titleCaseToolkit(toolkit)
          const logoUrl = `https://logos.composio.dev/api/${encodeURIComponent(toolkit)}`
          const operations = [
            { tool: 'COMPOSIO_SEARCH_TOOLS', status: 'completed' },
            { tool: 'COMPOSIO_MANAGE_CONNECTIONS', status: redirectUrl === undefined ? 'failed' : 'completed' },
          ]
          const projected = compactComposioSearchReceipt(
            { status: 'connection_required', operations, result: scopedResult }, sourceReceipt,
          )
          if (redirectUrl !== undefined && workflowSessionId !== undefined && execution.agent !== undefined) {
            const connected = await awaitConnection(execution, {
              toolkit,
              appLabel: label,
              redirectUrl,
              logoUrl,
              workflowSessionId,
            }, async () => {
              const waited = await session.execute('COMPOSIO_WAIT_FOR_CONNECTIONS', {
                session_id: workflowSessionId,
                toolkits: [toolkit],
              })
              const matching = connectionStatuses(waited)
                .filter(item => item.toolkit.toLowerCase() === toolkit.toLowerCase())
              return matching.length > 0 && matching.every(item => item.connected)
            })
            if (connected) {
              const activeStatuses = Array.isArray(projected?.['toolkit_connection_statuses'])
                ? projected['toolkit_connection_statuses'].map((status) => {
                  if (!record(status) || stringValue(status['toolkit'])?.toLowerCase() !== toolkit.toLowerCase()) return status
                  return { ...status, has_active_connection: true, status_message: 'ACTIVE' }
                })
                : [{ toolkit, has_active_connection: true, status_message: 'ACTIVE' }]
              return {
                ...(record(projected) ? projected : {}),
                status: 'ready',
                session_id: workflowSessionId,
                toolkit,
                app_label: label,
                logo_url: logoUrl,
                connected_toolkits: [toolkit],
                toolkit_connection_statuses: activeStatuses,
                operations: [...operations, { tool: 'COMPOSIO_WAIT_FOR_CONNECTIONS', status: 'completed' }],
              }
            }
          }
          execution.concludeTurn()
          return {
            ...(record(projected) ? projected : {}),
            status: 'connection_required',
            operations,
            toolkit,
            app_label: label,
            logo_url: logoUrl,
            prompt: `Connect ${label} to continue, then return here.`,
            ...(redirectUrl === undefined ? {} : { redirect_url: redirectUrl }),
            ...(workflowSessionId === undefined ? {} : { session_id: workflowSessionId }),
          }
        }
        const operations = [{ tool: 'COMPOSIO_SEARCH_TOOLS', status: 'completed' }]
        const projected = compactComposioSearchReceipt({
          status: discovered.size === 0 ? 'no_matching_tool' : 'ready',
          operations,
          result: scopedResult,
        }, sourceReceipt)
        if (record(projected)) {
          projected['discovery'] = { version: 1, router_id: session.sessionId, scope, query_key: queryKey, recorded_at: Date.now(), cache_hit: false }
        }
        if (record(projected) && discovered.size === 0) {
          // Provider guidance describes the unscoped semantic candidates. Once
          // those candidates have been rejected, preserving instructions such
          // as "manage connections" would send the model into an unrelated
          // authorization flow. Keep the native model loop in control, but give
          // it one truthful bounded continuation based on the scoped evidence.
          delete projected['next_steps_guidance']
          delete projected['recommended_plan_steps']
          delete projected['known_pitfalls']
          const searches = prior.length + 1
          projected['next_action'] = searches >= maxUnmatched ? 'report_discovery_limit' : 'refine_search'
          projected['next_action_guidance'] = searches >= maxUnmatched
            ? 'No matching tool was found in these searches. Report that limitation, not that the provider cannot support the operation; do not check or connect another app.'
            : 'Refine search once in this same workflow session for the missing provider-owned prerequisite or listing operation. Do not check connection status or connect another app.'
        }
        return record(projected) ? projected : { status: 'ready', operations }
      }
      const key = workflowStateKey(identity, execution, workflowSessionId(args))
      const fallbackKey = workflowStateKey(identity, execution)
      let selectedForWorkflow = selectedTools.get(key) ?? selectedTools.get(fallbackKey)
      let plannedForWorkflow = plannedReads.get(key) ?? plannedReads.get(fallbackKey)
      let contractsForWorkflow = contracts.get(key) ?? contracts.get(fallbackKey)
      if (selectedForWorkflow === undefined || contractsForWorkflow === undefined) {
        const restored = restoreWorkflowState(execution, workflowSessionId(args))
        if (restored !== undefined) {
          selectedForWorkflow = restored.selected
          plannedForWorkflow = restored.plannedReads
          contractsForWorkflow = restored.contracts
          selectedTools.set(key, restored.selected)
          plannedReads.set(key, restored.plannedReads)
          contracts.set(key, restored.contracts)
          resultFields.set(key, restored.resultFields)
          selectedTools.set(fallbackKey, restored.selected)
          plannedReads.set(fallbackKey, restored.plannedReads)
          contracts.set(fallbackKey, restored.contracts)
          resultFields.set(fallbackKey, restored.resultFields)
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
        if (slugs.some(slug => !selectedForWorkflow?.has(slug) && !plannedForWorkflow?.has(slug))) {
          throw new Error('Schema request contains a tool not selected by the current search')
        }
        const result = await session.execute('COMPOSIO_GET_TOOL_SCHEMAS', { ...metaArguments, tool_slugs: slugs })
        const sourceReceipt = await saveReceipt(
          ctx, config, execution, JSON.stringify(result), 'composio-tool-schemas.json',
          { tool: 'COMPOSIO_GET_TOOL_SCHEMAS' },
        )
        const loaded = executionContracts(result, new Set(slugs))
        if (loaded.length !== new Set(slugs).size) throw new Error('Provider did not return an authoritative schema for every requested tool')
        const workflowContracts = contractsForWorkflow ?? new Map<string, ExecutionContract>()
        const workflowSelected = selectedForWorkflow ?? new Set<string>()
        for (const contract of loaded) {
          workflowContracts.set(contract.tool_slug, contract)
          workflowSelected.add(contract.tool_slug)
        }
        selectedTools.set(key, workflowSelected)
        selectedTools.set(fallbackKey, workflowSelected)
        contracts.set(key, workflowContracts)
        contracts.set(fallbackKey, workflowContracts)
        return {
          status: 'ready',
          operations: [{ tool: 'COMPOSIO_GET_TOOL_SCHEMAS', status: 'completed' }],
          execution_contracts: loaded as unknown as JsonValue,
          ...(sourceReceipt === undefined ? {} : {
            source_receipt: privateReceiptReference(sourceReceipt),
          }),
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
        const sourceReceipt = await saveReceipt(
          ctx, config, execution, JSON.stringify(managed),
          args.action === 'manage_connection' ? 'composio-manage-connections.json' : 'composio-wait-for-connections.json',
          { tool: metaTool },
        )
        const statuses = connectionStatuses(managed)
        // A successful meta-tool invocation is not proof of OAuth completion.
        // Require affirmative evidence for every requested toolkit; unknown or
        // contradictory provider status must leave the workflow paused.
        const pending = toolkits.filter((toolkit) => {
          const matching = statuses.filter(item => item.toolkit.toLowerCase() === toolkit.toLowerCase())
          return matching.length === 0 || matching.some(item => !item.connected)
        })
        const redirectUrl = safeHttpsUrl(firstString(managed, ['redirect_url', 'redirectUrl', 'connection_url', 'url']))
        if (pending.length > 0) execution.concludeTurn()
        return {
          ...compactComposioExecutionReceipt(managed, sourceReceipt) as Record<string, JsonValue>,
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
      const idempotencyKey = discoveryKey({
        workflow: key,
        tool_slug: slug,
        arguments: executionArguments,
        call_id: execution.callId,
      })
      if (MUTATING_TOOL.test(slug) && execution.agent !== undefined) {
        const completed = completedWriteForIdempotencyKey(
          execution.agent.session.snapshotEvents(),
          idempotencyKey,
        )
        if (completed !== undefined) {
          const priorReceipt = completed['source_receipt'] as JsonValue | undefined
          return {
            status: 'duplicate',
            idempotency_key: idempotencyKey,
            operations: [{ tool: slug, status: 'already_completed' }],
            ...(priorReceipt === undefined ? {} : { prior_receipt: priorReceipt }),
          }
        }
      }
      await admitHarnessCredit(ctx, config, execution, {
        sessionId: String(execution.agent?.session.header.id ?? ''), turnId: turns.get(execution.agent ?? {})?.turn ?? -1,
        kind: 'composio_execution', tool: slug,
      })
      const turnState = execution.agent === undefined ? undefined : turns.get(execution.agent)
      if (turnState !== undefined) turnState.billableCalls += 1
      const providerResult = await session.execute(slug, executionArguments)
      const fields = resultFields.get(key) ?? resultFields.get(fallbackKey) ?? []
      const sourceReceipt = await saveReceipt(
        ctx, config, execution, JSON.stringify(providerResult), `composio-${slug.toLowerCase()}.json`, {
          tool: slug,
          contractVersion: contract.schema_hash,
          allowedFields: fields,
          approvedProjection: flattenedRequestedProjection(providerResult, new Set(fields)),
        },
      )
      const compact = {
        ...compactComposioExecutionReceipt(
          providerResult,
          sourceReceipt,
          fields,
        ) as Record<string, JsonValue>,
        status: 'ready',
        ...(MUTATING_TOOL.test(slug) ? { idempotency_key: idempotencyKey } : {}),
        operations: [{ tool: slug, status: 'completed' }],
      } as Record<string, JsonValue>
      appendConnectedReceipt(execution, slug, compact, workflowSessionId(args))
      return compact
    },
  })))

  ctx.effect(() => ctx.on('agent/pre-step', async ({ agent, turn, step, messages, signal }, next) => {
    if (turns.get(agent)?.turn !== turn) {
      turns.set(agent, {
        turn,
        enabled: connectedAppsEnabled(ctx, config.enabledByDefault === true),
        searchFingerprints: new Set(),
        billableCalls: 0,
      })
    }
    const decision = await next()
    // Some test and compatibility middleware terminates the chain without a decision.
    if (decision === undefined || decision.kind === 'reject') return decision
    // Admit a user-originated turn before its first provider request. This is
    // a check, not a debit: terminal settlement below still owns exactly-once
    // charging after it knows whether the turn ran a connected operation.
    if (step === 1 && messages.length > 0) {
      await admitHarnessCredit(ctx, config, { signal, callId: `turn-${turn}-admission` }, {
        sessionId: String(agent.session.header.id), turnId: turn, kind: 'turn_admission',
      })
    }
    const unfinished = unfinishedWorkflow(agent.session.snapshotEvents(), turn)
    const receipt = latestConnectedReceipt(agent)
    const projections = [
      ...(unfinished !== undefined && shouldProjectWorkflow(messages) ? [workflowContextMessage(unfinished)] : []),
      ...(receipt === undefined ? [] : [connectedReceiptContextMessage(receipt)]),
    ]
    return projections.length === 0 ? decision : { ...decision, messages: [...decision.messages, ...projections] }
  }))
  ctx.effect(() => ctx.on('tools/pre-execute', async (execution, next) => {
    if (!isConnectedAppInvocation(execution.name, execution.arguments)) return next()
    const enabled = execution.agent !== undefined
      && (turns.get(execution.agent)?.enabled
        ?? connectedAppsEnabled(ctx, config.enabledByDefault === true))
    if (!enabled) return { kind: 'deny', reason: 'Connected tools are disabled for this turn. Enable Tools and retry.' }
    const downstream = await next()
    if (downstream.kind !== 'allow' || execution.name !== BRIDGE_TOOL || !record(execution.arguments)
      || execution.arguments['action'] !== 'execute') return downstream
    const slug = stringValue(execution.arguments['tool_slug'])
    if (slug === undefined || !MUTATING_TOOL.test(slug)) return downstream
    return { kind: 'ask', reason: `Approve this ${slug} action once. The provider will run only after approval.` }
  }))
  ctx.effect(() => ctx.on('tools/post-execute', async (execution, result, next): Promise<PostToolDecision> => {
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
    if (record(parsed) && record(parsed['source_receipt'])) return decision
    const receipt = await saveReceipt(ctx, config, execution, raw)
    const compact = isSearch
      ? compactComposioSearchReceipt(parsed, receipt)
      : compactComposioExecutionReceipt(parsed, receipt)
    return compact === undefined ? decision : { kind: 'accept', content: [{ type: 'text', text: JSON.stringify(compact) }] }
  }))
  ctx.effect(() => ctx.on('agent/turn-ended', async ({ agent, turn, signal, reason }) => {
    const state = turns.get(agent)
    if (reason.kind !== 'completed' || state === undefined || state.turn !== turn || state.billableCalls > 0 || signal.aborted) return
    await admitHarnessCredit(ctx, config, { signal, callId: `turn-${turn}` }, {
      sessionId: String(agent.session.header.id), turnId: turn, kind: 'no_tool_turn',
    })
  }))
}
