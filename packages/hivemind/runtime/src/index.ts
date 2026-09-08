/**
 * Governed HIVE-MIND identity, context, recall, and HyperAgent discovery.
 *
 * @module @deepseek-ai/dsh-hivemind-runtime
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-attachment'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { homedir } from 'node:os'
import { isAbsolute, dirname, join } from 'node:path'
import { lstat, readFile, rename, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import type {} from '@deepseek-ai/dsh-hivemind-identity'
import type {} from '@deepseek-ai/dsh-hivemind-execution-scope'
import { contextPlugin, type ProfileSnapshot } from '@deepseek-ai/dsh-hivemind-context'
import { memoryPlugin, type RecallRequest, type SaveRequest } from '@deepseek-ai/dsh-hivemind-memory'
import { projectHyperagentProfiles } from '@deepseek-ai/dsh-hivemind-employee-directory'

export { completedExchanges, recentConversationText } from '@deepseek-ai/dsh-hivemind-context'

/** Cordis plugin name used in diagnostics and prompt snapshots. */
export const name = 'hivemind-runtime'

/** Services required to assemble context and expose progressive tools. */
export const inject = ['tools', 'skills', 'attachments', 'hivemindIdentity', 'hivemindExecutionScope']

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_PROFILE_CONTEXT_CHARS = 12_000
const MAX_ATTACHMENT_READ_BYTES = 2 * 1024 * 1024
const DEFAULT_ATTACHMENT_WINDOW_CHARS = 16_000
const MAX_ATTACHMENT_WINDOW_CHARS = 32_000
const PROFILE_PATH = '/api/profile'
const PROFILE_FACTS_PATH = '/api/profiles'
const PROFILE_CONTEXT_PATH = '/api/profiles/context'
const RECALL_PATH = '/api/recall'
const HYPERAGENT_PROFILES_URL = 'https://api.singulancelabs.com/v1/hyperagents/profiles'
const CONNECT_STATUS_PATH = '/hivemind/connect/status'
const CONNECT_START_PATH = '/hivemind/connect/start'
const CONNECT_DISCONNECT_PATH = '/hivemind/connect'

/** Deployment configuration. Every operational budget is explicit. */
export interface Config {
  /** Whether this mount contributes model context and HIVE-MIND tools. */
  agentFeaturesEnabled: boolean
  /** Whether compatibility tools besides the progressive meta-tool are exposed. */
  legacyToolsEnabled: boolean
  /** ICARUS JSON file holding the browser-issued HIVE-MIND credential. */
  icarusConfigPath: string
  /** Identity transport. Local mode uses ICARUS; scoped-service uses the authenticated request principal. */
  authorityMode?: 'local' | 'scoped-service'
  /** HIVE control-plane origin used only by the scoped production transport. */
  serviceApiBase?: string
  /** Environment variable holding the dedicated runner-to-control-plane signing secret. */
  serviceSecretEnv?: string
  /** Complete HTTP-operation deadline. */
  requestTimeoutMs: number
  /** Maximum accepted HTTP response bytes, capped by the security invariant. */
  responseMaxBytes: number
  /** Maximum accepted profile-context characters, capped by the prompt invariant. */
  profileContextMaxChars: number
  /** Maximum onboarding-company characters injected before a task asks for the full profile. */
  profileBriefMaxChars: number
  /** Server-side result limit sent by the recall tool. */
  recallResultLimit: number
  /** Maximum characters exposed from one recalled item. */
  recallItemMaxChars: number
  /** Number of completed human/assistant exchanges retained after projection. */
  historyTurns: number
  /** Maximum characters retained in the deterministic recent-conversation projection. */
  historyMaxChars: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  agentFeaturesEnabled: z.boolean().required(),
  legacyToolsEnabled: z.boolean().required(),
  icarusConfigPath: z.string().required(),
  authorityMode: z.union(['local', 'scoped-service'] as const).default('local'),
  serviceApiBase: z.string(),
  serviceSecretEnv: z.string(),
  requestTimeoutMs: z.natural().min(1).required(),
  responseMaxBytes: z.natural().min(1).max(MAX_RESPONSE_BYTES).required(),
  profileContextMaxChars: z.natural().min(1).max(MAX_PROFILE_CONTEXT_CHARS).required(),
  profileBriefMaxChars: z.natural().min(1).max(MAX_PROFILE_CONTEXT_CHARS).required(),
  recallResultLimit: z.natural().min(1).required(),
  recallItemMaxChars: z.natural().min(1).required(),
  historyTurns: z.natural().min(1).required(),
  historyMaxChars: z.natural().min(1).required(),
})

interface JsonRecord {
  [key: string]: JsonValue | undefined
}

interface IcarusAuthority {
  token: string
  apiBase: URL
  userEmail?: string
  pathPrefix?: string
}

interface TenantIdentity {
  userId: string
  orgId: string
}

/** One authoritative HIVE-MIND employee entry. */
class HiveMindRuntimeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`hivemind-runtime: ${message}`, options)
    this.name = 'HiveMindRuntimeError'
  }
}

function expandedPath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return isAbsolute(path) ? path : join(process.cwd(), path)
}

function sendJson(response: import('node:http').ServerResponse, status: number, value: JsonValue): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(value))
}

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HiveMindRuntimeError(`${label} must be a JSON object`)
  }
  return value as JsonRecord
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HiveMindRuntimeError(`${label} must be a non-empty string`)
  }
  return value.trim()
}

function requireEmptyArgs(value: unknown, label: string): void {
  const args = record(value, label)
  if (Object.keys(args).length > 0) throw new HiveMindRuntimeError(`${label} accepts no arguments`)
}

/** Find a file explicitly attached by the user in this chat. */
function chatAttachment(agent: Agent, filename: string): FileAttachmentRef {
  let match: FileAttachmentRef | undefined
  for (const event of agent.session.snapshotEvents()) {
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') continue
    for (const block of event.data.content) {
      if (block.type === 'file' && block.attachment.name === filename) match = block.attachment
    }
  }
  if (match === undefined) throw new HiveMindRuntimeError('that file is not attached in this chat')
  if (match.bytes > MAX_ATTACHMENT_READ_BYTES) {
    throw new HiveMindRuntimeError(`attachment exceeds the ${MAX_ATTACHMENT_READ_BYTES} byte reading limit`)
  }
  return match
}

/** Read an attached UTF-8 file without granting access to a host path. */
async function attachmentText(ctx: Context, ref: FileAttachmentRef, signal: AbortSignal): Promise<string> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of ctx.attachments.readFileStream(ref, signal)) {
    size += chunk.byteLength
    if (size > MAX_ATTACHMENT_READ_BYTES) throw new HiveMindRuntimeError(`attachment exceeds the ${MAX_ATTACHMENT_READ_BYTES} byte reading limit`)
    chunks.push(chunk)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    throw new HiveMindRuntimeError('attachment is not a UTF-8 text file', { cause: error })
  }
}


function allowedApiBase(value: unknown): URL {
  const raw = nonEmptyString(value, 'ICARUS hivemind.apiUrl')
  let url: URL
  try {
    url = new URL(raw)
  } catch (error: unknown) {
    throw new HiveMindRuntimeError('ICARUS hivemind.apiUrl is invalid', { cause: error })
  }
  const isCore = url.protocol === 'https:' && url.hostname === 'core.singulancelabs.com'
    && url.port.length === 0
  const isLoopback = (url.protocol === 'http:' || url.protocol === 'https:')
    && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
  if (!isCore && !isLoopback) {
    throw new HiveMindRuntimeError('ICARUS API base must be HTTPS core.singulancelabs.com or loopback')
  }
  if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0
    || url.hash.length > 0 || (url.pathname !== '/' && url.pathname !== '')) {
    throw new HiveMindRuntimeError('ICARUS API base must contain only an allowed origin')
  }
  return new URL(url.origin)
}

async function readBoundedRegularFile(
  path: string,
  maxBytes: number,
  label: 'ICARUS config' | 'employee registry',
  requireOwnerControl: boolean,
): Promise<string> {
  const resolved = expandedPath(path)
  let info
  try {
    info = await lstat(resolved)
  } catch (error: unknown) {
    throw new HiveMindRuntimeError(`${label} is unavailable`, { cause: error })
  }
  if (!info.isFile()) {
    throw new HiveMindRuntimeError(`${label} must be a regular file`)
  }
  if (requireOwnerControl) {
    const getuid = process.getuid
    if (getuid !== undefined && info.uid !== getuid.call(process)) {
      throw new HiveMindRuntimeError(`${label} must be owned by the current user`)
    }
    if ((info.mode & 0o022) !== 0) {
      throw new HiveMindRuntimeError(`${label} must not be writable by group or others`)
    }
  }
  if (info.size > maxBytes) {
    throw new HiveMindRuntimeError(`${label} exceeds its byte limit`)
  }
  return readFile(resolved, 'utf8')
}

async function loadAuthority(configPath: string, maxBytes: number): Promise<IcarusAuthority> {
  const text = await readBoundedRegularFile(configPath, maxBytes, 'ICARUS config', true)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error: unknown) {
    throw new HiveMindRuntimeError('ICARUS config is not valid JSON', { cause: error })
  }
  const root = record(parsed, 'ICARUS config')
  const hivemind = record(root['hivemind'], 'ICARUS hivemind config')
  if (hivemind['connected'] !== true) throw new HiveMindRuntimeError('ICARUS is not connected to HIVE-MIND')
  return {
    token: nonEmptyString(hivemind['token'], 'ICARUS HIVE-MIND token'),
    apiBase: allowedApiBase(hivemind['apiUrl']),
    ...typeof hivemind['userEmail'] === 'string' && hivemind['userEmail'].trim() !== ''
      ? { userEmail: hivemind['userEmail'].trim() }
      : {},
  }
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function allowedServiceBase(value: unknown): URL {
  const raw = nonEmptyString(value, 'HIVE scoped service API base')
  let url: URL
  try { url = new URL(raw) } catch (error: unknown) {
    throw new HiveMindRuntimeError('HIVE scoped service API base is invalid', { cause: error })
  }
  const loopback = (url.protocol === 'http:' || url.protocol === 'https:')
    && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
  if (url.protocol !== 'https:' && !loopback) throw new HiveMindRuntimeError('HIVE scoped service API base must use HTTPS or loopback')
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new HiveMindRuntimeError('HIVE scoped service API base must contain only an origin')
  }
  return new URL(url.origin)
}

function scopedServiceAuthority(ctx: Context, config: Config): IcarusAuthority {
  const principal = ctx.hivemindExecutionScope.require()
  const envName = config.serviceSecretEnv?.trim() || 'HIVE_HARNESS_RUNNER_SERVICE_SECRET'
  const secret = process.env[envName]
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new HiveMindRuntimeError(`scoped service secret ${envName} is unavailable or too short`)
  }
  const now = Math.floor(Date.now() / 1000)
  const claims = {
    iss: 'hivemind-harness-runner', aud: 'hivemind-control-plane-harness-proxy',
    sub: principal.userId, org_id: principal.orgId, profile: principal.profile,
    ...(principal.projectId === undefined ? {} : { project_id: principal.projectId }),
    iat: now, exp: now + 30, jti: randomUUID(),
  }
  const input = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url(claims)}`
  const signature = createHmac('sha256', secret).update(input).digest('base64url')
  return {
    token: `${input}.${signature}`,
    apiBase: allowedServiceBase(config.serviceApiBase),
    pathPrefix: '/internal/v1/harness-chat/core',
  }
}

async function resolveAuthority(ctx: Context, config: Config): Promise<IcarusAuthority> {
  return config.authorityMode === 'scoped-service'
    ? scopedServiceAuthority(ctx, config)
    : loadAuthority(config.icarusConfigPath, config.responseMaxBytes)
}

function requestSignal(caller: AbortSignal, timeoutMs: number): { signal: AbortSignal; dispose(): void; timedOut(): boolean } {
  const timeout = new AbortController()
  let expired = false
  const timer = setTimeout(() => {
    expired = true
    timeout.abort()
  }, timeoutMs)
  const signal = AbortSignal.any([caller, timeout.signal])
  return { signal, dispose: () =>{  clearTimeout(timer) }, timedOut: () => expired }
}

async function readResponseJson(response: Response, maxBytes: number): Promise<unknown> {
  if (response.body === null) throw new HiveMindRuntimeError('HIVE-MIND returned an empty response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const item = await reader.read()
    if (item.done) break
    total += item.value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new HiveMindRuntimeError('HIVE-MIND response exceeds its byte limit')
    }
    chunks.push(item.value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (error: unknown) {
    throw new HiveMindRuntimeError('HIVE-MIND returned invalid JSON', { cause: error })
  }
}

async function hiveRequest(
  authority: IcarusAuthority,
  path: string,
  init: Omit<RequestInit, 'redirect' | 'signal'>,
  callerSignal: AbortSignal,
  config: Config,
  allowedTargetOrigin = authority.apiBase.origin,
): Promise<unknown> {
  const targetPath = authority.pathPrefix === undefined ? path : `${authority.pathPrefix}${path}`
  const target = new URL(targetPath, authority.apiBase)
  if (target.origin !== allowedTargetOrigin) throw new HiveMindRuntimeError('HIVE-MIND request escaped its allowed origin')
  const operation = requestSignal(callerSignal, config.requestTimeoutMs)
  try {
    let response: Response
    try {
      response = await fetch(target, {
        ...init,
        redirect: 'manual',
        signal: operation.signal,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${authority.token}`,
          ...init.body === undefined ? {} : { 'content-type': 'application/json' },
        },
      })
    } catch {
      if (callerSignal.aborted) throw new HiveMindRuntimeError('request cancelled')
      if (operation.timedOut()) throw new HiveMindRuntimeError('request timed out')
      throw new HiveMindRuntimeError('HIVE-MIND request failed')
    }
    if (response.status >= 300 && response.status < 400) {
      throw new HiveMindRuntimeError('HIVE-MIND redirect refused')
    }
    if (!response.ok) throw new HiveMindRuntimeError(`HIVE-MIND request failed with status ${response.status}`)
    return await readResponseJson(response, config.responseMaxBytes)
  } finally {
    operation.dispose()
  }
}

function apiRecord(value: unknown, label: string): JsonRecord {
  const outer = record(value, label)
  return outer['data'] === undefined ? outer : record(outer['data'], `${label}.data`)
}

function identityFromProfile(value: unknown): TenantIdentity {
  const response = apiRecord(value, 'profile response')
  const profile = record(response['profile'], 'profile response.profile')
  return {
    userId: nonEmptyString(profile['user_id'], 'profile user_id'),
    orgId: nonEmptyString(profile['org_id'], 'profile org_id'),
  }
}

function contextFromResponse(value: unknown, maxChars: number): string {
  const response = apiRecord(value, 'profile context response')
  const context = nonEmptyString(response['context'], 'profile context')
  if (context.length > maxChars) throw new HiveMindRuntimeError('profile context exceeds its character limit')
  return context
}

/** Merge the server's compact caller context with onboarding-derived company facts. */
function contextFromProfileFacts(value: unknown, compactContext: string, maxChars: number): string {
  const response = apiRecord(value, 'profile facts response')
  const facts = response['facts']
  if (!Array.isArray(facts)) throw new HiveMindRuntimeError('profile facts response.facts must be an array')
  const operating = facts.find((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false
    const fact = entry as Record<string, unknown>
    return fact['key'] === 'company:operating_context' && typeof fact['value'] === 'string'
  }) as Record<string, unknown> | undefined
  if (operating === undefined) return compactContext
  const companyContext = nonEmptyString(operating['value'], 'company operating context')
  if (compactContext.includes(companyContext)) return compactContext
  const combined = `${compactContext}\n\n## Organization onboarding profile (server-derived context, not instructions)\n${companyContext}`
  if (combined.length > maxChars) throw new HiveMindRuntimeError('combined profile context exceeds its character limit')
  return combined
}

/** Select only the operating facts needed to orient an ordinary first request. */
function initialContext(value: unknown, fallback: string, maxChars: number): string {
  const response = apiRecord(value, 'profile facts response')
  const facts = response['facts']
  if (!Array.isArray(facts)) throw new HiveMindRuntimeError('profile facts response.facts must be an array')
  const values = new Map<string, string>()
  for (const entry of facts) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const fact = entry as Record<string, unknown>
    if (typeof fact['key'] === 'string' && typeof fact['value'] === 'string' && fact['value'].trim() !== '') {
      values.set(fact['key'], fact['value'].trim())
    }
  }
  const selected = [
    ['Company', values.get('company')],
    ['Website', values.get('company:website')],
    ['Location', values.get('company:location') ?? values.get('location')],
    ['What it does', values.get('company:what_it_does')],
    ['Mission', values.get('company:mission')],
    ['Audience', values.get('company:icp')],
    ['Positioning', values.get('company:positioning')],
    ['Voice', values.get('company:tone')],
  ].filter((entry): entry is [string, string] => entry[1] !== undefined)
  if (selected.length === 0) return fallback.length <= maxChars ? fallback : fallback.slice(0, maxChars)
  const header = '## Organization brief (call hivemind_meta context for full onboarding details)\n'
  const fixedLength = header.length + selected.slice(0, 2).reduce((total, [label, text]) => total + label.length + text.length + 3, 0)
  const remaining = Math.max(1, Math.floor((maxChars - fixedLength) / Math.max(1, selected.length - 2)))
  const brief = selected.map(([label, text], index) => `${label}: ${index < 2 ? text : text.slice(0, remaining)}`).join('\n')
  if (header.length + brief.length > maxChars) throw new HiveMindRuntimeError('profile brief limit is too small')
  return `${header}${brief}`
}

function hyperagentProfilesFromResponse(value: unknown): JsonRecord {
  return projectHyperagentProfiles(value) as JsonRecord
}

function compactRecallResponse(value: JsonRecord, limit: number, itemMaxChars: number): Record<string, JsonValue> {
  const preferred = Array.isArray(value['results']) && value['results'].length > 0
    ? value['results']
    : Array.isArray(value['memories']) ? value['memories'] : []
  const seen = new Set<string>()
  const results: Array<Record<string, JsonValue>> = []
  for (const [index, entry] of preferred.entries()) {
    if (results.length >= limit || typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const item = entry as JsonRecord
    const id = typeof item['id'] === 'string' ? item['id'] : `result-${index + 1}`
    const content = typeof item['content'] === 'string' ? item['content'].trim() : ''
    const key = `${id}\u0000${content}`
    if (seen.has(key)) continue
    seen.add(key)
    const boundedContent = content.length <= itemMaxChars
      ? content
      : `${content.slice(0, Math.max(1, itemMaxChars - 1))}…`
    const compact: Record<string, JsonValue> = { id, content: boundedContent }
    for (const field of ['citation_id', 'title', 'memory_type', 'source', 'created_at', 'document_date']) {
      if (typeof item[field] === 'string') compact[field] = item[field]
    }
    if (typeof item['score'] === 'number' && Number.isFinite(item['score'])) compact['score'] = item['score']
    results.push(compact)
  }
  return {
    results,
    count: results.length,
    ...typeof value['mode_used'] === 'string' ? { mode_used: value['mode_used'] } : {},
    ...typeof value['search_method'] === 'string' ? { search_method: value['search_method'] } : {},
    ...typeof value['timing_ms'] === 'number' && Number.isFinite(value['timing_ms']) ? { timing_ms: value['timing_ms'] } : {},
  }
}

/** Expose only a terminal memory-write receipt; tenant fields remain transport-private. */
function compactSaveReceipt(value: JsonRecord): Record<string, JsonValue> {
  if (value['skipped'] === true) {
    const mutation = value['mutation']
    const compact: Record<string, JsonValue> = { status: 'skipped' }
    if (typeof mutation === 'object' && mutation !== null && !Array.isArray(mutation)) {
      const operation = (mutation as JsonRecord)['operation']
      if (typeof operation === 'string') compact['operation'] = operation
    }
    return compact
  }
  const persisted = typeof value['memory'] === 'object' && value['memory'] !== null && !Array.isArray(value['memory'])
    ? value['memory'] as JsonRecord
    : value
  const receipt: Record<string, JsonValue> = { status: 'saved' }
  for (const field of ['id', 'title', 'memory_type', 'citation_id', 'created_at', 'updated_at']) {
    if (typeof persisted[field] === 'string') receipt[field] = persisted[field]
  }
  if (typeof persisted['id'] !== 'string') throw new HiveMindRuntimeError('memory save response is missing its receipt id')
  return receipt
}

async function loadProfileSnapshot(ctx: Context, config: Config, signal: AbortSignal): Promise<ProfileSnapshot> {
  const authority = await resolveAuthority(ctx, config)
  const profile = await hiveRequest(authority, PROFILE_PATH, { method: 'GET' }, signal, config)
  const identity = identityFromProfile(profile)
  const contextResponse = await hiveRequest(authority, PROFILE_CONTEXT_PATH, { method: 'GET' }, signal, config)
  const compactContext = contextFromResponse(contextResponse, config.profileContextMaxChars)
  const profileFacts = await hiveRequest(authority, PROFILE_FACTS_PATH, { method: 'GET' }, signal, config)
  const fullContext = contextFromProfileFacts(profileFacts, compactContext, config.profileContextMaxChars)
  return { identity, fullContext, initialContext: initialContext(profileFacts, compactContext, config.profileBriefMaxChars) }
}

/**
 * Confirm that the locally stored credential is still accepted by HIVE-MIND.
 * The connection chip is an authentication status, not merely a statement
 * that a token-shaped value exists on disk.
 */
async function connectionIsUsable(config: Config): Promise<void> {
  const authority = await loadAuthority(config.icarusConfigPath, config.responseMaxBytes)
  const controller = new AbortController()
  const profile = await hiveRequest(authority, PROFILE_PATH, { method: 'GET' }, controller.signal, config)
  identityFromProfile(profile)
}

const jsonOutput = {
  schema: { type: 'object' as const, additionalProperties: true, properties: {} },
  render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

function requireAgent(agent: Agent | undefined): Agent {
  if (agent === undefined) throw new HiveMindRuntimeError('this tool requires an active agent')
  return agent
}

function icarusExecutable(configPath: string): string {
  return join(dirname(expandedPath(configPath)), 'bin', 'icarus')
}

/** Remove only the local HIVE-MIND bearer credential, preserving other ICARUS settings. */
async function disconnect(configPath: string, maxBytes: number): Promise<void> {
  const resolved = expandedPath(configPath)
  const text = await readBoundedRegularFile(resolved, maxBytes, 'ICARUS config', true)
  const root = record(JSON.parse(text), 'ICARUS config')
  const hivemind = record(root['hivemind'], 'ICARUS hivemind config')
  const { token: _token, ...rest } = hivemind
  const next = JSON.stringify({ ...root, hivemind: { ...rest, connected: false } })
  const temporary = `${resolved}.disconnecting-${process.pid}`
  await writeFile(temporary, next, { mode: 0o600 })
  await rename(temporary, resolved)
}

/** Register local Web endpoints that initiate and observe the ICARUS browser login. */
function registerWebConnectRoutes(ctx: Context, config: Config): void {
  let connecting = false
  let loginProcess: ReturnType<typeof spawn> | undefined
  // The core runtime is also mounted by headless profiles, whose intentionally
  // minimal Context does not provide Cordis dynamic injection.
  const inject: unknown = Reflect.get(ctx, 'inject')
  if (typeof inject !== 'function') return
  const dynamicInject = inject as (dependencies: string[], callback: (webCtx: Context) => void) => void
  dynamicInject.call(ctx, ['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: CONNECT_STATUS_PATH,
      async handler(request, response) {
        if (request.method !== 'GET') {
          sendJson(response, 405, { status: 'method_not_allowed' })
          return
        }
        try {
          await connectionIsUsable(config)
          // OAuth can leave its launcher alive briefly after the credential has
          // been written. The credential is authoritative: never leave the UI
          // in a stale "connecting" state once it is usable.
          connecting = false
          loginProcess = undefined
          const authority = await loadAuthority(config.icarusConfigPath, config.responseMaxBytes)
          sendJson(response, 200, {
            status: 'connected',
            ...authority.userEmail === undefined ? {} : { user_email: authority.userEmail },
          })
        } catch {
          sendJson(response, 200, { status: connecting ? 'connecting' : 'disconnected' })
        }
      },
    }), 'hivemind-runtime: connection status route')
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: CONNECT_START_PATH,
      handler(request, response) {
        if (request.method !== 'POST') {
          sendJson(response, 405, { status: 'method_not_allowed' })
          return
        }
        if (!connecting) {
          connecting = true
          loginProcess = spawn(icarusExecutable(config.icarusConfigPath), ['connect', '--oauth-only'], {
            detached: false,
            stdio: 'ignore',
          })
          loginProcess.once('error', () => { connecting = false; loginProcess = undefined })
          loginProcess.once('exit', () => { connecting = false; loginProcess = undefined })
          loginProcess.unref()
        }
        sendJson(response, 202, { status: 'connecting' })
      },
    }), 'hivemind-runtime: connection start route')
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: CONNECT_DISCONNECT_PATH,
      async handler(request, response) {
        if (request.method !== 'DELETE') {
          sendJson(response, 405, { status: 'method_not_allowed' })
          return
        }
        try {
          connecting = false
          loginProcess?.kill()
          loginProcess = undefined
          await disconnect(config.icarusConfigPath, config.responseMaxBytes)
          sendJson(response, 200, { status: 'disconnected' })
        } catch {
          sendJson(response, 500, { status: 'unavailable' })
        }
      },
    }), 'hivemind-runtime: connection disconnect route')
  })
}

/**
 * Register HIVE-MIND context and governed tools.
 * @param ctx - plugin context owning every registration.
 * @param config - validated deployment budgets and file locations.
 * @returns Nothing; Cordis owns the registered effects.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.hivemindIdentity.register({
    async identity(signal) {
      const authority = await resolveAuthority(ctx, config)
      return identityFromProfile(await hiveRequest(authority, PROFILE_PATH, { method: 'GET' }, signal, config))
    },
  })
  const snapshots = new WeakMap<Agent, Promise<ProfileSnapshot>>()
  const snapshotFor = (agent: Agent, signal: AbortSignal): Promise<ProfileSnapshot> => {
    const current = snapshots.get(agent)
    if (current !== undefined) return current
    const pending = loadProfileSnapshot(ctx, config, signal)
    snapshots.set(agent, pending)
    void pending.catch(() => snapshots.delete(agent))
    return pending
  }

  if (config.authorityMode !== 'scoped-service') registerWebConnectRoutes(ctx, config)
  if (!config.agentFeaturesEnabled) return
  ctx.skills.register({
    name: 'hivemind-company-brain',
    description: 'Load only for a company-memory task that needs focused HIVE-MIND retrieval, evidence filters, or exact employee records.',
    source: 'runtime',
    content: `Use this skill only for a question about the authenticated user's organization, internal memories, files, documents, evidence, decisions, people, projects, or HyperAgents. HIVE-MIND should be considered automatically for such work, but do not load this skill or call recall for greetings, general knowledge, simple transformations, or a fact already established by a recent completed answer.

1. First decide whether company history is actually needed. Use a sufficient compact organization brief or recent completed answer directly. Otherwise call \`hivemind_meta\` with exactly one operation:
   - \`context\`: load the full onboarding-derived user and organization profile.
   - \`recall\`: search internal company memory and evidence.
   - \`profiles\`: fetch the authenticated organization's exact HyperAgent directory. Never invent employees.
2. For recall, preserve the user's exact named entity or filename in \`query\`. Add only filters supported by the request: \`source_platforms\`, \`project\`, \`valid_at\`, \`transaction_at\`, \`sort\`, and explicit \`tags\`.
3. For internal media, use \`media_kind: "image"\`, the exact \`filename\` when known, object names in \`entities\`, and \`source_platforms: ["knowledge-upload"]\` when the image came from an upload. For example, an uploaded image with a glass uses a focused query plus \`media_kind: "image"\` and \`entities: ["glass"]\`.
4. A returned title, filename, citation ID, or memory ID is an internal evidence reference, not a workspace path and not proof that a downloadable artifact is available. Do not use shell, filesystem, Glob, Grep, or web tools to locate it unless the user explicitly asks about a local workspace or supplies a local path.
5. For temporal questions, preserve the user's date or timeframe and use \`valid_at\` for what was true then or \`transaction_at\` for what the system knew then.\n6. Use \`hivemind_save_memory\` only for a stable user preference, explicit or confirmed decision, correction, or completed outcome that will matter in a future session. Save one concise factual statement with a descriptive title, source type, and precise tags. Never save secrets, credentials, private authentication material, ephemeral chat, speculation, or unverified claims. For a correction, first recall the old memory and pass \`relationship: "update"\` with its exact \`related_to\` ID. Report a save only after its receipt returns.\n7. Read returned evidence and citations completely enough to answer. Identify conflicts or gaps, and do not claim that a file, image, or fact is available beyond the receipt. Recall again only when the first focused result set is insufficient or the user explicitly asks for deeper coverage.\n8. HIVE-MIND supplies internal company knowledge. Use native Harness tools for independent web evidence, coding, artifacts, workflows, and subagents when those tasks are actually requested.`,
  })
  ctx.plugin(contextPlugin(config, snapshotFor))

  ctx.plugin(memoryPlugin({ defaultLimit: config.recallResultLimit }, {
    async context(agent, signal) {
      const snapshot = await snapshotFor(agent, signal)
      return { status: 'ready', operation: 'context', context: snapshot.fullContext }
    },
    async profiles(signal) {
      const authority = await resolveAuthority(ctx, config)
      const result = config.authorityMode === 'scoped-service'
        ? await hiveRequest(authority, '/v1/hyperagents/profiles', { method: 'GET' }, signal, config)
        : await hiveRequest(authority, HYPERAGENT_PROFILES_URL, { method: 'GET' }, signal, config, 'https://api.singulancelabs.com')
      return { operation: 'profiles', ...hyperagentProfilesFromResponse(result) }
    },
    async recall(request: RecallRequest, signal) {
      const authority = await resolveAuthority(ctx, config)
      const result = await hiveRequest(authority, RECALL_PATH, {
        method: 'POST',
        body: JSON.stringify({
          query_context: request.query,
          max_memories: request.limit,
          mode: request.mode,
          ...request.tags === undefined ? {} : { tags: request.tags },
          ...request.sourcePlatforms === undefined ? {} : { source_platforms: request.sourcePlatforms },
          ...request.project === undefined ? {} : { project: request.project },
          ...request.validAt === undefined ? {} : { valid_at: request.validAt },
          ...request.transactionAt === undefined ? {} : { transaction_at: request.transactionAt },
          ...request.sort === undefined ? {} : { sort: request.sort },
          ...request.includeSuperseded === undefined ? {} : { include_superseded: request.includeSuperseded },
        }),
      }, signal, config)
      return {
        status: 'ready',
        operation: 'recall',
        result: compactRecallResponse(apiRecord(result, 'meta recall response'), request.limit, config.recallItemMaxChars),
      }
    },
    async save(agent, request: SaveRequest, signal) {
      const snapshot = await snapshotFor(agent, signal)
      const authority = await resolveAuthority(ctx, config)
      const result = await hiveRequest(authority, '/api/memories?sync=true', {
        method: 'POST',
        body: JSON.stringify({
          title: request.title,
          content: request.content,
          memory_type: request.sourceType === 'decision' ? 'decision' : 'fact',
          source_platform: 'deepseek-harness',
          tags: request.tags ?? [],
          ...request.project === undefined ? {} : { project: request.project },
          ...request.relationship === undefined ? {} : {
            relationship: {
              type: { update: 'Updates', extend: 'Extends', derive: 'Derives' }[request.relationship],
              target_id: request.relatedTo,
            },
          },
          metadata: { source_type: request.sourceType, governed: true },
          user_id: snapshot.identity.userId,
          org_id: snapshot.identity.orgId,
          smartIngest: true,
          sync: true,
        }),
      }, signal, config)
      return compactSaveReceipt(apiRecord(result, 'meta save response'))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'hivemind_read_attachment',
    description: 'Read a text file explicitly attached by the user in this HIVE-MIND chat. Use before summarizing, extracting facts, or saving information from that file. This tool can read only chat attachments, never local filesystem paths.',
    parameters: {
      filename: { type: 'string', required: true, description: 'Exact displayed attachment filename.' },
      offset: { type: 'integer', description: 'Zero-based character offset. Defaults to 0.' },
      max_chars: { type: 'integer', description: `Maximum returned characters, from 1 to ${MAX_ATTACHMENT_WINDOW_CHARS}.` },
    },
    output: jsonOutput,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = record(args, 'attachment read arguments')
      const filename = nonEmptyString(input['filename'], 'attachment filename')
      const rawOffset = input['offset'] ?? 0
      const rawMaxChars = input['max_chars'] ?? DEFAULT_ATTACHMENT_WINDOW_CHARS
      if (!Number.isInteger(rawOffset) || (rawOffset as number) < 0) throw new HiveMindRuntimeError('attachment offset must be a non-negative integer')
      if (!Number.isInteger(rawMaxChars) || (rawMaxChars as number) < 1 || (rawMaxChars as number) > MAX_ATTACHMENT_WINDOW_CHARS) {
        throw new HiveMindRuntimeError(`attachment max_chars must be an integer from 1 to ${MAX_ATTACHMENT_WINDOW_CHARS}`)
      }
      const text = await attachmentText(ctx, chatAttachment(requireAgent(exec.agent), filename), exec.signal)
      const offset = rawOffset as number
      const maxChars = rawMaxChars as number
      return {
        status: 'ready',
        filename,
        offset,
        total_chars: text.length,
        truncated: offset + maxChars < text.length,
        content: text.slice(offset, offset + maxChars),
      }
    },
  }))

  if (!config.legacyToolsEnabled) return

  ctx.tools.register(defineTool({
    name: 'hivemind_profile_context',
    description: 'Read the authenticated user and organization context already governing this session.',
    parameters: {},
    output: jsonOutput,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const snapshot = await snapshotFor(requireAgent(exec.agent), exec.signal)
      return { status: 'ready', context: snapshot.initialContext }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'hivemind_recall',
    description: 'Recall organization memory for a focused query. Use only when current context is insufficient.',
    parameters: {
      query: { type: 'string', required: true, description: 'Focused memory question.' },
    },
    output: jsonOutput,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const query = nonEmptyString(args.query, 'recall query')
      const agent = requireAgent(exec.agent)
      const snapshot = await snapshotFor(agent, exec.signal)
      const authority = await resolveAuthority(ctx, config)
      const result = await hiveRequest(authority, RECALL_PATH, {
        method: 'POST',
        body: JSON.stringify({
          query_context: query,
          max_memories: config.recallResultLimit,
          mode: 'memory',
        }),
      }, exec.signal, config)
      const response = apiRecord(result, 'recall response')
      const responseUserId = response['user_id']
      const responseOrgId = response['org_id']
      if (responseUserId !== undefined && responseUserId !== snapshot.identity.userId) {
        throw new HiveMindRuntimeError('recall response user_id does not match the authenticated profile')
      }
      if (responseOrgId !== undefined && responseOrgId !== snapshot.identity.orgId) {
        throw new HiveMindRuntimeError('recall response org_id does not match the authenticated profile')
      }
      return { status: 'ready', result: compactRecallResponse(response, config.recallResultLimit, config.recallItemMaxChars) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'hivemind_hyperagent_profiles',
    description: 'Fetch the authenticated organization\'s exact HyperAgent profiles for identification, selection, assignment, review, or sub-agent coordination. User and organization scope are derived from the API key. Never invent employees.',
    parameters: {},
    output: jsonOutput,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      requireEmptyArgs(args, 'hyperagent profiles arguments')
      const authority = await resolveAuthority(ctx, config)
      const result = config.authorityMode === 'scoped-service'
        ? await hiveRequest(authority, '/v1/hyperagents/profiles', { method: 'GET' }, exec.signal, config)
        : await hiveRequest(authority, HYPERAGENT_PROFILES_URL, { method: 'GET' }, exec.signal, config, 'https://api.singulancelabs.com')
      return hyperagentProfilesFromResponse(result)
    },
  }))

}
