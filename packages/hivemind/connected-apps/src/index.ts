/** Tenant-scoped progressive Composio capability for HIVE-MIND. */

import type { Context } from '@deepseek-ai/cordis'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import type { Composio } from '@composio/core'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-hivemind-identity'
import type {} from '@deepseek-ai/dsh-hivemind-execution-scope'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
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

interface ConnectedWriteIntentEventData {
  readonly version: 1
  readonly idempotencyKey: string
  readonly workflowSessionId: string
  readonly plannedStepId: string
  readonly toolSlug: string
  readonly schemaHash: string
  readonly argumentsHash: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Authenticated Composio router session bound to one HIVE conversation.
     * Log-only: it restores provider state after runner restart and never
     * enters derived model history.
     */
    'hivemind/composio-session': ComposioRouterSessionEventData
    /**
     * Durable pre-dispatch fence for one connected-app write. If execution is
     * interrupted before a terminal tool result is committed, replay treats
     * the outcome as unknown and never dispatches the write automatically.
     */
    'hivemind/connected-write-intent': ConnectedWriteIntentEventData
  }
}

export const name = 'hivemind-connected-apps'
export const inject = ['tools', 'hivemindIdentity', 'hivemindExecutionScope', 'userQuestions']

const SEARCH_TOOL = 'mcp__composio__COMPOSIO_SEARCH_TOOLS'
const COMPOSIO_TOOL_PREFIX = 'mcp__composio__'
const CONNECTED_WORKFLOWS_SKILL = 'composio-connected-workflows'
const PLUGINS_SETTINGS_NAMESPACE = 'hivemind-plugins'
const BRIDGE_TOOL = 'hivemind_connected_task'
const RECEIPT_READ_TOOL = 'hivemind_connected_receipt_read'
const WORKFLOW_CONTEXT_SOURCE = 'dsh-hivemind-connected-apps/workflow'
const META_TOOLS = new Set([
  'COMPOSIO_SEARCH_TOOLS',
  'COMPOSIO_GET_TOOL_SCHEMAS',
  'COMPOSIO_MANAGE_CONNECTIONS',
  'COMPOSIO_WAIT_FOR_CONNECTIONS',
])
// Provider catalogs evolve faster than this bridge. External actions are
// approval-gated unless their leading operation is explicitly read-only;
// unknown verbs therefore fail closed instead of silently becoming writes.
const READ_ONLY_ACTIONS = new Set([
  'GET', 'LIST', 'SEARCH', 'FIND', 'FETCH', 'READ', 'LOOKUP', 'RETRIEVE',
  'QUERY', 'CHECK', 'DESCRIBE', 'INSPECT', 'PREVIEW', 'DOWNLOAD', 'EXPORT', 'COUNT',
])
const WRITE_ACTIONS = new Set([
  'SEND', 'CREATE', 'POST', 'PUBLISH', 'UPDATE', 'EDIT', 'PATCH', 'PUT',
  'DELETE', 'REMOVE', 'INVITE', 'PAY', 'TRANSFER', 'UPLOAD', 'WRITE', 'ADD',
  'CANCEL', 'SCHEDULE', 'MODIFY', 'SET', 'MOVE', 'RENAME', 'ARCHIVE',
  'RESTORE', 'UPSERT', 'REPLY', 'FORWARD',
])
const WRITE_REFERENCE_FIELDS = [
  'id', 'event_id', 'calendar_id', 'series_master_id', 'recurring_event_id',
  'resource_id', 'message_id', 'thread_id', 'url', 'attendees', 'organizer',
] as const

function requiresApproval(toolSlug: string): boolean {
  const tokens = toolSlug.toUpperCase().split('_')
  return tokens.some(token => WRITE_ACTIONS.has(token))
    || !tokens.some(token => READ_ONLY_ACTIONS.has(token))
}

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
  /** HIVE control-plane origin used for encrypted provider receipts. */
  receiptApiBase?: string
  /** Extra HTTP origins allowed for runner-to-control-plane receipt calls. */
  receiptHttpOrigins?: string[]
  /** Environment variable holding the runner service signing secret. */
  receiptServiceSecretEnv?: string
  /** Complete durable receipt request deadline. */
  receiptRequestTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  apiKey: z.string(),
  enabledByDefault: z.boolean().default(false),
  connectionCallbackBaseUrl: z.string(),
  discoveryCacheTtlMs: z.number().min(1).default(300_000),
  maxUnmatchedSearches: z.number().min(1).default(2),
  maxDiscoverySearches: z.number().min(1).default(2),
  receiptApiBase: z.string(),
  receiptHttpOrigins: z.array(String).default([]),
  receiptServiceSecretEnv: z.string().default('HIVE_HARNESS_RUNNER_SERVICE_SECRET'),
  receiptRequestTimeoutMs: z.number().min(1).default(10_000),
})

interface DurableReceiptRef {
  readonly receipt_id: string
  readonly stored: true
  readonly bytes: number
  readonly expires_at: string
  readonly allowed_fields: readonly string[]
}

interface DurableReceiptStore {
  save(execution: ToolExecution, input: {
    provider: string
    tool: string
    contractVersion?: string
    rawReceipt: unknown
    allowedFields: readonly string[]
    approvedProjection: Record<string, JsonValue>
    projectionPolicy: string
  }): Promise<DurableReceiptRef>
  read(execution: ToolExecution, receiptId: string, fields: readonly string[]): Promise<Record<string, JsonValue>>
}

declare module '@deepseek-ai/cordis' {
  interface Context { connectedAppReceiptStore: DurableReceiptStore }
}

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
  if (!Array.isArray(value)) throw new TypeError('Search requires a non-empty task or queries with one atomic use_case per external-app action')
  const queries = value.map((item) => {
    if (!record(item)) throw new TypeError('Each search query must be an object')
    const app = stringValue(item['app'])
    const explicitUseCase = stringValue(item['use_case'])
    const conventionalQuery = stringValue(item['query'])
    const baseUseCase = explicitUseCase ?? conventionalQuery
    if (baseUseCase === undefined) throw new TypeError('Each search query requires a non-empty use_case or query')
    const knownFields = stringValue(item['known_fields'])
    const orderBy = stringValue(item['order_by'])
    const limit = item['limit']
    if (limit !== undefined && (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 100)) {
      throw new TypeError('Search query limit must be an integer between 1 and 100')
    }
    const fields = stringArray(item['result_fields']).map(field => field.trim()).filter(Boolean)
    const useCase = explicitUseCase === undefined
      ? [
        baseUseCase.replace(/[.\s]+$/, ''),
        ...(orderBy === undefined ? [] : [`Order by ${orderBy.replace(/[.\s]+$/, '')}`]),
        ...(limit === undefined ? [] : [`Limit ${String(limit)}`]),
        ...(fields.length === 0 ? [] : [`Return ${fields.join(', ')}`]),
      ].join('. ') + '.'
      : baseUseCase
    const scopedUseCase = app === undefined || useCase.toLocaleLowerCase().includes(app.toLocaleLowerCase())
      ? useCase
      : `${app}: ${useCase}`
    return knownFields === undefined ? { use_case: scopedUseCase } : { use_case: scopedUseCase, known_fields: knownFields }
  })
  if (queries.length === 0 || queries.length > 8) throw new TypeError('Search requires between 1 and 8 atomic queries')
  return queries
}

function searchSession(value: unknown): { generate_id: true } | { id: string } {
  if (value === undefined) return { generate_id: true }
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
  return `${sessionKey(identity)}:${identity.orgId}:${conversation}:${workflowId ?? 'current'}`
}

function workflowStepKey(
  identity: { userId: string; orgId: string },
  execution: Pick<ToolExecution, 'agent'>,
  plannedStepId: string,
): string {
  return `${workflowStateKey(identity, execution)}:step:${plannedStepId}`
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
  workflowId: string
  selected: Set<string>
  contracts: Map<string, ExecutionContract>
  resultFields: string[]
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

function hasWriteIntentForIdempotencyKey(events: readonly unknown[], idempotencyKey: string): boolean {
  return events.some(event => record(event)
    && event['type'] === 'hivemind/connected-write-intent'
    && record(event['data'])
    && event['data']['idempotencyKey'] === idempotencyKey)
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
  readonly toolkits: string[]
  readonly selectedToolSlugs: string[]
}

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

/** Reconstruct only a connection workflow that still requires an explicit resume. */
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
      if (workflowId === undefined || !['connection_required', 'connection_pending'].includes(status)) {
        if (pending?.workflowId === workflowId) pending = undefined
        continue
      }
      const workflowContracts = executionContracts(result.value)
      pending = {
        turn: owner.turn ?? 0,
        workflowId,
        status,
        toolkits: workflowToolkits(result.value),
        selectedToolSlugs: workflowContracts.map(contract => contract.tool_slug),
      }
      continue
    }
    if (pending === undefined || (workflowId !== undefined && workflowId !== pending.workflowId)) continue
    if (action === 'wait_connection') {
      const toolkits = workflowToolkits(result.value)
      pending = status === 'ready'
        ? { ...pending, turn: owner.turn ?? pending.turn, status: 'resume_ready', toolkits: toolkits.length > 0 ? toolkits : pending.toolkits }
        : ['connection_required', 'connection_pending'].includes(status)
          ? { ...pending, turn: owner.turn ?? pending.turn, status, toolkits: toolkits.length > 0 ? toolkits : pending.toolkits }
          : undefined
      continue
    }
    if (action === 'execute') pending = undefined
  }
  return pending !== undefined && pending.turn < currentTurn ? pending : undefined
}

function workflowContextMessage(state: UnfinishedWorkflowProjection) {
  const waiting = state.status === 'connection_required' || state.status === 'connection_pending'
  const projection = {
    session_id: state.workflowId,
    status: state.status,
    toolkits: state.toolkits,
    selected_tool_slugs: state.selectedToolSlugs,
    next_action: waiting ? 'wait_connection' : 'execute_selected_tool',
  }
  return createUserMessage({
    content: [{
      type: 'text',
      text: `## Connected-app resume required\nA user-visible connection flow for this conversation requires an explicit resume. Reuse this session without repeating discovery. Do not infer schemas or provider data from this compact notice.\n${JSON.stringify(projection)}`,
    }],
    source: { kind: 'plugin', plugin: WORKFLOW_CONTEXT_SOURCE, form: 'recall' },
  })
}

function canonicalJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(canonicalJsonValue)
  if (record(value)) {
    const output: Record<string, JsonValue> = {}
    for (const key of Object.keys(value).sort()) {
      const entry = value[key]
      if (entry !== undefined) output[key] = canonicalJsonValue(entry)
    }
    return output
  }
  throw new TypeError('Connected-app execution identity accepts JSON values only')
}

function discoveryKey(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalJsonValue(value))).digest('hex')
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
    if ((key === 'description' || key === 'title') && typeof item === 'string') {
      compact[key] = item.length > 240 ? `${item.slice(0, 240)}…` : item
      continue
    }
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

function restoreWorkflowState(
  execution: Pick<ToolExecution, 'agent'>,
  requestedId?: string,
  requestedStepId?: string,
): RestoredWorkflowState | undefined {
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
    if (requestedStepId !== undefined && stringValue(args['planned_step_id']) !== requestedStepId) continue
    const candidateId = returnedWorkflowSessionId(result.value) ?? workflowSessionId(args)
    if (workflowId !== undefined && candidateId !== workflowId) continue
    workflowId = candidateId
    break
  }
  if (workflowId === undefined) return undefined
  const selected = new Set<string>()
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
      for (const contract of executionContracts(result.value, selected)) restoredContracts.set(contract.tool_slug, contract)
      continue
    }
    if (args?.['action'] !== 'schemas' || workflowSessionId(args) !== workflowId) continue
    for (const contract of executionContracts(result.value, selected)) restoredContracts.set(contract.tool_slug, contract)
  }
  return foundSearch ? { workflowId, selected, contracts: restoredContracts, resultFields: [...resultFields] } : undefined
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

const MAIL_HEADER_FIELDS: Readonly<Record<string, string>> = {
  from: 'sender',
  date: 'received_at',
  subject: 'subject',
  to: 'recipient',
}

function mailHeaderProjection(value: Record<string, unknown>): Record<string, JsonValue> {
  const payload = record(value['payload']) ? value['payload'] : undefined
  const candidates = [value['headers'], payload?.['headers']]
  const projected: Record<string, JsonValue> = {}
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    for (const item of candidate) {
      if (!record(item)) continue
      const name = stringValue(item['name'])?.trim().toLowerCase()
      const headerValue = stringValue(item['value'])?.trim()
      const semantic = name === undefined ? undefined : MAIL_HEADER_FIELDS[name]
      if (semantic !== undefined && headerValue !== undefined && headerValue !== '') {
        projected[semantic] = headerValue.length > 800 ? `${headerValue.slice(0, 800)}…` : headerValue
      }
    }
  }
  return projected
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
  if (typeof value === 'string') return value.length > 800 ? `${value.slice(0, 800)}…` : value
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 20).map(item => compactProviderValue(item))
  if (!record(value)) return String(value)
  // Provider message APIs often keep the only trustworthy sender and date in
  // MIME headers. Project those semantic values before omitting the transport
  // tree so a normal read never needs a second provider call or raw receipt.
  const compact: Record<string, JsonValue> = mailHeaderProjection(value)
  let count = Object.keys(compact).length
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

const RESULT_FIELD_ALIASES: Readonly<Record<string, readonly string[]>> = {
  sender: ['sender', 'from'],
  from: ['from', 'sender'],
  recipient: ['recipient', 'to'],
  to: ['to', 'recipient'],
  received_at: ['received_at', 'messageTimestamp', 'receivedAt', 'internalDate', 'internal_date', 'timestamp', 'date'],
  date: ['date', 'messageTimestamp', 'received_at', 'receivedAt', 'internalDate', 'internal_date', 'timestamp'],
  timestamp: ['timestamp', 'messageTimestamp', 'received_at', 'receivedAt', 'internalDate', 'internal_date', 'date'],
  snippet: ['snippet', 'messageText', 'previewText', 'bodyPreview'],
  body: ['body', 'messageText', 'snippet', 'text', 'content'],
}

function calendarEventRecord(value: Record<string, unknown>): boolean {
  return Object.hasOwn(value, 'start') || Object.hasOwn(value, 'end')
    || Object.hasOwn(value, 'eventType') || Object.hasOwn(value, 'event_type')
}

function calendarTemporalField(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!record(value)) return undefined
  return stringValue(value['dateTime']) ?? stringValue(value['date_time']) ?? stringValue(value['date'])
}

function calendarProviderField(value: Record<string, unknown>, field: string): JsonValue | undefined {
  if (!calendarEventRecord(value)) return undefined
  if (field === 'title') return stringValue(value['title']) ?? stringValue(value['summary'])
  if (field === 'start_time' || field === 'start_at') {
    return calendarTemporalField(value['start_time'] ?? value['startTime'] ?? value['start'])
  }
  if (field === 'end_time' || field === 'end_at') {
    return calendarTemporalField(value['end_time'] ?? value['endTime'] ?? value['end'])
  }
  if (field === 'timezone' || field === 'time_zone') {
    const start = record(value['start']) ? value['start'] : undefined
    const end = record(value['end']) ? value['end'] : undefined
    return stringValue(value['timezone']) ?? stringValue(value['timeZone'])
      ?? stringValue(start?.['timeZone']) ?? stringValue(start?.['time_zone'])
      ?? stringValue(end?.['timeZone']) ?? stringValue(end?.['time_zone'])
  }
  if (field === 'location') return stringValue(value['location'])
  return undefined
}

function semanticProviderField(value: Record<string, unknown>, field: string, tool?: string): JsonValue | undefined {
  if (tool?.startsWith('GOOGLECALENDAR_')) {
    const calendar = calendarProviderField(value, field)
    if (calendar !== undefined) return calendar
  }
  const aliases = RESULT_FIELD_ALIASES[field] ?? [field]
  const direct = aliases.find(key => Object.hasOwn(value, key) && value[key] !== undefined)
  if (direct !== undefined) return value[direct] as JsonValue
  const headers = mailHeaderProjection(value)
  const canonical = field === 'from' ? 'sender'
    : field === 'date' || field === 'timestamp' ? 'received_at'
      : field === 'to' ? 'recipient'
        : field
  return headers[canonical]
}

function projectRequestedFields(value: unknown, requested: ReadonlySet<string>, tool?: string): JsonValue | undefined {
  if (Array.isArray(value)) {
    const projected = value.flatMap((item): JsonValue[] => {
      const nested = projectRequestedFields(item, requested, tool)
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
    const nested = projectRequestedFields(item, requested, tool)
    if (nested !== undefined && (!Array.isArray(nested) || nested.length > 0)
      && (!record(nested) || Object.keys(nested).length > 0)) projected[key] = nested
  }
  for (const field of requested) {
    if (Object.hasOwn(projected, field)) continue
    const semantic = semanticProviderField(value, field, tool)
    if (semantic !== undefined) projected[field] = compactProviderValue(semantic)
  }
  return Object.keys(projected).length === 0 ? undefined : projected
}

function approvedFieldProjection(value: unknown, requestedFields: readonly string[], tool?: string): Record<string, JsonValue> {
  const output: Record<string, JsonValue> = {}
  const visit = (candidate: unknown, field: string, depth: number): JsonValue[] => {
    if (depth > 8) return []
    if (Array.isArray(candidate)) return candidate.flatMap(item => visit(item, field, depth + 1))
    if (!record(candidate)) return []
    const semantic = semanticProviderField(candidate, field, tool)
    if (semantic !== undefined) return [semantic]
    return Object.values(candidate).flatMap(item => visit(item, field, depth + 1))
  }
  for (const field of requestedFields) {
    const values = visit(value, field, 0)
    if (values.length === 1 && values[0] !== undefined) output[field] = values[0]
    else if (values.length > 1) output[field] = values
  }
  return output
}

function privateReceiptProjection(receipt: DurableReceiptRef): Record<string, JsonValue> {
  return {
    stored: true,
    receipt_id: receipt.receipt_id,
    bytes: receipt.bytes,
    expires_at: receipt.expires_at,
    allowed_fields: [...receipt.allowed_fields],
  }
}

interface ConnectedAppInspection {
  readonly version: 1
  readonly workflow_session_id: string
  readonly contract_cache_hit: boolean
  readonly schema_hash: string
  readonly arguments_hash: string
  readonly execution_key: string
  readonly receipt_reused: boolean
  readonly reused_receipt_id?: string
}

const INSPECTION_KEY = '_hivemind_connected_app_inspection'

function withInspection(
  value: Record<string, JsonValue>,
  inspection: ConnectedAppInspection,
): Record<string, JsonValue> {
  return { ...value, [INSPECTION_KEY]: inspection as unknown as JsonValue }
}

function modelVisibleConnectedAppResult(value: JsonValue): JsonValue {
  if (!record(value) || !Object.hasOwn(value, INSPECTION_KEY)) return value
  const { [INSPECTION_KEY]: _inspection, ...visible } = value
  return visible as JsonValue
}

function connectedAppPresentationMeta(value: JsonValue): JsonValue {
  if (!record(value) || !record(value[INSPECTION_KEY])) return {}
  return { connected_app: value[INSPECTION_KEY] as JsonValue }
}

function receiptId(value: unknown): string | undefined {
  if (!record(value)) return undefined
  const receipt = record(value['private_receipt'])
    ? value['private_receipt']
    : record(value['source_receipt'])
      ? value['source_receipt']
      : record(value['prior_receipt'])
        ? value['prior_receipt']
        : undefined
  return stringValue(receipt?.['receipt_id'])
}

/** Bound a provider execution so MIME payloads and transport noise stay out of the transcript. */
export function compactComposioExecutionReceipt(
  value: unknown,
  receipt?: DurableReceiptRef,
  resultFields: readonly string[] = [],
  tool?: string,
): JsonValue {
  const requested = new Set(resultFields)
  const compact = requested.size === 0
    ? compactProviderValue(value)
    : projectRequestedFields(value, requested, tool) ?? compactProviderValue(value)
  const pagination = paginationProjection(value)
  return {
    ...(record(compact) ? compact : { result: compact }),
    ...(receipt === undefined ? {} : { private_receipt: privateReceiptProjection(receipt) }),
    projection_policy: requested.size === 0
      ? 'Duplicated MIME transport trees and transport headers omitted; readable evidence retained, while long text and collections are bounded. The original receipt is stored privately when private_receipt is present.'
      : 'Only the exact requested result fields are projected when present. The original provider receipt is preserved separately.',
    ...(pagination === undefined ? {} : { pagination }),
  }
}

/** Create a bounded model-visible projection while retaining the full receipt privately. */
export function compactComposioSearchReceipt(value: unknown, _receipt?: DurableReceiptRef): Record<string, JsonValue> | undefined {
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
    schema_policy: 'Use the exact execution_contracts below. If a selected slug has no contract, load its schema before execution. Never infer argument names.',
  }
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

function receiptServiceBase(value: string, allowedOrigins: readonly string[]): URL {
  const url = new URL(value)
  const local = url.protocol === 'http:' && ['control-plane', 'hivemind-control-plane', 'localhost', '127.0.0.1'].includes(url.hostname)
  const explicitlyAllowed = allowedOrigins.some((origin) => {
    try { return new URL(origin).origin === url.origin } catch { return false }
  })
  if (url.protocol !== 'https:' && !local && !explicitlyAllowed) throw new TypeError('Connected receipt API must use HTTPS or an allowed local origin')
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new TypeError('Connected receipt API base must contain only an origin')
  }
  return new URL(url.origin)
}

function runnerToken(ctx: Context, config: Config): string {
  const principal = ctx.hivemindExecutionScope.require()
  const envName = config.receiptServiceSecretEnv?.trim() || 'HIVE_HARNESS_RUNNER_SERVICE_SECRET'
  const secret = process.env[envName]
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) throw new Error('Connected receipt service secret is unavailable')
  const now = Math.floor(Date.now() / 1000)
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  const claims = {
    iss: 'hivemind-harness-runner', aud: 'hivemind-control-plane-harness-proxy',
    sub: principal.userId, org_id: principal.orgId, profile: principal.profile,
    ...(principal.projectId === undefined ? {} : { project_id: principal.projectId }),
    iat: now, exp: now + 30, jti: randomUUID(),
  }
  const signed = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`
  return `${signed}.${createHmac('sha256', secret).update(signed).digest('base64url')}`
}

function callTurn(execution: ToolExecution): number | undefined {
  const events = execution.agent?.session.snapshotEvents() ?? []
  return events.map(bridgeCall).find(call => call?.callId === String(execution.callId))?.turn
}

function createDurableReceiptStore(ctx: Context, config: Config): DurableReceiptStore {
  if (config.receiptApiBase === undefined) throw new TypeError('Connected receipt API is required')
  const base = receiptServiceBase(config.receiptApiBase, config.receiptHttpOrigins ?? [])
  const request = async (execution: ToolExecution, path: string, body: unknown): Promise<Record<string, unknown>> => {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, config.receiptRequestTimeoutMs ?? 10_000)
    try {
      const response = await fetch(new URL(path, base), {
        method: 'POST', redirect: 'manual', signal: AbortSignal.any([execution.signal, controller.signal]),
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${runnerToken(ctx, config)}` },
        body: JSON.stringify(body),
      })
      const raw = await response.text()
      if (Buffer.byteLength(raw, 'utf8') > 1024 * 1024) throw new Error('Connected receipt response exceeds its byte limit')
      let parsed: unknown
      try { parsed = JSON.parse(raw) } catch { throw new Error('Connected receipt service returned invalid JSON') }
      if (!response.ok) throw new Error(`Connected receipt service rejected the operation: ${record(parsed) ? stringValue(parsed['error']) ?? response.status : response.status}`)
      if (!record(parsed)) throw new Error('Connected receipt service returned an invalid response')
      return parsed
    } finally { clearTimeout(timer) }
  }
  return {
    async save(execution, input) {
      const sessionId = execution.agent?.session.header.id
      if (sessionId === undefined) throw new Error('Connected receipt storage requires an owning session')
      const value = await request(execution, '/internal/v1/harness-chat/receipts', {
        session_id: String(sessionId), turn_id: callTurn(execution), call_id: String(execution.callId),
        provider: input.provider, tool: input.tool, contract_version: input.contractVersion,
        raw_receipt: input.rawReceipt, allowed_fields: input.allowedFields,
        approved_projection: input.approvedProjection, projection_policy: input.projectionPolicy,
      })
      const receiptId = stringValue(value['receipt_id'])
      const expiresAt = stringValue(value['expires_at'])
      if (receiptId === undefined || expiresAt === undefined || value['stored'] !== true || typeof value['bytes'] !== 'number') {
        throw new Error('Connected receipt service returned an invalid storage receipt')
      }
      return { receipt_id: receiptId, stored: true, bytes: value['bytes'], expires_at: expiresAt, allowed_fields: stringArray(value['allowed_fields']) }
    },
    async read(execution, receiptId, fields) {
      const sessionId = execution.agent?.session.header.id
      if (sessionId === undefined) throw new Error('Connected receipt read requires an owning session')
      const value = await request(execution, `/internal/v1/harness-chat/receipts/${encodeURIComponent(receiptId)}/read`, {
        session_id: String(sessionId), fields,
      })
      if (!record(value['fields'])) throw new Error('Connected receipt service returned invalid fields')
      return value['fields'] as Record<string, JsonValue>
    },
  }
}

async function saveReceipt(
  ctx: Context,
  execution: ToolExecution,
  value: unknown,
  options: { tool?: string; contractVersion?: string; resultFields?: readonly string[] } = {},
): Promise<DurableReceiptRef | undefined> {
  const sessionId = execution.agent?.session.header.id
  const store = ctx.get('connectedAppReceiptStore')
  if (sessionId === undefined || store === undefined) return undefined
  const resultFields = options.resultFields ?? []
  try {
    return await store.save(execution, {
      provider: 'composio', tool: options.tool ?? execution.name,
      ...(options.contractVersion === undefined ? {} : { contractVersion: options.contractVersion }),
      rawReceipt: value, allowedFields: resultFields,
      approvedProjection: approvedFieldProjection(value, resultFields, options.tool ?? execution.name),
      projectionPolicy: resultFields.length === 0 ? 'private-source-v1' : 'selected-contract-v1',
    })
  } catch (error: unknown) {
    ctx.logger.warn(`hivemind-connected-apps: could not persist durable provider receipt: ${String(error)}`)
    throw new Error('Connected app result could not be stored durably')
  }
}

/** Register the compact progressive Composio router and its policy guards. */
export function apply(ctx: Context, config: Config = {}): void {
  if (ctx.get('connectedAppReceiptStore') === undefined && config.receiptApiBase !== undefined) {
    ctx.provide('connectedAppReceiptStore', createDurableReceiptStore(ctx, config))
  }
  const turns = new WeakMap<object, {
    turn: number
    enabled: boolean
    searchFingerprints: Set<string>
    executionResults: Map<string, Record<string, JsonValue>>
  }>()
  const apiKey = config.apiKey?.trim()
  const composio = apiKey
    ? import('@composio/core').then(({ Composio }) => new Composio({ apiKey, allowTracking: false, disableVersionCheck: true }))
    : undefined
  type ComposioSession = Awaited<ReturnType<Composio['sessions']['create']>>
  const sessions = new Map<string, Promise<ComposioSession>>()
  const selectedTools = new Map<string, Set<string>>()
  const contracts = new Map<string, Map<string, ExecutionContract>>()
  const resultFields = new Map<string, string[]>()
  const workflowSteps = new Map<string, string>()

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

  ctx.tools.register(defineTool({
    name: RECEIPT_READ_TOOL,
    description: 'Read only explicitly approved fields from one encrypted connected-app receipt created in this same authenticated conversation. Use only when the initial bounded result lacks a field that the selected execution contract already approved.',
    parameters: {
      receipt_id: { type: 'string', required: true, description: 'Opaque receipt id returned by a completed connected-app execution.' },
      fields: { type: 'array', required: true, items: { type: 'string' }, description: 'One or more fields already approved by the original selected execution contract.' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, value: JsonValue) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, execution) {
      if (!connectedAppsEnabled(ctx, config.enabledByDefault === true)) throw new Error('Connected tools are disabled for this turn. Enable Tools and retry.')
      const receiptId = stringValue(args.receipt_id)
      const requested = stringArray(args.fields)
      if (receiptId === undefined || requested.length === 0 || requested.length > 32) throw new TypeError('Receipt read requires an opaque receipt_id and between 1 and 32 approved fields')
      const store = ctx.get('connectedAppReceiptStore')
      if (store === undefined) throw new Error('Durable connected-app receipts are not configured on this runtime')
      return {
        status: 'ready', receipt_id: receiptId,
        fields: await store.read(execution, receiptId, requested),
        operations: [{ tool: RECEIPT_READ_TOOL, status: 'completed' }],
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: BRIDGE_TOOL,
    description: 'Tenant-scoped connected-app gateway. Reuse the returned session and selected contract when continuing the same connected-app task or executing a dependent step. Start a new search only for a genuinely new provider operation or when the contract is missing or stale. Search uses atomic queries, explicit outcomes, and exact result limits; never guess tools. External writes require HIVE approval.',
    parameters: {
      action: { type: 'string', required: true, enum: ['connection_status', 'search', 'schemas', 'manage_connection', 'wait_connection', 'execute'], description: 'Use connection_status only for a pure status check of explicitly named apps. Use search for real app work.' },
      task: { type: 'string', description: 'Simple single-action search shorthand. State the service category, operation, filters, ordering, limit, and output fields. Use queries for multiple actions.' },
      apps: { type: 'array', items: { type: 'string' }, description: 'One to four explicit app names for connection_status. Resolved against authenticated toolkit metadata, never semantic tool search.' },
      queries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            app: { type: 'string', description: 'External app only when explicitly named or already established. Omit it when the user named only a service category so authenticated discovery can select an active provider.' },
            use_case: { type: 'string', description: 'Normalized complete use case for one atomic app action. Name the app; include operation, filters, ordering, limit, and required output fields. Do not include personal identifiers.' },
            query: { type: 'string', description: 'Conventional alias for use_case. Prefer use_case; filters, ordering, limit, and output fields are normalized into the atomic request.' },
            limit: { type: 'integer', description: 'Requested maximum result count from 1 to 100 when query is used.' },
            order_by: { type: 'string', description: 'Requested ordering when query is used, for example received_at descending.' },
            known_fields: { type: 'string', description: 'Optional comma-separated key:value identifiers or settings. Keep to 1-2 short items.' },
            result_fields: {
              type: 'array', items: { type: 'string' },
              description: 'Semantic fields required in the final answer, such as sender, received_at, subject, and snippet. Registered provider aliases normalize these fields after execution; this list is omitted from Composio search.',
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
      tool_slugs: { type: 'array', items: { type: 'string' }, description: 'Selected tool slugs for schema loading.' },
      toolkits: { type: 'array', items: { type: 'string' }, description: 'Exact toolkits returned by search.' },
      session_id: { type: 'string', description: 'Search session id reused by later schema, connection, and execution operations.' },
      planned_step_id: { type: 'string', description: 'Stable identifier for one planned provider step. Use a different id for a different dependent operation; reuse it only when retrying the same logical step.' },
      arguments: { type: 'object', additionalProperties: true, description: 'Selected tool arguments.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value: JsonValue) => [{ type: 'text', text: JSON.stringify(modelVisibleConnectedAppResult(value)) }],
      presentationMeta: (_args, value: JsonValue) => connectedAppPresentationMeta(value),
    },
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
        const managed = await session.execute('COMPOSIO_MANAGE_CONNECTIONS', { toolkits: [selected.slug] })
        const sourceReceipt = await saveReceipt(ctx, execution, managed, { tool: 'COMPOSIO_MANAGE_CONNECTIONS' })
        const redirectUrl = safeHttpsUrl(firstString(managed, ['redirect_url', 'redirectUrl', 'connection_url', 'url']))
        const logoUrl = selected.logo ?? `https://logos.composio.dev/api/${encodeURIComponent(selected.slug)}`
        const conversationId = execution.agent === undefined ? undefined : execution.agent.session?.header.id
        if (redirectUrl !== undefined && conversationId !== undefined && execution.agent !== undefined) {
          const connected = await awaitConnection(execution, {
            toolkit: selected.slug,
            appLabel: selected.name,
            redirectUrl,
            logoUrl,
            workflowSessionId: `connection:${String(conversationId)}`,
          }, async () => exactToolkit(
            await session.toolkits({ toolkits: [selected.slug], limit: 1 }), selected.name,
          ).connected)
          if (connected) {
            return {
              ...compactComposioExecutionReceipt(managed, sourceReceipt) as Record<string, JsonValue>,
              status: 'ready',
              toolkit: selected.slug,
              app_label: selected.name,
              logo_url: logoUrl,
              connected_toolkits: [selected.slug],
              toolkit_connection_statuses: [{
                toolkit: selected.slug, app_label: selected.name, has_active_connection: true, status_message: 'ACTIVE',
              }],
              operations: [{ tool: 'COMPOSIO_MANAGE_CONNECTIONS', status: 'completed' }],
              next_action: 'continue_current_request',
              next_action_guidance: 'Connection is now active. Continue the same user request with connected-app search; do not end the turn, ask the user to repeat it, or switch to HIVE memory.',
            }
          }
        }
        execution.concludeTurn()
        return {
          ...compactComposioExecutionReceipt(managed, sourceReceipt) as Record<string, JsonValue>,
          status: 'connection_required',
          toolkit: selected.slug,
          app_label: selected.name,
          logo_url: logoUrl,
          prompt: `Connect ${selected.name} to continue, then return here.`,
          ...(redirectUrl === undefined ? {} : { redirect_url: redirectUrl }),
          operations: [{ tool: 'COMPOSIO_MANAGE_CONNECTIONS', status: redirectUrl === undefined ? 'failed' : 'completed' }],
        }
      }
      if (args.action === 'search') {
        const turnState = execution.agent === undefined ? undefined : turns.get(execution.agent)
        const task = stringValue(args.task)
        const queryInput = Array.isArray(args.queries)
          ? args.queries
          : task === undefined ? args.queries : [{ use_case: task }]
        const queries = searchQueries(queryInput)
        const workflowSession = searchSession(args.session)
        const searchStrategy = stringValue(args.search_strategy)
        if (searchStrategy !== undefined && searchStrategy !== 'auto' && searchStrategy !== 'tool_search') throw new TypeError('Unsupported Composio search strategy')
        const requestedWorkflowId = workflowSessionId(args)
        const scope = discoveryKey({ apps: [...requestedApps(queryInput)].sort(), known: queries.map(query => query.known_fields ?? '').sort() })
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
        const plannedStepId = stringValue(args.planned_step_id) ?? 'discovery'
        const fingerprint = JSON.stringify({ plannedStepId, queries, workflowSession, searchStrategy: searchStrategy ?? 'auto' })
        if (turnState?.searchFingerprints.has(fingerprint)) {
          throw new Error('Connected-app search repeated without new evidence; refine the query or follow the current plan')
        }
        const model = stringValue(args.model)
        let result: unknown
        try {
          result = await session.execute('COMPOSIO_SEARCH_TOOLS', {
            queries,
            session: workflowSession,
            ...(model === undefined ? {} : { model }),
            ...(searchStrategy === undefined ? {} : { search_strategy: searchStrategy }),
          })
        } catch (error: unknown) {
          if (execution.signal.aborted || (record(error) && error['name'] === 'AbortError')) throw error
          ctx.logger.warn(`hivemind-connected-apps: provider discovery failed: ${String(error)}`)
          return {
            status: 'provider_unavailable',
            retryable: false,
            evidence_complete: false,
            operations: [{ tool: 'COMPOSIO_SEARCH_TOOLS', status: 'failed' }],
            next_action: 'report_provider_failure',
            next_action_guidance: 'Provider discovery failed for this turn before any capability or data conclusion could be established. Do not retry in this turn and do not report that an app, contact, event, or record does not exist.',
          }
        }
        const sourceReceipt = await saveReceipt(ctx, execution, result, { tool: 'COMPOSIO_SEARCH_TOOLS' })
        const scoped = scopeSearchResult(result, requestedApps(queryInput))
        const scopedResult = scoped.value
        const container: unknown = record(scopedResult) && record(scopedResult['data']) ? scopedResult['data'] : scopedResult
        if ([scopedResult, container].some(value => record(value) && (value['successful'] === false || value['success'] === false))) {
          return {
            status: 'provider_unavailable',
            retryable: false,
            evidence_complete: false,
            operations: [{ tool: 'COMPOSIO_SEARCH_TOOLS', status: 'failed' }],
            next_action: 'report_provider_failure',
            next_action_guidance: 'Provider discovery failed for this turn before any capability or data conclusion could be established. Do not retry in this turn and do not report that an app, contact, event, or record does not exist.',
          }
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
        if (discovered.size > 0 && activeWorkflowId === undefined) {
          ctx.logger.warn('hivemind-connected-apps: provider returned selected tools without a workflow session id')
          return {
            status: 'provider_unavailable',
            retryable: false,
            evidence_complete: false,
            operations: [{ tool: 'COMPOSIO_SEARCH_TOOLS', status: 'failed' }],
            next_action: 'report_provider_failure',
            next_action_guidance: 'Provider discovery returned no scoped workflow identity, so no tool was authorized. Do not retry in this turn, execute, or infer availability from this result.',
          }
        }
        // A conversation can execute several independent provider steps in one
        // native turn (for example find an event, then patch it). Keep each
        // search contract behind its own provider workflow id. The unqualified
        // fallback is used only when the provider returned no workflow id.
        const stateKeys = new Set([
          workflowStateKey(identity, execution, activeWorkflowId),
        ])
        const discoveredContracts = new Map(executionContracts(scopedResult, discovered).map(contract => [contract.tool_slug, contract]))
        for (const stateKey of stateKeys) {
          const selected = selectedTools.get(stateKey) ?? new Set<string>()
          for (const slug of discovered) selected.add(slug)
          selectedTools.set(stateKey, selected)
          const available = contracts.get(stateKey) ?? new Map<string, ExecutionContract>()
          for (const [slug, contract] of discoveredContracts) available.set(slug, contract)
          contracts.set(stateKey, available)
          const requested = new Set(resultFields.get(stateKey) ?? [])
          for (const field of requestedResultFields(queryInput)) requested.add(field)
          resultFields.set(stateKey, [...requested])
        }
        if (activeWorkflowId !== undefined) {
          workflowSteps.set(workflowStepKey(identity, execution, plannedStepId), activeWorkflowId)
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
      let continuationId = workflowSessionId(args)
      const plannedStepId = stringValue(args.planned_step_id)
      const requestedSlugs = args.action === 'execute'
        ? stringArray([args.tool_slug])
        : args.action === 'schemas'
          ? (stringArray(args.tool_slugs).length > 0 ? stringArray(args.tool_slugs) : stringArray([args.tool_slug]))
          : []
      if (continuationId === undefined && plannedStepId !== undefined) {
        continuationId = workflowSteps.get(workflowStepKey(identity, execution, plannedStepId))
      }
      if (continuationId === undefined && requestedSlugs.length > 0) {
        const scopePrefix = `${workflowStateKey(identity, execution).slice(0, -'current'.length)}`
        const candidates = [...selectedTools.entries()]
          .filter(([stateKey, selected]) => stateKey.startsWith(scopePrefix)
            && !stateKey.endsWith(':current')
            && requestedSlugs.every(slug => selected.has(slug)))
          .map(([stateKey]) => stateKey.slice(scopePrefix.length))
        if (candidates.length === 1) continuationId = candidates[0]
      }
      let key = workflowStateKey(identity, execution, continuationId)
      let selectedForWorkflow = selectedTools.get(key)
      let contractsForWorkflow = contracts.get(key)
      if (selectedForWorkflow === undefined || contractsForWorkflow === undefined) {
        const restored = restoreWorkflowState(execution, continuationId, plannedStepId)
        if (restored !== undefined) {
          continuationId = restored.workflowId
          key = workflowStateKey(identity, execution, continuationId)
          selectedForWorkflow = restored.selected
          contractsForWorkflow = restored.contracts
          selectedTools.set(key, restored.selected)
          contracts.set(key, restored.contracts)
          resultFields.set(key, restored.resultFields)
          if (plannedStepId !== undefined) workflowSteps.set(workflowStepKey(identity, execution, plannedStepId), continuationId)
        }
      }
      const metaArguments: Record<string, unknown> = {}
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
        const sourceReceipt = await saveReceipt(ctx, execution, result, { tool: 'COMPOSIO_GET_TOOL_SCHEMAS' })
        const loaded = executionContracts(result, new Set(slugs))
        const workflowContracts = contractsForWorkflow ?? new Map<string, ExecutionContract>()
        for (const contract of loaded) workflowContracts.set(contract.tool_slug, contract)
        contracts.set(key, workflowContracts)
        return {
          status: 'ready',
          operations: [{ tool: 'COMPOSIO_GET_TOOL_SCHEMAS', status: 'completed' }],
          execution_contracts: loaded as unknown as JsonValue,
          ...(sourceReceipt === undefined ? {} : { private_receipt: privateReceiptProjection(sourceReceipt) }),
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
        const sourceReceipt = await saveReceipt(ctx, execution, managed, { tool: metaTool })
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
      const workflowId = continuationId ?? 'current'
      const resolvedStepId = plannedStepId ?? 'execute'
      const argumentsHash = discoveryKey(executionArguments)
      const executionFingerprint = discoveryKey({
        workflow_id: workflowId,
        planned_step_id: resolvedStepId,
        tool_slug: slug,
        schema_hash: contract.schema_hash,
        arguments_hash: argumentsHash,
      })
      const inspection = (receiptReused: boolean, reusedReceiptId?: string): ConnectedAppInspection => ({
        version: 1,
        workflow_session_id: workflowId,
        contract_cache_hit: true,
        schema_hash: contract.schema_hash,
        arguments_hash: argumentsHash,
        execution_key: executionFingerprint,
        receipt_reused: receiptReused,
        ...(reusedReceiptId === undefined ? {} : { reused_receipt_id: reusedReceiptId }),
      })
      const turnState = execution.agent === undefined ? undefined : turns.get(execution.agent)
      const completedRead = turnState?.executionResults.get(executionFingerprint)
      if (!requiresApproval(slug) && completedRead !== undefined) {
        return withInspection({
          ...completedRead,
          repeated_execution: true,
          operations: [{ tool: slug, status: 'already_completed' }],
        }, inspection(true, receiptId(completedRead)))
      }
      const idempotencyKey = executionFingerprint
      if (requiresApproval(slug) && execution.agent !== undefined) {
        const events = execution.agent.session.snapshotEvents()
        const completed = completedWriteForIdempotencyKey(
          events,
          idempotencyKey,
        )
        if (completed !== undefined) {
          const priorReceipt = (completed['private_receipt'] ?? completed['source_receipt']) as JsonValue | undefined
          return withInspection({
            status: 'duplicate',
            idempotency_key: idempotencyKey,
            operations: [{ tool: slug, status: 'already_completed' }],
            ...(priorReceipt === undefined ? {} : { prior_receipt: priorReceipt }),
          }, inspection(true, receiptId(completed)))
        }
        if (hasWriteIntentForIdempotencyKey(events, idempotencyKey)) {
          return withInspection({
            status: 'unknown_outcome',
            retryable: false,
            idempotency_key: idempotencyKey,
            operations: [{ tool: slug, status: 'not_retried' }],
            next_action: 'reconcile_write_status',
            next_action_guidance: 'A prior dispatch of this exact write did not commit a terminal receipt. Do not execute it again automatically. Reconcile provider state using an authorized read or ask the user before any replacement action.',
          }, inspection(false))
        }
        execution.agent.session.append('hivemind/connected-write-intent', {
          version: 1,
          idempotencyKey,
          workflowSessionId: workflowId,
          plannedStepId: resolvedStepId,
          toolSlug: slug,
          schemaHash: contract.schema_hash,
          argumentsHash,
        })
      }
      const providerResult = await session.execute(slug, executionArguments)
      const selectedResultFields = resultFields.get(key) ?? []
      const durableResultFields = requiresApproval(slug)
        ? [...new Set([...selectedResultFields, ...WRITE_REFERENCE_FIELDS])]
        : selectedResultFields
      const sourceReceipt = await saveReceipt(
        ctx, execution, providerResult, {
          tool: slug,
          contractVersion: contract.tool_version ?? contract.schema_hash,
          resultFields: durableResultFields,
        },
      )
      const projected = {
        ...compactComposioExecutionReceipt(
          providerResult,
          sourceReceipt,
          durableResultFields,
          slug,
        ) as Record<string, JsonValue>,
        status: 'ready',
        ...(requiresApproval(slug) ? { idempotency_key: idempotencyKey } : {}),
        operations: [{ tool: slug, status: 'completed' }],
      }
      if (!requiresApproval(slug)) turnState?.executionResults.set(executionFingerprint, projected)
      return withInspection(projected, inspection(false))
    },
  }))

  ctx.on('agent/pre-step', async ({ agent, turn }, next) => {
    if (turns.get(agent)?.turn !== turn) {
      turns.set(agent, {
        turn,
        enabled: connectedAppsEnabled(ctx, config.enabledByDefault === true),
        searchFingerprints: new Set(),
        executionResults: new Map(),
      })
    }
    const decision = await next()
    // Some test and compatibility middleware terminates the chain without a decision.
    if (decision === undefined || decision.kind === 'reject') return decision
    const unfinished = unfinishedWorkflow(agent.session.snapshotEvents(), turn)
    return unfinished === undefined
      ? decision
      : { ...decision, messages: [...decision.messages, workflowContextMessage(unfinished)] }
  })
  ctx.on('tools/pre-execute', async (execution, next) => {
    if (!isConnectedAppInvocation(execution.name, execution.arguments)) return next()
    const enabled = execution.agent !== undefined
      && (turns.get(execution.agent)?.enabled
        ?? connectedAppsEnabled(ctx, config.enabledByDefault === true))
    if (!enabled) return { kind: 'deny', reason: 'Connected tools are disabled for this turn. Enable Tools and retry.' }
    const downstream = await next()
    if (downstream.kind !== 'allow' || execution.name !== BRIDGE_TOOL || !record(execution.arguments)
      || execution.arguments['action'] !== 'execute') return downstream
    const slug = stringValue(execution.arguments['tool_slug'])
    if (slug === undefined || !requiresApproval(slug)) return downstream
    return { kind: 'ask', reason: `Approve this ${slug} action once. The provider will run only after approval.` }
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
    if (record(parsed) && (record(parsed['private_receipt']) || record(parsed['source_receipt']))) return decision
    const receipt = await saveReceipt(ctx, execution, parsed, { tool: execution.name })
    const compact = isSearch
      ? compactComposioSearchReceipt(parsed, receipt)
      : compactComposioExecutionReceipt(parsed, receipt)
    return compact === undefined ? decision : { kind: 'accept', content: [{ type: 'text', text: JSON.stringify(compact) }] }
  })
}
