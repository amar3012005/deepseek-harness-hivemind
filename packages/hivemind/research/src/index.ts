/** Governed, provider-neutral HIVE-MIND research for DeepSeek Harness. */

import { createHmac, randomUUID } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-hivemind-execution-scope'
import type { WebSearchSource } from '@deepseek-ai/dsh-web'

export const name = 'hivemind-research'
export const inject = ['tools', 'hivemindExecutionScope', 'web']

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const RESEARCH_TYPES = ['auto', 'known_url', 'focused_fact', 'broad_discovery', 'multi_hop', 'legal_compliance', 'connected_source'] as const
type ResearchType = typeof RESEARCH_TYPES[number]

export interface Config {
  executionMode?: 'remote' | 'local-web'
  authorityMode?: 'local' | 'scoped-service'
  /** ICARUS JSON credential path in local mode only. */
  icarusConfigPath?: string
  serviceApiBase?: string
  serviceSecretEnv?: string
  requestTimeoutMs: number
  maxObjectiveChars: number
  maxUrls: number
  maxResults: number
  /** Maximum independent objectives accepted by one parallel gather call. */
  maxGatherObjectives: number
  /** Maximum deduplicated sources returned in one model-visible gather receipt. */
  maxGatherSources: number
  /** Maximum characters from each durable source excerpt projected into model-visible tool output. */
  modelExcerptChars: number
  /** Expose lower-level request, gather, and status controls beside the stable answer tool. */
  exposeAdvancedTools: boolean
  /** Inject terminal background receipts when no native tool result can carry them. */
  injectTerminalReceipts: boolean
  /** A bounded inline read prevents a queued receipt from being mistaken for a final answer. */
  inlineWaitMs: number
  statusPollMs: number
}

export const Config: z<Config> = z.object({
  executionMode: z.union(['remote', 'local-web'] as const).default('remote'),
  authorityMode: z.union(['local', 'scoped-service'] as const).default('local'),
  icarusConfigPath: z.string(),
  serviceApiBase: z.string(),
  serviceSecretEnv: z.string(),
  requestTimeoutMs: z.natural().min(1).default(30_000),
  maxObjectiveChars: z.natural().min(1).default(8_000),
  maxUrls: z.natural().min(1).max(20).default(8),
  maxResults: z.natural().min(1).max(20).default(8),
  maxGatherObjectives: z.natural().min(2).max(12).default(6),
  maxGatherSources: z.natural().min(2).max(40).default(16),
  modelExcerptChars: z.natural().min(80).max(4_000).default(480),
  exposeAdvancedTools: z.boolean().default(true),
  injectTerminalReceipts: z.boolean().default(true),
  inlineWaitMs: z.natural().min(0).max(30_000).default(12_000),
  statusPollMs: z.natural().min(100).max(10_000).default(1_000),
})

interface JsonRecord { [key: string]: JsonValue | undefined }
interface Authority { token: string; apiBase: URL; pathPrefix?: string }
interface SubmittedResearch {
  jobId: string
  type: ResearchType
  route: string
  status: string
  runId?: string
  gatherId?: string
  workflowId?: string
  planId?: string
}
interface ResearchSource { url: string; title?: string; excerpt?: string }
interface ResearchReceipt {
  jobId: string
  runId?: string
  gatherId?: string
  workflowId?: string
  planId?: string
  status: string
  route?: string
  provider?: string
  resultCount?: number
  sources: ResearchSource[]
  evidenceState: 'pending' | 'ready' | 'partial' | 'unavailable'
  error?: string
}

interface ResearchGatherReceipt {
  gatherId: string
  workflowId?: string
  runId?: string
  planId?: string
  workstreamId?: string
  status: 'succeeded' | 'partial' | 'failed'
  provider?: string
  objectives: readonly { objective: string; jobId: string; evidenceState: ResearchReceipt['evidenceState']; sourceCount: number; error?: string }[]
  sources: ResearchSource[]
}

interface ResearchWorkflowStarted {
  workflowId: string
  objective: string
  status: 'running'
  turn?: number
}

interface ResearchWorkflowTerminal {
  workflowId: string
  objective: string
  status: 'completed' | 'partial' | 'failed' | 'cancelled'
  evidenceState: 'ready' | 'partial' | 'unavailable'
  gatherId?: string
  sourceCount: number
  turn?: number
}

function modelReceipt(receipt: ResearchReceipt, maxExcerptChars: number): ResearchReceipt {
  return {
    ...receipt,
    sources: receipt.sources.map(source => ({
      ...source,
      ...(source.excerpt === undefined ? {} : { excerpt: source.excerpt.slice(0, maxExcerptChars) }),
    })),
  }
}

function isTerminalReceipt(value: unknown): value is ResearchReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const receipt = value as Partial<ResearchReceipt>
  return typeof receipt.jobId === 'string'
    && receipt.jobId.trim() !== ''
    && receipt.evidenceState !== undefined
    && receipt.evidenceState !== 'pending'
}

function completionInjection(receipts: readonly ResearchReceipt[]): string {
  const entries = receipts.map((receipt) => {
    const sourceCount = receipt.sources.length
    const provider = receipt.provider === undefined ? '' : ` via ${receipt.provider}`
    const detail = receipt.error === undefined ? `${sourceCount} source${sourceCount === 1 ? '' : 's'}` : `evidence gap: ${receipt.error}`
    return `- Research ${receipt.jobId} is ${receipt.evidenceState}${provider}; ${detail}.`
  })
  return `## Operating research update\n\n${entries.join('\n')}\n\nUse these durable receipts in the current work. Do not start a duplicate request; distinguish ready evidence from an incomplete or unavailable evidence gap.`
}

/** Optional host-owned native jobs seam; research remains usable without it. */
interface ResearchJobRegistry {
  start(spec: {
    kind: string
    label: string
    owner: Agent
    outputLimitBytes: number
    run(): { cancel(reason?: string): void; done: Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string; output?: string }> }
  }): unknown
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Records the exact governed research objective and the durable job identity returned when work is accepted. */
    'hivemind/research-requested': SubmittedResearch & { objective: string }
    /** Records the latest bounded provider attribution, result count, status, and failure evidence read for one research job. */
    'hivemind/research-receipt': ResearchReceipt
    /** One terminal receipt for the complete bounded parallel gather phase. */
    'hivemind/research-gathered': ResearchGatherReceipt
    /** Starts one user-selected governed research task before its concurrent evidence lanes dispatch. */
    'hivemind/research-workflow-started': ResearchWorkflowStarted
    /** Marks a governed research task terminal so the parent synthesizes rather than reopening completed evidence work. */
    'hivemind/research-workflow-terminal': ResearchWorkflowTerminal
  }
}

function inputRecord(value: JsonValue | undefined): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('hivemind-research: arguments must be an object')
  return value
}

function text(value: JsonValue | undefined, label: string, maxChars: number): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`hivemind-research: ${label} must be a non-empty string`)
  const result = value.trim()
  if (result.length > maxChars) throw new TypeError(`hivemind-research: ${label} exceeds ${maxChars} characters`)
  return result
}

function optionalText(value: JsonValue | undefined, label: string, maxChars: number): string | undefined {
  return value === undefined ? undefined : text(value, label, maxChars)
}

/** Optional provider attribution may be absent or blank on queued/failed jobs. */
function optionalAttribution(value: JsonValue | undefined, label: string, maxChars: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return text(value, label, maxChars)
}

function stringList(value: JsonValue | undefined, label: string, maxItems: number, maxChars: number): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maxItems) throw new TypeError(`hivemind-research: ${label} must contain at most ${maxItems} strings`)
  return value.map((item, index) => text(item, `${label}[${index}]`, maxChars))
}

function activeAgent(agent: Agent | undefined): Agent {
  if (agent === undefined) throw new TypeError('hivemind-research: an active agent is required')
  return agent
}

/** Recover the current HyperAgents operating run without accepting a model-supplied identifier. */
function activeRunId(agent: Agent): string | undefined {
  if (typeof agent.session.snapshotEvents !== 'function') return undefined
  const events = agent.session.snapshotEvents() as ReadonlyArray<{ readonly type: string; readonly data: unknown }>
  for (const event of [...events].reverse()) {
    if (event.type !== 'hivemind/run-plan' && event.type !== 'hivemind/run-plan-revised' && event.type !== 'hivemind/operating-context') continue
    if (typeof event.data !== 'object' || event.data === null || Array.isArray(event.data)) continue
    const runId = (event.data as Record<string, unknown>)['runId']
    if (typeof runId === 'string' && runId.trim() !== '') return runId
  }
  return undefined
}

/** Recover the current plan revision identity for gather idempotency. */
function activePlanId(agent: Agent): string | undefined {
  if (typeof agent.session.snapshotEvents !== 'function') return undefined
  const events = agent.session.snapshotEvents() as ReadonlyArray<{ readonly type: string; readonly data: unknown }>
  for (const event of [...events].reverse()) {
    if (event.type !== 'hivemind/run-plan' && event.type !== 'hivemind/run-plan-revised') continue
    if (typeof event.data !== 'object' || event.data === null || Array.isArray(event.data)) continue
    const planId = (event.data as Record<string, unknown>)['planId']
    if (typeof planId === 'string' && planId.trim() !== '') return planId
  }
  return undefined
}

function completedGatherId(agent: Agent, planId: string | undefined): string | undefined {
  if (planId === undefined || typeof agent.session.snapshotEvents !== 'function') return undefined
  const events = agent.session.snapshotEvents() as ReadonlyArray<{ readonly type: string; readonly data: unknown }>
  for (const event of [...events].reverse()) {
    if (event.type === 'hivemind/evidence-gap-recorded' && typeof event.data === 'object' && event.data !== null && !Array.isArray(event.data)) {
      if ((event.data as Record<string, unknown>)['planId'] === planId) return undefined
    }
    if (event.type !== 'hivemind/research-receipt' || typeof event.data !== 'object' || event.data === null || Array.isArray(event.data)) continue
    const data = event.data as Partial<ResearchReceipt>
    if (data.planId === planId && typeof data.gatherId === 'string') return data.gatherId
  }
  return undefined
}

/** Current live turn identity, if the caller is executing inside the native agent loop. */
function activeTurn(agent: Agent): number | undefined {
  if (typeof agent.session.snapshotEvents !== 'function') return undefined
  const events = agent.session.snapshotEvents() as ReadonlyArray<{ readonly type: string; readonly data: unknown }>
  for (const event of [...events].reverse()) {
    if (event.type !== 'turn/start' || typeof event.data !== 'object' || event.data === null || Array.isArray(event.data)) continue
    const turn = (event.data as Record<string, unknown>)['turn']
    if (typeof turn === 'number' && Number.isSafeInteger(turn)) return turn
  }
  return undefined
}

/**
 * A completed governed-research task is authoritative for its whole user turn.
 *
 * The model may paraphrase the same request after receiving evidence. Matching
 * on its rewritten objective would reopen provider work and defeat the stable
 * task boundary. A new user turn, or an explicit evidence-gap capability added
 * later, is the correct way to request further coverage.
 */
function completedResearchWorkflow(agent: Agent, turn: number | undefined): ResearchWorkflowTerminal | undefined {
  if (typeof agent.session.snapshotEvents !== 'function') return undefined
  const events = agent.session.snapshotEvents() as ReadonlyArray<{ readonly type: string; readonly data: unknown }>
  for (const event of [...events].reverse()) {
    if (event.type !== 'hivemind/research-workflow-terminal' || typeof event.data !== 'object' || event.data === null || Array.isArray(event.data)) continue
    const workflow = event.data as Partial<ResearchWorkflowTerminal>
    if (workflow.turn !== turn || typeof workflow.workflowId !== 'string') continue
    if (workflow.status !== 'completed' && workflow.status !== 'partial' && workflow.status !== 'failed' && workflow.status !== 'cancelled') continue
    return workflow as ResearchWorkflowTerminal
  }
  return undefined
}

/** Recover the durable research-task identity attached to a submitted job. */
function workflowIdForJob(agent: Agent, jobId: string): string | undefined {
  if (typeof agent.session.snapshotEvents !== 'function') return undefined
  const events = agent.session.snapshotEvents() as ReadonlyArray<{ readonly type: string; readonly data: unknown }>
  for (const event of [...events].reverse()) {
    if (event.type !== 'hivemind/research-requested' || typeof event.data !== 'object' || event.data === null || Array.isArray(event.data)) continue
    const submitted = event.data as Partial<SubmittedResearch>
    if (submitted.jobId === jobId && typeof submitted.workflowId === 'string') return submitted.workflowId
  }
  return undefined
}

/** End a pending task only after every job recorded for it has a terminal receipt. */
function settleResearchWorkflow(agent: Agent, workflowId: string): void {
  if (typeof agent.session.snapshotEvents !== 'function') return
  const events = agent.session.snapshotEvents() as ReadonlyArray<{ readonly type: string; readonly data: unknown }>
  const started = [...events].reverse().map(event => event.type === 'hivemind/research-workflow-started' && typeof event.data === 'object' && event.data !== null && !Array.isArray(event.data)
    ? event.data as Partial<ResearchWorkflowStarted>
    : undefined).find(event => event?.workflowId === workflowId)
  if (started === undefined || typeof started.objective !== 'string') return
  if (events.some(event => event.type === 'hivemind/research-workflow-terminal'
    && typeof event.data === 'object'
    && event.data !== null
    && !Array.isArray(event.data)
    && (event.data as Partial<ResearchWorkflowTerminal>).workflowId === workflowId)) return

  const requested = events.flatMap((event) => {
    if (event.type !== 'hivemind/research-requested' || typeof event.data !== 'object' || event.data === null || Array.isArray(event.data)) return []
    const submitted = event.data as Partial<SubmittedResearch>
    return submitted.workflowId === workflowId && typeof submitted.jobId === 'string' ? [submitted.jobId] : []
  })
  if (requested.length === 0) return
  const latest = new Map<string, ResearchReceipt>()
  for (const event of events) {
    if (event.type !== 'hivemind/research-receipt' || typeof event.data !== 'object' || event.data === null || Array.isArray(event.data)) continue
    const item = event.data as Partial<ResearchReceipt>
    if (item.workflowId === workflowId && typeof item.jobId === 'string') latest.set(item.jobId, item as ResearchReceipt)
  }
  const receipts = requested.map(jobId => latest.get(jobId))
  if (receipts.some(item => item === undefined || item.evidenceState === 'pending')) return
  const resolved = receipts.filter((item): item is ResearchReceipt => item !== undefined)
  const ready = resolved.filter(item => item.evidenceState === 'ready').length
  agent.session.append('hivemind/research-workflow-terminal', {
    workflowId,
    objective: started.objective,
    status: ready === resolved.length ? 'completed' : ready > 0 ? 'partial' : 'failed',
    evidenceState: ready === resolved.length ? 'ready' : ready > 0 ? 'partial' : 'unavailable',
    sourceCount: resolved.reduce((count, item) => count + item.sources.length, 0),
    ...(typeof started.turn === 'number' ? { turn: started.turn } : {}),
  })
}

function expandedPath(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return isAbsolute(value) ? value : join(process.cwd(), value)
}

function apiBase(value: string, label: string, localAuthorityOnly = false): URL {
  const parsed = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  const canonicalHivemind = parsed.protocol === 'https:' && parsed.hostname === 'core.singulancelabs.com' && parsed.port === ''
  if (localAuthorityOnly && !canonicalHivemind && !loopback) throw new Error(`hivemind-research: ${label} must be the canonical HIVE-MIND API or loopback`)
  if (!localAuthorityOnly && parsed.protocol !== 'https:' && !loopback) throw new Error(`hivemind-research: ${label} must use HTTPS or loopback`)
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new Error(`hivemind-research: ${label} must be an origin`)
  }
  return new URL(parsed.origin)
}

async function localAuthority(config: Config): Promise<Authority> {
  const configPath = config.icarusConfigPath?.trim()
  if (configPath === undefined || configPath.length === 0) {
    throw new Error('hivemind-research: local authority requires an ICARUS config path')
  }
  const path = expandedPath(configPath)
  const info = await lstat(path)
  if (!info.isFile() || info.size > MAX_RESPONSE_BYTES) throw new Error('hivemind-research: ICARUS config is not a safe regular file')
  if (process.platform !== 'win32' && process.getuid !== undefined && info.uid !== process.getuid()) throw new Error('hivemind-research: ICARUS config is not owned by this user')
  if (process.platform !== 'win32' && (info.mode & 0o022) !== 0) throw new Error('hivemind-research: ICARUS config must not be group or world writable')
  const raw = await readFile(path, 'utf8')
  const root = JSON.parse(raw) as { hivemind?: { connected?: unknown; token?: unknown; apiUrl?: unknown } }
  const hive = root.hivemind
  if (hive?.connected !== true || typeof hive.token !== 'string' || hive.token.length === 0 || typeof hive.apiUrl !== 'string') {
    throw new Error('hivemind-research: HIVE-MIND is not connected')
  }
  return { token: hive.token, apiBase: apiBase(hive.apiUrl, 'ICARUS API base', true) }
}

function serviceAuthority(ctx: Context, config: Config): Authority {
  const principal = ctx.hivemindExecutionScope.require()
  const env = config.serviceSecretEnv ?? 'HIVE_HARNESS_RUNNER_SERVICE_SECRET'
  const secret = process.env[env]
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) throw new Error(`hivemind-research: ${env} is unavailable`)
  if (config.serviceApiBase === undefined) throw new Error('hivemind-research: serviceApiBase is required in scoped-service mode')
  const now = Math.floor(Date.now() / 1000)
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iss: 'hivemind-harness-runner', aud: 'hivemind-control-plane-harness-proxy', sub: principal.userId, org_id: principal.orgId, profile: principal.profile, iat: now, exp: now + 30, jti: randomUUID() })}`
  return { token: `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`, apiBase: apiBase(config.serviceApiBase, 'service API base'), pathPrefix: '/internal/v1/harness-chat/core' }
}

async function authority(ctx: Context, config: Config): Promise<Authority> {
  return config.authorityMode === 'scoped-service' ? serviceAuthority(ctx, config) : localAuthority(config)
}

async function request(ctx: Context, config: Config, path: string, init: RequestInit, signal: AbortSignal): Promise<JsonRecord> {
  const auth = await authority(ctx, config)
  const target = new URL(`${auth.pathPrefix ?? ''}${path}`, auth.apiBase)
  if (target.origin !== auth.apiBase.origin) throw new Error('hivemind-research: request escaped the trusted origin')
  const controller = new AbortController()
  const timer = setTimeout(() =>{  controller.abort() }, config.requestTimeoutMs)
  try {
    const response = await fetch(target, { ...init, signal: AbortSignal.any([signal, controller.signal]), redirect: 'manual', headers: { accept: 'application/json', authorization: `Bearer ${auth.token}`, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) } })
    if (!response.ok) throw new Error(`hivemind-research: request failed with status ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error('hivemind-research: response exceeds byte limit')
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('hivemind-research: response must be an object')
    return value as JsonRecord
  } finally { clearTimeout(timer) }
}

function unwrap(value: JsonRecord): JsonRecord {
  const data = value.data
  return typeof data === 'object' && data !== null && !Array.isArray(data) ? data : value
}

function selectType(input: JsonRecord, urls: readonly string[]): ResearchType {
  const value = input.research_type === undefined ? 'auto' : text(input.research_type, 'research_type', 40)
  if (!RESEARCH_TYPES.includes(value as ResearchType)) throw new TypeError('hivemind-research: unsupported research_type')
  if (value !== 'auto') return value as ResearchType
  return urls.length > 0 ? 'known_url' : 'focused_fact'
}

function route(type: ResearchType): string {
  if (type === 'known_url') return '/api/web/crawl/jobs'
  if (type === 'multi_hop') return '/api/web/research/jobs'
  if (type === 'connected_source') throw new Error('hivemind-research: connected_source requires the connected-apps capability; use its task-specific tool')
  return '/api/web/search/jobs'
}

function bodyFor(type: ResearchType, objective: string, urls: readonly string[], domains: readonly string[], limit: number): JsonRecord {
  if (type === 'known_url') return { urls: [...urls], depth: 0, page_limit: limit }
  if (type === 'multi_hop') return { input: objective, model: 'auto', citation_format: 'numbered' }
  return { query: objective, domains: [...domains], limit }
}

function submission(value: JsonRecord, type: ResearchType, path: string): SubmittedResearch {
  const response = unwrap(value)
  const jobId = text(response.job_id, 'response.job_id', 200)
  return { jobId, type, route: path, status: optionalText(response.status, 'response.status', 40) ?? 'queued' }
}

function safeUrl(value: JsonValue | undefined): string | undefined {
  if (typeof value !== 'string' || value.length > 2_000) return undefined
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : undefined
  } catch { return undefined }
}

function firstText(record: JsonRecord, keys: readonly string[], maxChars: number): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, maxChars)
  }
  return undefined
}

/** Keep model-visible evidence small and portable across search, crawl, and research providers. */
function sourcesFor(response: JsonRecord, maxResults: number): ResearchSource[] {
  const candidates = [response.sources, response.results, response.pages]
  const sources: ResearchSource[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    for (const item of candidate) {
      if (sources.length >= maxResults || typeof item !== 'object' || item === null || Array.isArray(item)) continue
      const record = item as JsonRecord
      const url = safeUrl(record.url ?? record.source_url ?? record.link ?? record.href)
      if (url === undefined || seen.has(url)) continue
      seen.add(url)
      const title = firstText(record, ['title', 'name', 'source_title'], 300)
      const excerpt = firstText(record, ['snippet', 'excerpt', 'summary', 'text'], 1_000)
      sources.push({ url, ...(title === undefined ? {} : { title }), ...(excerpt === undefined ? {} : { excerpt }) })
    }
  }
  return sources
}

function receipt(value: JsonRecord, jobId: string, maxResults: number): ResearchReceipt {
  const response = unwrap(value)
  const results = Array.isArray(response.results) ? response.results : []
  const provider = optionalAttribution(response.runtime_used, 'response.runtime_used', 100)
  const status = optionalText(response.status, 'response.status', 40) ?? 'unknown'
  const sources = sourcesFor(response, maxResults)
  const error = optionalAttribution(response.error, 'response.error', 1_000)
  const evidenceState: ResearchReceipt['evidenceState'] =
    sources.length > 0 && error === undefined ? 'ready'
      : sources.length > 0 ? 'partial'
        : ['queued', 'running', 'pending'].includes(status) ? 'pending'
          : 'unavailable'
  return {
    jobId,
    status,
    ...(provider === undefined ? {} : { provider }),
    ...(error === undefined ? {} : { error }),
    ...results.length > 0 ? { resultCount: results.length } : {},
    sources,
    evidenceState,
  }
}

function pending(status: string): boolean {
  return ['queued', 'running', 'pending'].includes(status)
}

function compactExcerpt(value: string, maxChars = 1_000): string | undefined {
  const text = value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text === '' ? undefined : text.slice(0, maxChars)
}

/** Read a document title without projecting the fetched page into model context. */
function documentTitle(value: string): string | undefined {
  const htmlTitle = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(value)?.[1]
  const candidate = htmlTitle ?? value.split(/\r?\n/u).map(line => line.trim()).find(Boolean)
  if (candidate === undefined) return undefined
  const normalized = candidate.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return normalized === '' ? undefined : normalized.slice(0, 300)
}

/**
 * Resolve the leading first-party result inside the governed request. This is
 * transport enrichment, not a second research lane: redirects and the page
 * title become part of the same durable receipt and never require another LLM
 * continuation merely to confirm the canonical page identity.
 */
async function resolveLeadingFirstPartySource(
  ctx: Context,
  sources: ResearchSource[],
  signal: AbortSignal,
): Promise<ResearchSource[]> {
  const leading = sources[0]
  if (leading === undefined) return sources
  try {
    const fetched = await ctx.web.fetch({ url: leading.url }, signal)
    if (fetched.statusCode < 200 || fetched.statusCode >= 400) return sources
    const title = documentTitle(fetched.body.content)
    const resolved: ResearchSource = {
      url: fetched.url,
      ...(title === undefined ? (leading.title === undefined ? {} : { title: leading.title }) : { title }),
      ...(leading.excerpt === undefined ? {} : { excerpt: leading.excerpt }),
    }
    return [resolved, ...sources.slice(1).filter(source => source.url !== resolved.url)]
  } catch {
    // Search evidence remains usable when optional canonicalization fails.
    return sources
  }
}

async function localWebReceipt(
  ctx: Context,
  type: ResearchType,
  objective: string,
  urls: readonly string[],
  domains: readonly string[],
  requirements: readonly string[],
  maxResults: number,
  signal: AbortSignal,
): Promise<ResearchReceipt> {
  const jobId = `local-web-${randomUUID()}`
  if (type === 'known_url') {
    const sources: ResearchSource[] = []
    for (const url of urls.slice(0, maxResults)) {
      const fetched = await ctx.web.fetch({ url }, signal)
      const excerpt = compactExcerpt(fetched.body.content)
      sources.push({ url: fetched.url, ...(excerpt === undefined ? {} : { excerpt }) })
    }
    return { jobId, status: 'succeeded', provider: 'http', resultCount: sources.length, sources, evidenceState: sources.length > 0 ? 'ready' : 'unavailable' }
  }
  const scoped = domains.length === 0 ? objective : `${objective} ${domains.map(domain => `site:${domain}`).join(' ')}`
  const result = await ctx.web.search({ query: scoped, maxResults }, signal)
  let sources = result.sources.map((source: WebSearchSource) => ({
    url: source.url,
    ...(source.title === undefined ? {} : { title: source.title }),
    ...(source.snippet === undefined ? {} : { excerpt: source.snippet.slice(0, 1_000) }),
  }))
  if (requirements.includes('first_party')) sources = await resolveLeadingFirstPartySource(ctx, sources, signal)
  return { jobId, status: 'succeeded', provider: 'parallel', resultCount: sources.length, sources, evidenceState: sources.length > 0 ? 'ready' : 'unavailable' }
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })
}

/**
 * Read the just-created job for a short, bounded window. This is deliberately
 * not a hidden provider retry: the request and every receipt remain durable
 * session events, while longer work stays resumable via research_status.
 */
async function awaitInitialReceipt(ctx: Context, config: Config, jobId: string, signal: AbortSignal): Promise<ResearchReceipt> {
  const deadline = Date.now() + config.inlineWaitMs
  let latest: ResearchReceipt | undefined
  do {
    const value = await request(ctx, config, `/api/web/jobs/${encodeURIComponent(jobId)}`, { method: 'GET' }, signal)
    latest = receipt(value, jobId, config.maxResults)
    if (!pending(latest.status) || Date.now() >= deadline) return latest
    await sleep(Math.min(config.statusPollMs, Math.max(0, deadline - Date.now())), signal)
  } while (Date.now() <= deadline)
  return latest ?? { jobId, status: 'queued', sources: [], evidenceState: 'pending' }
}

/**
 * Watch a durable control-plane job through the native Harness job registry.
 * The remote job remains the authority; this only owns the bounded polling
 * resource and lets tool-jobs wake the parent when a terminal receipt lands.
 */
function watchResearch(
  ctx: Context,
  config: Config,
  agent: Agent,
  jobId: string,
  runId: string | undefined,
  watched: WeakMap<Agent, Set<string>>,
): void {
  const active = watched.get(agent) ?? new Set<string>()
  if (active.has(jobId)) return
  const jobs = ctx.get('jobs') as ResearchJobRegistry | undefined
  if (jobs === undefined) return
  active.add(jobId)
  watched.set(agent, active)
  try {
    jobs.start({
      kind: 'hivemind_research',
      label: `HIVE-MIND research ${jobId}`,
      owner: agent,
      outputLimitBytes: 4_000,
      run() {
        const controller = new AbortController()
        const done = (async () => {
          try {
            let received: ResearchReceipt
            do {
              const value = await request(ctx, config, `/api/web/jobs/${encodeURIComponent(jobId)}`, { method: 'GET' }, controller.signal)
              received = { ...receipt(value, jobId, config.maxResults), ...(runId === undefined ? {} : { runId }) }
              if (!pending(received.status)) {
                const workflowId = workflowIdForJob(agent, jobId)
                if (workflowId !== undefined) received = { ...received, workflowId }
                agent.session.append('hivemind/research-receipt', received)
                if (workflowId !== undefined) settleResearchWorkflow(agent, workflowId)
                return { status: 'completed' as const, output: JSON.stringify(received) }
              }
              await sleep(config.statusPollMs, controller.signal)
            } while (true)
          } catch (error) {
            // Job-controller teardown only stops this local watcher. The
            // control-plane research job remains durable and must retain its
            // pending receipt so a recreated parent can attach a new watcher.
            if (controller.signal.aborted) return { status: 'killed' as const, detail: 'research watcher cancelled' }
            const message = error instanceof Error ? error.message : String(error)
            const workflowId = workflowIdForJob(agent, jobId)
            agent.session.append('hivemind/research-receipt', { jobId, ...(runId === undefined ? {} : { runId }), ...(workflowId === undefined ? {} : { workflowId }), status: 'failed', sources: [], evidenceState: 'unavailable', error: message })
            if (workflowId !== undefined) settleResearchWorkflow(agent, workflowId)
            return { status: 'failed' as const, detail: 'research watcher failed', output: message }
          } finally { active.delete(jobId) }
        })()
        return { cancel: () =>{  controller.abort() }, done }
      },
    })
  } catch (error) {
    active.delete(jobId)
    throw error
  }
}

/** Reattach live native watchers to remote jobs that remain pending in the persisted session. */
function restorePendingResearch(ctx: Context, config: Config, agent: Agent, watched: WeakMap<Agent, Set<string>>): void {
  if (typeof agent.session.snapshotEvents !== 'function') return
  const latest = new Map<string, ResearchReceipt>()
  for (const event of agent.session.snapshotEvents() as ReadonlyArray<{ readonly type: string; readonly data: unknown }>) {
    if (event.type !== 'hivemind/research-receipt' || typeof event.data !== 'object' || event.data === null || Array.isArray(event.data)) continue
    const value = event.data as Partial<ResearchReceipt>
    if (typeof value.jobId === 'string') latest.set(value.jobId, value as ResearchReceipt)
  }
  for (const receipt of latest.values()) if (receipt.evidenceState === 'pending') watchResearch(ctx, config, agent, receipt.jobId, receipt.runId, watched)
}

const output = { schema: { type: 'object' as const, additionalProperties: true, properties: {} }, render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }] }

/** Register the compact request/status interface; provider choice remains server-side. */
export function apply(ctx: Context, configured: Partial<Config> = {}): void {
  const config: Config = {
    executionMode: configured.executionMode ?? 'remote',
    authorityMode: configured.authorityMode ?? 'local',
    ...(configured.icarusConfigPath === undefined ? {} : { icarusConfigPath: configured.icarusConfigPath }),
    ...(configured.serviceApiBase === undefined ? {} : { serviceApiBase: configured.serviceApiBase }),
    ...(configured.serviceSecretEnv === undefined ? {} : { serviceSecretEnv: configured.serviceSecretEnv }),
    requestTimeoutMs: configured.requestTimeoutMs ?? 30_000,
    maxObjectiveChars: configured.maxObjectiveChars ?? 8_000,
    maxUrls: configured.maxUrls ?? 8,
    maxResults: configured.maxResults ?? 8,
    maxGatherObjectives: configured.maxGatherObjectives ?? 6,
    maxGatherSources: configured.maxGatherSources ?? 16,
    modelExcerptChars: configured.modelExcerptChars ?? 480,
    exposeAdvancedTools: configured.exposeAdvancedTools ?? true,
    injectTerminalReceipts: configured.injectTerminalReceipts ?? true,
    inlineWaitMs: configured.inlineWaitMs ?? 12_000,
    statusPollMs: configured.statusPollMs ?? 1_000,
  }
  const watched = new WeakMap<Agent, Set<string>>()
  const deliveredResearchReceipts = new WeakMap<Agent, Set<string>>()
  // A restarted/recreated parent reconstructs its pending remote job ids from
  // the session log at its next native inbox claim. No model retry is needed.
  ctx.on('agent/inbox/claimed', ({ agent }) =>{  restorePendingResearch(ctx, config, agent, watched) })
  // Terminal jobs are durable session events, not a second model tool call.
  // Give their compact receipt to the next native model request exactly once;
  // the parent can then continue naturally without manual polling or a
  // duplicate submission.
  if (config.injectTerminalReceipts) {
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      const decision = await next()
      if (decision.kind === 'reject' || typeof agent.session.snapshotEvents !== 'function') return decision
      const delivered = deliveredResearchReceipts.get(agent) ?? new Set<string>()
      const fresh: ResearchReceipt[] = (agent.session.snapshotEvents() as ReadonlyArray<{ readonly type: string; readonly data: unknown }>)
        .filter(event => event.type === 'hivemind/research-receipt' && isTerminalReceipt(event.data))
        .map(event => event.data)
        .filter((receipt): receipt is ResearchReceipt => isTerminalReceipt(receipt) && !delivered.has(receipt.jobId))
      if (fresh.length === 0) return decision
      for (const receipt of fresh) delivered.add(receipt.jobId)
      deliveredResearchReceipts.set(agent, delivered)
      return {
        ...decision,
        messages: [createUserMessage({
          content: [{ type: 'text', text: completionInjection(fresh) }],
          source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name: 'hivemind:research-completed', text: completionInjection(fresh) }] },
        }), ...decision.messages],
        startsRequestSeries: true,
      }
    }, { prepend: true })
  }
  const gatherTool = defineTool({
    name: 'hivemind_research_gather',
    description: 'Gather one or more current-evidence questions in one bounded research phase after an operating plan. Independent objectives execute concurrently. Supply only the distinct natural-language objectives needed for the decision. The coordinator uses the same governed provider for every item, persists the normal request and evidence receipts, deduplicates sources, and returns one compact bundle for synthesis. Use a single objective when one evidence set is sufficient; use several to avoid sequential research calls.',
    parameters: {
      objectives: { type: 'array', required: true, items: { type: 'string' }, description: `One to ${config.maxGatherObjectives} research questions; independent items run concurrently.` },
      domains: { type: 'array', items: { type: 'string' }, description: 'Optional domains shared by every query.' },
      source_requirements: { type: 'array', items: { type: 'string' }, description: 'Shared evidence constraints such as first_party or regulator.' },
      limit_per_objective: { type: 'integer', description: `Maximum results per question (1-${config.maxResults}).` },
      workstream_id: { type: 'string', description: 'Optional operating-plan workstream that this evidence gather completes.' },
    },
    output,
    isConcurrencySafe: () => true,
    async execute(args, execution) {
      const input = inputRecord(args as JsonValue)
      const objectives = stringList(input.objectives, 'objectives', config.maxGatherObjectives, config.maxObjectiveChars)
      if (new Set(objectives).size !== objectives.length) throw new TypeError('hivemind-research: gather objectives must be unique')
      const domains = stringList(input.domains, 'domains', config.maxUrls, 200)
      const requirements = stringList(input.source_requirements, 'source_requirements', 8, 100)
      const workstreamId = optionalText(input.workstream_id, 'workstream_id', 100)
      const workflowId = optionalText(input.workflow_id, 'workflow_id', 100)
      const requestedLimit = input.limit_per_objective ?? config.maxResults
      if (!Number.isInteger(requestedLimit) || (requestedLimit as number) < 1) throw new TypeError('hivemind-research: limit_per_objective must be a positive integer')
      const effectiveLimit = Math.min(requestedLimit as number, config.maxResults)
      const agent = activeAgent(execution.agent)
      const runId = activeRunId(agent)
      const planId = activePlanId(agent)
      const previousGatherId = completedGatherId(agent, planId)
      if (previousGatherId !== undefined) return {
        status: 'already_gathered',
        gather_id: previousGatherId,
        plan_id: planId,
        next: 'This plan already completed its bounded gather phase. Synthesize from the existing receipt, or revise the operating plan before materially different research.',
      }
      const gatherId = `gather-${randomUUID()}`
      const settled = await Promise.allSettled(objectives.map(async (objective) => {
        if (config.executionMode === 'local-web') {
          return localWebReceipt(ctx, 'focused_fact', objective, [], domains, requirements, effectiveLimit, execution.signal)
        }
        const path = route('focused_fact')
        const submitted = submission(await request(ctx, config, path, {
          method: 'POST',
          body: JSON.stringify(bodyFor('focused_fact', objective, [], domains, effectiveLimit)),
        }, execution.signal), 'focused_fact', path)
        agent.session.append('hivemind/research-requested', {
          ...submitted,
          ...(runId === undefined ? {} : { runId }),
          ...(planId === undefined ? {} : { planId }),
          gatherId,
          ...(workflowId === undefined ? {} : { workflowId }),
          objective,
        })
        return awaitInitialReceipt(ctx, config, submitted.jobId, execution.signal)
      }))

      const receipts: ResearchReceipt[] = settled.map((result, index) => result.status === 'fulfilled'
        ? {
          ...result.value,
          ...(runId === undefined ? {} : { runId }),
          ...(planId === undefined ? {} : { planId }),
          gatherId,
          ...(workflowId === undefined ? {} : { workflowId }),
        }
        : {
          jobId: `gather-error-${gatherId}-${index + 1}`,
          ...(runId === undefined ? {} : { runId }),
          ...(planId === undefined ? {} : { planId }),
          gatherId,
          ...(workflowId === undefined ? {} : { workflowId }),
          status: 'failed',
          sources: [],
          evidenceState: 'unavailable',
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        })
      for (let index = 0; index < receipts.length; index += 1) {
        const item = receipts[index]
        const objective = objectives[index]
        if (item === undefined || objective === undefined) throw new Error('hivemind-research: gather result alignment failed')
        if (config.executionMode === 'local-web') agent.session.append('hivemind/research-requested', {
          jobId: item.jobId,
          type: 'focused_fact',
          route: 'local:web',
          status: item.status,
          ...(runId === undefined ? {} : { runId }),
          ...(planId === undefined ? {} : { planId }),
          gatherId,
          ...(workflowId === undefined ? {} : { workflowId }),
          objective,
        })
        agent.session.append('hivemind/research-receipt', item)
        if (item.evidenceState === 'pending') watchResearch(ctx, config, agent, item.jobId, runId, watched)
      }
      const delivered = deliveredResearchReceipts.get(agent) ?? new Set<string>()
      for (const item of receipts) if (item.evidenceState !== 'pending') delivered.add(item.jobId)
      deliveredResearchReceipts.set(agent, delivered)
      const sources: ResearchSource[] = []
      const seen = new Set<string>()
      for (const receipt of receipts) for (const source of receipt.sources) {
        if (sources.length >= config.maxGatherSources || seen.has(source.url)) continue
        seen.add(source.url)
        sources.push(source)
      }
      const ready = receipts.filter(receipt => receipt.evidenceState === 'ready').length
      const status: ResearchGatherReceipt['status'] = ready === receipts.length ? 'succeeded' : ready > 0 ? 'partial' : 'failed'
      const providers = [...new Set(receipts.flatMap(receipt => receipt.provider === undefined ? [] : [receipt.provider]))]
      const receipt: ResearchGatherReceipt = {
        gatherId,
        ...(workflowId === undefined ? {} : { workflowId }),
        ...(runId === undefined ? {} : { runId }),
        ...(planId === undefined ? {} : { planId }),
        ...(workstreamId === undefined ? {} : { workstreamId }),
        status,
        ...(providers.length === 1 ? { provider: providers[0] } : {}),
        objectives: receipts.map((item, index) => {
          const objective = objectives[index]
          if (objective === undefined) throw new Error('hivemind-research: gather objective alignment failed')
          return {
            objective,
            jobId: item.jobId,
            evidenceState: item.evidenceState,
            sourceCount: item.sources.length,
            ...(item.error === undefined ? {} : { error: item.error }),
          }
        }),
        sources,
      }
      const allObjectivesTerminal = receipts.every(item => item.evidenceState !== 'pending')
      if (allObjectivesTerminal) agent.session.append('hivemind/research-gathered', receipt)
      return {
        status,
        all_objectives_terminal: allObjectivesTerminal,
        receipt: {
          ...receipt,
          sources: modelReceipt({
            jobId: gatherId,
            status,
            sources,
            evidenceState: status === 'succeeded' ? 'ready' : status === 'partial' ? 'partial' : 'unavailable',
          }, config.modelExcerptChars).sources,
        },
        next: status === 'failed'
          ? 'No requested research lane produced citeable evidence. Report the evidence gaps.'
          : 'All listed evidence states are terminal. Synthesize from this combined receipt; do not call research_status or launch duplicate research for covered objectives.',
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Gather governed research', kind: 'read', rawInput: 'parallel gather' }),
  })
  if (config.exposeAdvancedTools) ctx.tools.register(gatherTool)
  ctx.tools.register(defineTool({
    name: 'hivemind_research_answer',
    description: 'Research a current topic through one governed, citation-ready evidence phase. Use this once for a multi-source research question before writing the final answer. Supply the overall objective and only genuinely independent questions when they materially improve coverage; they run concurrently. When it returns terminal evidence, synthesize directly from the receipt. Do not start separate research, status, web-search, or web-fetch calls for the same coverage unless the receipt records a specific evidence gap.',
    parameters: {
      objective: { type: 'string', required: true, description: 'The complete user research question and requested final outcome.' },
      questions: { type: 'array', items: { type: 'string' }, description: `Optional genuinely independent evidence questions in addition to the objective (at most ${config.maxGatherObjectives - 1}). Omit when the objective is one coherent research question.` },
      domains: { type: 'array', items: { type: 'string' }, description: 'Optional authoritative domains shared by every evidence question.' },
      source_requirements: { type: 'array', items: { type: 'string' }, description: 'Evidence constraints such as first_party or regulator.' },
      limit_per_question: { type: 'integer', description: `Maximum sources per evidence question (1-${config.maxResults}).` },
    },
    output,
    // One task already owns its concurrent evidence lanes. Serializing task
    // submissions prevents a model from opening duplicate workflows for the
    // same user request while preserving provider-level parallelism inside it.
    isConcurrencySafe: () => false,
    async execute(args, execution) {
      const input = inputRecord(args as JsonValue)
      const objective = text(input.objective, 'objective', config.maxObjectiveChars)
      const questions = stringList(input.questions, 'questions', config.maxGatherObjectives - 1, config.maxObjectiveChars)
      // The overall question is the canonical evidence lane.  Optional
      // questions add genuinely independent coverage; they never replace the
      // requested outcome and therefore cannot leave the parent without
      // evidence for its final synthesis.
      const objectives = [objective, ...questions]
      if (new Set(objectives).size !== objectives.length) throw new TypeError('hivemind-research: pipeline questions must be unique')
      const domains = stringList(input.domains, 'domains', config.maxUrls, 200)
      const requirements = stringList(input.source_requirements, 'source_requirements', 8, 100)
      const requestedLimit = input.limit_per_question ?? config.maxResults
      if (!Number.isInteger(requestedLimit) || (requestedLimit as number) < 1) throw new TypeError('hivemind-research: limit_per_question must be a positive integer')

      const agent = activeAgent(execution.agent)
      const turn = activeTurn(agent)
      const completed = completedResearchWorkflow(agent, turn)
      if (completed !== undefined) return {
        status: 'already_completed',
        workflow: completed,
        next: 'This research task is already terminal in the current user turn. Synthesize from its completed evidence receipt; do not reopen research unless the user asks for a refresh or records a specific evidence gap.',
      }

      const workflowId = `research-workflow-${randomUUID()}`
      agent.session.append('hivemind/research-workflow-started', {
        workflowId,
        objective,
        status: 'running',
        ...(turn === undefined ? {} : { turn }),
      })
      try {
        const result = await gatherTool.execute({
          objectives,
          ...(domains.length === 0 ? {} : { domains }),
          ...(requirements.length === 0 ? {} : { source_requirements: requirements }),
          limit_per_objective: Math.min(requestedLimit as number, config.maxResults),
          workflow_id: workflowId,
        }, execution) as Record<string, JsonValue>
        if (result.status === 'already_gathered') {
          const terminal: ResearchWorkflowTerminal = {
            workflowId,
            objective,
            status: 'completed',
            evidenceState: 'ready',
            ...(typeof result.gather_id === 'string' ? { gatherId: result.gather_id } : {}),
            sourceCount: 0,
            ...(turn === undefined ? {} : { turn }),
          }
          agent.session.append('hivemind/research-workflow-terminal', terminal)
          return { ...result, workflow: terminal }
        }
        if (result.all_objectives_terminal !== true) return {
          ...result,
          workflow: {
            workflowId,
            objective,
            status: 'running',
            ...(turn === undefined ? {} : { turn }),
          },
          next: 'Research is still running through its durable receipts. Do not submit another research task or synthesize yet; native job completion will resume the parent from the terminal evidence receipt.',
        }
        const gathered = inputRecord(result.receipt)
        const status = execution.signal.aborted
          ? 'cancelled'
          : result.status === 'succeeded' ? 'completed' : result.status === 'partial' ? 'partial' : 'failed'
        const sources = Array.isArray(gathered.sources) ? gathered.sources : []
        const terminal: ResearchWorkflowTerminal = {
          workflowId,
          objective,
          status,
          evidenceState: status === 'completed' ? 'ready' : status === 'partial' ? 'partial' : 'unavailable',
          ...(typeof gathered.gatherId === 'string' ? { gatherId: gathered.gatherId } : {}),
          sourceCount: sources.length,
          ...(turn === undefined ? {} : { turn }),
        }
        agent.session.append('hivemind/research-workflow-terminal', terminal)
        return {
          ...result,
          ...(status === 'cancelled' ? { status: 'cancelled' } : {}),
          workflow: terminal,
          ...(status === 'cancelled' ? { next: 'This research task was cancelled. Do not retry automatically; await a new user request.' } : {}),
        }
      } catch (error) {
        const terminal: ResearchWorkflowTerminal = {
          workflowId,
          objective,
          status: execution.signal.aborted ? 'cancelled' : 'failed',
          evidenceState: 'unavailable',
          sourceCount: 0,
          ...(turn === undefined ? {} : { turn }),
        }
        agent.session.append('hivemind/research-workflow-terminal', terminal)
        return {
          status: execution.signal.aborted ? 'cancelled' : 'failed',
          all_objectives_terminal: true,
          workflow: terminal,
          evidence_gap: error instanceof Error ? error.message : String(error),
          next: execution.signal.aborted
            ? 'This research task was cancelled. Do not retry automatically; await a new user request.'
            : 'This research task failed before terminal evidence arrived. State the evidence gap and do not retry automatically.',
        }
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Research current evidence', kind: 'read', rawInput: 'governed research pipeline' }),
  }))
  if (!config.exposeAdvancedTools) return
  ctx.tools.register(defineTool({
    name: 'hivemind_research_request',
    description: 'Start governed HIVE-MIND research and, by default, wait briefly for the same job to return a durable evidence receipt. Use for public facts, sources, comparisons, or independent evidence not already present in organization memory. If the authoritative current page or entity is uncertain, begin with broad_discovery or focused_fact, then pass the returned official URL to known_url. Use known_url for supplied pages, focused_fact for a narrow current fact, broad_discovery for finding entities, multi_hop for deep multi-source research, and legal_compliance when first-party and regulator sources are required. Do not use this tool when the requested deliverable is a screenshot, rendered page, visual inspection, browser interaction, console/network evidence, or browser test; use the controlled browser capability after research identifies the target. The server chooses the provider and records receipts; do not call provider-specific tools or invent sources.',
    parameters: {
      objective: { type: 'string', required: true, description: 'Complete research question and required final output.' },
      research_type: { type: 'string', enum: [...RESEARCH_TYPES], description: 'Optional research lane; auto chooses known_url when URLs exist, otherwise focused_fact.' },
      urls: { type: 'array', items: { type: 'string' }, description: 'Known public URLs to extract.' },
      domains: { type: 'array', items: { type: 'string' }, description: 'Optional domains for focused public search.' },
      entities: { type: 'array', items: { type: 'string' }, description: 'Named entities to resolve or discover.' },
      source_requirements: { type: 'array', items: { type: 'string' }, description: 'Evidence constraints, e.g. first_party or regulator.' },
      limit: { type: 'integer', description: `Maximum evidence results (1-${config.maxResults}); larger positive values are safely capped.` },
      wait_for_result: { type: 'boolean', description: 'Defaults to true. Wait briefly for this same job and return its receipt; set false only when the user explicitly wants an asynchronous research handoff.' },
    },
    output,
    isConcurrencySafe: () => true,
    async execute(args, execution) {
      const input = inputRecord(args as JsonValue)
      const objective = text(input.objective, 'objective', config.maxObjectiveChars)
      const urls = stringList(input.urls, 'urls', config.maxUrls, 2_000)
      const domains = stringList(input.domains, 'domains', config.maxUrls, 200)
      stringList(input.entities, 'entities', config.maxUrls, 500)
      const requirements = stringList(input.source_requirements, 'source_requirements', 8, 100)
      const type = selectType(input, urls)
      if (type === 'known_url' && urls.length === 0) throw new TypeError('hivemind-research: known_url requires urls')
      if (type === 'legal_compliance' && !requirements.some(item => item === 'first_party' || item === 'regulator')) throw new TypeError('hivemind-research: legal_compliance requires first_party or regulator source_requirements')
      const requestedLimit = input.limit ?? config.maxResults
      if (!Number.isInteger(requestedLimit) || (requestedLimit as number) < 1) throw new TypeError('hivemind-research: limit must be a positive integer')
      const effectiveLimit = Math.min(requestedLimit as number, config.maxResults)
      const path = route(type)
      const agent = activeAgent(execution.agent)
      const runId = activeRunId(agent)
      if (config.executionMode === 'local-web') {
        const received = await localWebReceipt(ctx, type, objective, urls, domains, requirements, effectiveLimit, execution.signal)
        const result: SubmittedResearch = { jobId: received.jobId, type, route: 'local:web', status: received.status, ...(runId === undefined ? {} : { runId }) }
        const compact = { ...received, ...(runId === undefined ? {} : { runId }) }
        agent.session.append('hivemind/research-requested', { ...result, objective })
        agent.session.append('hivemind/research-receipt', compact)
        return {
          status: compact.status,
          research: result,
          receipt: modelReceipt(compact, config.modelExcerptChars),
          evidence_requirements: requirements,
          next: compact.evidenceState === 'ready'
            ? 'Evidence is ready. The leading first-party result already includes its resolved URL and document title. Complete the answer from this receipt; fetch again only when the requested output requires page content not present here.'
            : 'Parallel search returned no citeable evidence. Report the evidence gap; do not fabricate a result.',
        }
      }
      const rawResult = submission(await request(ctx, config, path, { method: 'POST', body: JSON.stringify(bodyFor(type, objective, urls, domains, effectiveLimit)) }, execution.signal), type, path)
      const result = { ...rawResult, ...(runId === undefined ? {} : { runId }) }
      agent.session.append('hivemind/research-requested', { ...result, objective })
      const waitForResult = input.wait_for_result === undefined ? true : input.wait_for_result
      if (typeof waitForResult !== 'boolean') throw new TypeError('hivemind-research: wait_for_result must be a boolean')
      if (!waitForResult) return {
        status: 'queued', research: result, evidence_requirements: requirements,
        next: 'This job is intentionally asynchronous. The native job watcher will retain the same receipt and inject its terminal update into the next parent request. Do not start a duplicate request.',
      }
      const received = await awaitInitialReceipt(ctx, config, result.jobId, execution.signal)
      const compact = { ...received, ...(runId === undefined ? {} : { runId }) }
      agent.session.append('hivemind/research-receipt', compact)
      if (compact.evidenceState === 'pending') watchResearch(ctx, config, agent, result.jobId, runId, watched)
      return {
        status: compact.status,
        research: result,
        receipt: modelReceipt(compact, config.modelExcerptChars),
        evidence_requirements: requirements,
        next: compact.evidenceState === 'ready'
          ? 'This is terminal evidence. Use the cited sources and complete the requested analysis; do not call hivemind_research_status for this job.'
          : compact.evidenceState === 'pending'
            ? 'Research remains in progress after the bounded wait. The native watcher continues this same job and provides its terminal receipt to the parent; do not start a duplicate request or present a queued job as a final result.'
            : 'Research did not produce complete evidence. Report the receipt and evidence gap; do not fabricate a result.',
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Start governed research', kind: 'read', rawInput: 'research' }),
  }))
  ctx.tools.register(defineTool({
    name: 'hivemind_research_status',
    description: 'Read the durable status for a prior research job only when its prior receipt said evidenceState: pending. Do not call this after a request already returned ready, unavailable, or failed evidence: that terminal receipt already contains the evidence or gap and polling cannot improve it.',
    parameters: { job_id: { type: 'string', required: true, description: 'Job ID returned by hivemind_research_request.' } },
    output,
    isConcurrencySafe: () => true,
    async execute(args, execution) {
      const jobId = text(inputRecord(args as JsonValue).job_id, 'job_id', 200)
      const agent = activeAgent(execution.agent)
      if (config.executionMode === 'local-web') {
        const events = typeof agent.session.snapshotEvents === 'function' ? agent.session.snapshotEvents() : []
        const found = [...events].reverse().find(event => event.type === 'hivemind/research-receipt'
          && typeof event.data === 'object' && event.data !== null && !Array.isArray(event.data)
          && (event.data as Partial<ResearchReceipt>).jobId === jobId)
        if (found === undefined) throw new Error(`hivemind-research: unknown local research job ${jobId}`)
        const compact = found.data as ResearchReceipt
        return { status: compact.status, receipt: modelReceipt(compact, config.modelExcerptChars), next: compact.evidenceState === 'ready' ? 'This job is already terminal. Use the cited sources; do not poll it again.' : 'Report the evidence gap; do not fabricate a result.' }
      }
      const value = await request(ctx, config, `/api/web/jobs/${encodeURIComponent(jobId)}`, { method: 'GET' }, execution.signal)
      const runId = activeRunId(agent)
      const received = receipt(value, jobId, config.maxResults)
      const compact = { ...received, ...(runId === undefined ? {} : { runId }) }
      agent.session.append('hivemind/research-receipt', compact)
      if (compact.evidenceState === 'pending') watchResearch(ctx, config, agent, jobId, runId, watched)
      return {
        status: compact.status,
        receipt: modelReceipt(compact, config.modelExcerptChars),
        next: compact.evidenceState === 'ready'
          ? 'This job is already terminal. Use the cited sources, or open one returned URL with the browser capability only when rendered page evidence is needed; do not poll it again.'
          : compact.evidenceState === 'pending'
            ? 'Research is not complete. Check this same job again; do not start a duplicate request.'
            : 'Research did not produce complete evidence. Report the receipt and evidence gap; do not fabricate a result.',
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Read research evidence', kind: 'read', rawInput: 'status' }),
  }))
}
