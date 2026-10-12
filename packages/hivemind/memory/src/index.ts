/** Progressive model-facing HIVE-MIND memory capability. @module @deepseek-ai/dsh-hivemind-memory */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolExecution, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-projection'
import { createUserMessage, ToolCallId, type ContextFormed } from '@deepseek-ai/dsh-llm'
import type { HivemindPrincipal } from '@deepseek-ai/dsh-hivemind-execution-scope'
import type {} from '@deepseek-ai/dsh-hivemind-execution-scope'
import { memorySaveApprovalProjection } from './save-approval-projection.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

export interface RecallRequest {
  query: string
  mode: 'memory' | 'auto' | 'hybrid' | 'evidence'
  limit: number
  tags?: string[]
  sourcePlatforms?: string[]
  project?: string
  validAt?: string
  transactionAt?: string
  sort?: 'score' | 'date_asc' | 'date_desc'
  includeSuperseded?: boolean
  /** Optional server-enforced read lens. Omitted means the full authorized union. */
  scopeFilter?: 'personal' | 'organization' | 'project'
}

/** A bounded lookup against the authenticated organization's canonical entity index. */
export interface EntitySearchRequest {
  query: string
  limit: number
  /** Optional server-enforced read lens. Omitted means the full authorized union. */
  scopeFilter?: 'personal' | 'organization' | 'project'
  project?: string
}

/** A policy-checked durable fact or correction proposed by the HIVE agent. */
export interface SaveRequest {
  title: string
  content: string
  /** Trusted plugin provenance and replay key; never exposed by the model-facing save schema. */
  metadata?: Record<string, JsonValue>
  idempotencyKey?: string
  derived?: boolean
  sourceType: 'text' | 'conversation' | 'documentation' | 'decision'
  tags?: string[]
  project?: string
  relationship?: 'update' | 'extend' | 'derive'
  relatedTo?: string
  /** Concrete write destination. Full scope is intentionally not writable. */
  scope?: 'personal' | 'organization' | 'project'
}

const READ_SCOPES = ['personal', 'organization', 'project'] as const
type ReadScope = typeof READ_SCOPES[number]

export interface SaveStatusRequest { idempotencyKey: string }
export interface MemoryProvider {
  /** Read only approved tenant-local advisory methods, never private learning. */
  approvedMethods?(signal: AbortSignal): Promise<readonly Record<string, JsonValue>[]>
  /** Prepare an immutable company proposal; publication requires a separate Runtime review. */
  proposeMethod?(request: Record<string, JsonValue>, signal: AbortSignal): Promise<Record<string, JsonValue>>
  reviewMethod?(request: Record<string, JsonValue>, execution: ToolExecution): Promise<Record<string, JsonValue>>
  context(agent: Agent, signal: AbortSignal): Promise<Record<string, JsonValue>>
  entities(request: EntitySearchRequest, signal: AbortSignal, execution: ToolExecution): Promise<Record<string, JsonValue>>
  recall(request: RecallRequest, signal: AbortSignal, execution: ToolExecution): Promise<Record<string, JsonValue>>
  /** Apply a durable session-derived default before the one native approval. */
  prepareSave?(agent: Agent, request: SaveRequest): SaveRequest
  save(agent: Agent, request: SaveRequest, signal: AbortSignal, execution: ToolExecution): Promise<Record<string, JsonValue>>
  saveStatus?(request: SaveStatusRequest, signal: AbortSignal): Promise<Record<string, JsonValue>>
  profiles(signal: AbortSignal): Promise<Record<string, JsonValue>>
}

declare module '@deepseek-ai/cordis' {
  interface Context { hivemindMemory: MemoryProvider; hivemindMemoryApproval: MemoryApprovalService; hivemindExecutionScope: import('@deepseek-ai/dsh-hivemind-execution-scope').default }
}

export interface MemoryPluginConfig { defaultLimit: number }

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Stores an immutable prepared write and exact native call identity for approved continuation. */
    'hivemind/memory-save-checkpoint': SaveCheckpoint
    /** Records the governed HIVE memory-save lifecycle, destination, and idempotency key. */
    'hivemind/memory-save': {
      operation_id: string
      status: 'prepared' | 'approved' | 'executing' | 'completed' | 'cancelled'
      destination?: 'personal' | 'organization' | 'project'
      idempotency_key?: string
    }
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'hivemind-memory': {
      kind: 'hivemind-memory'
      plugin: 'hivemind-memory'
      callId: string
      operationId: string
      action: 'approved-save-resume' | 'save-result'
    } & ContextFormed
  }
}

interface PendingSave {
  pending: true
  callId: ToolExecution['callId']
  operationId: string
  status?: 'pending'
  message?: string
}

/** Immutable payload owned by the memory tool, never reconstructed from model replay. */
export interface SaveCheckpoint {
  callId: string
  rootCallId: string
  tool: string
  arguments: JsonValue
  requests: SaveRequest[]
  approvalRequest?: SaveRequest
  operationId?: string
  owner: Pick<HivemindPrincipal, 'orgId' | 'userId' | 'profile' | 'variation' | 'projectId'>
  status: 'pending' | 'approved' | 'executing' | 'declined' | 'completed' | 'failed'
  destination?: 'personal' | 'organization' | 'project'
  result?: JsonValue
}

function checkpointFor(agent: Agent, callId: string): SaveCheckpoint | undefined {
  return agent.session.snapshotEvents().findLast(event => event.type === 'hivemind/memory-save-checkpoint'
    && event.data.callId === callId)?.data as SaveCheckpoint | undefined
}

function prepareCheckpoint(
  execution: Pick<ToolExecution, 'agent' | 'callId' | 'rootCallId' | 'name' | 'arguments'>,
  requests: SaveRequest[],
  owner: SaveCheckpoint['owner'],
): SaveRequest[] {
  if (execution.agent === undefined) throw new TypeError('hivemind-memory: active agent required')
  const saved = checkpointFor(execution.agent, String(execution.callId))
  if (saved !== undefined) {
    if (saved.tool !== (execution.name ?? 'hivemind_meta')
      || saved.rootCallId !== String(execution.rootCallId ?? execution.callId)
      || JSON.stringify(saved.arguments) !== JSON.stringify(execution.arguments ?? {})
      || !sameOwner(owner, saved.owner)) {
      throw new Error('hivemind-memory: call identity does not match the saved checkpoint')
    }
    return saved.requests
  }
  execution.agent.session.append('hivemind/memory-save-checkpoint', {
    callId: String(execution.callId), rootCallId: String(execution.rootCallId ?? execution.callId),
    tool: execution.name ?? 'hivemind_meta', arguments: JSON.parse(JSON.stringify(execution.arguments ?? {})) as JsonValue,
    requests, owner, status: 'pending',
  })
  return requests
}

/** Maintenance-only migration for a demonstrably unexecuted, exact legacy save. */
export class MemoryApprovalService extends TypertRemoteService {
  constructor(ctx: Context) { super(ctx, 'hivemindMemoryApproval') }

  @Remote
  pendingSaves(agent: Agent): readonly import('./save-approval-projection.ts').MemorySaveApprovalItem[] {
    if (this.ctx.agents.get(agent.id) !== agent || !this.ctx.agents.roots().includes(agent)) throw new Error('hivemind-memory: exact live root required')
    const owner = this.ctx.hivemindExecutionScope.require()
    const snapshot = this.ctx.sessionProjections.snapshot(agent.session).values.hivemindMemorySaveApprovals
    return (snapshot?.active ?? []).filter((item) => {
      const saved = checkpointFor(agent, item.callId)
      return saved !== undefined && sameOwner(owner, saved.owner)
    })
  }

  @Remote
  async decideSave(agent: Agent, callId: ToolCallId, operationId: string, decision: 'decline' | 'personal' | 'organization' | 'project'): Promise<boolean> {
    if (this.ctx.agents.get(agent.id) !== agent || !this.ctx.agents.roots().includes(agent)) throw new Error('hivemind-memory: exact live root required')
    const owner = this.ctx.hivemindExecutionScope.require()
    const saved = checkpointFor(agent, String(callId))
    const savedExecution = saved === undefined ? undefined : {
      agent,
      callId: ToolCallId(saved.callId),
      rootCallId: ToolCallId(saved.rootCallId),
      name: saved.tool,
      arguments: saved.arguments,
    } as ToolExecution
    if (saved === undefined || saved.operationId !== operationId || saved.approvalRequest === undefined
      || savedExecution === undefined || saveOperationId(savedExecution, saved.approvalRequest) !== operationId
      || !sameOwner(owner, saved.owner)) throw new Error('hivemind-memory: active saved operation and tenant must match')
    if (saved.status !== 'pending') {
      if (saved.status === 'approved' && decision === saved.destination) {
        agent.steer(createUserMessage({ source: { kind: 'hivemind-memory', plugin: 'hivemind-memory', callId: String(callId), operationId, action: 'approved-save-resume' },
          content: [{ type: 'text', text: 'Resume the exact approved HIVE-MIND memory save checkpoint. Do not recreate or alter its payload.' }] }))
        return true
      }
      if (saved.status === 'completed' && decision === saved.destination) return true
      if (saved.status === 'declined' && decision === 'decline') return true
      throw new Error('hivemind-memory: a conflicting decision already exists for this operation')
    }
    if (decision !== 'decline' && !saved.requests.every(request => decision !== 'project' || request.project !== undefined)) throw new Error('hivemind-memory: project destination is unavailable')
    const destination = decision === 'decline' ? undefined : decision
    const next: SaveCheckpoint = { ...saved, status: decision === 'decline' ? 'declined' : 'approved', ...(destination === undefined ? {} : { destination }) }
    agent.session.append('hivemind/memory-save-checkpoint', next)
    appendSaveEvent(agent, { operation_id: operationId, status: decision === 'decline' ? 'cancelled' : 'approved', ...(destination === undefined ? {} : { destination }) })
    const sessions = this.ctx.get('sessions')
    if (sessions !== undefined && !await sessions.flush(agent.session)) throw new Error('hivemind-memory: approval checkpoint was not persisted')
    if (destination !== undefined) agent.steer(createUserMessage({
      source: { kind: 'hivemind-memory', plugin: 'hivemind-memory', callId: String(callId), operationId, action: 'approved-save-resume' },
      content: [{ type: 'text', text: 'Resume the exact approved HIVE-MIND memory save checkpoint. Do not recreate or alter its payload.' }],
    }))
    return true
  }
}

function sameOwner(a: HivemindPrincipal, b: SaveCheckpoint['owner']): boolean {
  return a.orgId === b.orgId && a.userId === b.userId && a.profile === b.profile
    && a.variation === b.variation && a.projectId === b.projectId
}

/** Pause one prepared save for a native destination approval, then return the
 * final request to the same invocation. A declined/cancelled card performs no
 * provider write and never asks the model to reconstruct the save. */
async function approveSaveDestination(
  ctx: Context,
  execution: ToolExecution,
  request: SaveRequest,
  fullAccessAllowed: ((agent: Agent, signal: AbortSignal) => Promise<boolean>) | undefined,
): Promise<(SaveRequest & { scope: NonNullable<SaveRequest['scope']> }) | PendingSave | undefined> {
  if (execution.agent === undefined) throw new TypeError('hivemind-memory: active agent required')
  const operationId = saveOperationId(execution, request)
  const prior = latestSaveEvent(execution.agent, operationId)
  if (prior?.status === 'completed' && prior.destination !== undefined) {
    return { ...request, scope: prior.destination, idempotencyKey: `${operationId}:${prior.destination}` }
  }
  if (prior?.status === 'approved' && prior.destination !== undefined) {
    return { ...request, scope: prior.destination, idempotencyKey: `${operationId}:${prior.destination}` }
  }
  const previousCheckpoint = checkpointFor(execution.agent, String(execution.callId))
  if (previousCheckpoint?.status === 'declined') return undefined
  if ((previousCheckpoint?.status === 'approved' || previousCheckpoint?.status === 'executing') && previousCheckpoint.destination !== undefined) {
    return { ...request, scope: previousCheckpoint.destination, idempotencyKey: `${operationId}:${previousCheckpoint.destination}` }
  }
  const presets = ctx.get('permissionPresets') as { current(session: Agent['session']): string } | undefined
  if (presets?.current(execution.agent.session) === 'danger-full-access' || await fullAccessAllowed?.(execution.agent, execution.signal)) {
    // Full access is explicit session permission; it does not change tenant ACLs.
    // A concrete requested/prepared scope wins. Company-brain saves otherwise
    // use the company, or the explicitly selected project.
    const scope = request.scope ?? (request.project !== undefined ? 'project' : 'organization')
    appendSaveEvent(execution.agent, { operation_id: operationId, status: 'approved', destination: scope })
    if (previousCheckpoint !== undefined) execution.agent.session.append('hivemind/memory-save-checkpoint', { ...previousCheckpoint, operationId, approvalRequest: request, status: 'approved', destination: scope })
    return { ...request, scope, idempotencyKey: `${operationId}:${scope}` }
  }
  if (previousCheckpoint === undefined) throw new Error('hivemind-memory: prepared save checkpoint is unavailable')
  if (previousCheckpoint.operationId !== undefined && previousCheckpoint.operationId !== operationId) throw new Error('hivemind-memory: saved operation identity changed')
  execution.agent.session.append('hivemind/memory-save-checkpoint', { ...previousCheckpoint, operationId, approvalRequest: request, status: 'pending' })
  appendSaveEvent(execution.agent, { operation_id: operationId, status: 'prepared' })
  ;(execution as ToolRunContext).concludeTurn()
  return { pending: true, callId: execution.callId, operationId, status: 'pending', message: 'Memory save is prepared and awaits an explicit destination decision. No write has occurred.' }

}

type SaveEventStatus = 'prepared' | 'approved' | 'executing' | 'completed' | 'cancelled'

interface SaveEventData {
  operation_id: string
  status: SaveEventStatus
  destination?: 'personal' | 'organization' | 'project'
  idempotency_key?: string
}

export function saveOperationId(execution: ToolExecution, request: SaveRequest): string {
  const sessionId = execution.agent?.session?.header.id || 'session-unavailable'
  const canonical = JSON.stringify({
    session_id: sessionId,
    title: request.title,
    content: request.content,
    source_type: request.sourceType,
    tags: [...(request.tags ?? [])].sort(),
    project: request.project ?? null,
    relationship: request.relationship ?? null,
    related_to: request.relatedTo ?? null,
  })
  return `saveop:${createHash('sha256').update(canonical).digest('hex')}`
}

function appendSaveEvent(agent: Agent, data: SaveEventData): void {
  agent.session.append('hivemind/memory-save', data)
}

async function runCheckpointedSave(
  ctx: Context,
  execution: ToolExecution,
  destination: NonNullable<SaveRequest['scope']>,
  work: () => Promise<Record<string, JsonValue>>,
): Promise<Record<string, JsonValue>> {
  const agent = execution.agent
  if (agent === undefined) throw new TypeError('hivemind-memory: active agent required')
  const saved = checkpointFor(agent, String(execution.callId))
  if (saved?.status === 'completed' && saved.result !== undefined && typeof saved.result === 'object' && saved.result !== null && !Array.isArray(saved.result)) {
    return saved.result as Record<string, JsonValue>
  }
  if (saved === undefined || saved.operationId === undefined || saved.status !== 'approved' || saved.destination !== destination) {
    throw new Error('hivemind-memory: approved checkpoint is required before writing')
  }
  agent.session.append('hivemind/memory-save-checkpoint', { ...saved, status: 'executing' })
  appendSaveEvent(agent, { operation_id: saved.operationId, status: 'executing', destination })
  const sessions = ctx.get('sessions')
  if (sessions !== undefined && !await sessions.flush(agent.session)) throw new Error('hivemind-memory: execution checkpoint was not persisted')
  try {
    const result = await work()
    agent.session.append('hivemind/memory-save-checkpoint', { ...saved, status: 'completed', destination, result })
    appendSaveEvent(agent, { operation_id: saved.operationId, status: 'completed', destination })
    if (sessions !== undefined && !await sessions.flush(agent.session)) throw new Error('hivemind-memory: result checkpoint was not persisted')
    return result
  } catch (error) {
    agent.session.append('hivemind/memory-save-checkpoint', { ...saved, status: 'failed', destination })
    appendSaveEvent(agent, { operation_id: saved.operationId, status: 'cancelled', destination })
    if (sessions !== undefined) await sessions.flush(agent.session)
    throw error
  }
}

function latestSaveEvent(agent: Agent, operationId: string): SaveEventData | undefined {
  // Session keeps its authoritative event log behind snapshotEvents(); the
  // public Session object does not expose an `events` field. Reading that
  // private-looking field caused resumed approvals to appear pending and the
  // destination card to be shown repeatedly.
  const events = agent.session.snapshotEvents() as readonly { type?: string; data?: SaveEventData }[]
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'hivemind/memory-save' && event.data?.operation_id === operationId) return event.data
  }
  return undefined
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`hivemind-memory: ${label} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`hivemind-memory: ${label} must be a non-empty string`)
  return value.trim()
}

function strings(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new TypeError(`hivemind-memory: ${label} must be an array`)
  return value.map((item, index) => text(item, `${label}[${index}]`))
}

function optionalScope(value: unknown, label: string): ReadScope | undefined {
  if (value === undefined) return undefined
  const result = text(value, label)
  if (!(READ_SCOPES as readonly string[]).includes(result)) throw new TypeError(`hivemind-memory: ${label} is unsupported`)
  return result as ReadScope
}

function boundedText(value: unknown, label: string, maxChars: number): string {
  const result = text(value, label)
  if (result.length > maxChars) throw new TypeError(`hivemind-memory: ${label} exceeds ${maxChars} characters`)
  return result
}

function memoryId(value: unknown, label: string): string {
  const result = text(value, label)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) {
    throw new TypeError(`hivemind-memory: ${label} must be an exact memory id returned by recall`)
  }
  return result
}

/** Refuse obvious credential material before it can leave the Harness process. */
function containsCredentialMaterial(value: string): boolean {
  return [
    /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/i,
    /\b(?:api[ _-]?key|access[ _-]?token|auth(?:entication)?[ _-]?token|password|secret)\s*[:=]\s*\S+/i,
    /\b(?:sk|ak|pk)_[A-Za-z0-9_-]{16,}\b/,
    /\b(?:one[- ]time (?:pass(?:word|code)|code)|otp|verification code|security code|login code|sign[- ]in code|2fa code|mfa code)\b/i,
    /\b(?:reset|recover|change)\s+(?:your\s+)?password\b/i,
    /https?:\/\/\S*(?:reset[-_/]?password|password[-_/]?reset|verify[-_/]?(?:account|email)|magic[-_/]?link)\S*/i,
    /\b(?:new|unrecognized|unrecognised|suspicious)\s+(?:sign[- ]?in|login|authentication)(?:\s+(?:attempt|alert|activity))?\b/i,
  ].some(pattern => pattern.test(value))
}

function tagsFor(input: Record<string, unknown>): string[] | undefined {
  const tags = strings(input['tags'], 'tags') ?? []
  const mediaKind = input['media_kind']
  if (mediaKind !== undefined) tags.push(`kind:${text(mediaKind, 'media_kind')}`)
  const filename = input['filename']
  if (filename !== undefined) tags.push(`filename:${text(filename, 'filename')}`)
  for (const entity of strings(input['entities'], 'entities') ?? []) tags.push(`entity:${entity}`)
  return tags.length === 0 ? undefined : [...new Set(tags)]
}

/** Normalize model-extracted save entities deterministically at the tool
 * boundary. Entity extraction remains with the model because it has the full
 * user meaning; this function never performs a second inference. */
function saveTags(input: Record<string, unknown>): string[] | undefined {
  const tags = strings(input['tags'], 'tags') ?? []
  for (const entity of strings(input['entities'], 'entities') ?? []) {
    const normalized = entity
      .normalize('NFKC')
      .toLocaleLowerCase('en-US')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
    if (normalized !== '') tags.push(`entity:${normalized}`)
  }
  const unique = [...new Set(tags)]
  if (unique.length > 50) throw new TypeError('hivemind-memory: tags and entities may contain at most 50 unique items')
  return unique.length === 0 ? undefined : unique
}

/** Accept the historical flat read form without spending another model turn.
 * The canonical public schema remains nested and both forms receive the same
 * strict field validation below. */
function readInput(args: Record<string, unknown>, key: 'recall' | 'entities'): Record<string, unknown> {
  const nested = args[key]
  const { operation: _operation, ...flat } = args
  const input = nested !== undefined || flat['query'] === undefined ? object(nested, key) : flat
  // An empty optional read filter means no filter. Required query/limit and
  // every write field retain their existing strict validation.
  return Object.fromEntries(Object.entries(input).filter(([field, value]) => {
    if (['filename', 'valid_at', 'transaction_at', 'project'].includes(field) && typeof value === 'string' && value.trim() === '') return false
    return field !== 'media_kind' || value !== 'all'
  }))
}

/** Repair only an unambiguous single read envelope before native validation.
 * Writes and mixed/unknown shapes still fail the required-operation schema. */
function repairMissingReadOperation(args: unknown): unknown {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return args
  const input = args as Record<string, unknown>
  if (Object.hasOwn(input, 'operation')) return args
  const keys = Object.keys(input)
  if (keys.length !== 1 || (keys[0] !== 'entities' && keys[0] !== 'recall')) return args
  const nested = input[keys[0]]
  if (typeof nested !== 'object' || nested === null || Array.isArray(nested)) return args
  return { ...input, operation: keys[0] }
}

/** Parse the one canonical shape accepted by both the compatibility gateway and save tool. */
function saveRequest(input: Record<string, unknown>): SaveRequest {
  const sourceType = text(input['source_type'] ?? 'conversation', 'source_type')
  if (!['text', 'conversation', 'documentation', 'decision'].includes(sourceType)) throw new TypeError('hivemind-memory: source_type is unsupported')
  const relationship = input['relationship'] === undefined ? undefined : text(input['relationship'], 'relationship')
  if (relationship !== undefined && !['update', 'extend', 'derive'].includes(relationship)) throw new TypeError('hivemind-memory: relationship is unsupported')
  const relatedTo = input['related_to'] === undefined ? undefined : memoryId(input['related_to'], 'related_to')
  const scope = optionalScope(input['scope'] ?? input['destination_scope'], 'scope')
  const project = input['project'] === undefined ? undefined : boundedText(input['project'], 'project', 255)
  if (scope === 'project' && project === undefined) throw new TypeError('hivemind-memory: project scope requires project')
  if (relationship !== undefined && relatedTo === undefined) throw new TypeError('hivemind-memory: related_to is required when relationship is set')
  if (relationship === undefined && relatedTo !== undefined) throw new TypeError('hivemind-memory: relationship is required when related_to is set')
  const tags = saveTags(input)
  const request: SaveRequest = {
    title: boundedText(input['title'], 'save.title', 500),
    content: boundedText(input['content'], 'save.content', 20_000),
    sourceType: sourceType as SaveRequest['sourceType'],
    ...tags === undefined ? {} : { tags },
    ...project === undefined ? {} : { project },
    ...relationship === undefined ? {} : { relationship: relationship as NonNullable<SaveRequest['relationship']> },
    ...relatedTo === undefined ? {} : { relatedTo },
    ...scope === undefined ? {} : { scope },
  }
  if (containsCredentialMaterial(`${request.title}\n${request.content}`)) throw new TypeError('hivemind-memory: save refuses credential or authentication material')
  return request
}
const output = {
  schema: { type: 'object' as const, additionalProperties: true, properties: {} },
  render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

/** Register the authenticated HIVE-MIND context, recall, governed save, and employee-directory router. */
export function memoryPlugin(config: MemoryPluginConfig, provider: MemoryProvider) {
  return {
    name: 'hivemind-memory',
    inject: ['tools', 'agents', 'hivemindExecutionScope', 'sessionProjections'],
    apply(ctx: Context): void {
      ctx.sessionProjections.register(memorySaveApprovalProjection)
      let hqFullAccessAllowed: ((agent: Agent, signal: AbortSignal) => Promise<boolean>) | undefined
      ctx.inject(['hivemindHq'], hqCtx => hqCtx.effect(() => {
        const hq = hqCtx.get('hivemindHq') as {
          fullAccessAllowed?: (agent: Agent, signal: AbortSignal) => Promise<boolean>
        }
        hqFullAccessAllowed = (agent, signal) => hq.fullAccessAllowed?.(agent, signal) ?? Promise.resolve(false)
        return () => { hqFullAccessAllowed = undefined }
      }))
      const resuming = new WeakSet<Agent>()
      ctx.effect(() => ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
        const decision = await next()
        if (decision.kind === 'reject' || resuming.has(agent)) return decision
        const checkpoints = new Map<string, SaveCheckpoint>()
        for (const event of agent.session.snapshotEvents()) {
          if (event.type === 'hivemind/memory-save-checkpoint') checkpoints.set(event.data.callId, event.data)
        }
        for (const saved of checkpoints.values()) {
          const admitted = agent.session.snapshotEvents().findLast(event => event.type === 'user/message'
            && event.data.source.kind === 'hivemind-memory' && event.data.source.action === 'approved-save-resume'
            && event.data.source.callId === saved.callId && event.data.source.operationId === saved.operationId)
          if (saved.status !== 'approved' || saved.operationId === undefined || admitted === undefined) continue
          resuming.add(agent)
          try {
            const result = await ctx.hivemindExecutionScope.run(saved.owner, () => ctx.tools.execute({
              agent, signal, callId: ToolCallId(saved.callId),
              rootCallId: ToolCallId(saved.rootCallId), name: saved.tool, arguments: saved.arguments,
            }))
            agent.session.append('user/message', createUserMessage({
              source: { kind: 'hivemind-memory', plugin: 'hivemind-memory', callId: saved.callId, operationId: saved.operationId, action: 'save-result' },
              content: [{ type: 'text', text: JSON.stringify({ operation: 'approved_memory_save', callId: saved.callId,
                isError: result.isError, content: result.content }) }],
            }), { surfaceOp: 'append' })
          } finally { resuming.delete(agent) }
        }
        return decision
      }))
      new MemoryApprovalService(ctx)
      ctx.provide('hivemindMemory', provider)
      ctx.effect(() => ctx.tools.register(defineTool({
        name: 'hivemind_save_memory',
        description: 'Durably save one confirmed, stable HIVE-MIND memory. A user-stated company decision, project direction, standing preference, role assignment, or factual correction can qualify even without the words "save this"; do not persist a proposal, question, transient remark, or speculation. Use this direct tool for a standalone fact, preference, decision, correction, relationship, or completed outcome. Before saving, extract every concrete detail that will help future recall—each named person, organization, product, project, document, system, tool, place, date or period, and distinct subject or concept—and include each once in entities; the Harness deterministically stores them as normalized entity:* tags. Do not collapse a detailed memory into only broad generic tags. A successful result must include the saved memory receipt. Never save secrets, credentials, ephemeral chat, guesses, or unverified claims.',
        parameters: {
          title: { type: 'string', required: true },
          content: { type: 'string', required: true },
          source_type: { type: 'string', enum: ['text', 'conversation', 'documentation', 'decision'] },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional non-entity classification tags. Put concrete named details in entities.' },
          entities: { type: 'array', items: { type: 'string' }, description: 'Exhaustive concrete details from the memory: every named person, organization, product, project, document, system, tool, place, date or period, and distinct subject or concept. Each value becomes one normalized entity:* tag. Never invent an entity.' },
          project: { type: 'string' },
          scope: { type: 'string', enum: ['personal', 'organization', 'project'], description: 'Concrete write destination. Full scope is read-only and cannot be used for a save. Project scope requires project.' },
          relationship: { type: 'string', enum: ['update', 'extend', 'derive'], description: 'Optional relation to an existing recalled memory. Omit for a new standalone memory. When set, related_to is required.' },
          related_to: { type: 'string', description: 'The exact recalled memory UUID that the relationship targets. Never use a person, project, topic, or label.' },
        },
        output,
        isConcurrencySafe: () => false,
        async execute(args, execution) {
          const agent = execution.agent
          if (agent === undefined) throw new TypeError('hivemind-memory: active agent required')
          const normalized = saveRequest(args)
          const owner = ctx.hivemindExecutionScope.require()
          const [prepared] = prepareCheckpoint(execution, [provider.prepareSave?.(agent, normalized) ?? normalized], owner)
          if (prepared === undefined) throw new Error('hivemind-memory: prepared save is unavailable')
          const approved = await approveSaveDestination(ctx, execution, prepared, hqFullAccessAllowed)
          if (approved !== undefined && 'pending' in approved) return approved as unknown as Record<string, JsonValue>
          return approved === undefined
            ? { operation: 'save', status: 'cancelled' }
            : runCheckpointedSave(ctx, execution, approved.scope, () =>
              provider.save(agent, approved, execution.signal, execution))
        },
      })))
      ctx.effect(() => ctx.tools.register(defineTool({
        name: 'hivemind_batch_save_memories',
        description: 'Durably save a bounded batch of confirmed stable HIVE-MIND memories with one destination approval. Use this instead of many individual save calls when the user explicitly asks to save multiple records. For every item, extract every concrete detail that will help future recall into entities; the Harness stores those values as normalized entity:* tags. Do not reduce detailed records to broad generic tags. Every item is validated before approval; writes execute sequentially and return one batch receipt.',
        parameters: {
          items: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                title: { type: 'string', required: true },
                content: { type: 'string', required: true },
                source_type: { type: 'string', enum: ['text', 'conversation', 'documentation', 'decision'] },
                tags: { type: 'array', items: { type: 'string' }, description: 'Optional non-entity classification tags.' },
                entities: { type: 'array', items: { type: 'string' }, description: 'Exhaustive concrete details: named people, organizations, products, projects, documents, systems, tools, places, dates or periods, and distinct subjects or concepts.' },
                project: { type: 'string' },
                relationship: { type: 'string', enum: ['update', 'extend', 'derive'] },
                related_to: { type: 'string' },
              },
            },
          },
          scope: { type: 'string', enum: ['personal', 'organization', 'project'], description: 'One destination for the complete batch. Project scope requires every item to use the same project.' },
        },
        output,
        isConcurrencySafe: () => false,
        async execute(args, execution) {
          if (execution.agent === undefined) throw new TypeError('hivemind-memory: active agent required')
          const agent = execution.agent
          if (!Array.isArray(args.items) || args.items.length < 1 || args.items.length > 25) {
            throw new TypeError('hivemind-memory: batch requires between 1 and 25 items')
          }
          const requestedScope = optionalScope(args.scope, 'scope')
          const owner = ctx.hivemindExecutionScope.require()
          const prepared = prepareCheckpoint(execution, args.items.map((item, index) => {
            const raw = object(item, `items[${index}]`)
            const request = saveRequest({ ...raw, ...(requestedScope === undefined ? {} : { scope: requestedScope }) })
            return provider.prepareSave?.(agent, request) ?? request
          }), owner)
          const projects = [...new Set(prepared.flatMap(item => item.project === undefined ? [] : [item.project]))]
          if (requestedScope === 'project' && projects.length !== 1) {
            throw new TypeError('hivemind-memory: project batch requires one shared project')
          }
          const approvalRequest: SaveRequest = {
            title: `${prepared.length} prepared memories`,
            content: JSON.stringify(prepared.map(({ metadata: _metadata, idempotencyKey: _key, ...item }) => item)),
            sourceType: 'conversation',
            ...(projects.length === 1 ? { project: projects[0] } : {}),
            ...(requestedScope === undefined ? {} : { scope: requestedScope }),
          }
          const checkpoint = checkpointFor(agent, String(execution.callId))
          if (checkpoint !== undefined) agent.session.append('hivemind/memory-save-checkpoint', { ...checkpoint, operationId: saveOperationId(execution, approvalRequest), approvalRequest })
          const approved = await approveSaveDestination(ctx, execution, approvalRequest, hqFullAccessAllowed)
          if (approved !== undefined && 'pending' in approved) return approved as unknown as Record<string, JsonValue>
          if (approved === undefined) return { operation: 'batch_save', status: 'cancelled', count: prepared.length }
          if (approved.scope === undefined) throw new Error('hivemind-memory: approved batch destination is unavailable')
          const destination = approved.scope
          return runCheckpointedSave(ctx, execution, destination, async () => {
            const results: Record<string, JsonValue>[] = []
            for (const request of prepared) {
              results.push(await provider.save(agent, { ...request, scope: destination, idempotencyKey: `${saveOperationId(execution, request)}:${destination}` }, execution.signal, execution))
            }
            return { operation: 'batch_save', status: 'completed', count: results.length, destination, results }
          })
        },
      })))
      const metaTool = defineTool({
        name: 'hivemind_meta',
        description: 'HIVE-MIND gateway. REQUIRED top-level operation: "context", "entities", "recall", "save", "save_status", or "profiles". Put entity-search arguments under entities and memory-search arguments under recall. An unambiguous omitted read operation is repaired once before dispatch; mixed forms and writes are rejected. For questions about a named person, organization, topic, project, or document, call {operation:"recall",recall:{query:"exact user question"}} directly; append recent conversation context only to resolve an ambiguous reference, never an inferred profile identity. Entity search is optional, not a prerequisite. For an explicit entity-search request, call {operation:"entities",entities:{query:"name"}} and report actual matches only. Empty entity matches are not evidence of absent memories. Do not merge same-name people or personal and company facts without an evidence-backed identity link. Use context for the caller or company profile. Proactively save a confirmed stable preference, decision, project direction, role assignment, correction, or completed outcome, but never a proposal, question, transient remark, guess, secret, or credential. Add every concrete named detail to save.entities. Tenant scope comes from the current credential.',
        parameters: {
          operation: { type: 'string', required: true, enum: ['context', 'entities', 'recall', 'save', 'save_status', 'profiles'], description: 'REQUIRED at the top level on every call. Do not place it inside entities or recall. If validation reports a missing operation, correct the next call once; do not repeat the malformed call.' },
          entities: {
            type: 'object',
            additionalProperties: false,
            properties: {
              query: { type: 'string', required: true, description: 'Exact named subject to match against canonical names and aliases.' },
              limit: { type: 'integer', description: 'Maximum canonical matches to return.' },
              scope_filter: { type: 'string', enum: ['personal', 'organization', 'project'], description: 'Optional server-enforced read lens. Omit for the full authorized union.' },
              project: { type: 'string', description: 'Authorized project identifier when using project scope.' },
            },
          },
          recall: {
            type: 'object',
            additionalProperties: false,
            properties: {
              query: { type: 'string', required: true, description: 'Use the full user question verbatim. Only append a referent from recent completed conversation when a pronoun or "this topic" needs resolution. Do not inject profile names or inferred identity. A name is a soft query hint, not an entity ID requirement.' },
              mode: { type: 'string', enum: ['memory', 'auto', 'hybrid', 'evidence'] },
              limit: { type: 'integer' },
              tags: { type: 'array', items: { type: 'string' } },
              source_platforms: { type: 'array', items: { type: 'string' } },
              media_kind: { type: 'string', enum: ['all', 'image', 'document'], description: 'Omit or use all unless the user requested an image/document filter.' },
              filename: { type: 'string', description: 'Optional filename filter; omit unless the user named a file. Empty means no filter.' },
              entities: { type: 'array', items: { type: 'string' } },
              project: { type: 'string' },
              valid_at: { type: 'string', description: 'Optional historical validity filter. Omit unless requested; empty means no filter.' },
              transaction_at: { type: 'string', description: 'Optional historical transaction filter. Omit unless requested; empty means no filter.' },
              sort: { type: 'string', enum: ['score', 'date_asc', 'date_desc'] },
              include_superseded: { type: 'boolean' },
              scope_filter: { type: 'string', enum: ['personal', 'organization', 'project'], description: 'Optional server-enforced read lens. Omit for the full authorized union.' },
            },
          },
          save: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string', required: true },
              content: { type: 'string', required: true },
              source_type: { type: 'string', enum: ['text', 'conversation', 'documentation', 'decision'] },
              tags: { type: 'array', items: { type: 'string' }, description: 'Optional non-entity classification tags.' },
              entities: { type: 'array', items: { type: 'string' }, description: 'Exhaustive concrete details from the memory: every named person, organization, product, project, document, system, tool, place, date or period, and distinct subject or concept. Each value becomes one normalized entity:* tag.' },
              project: { type: 'string' },
              scope: { type: 'string', enum: ['personal', 'organization', 'project'], description: 'Concrete write destination. Full scope is read-only and cannot be used for a save. Project scope requires project.' },
              relationship: { type: 'string', enum: ['update', 'extend', 'derive'], description: 'Optional relation to an existing memory. Omit for a new standalone memory. When set, related_to is required.' },
              related_to: { type: 'string', description: 'The exact recalled memory UUID that the relationship targets. Never use a person, project, topic, or label.' },
            },
          },
          save_status: {
            type: 'object',
            additionalProperties: false,
            properties: {
              idempotency_key: { type: 'string', required: true, description: 'Exact idempotency key returned by a prior save result.' },
            },
          },
        },
        output,
        isConcurrencySafe: args => args.operation !== 'save',
        async execute(args, execution) {
          const operation = text(args.operation, 'operation')
          if (operation === 'context') {
            if (execution.agent === undefined) throw new TypeError('hivemind-memory: active agent required')
            return provider.context(execution.agent, execution.signal)
          }
          if (operation === 'profiles') return provider.profiles(execution.signal)
          if (operation === 'entities') {
            const input = readInput(args, 'entities')
            const rawLimit = input['limit'] ?? config.defaultLimit
            if (!Number.isInteger(rawLimit) || (rawLimit as number) < 1 || (rawLimit as number) > 25) throw new TypeError('hivemind-memory: entity limit must be an integer from 1 to 25')
            const scopeFilter = optionalScope(input['scope_filter'] ?? input['scope'], 'entities.scope_filter')
            return provider.entities({
              query: text(input['query'], 'entities.query'), limit: rawLimit as number,
              ...scopeFilter === undefined ? {} : { scopeFilter },
              ...input['project'] === undefined ? {} : { project: boundedText(input['project'], 'entities.project', 255) },
            }, execution.signal, execution)
          }
          if (operation === 'save') {
            if (execution.agent === undefined) throw new TypeError('hivemind-memory: active agent required')
            const agent = execution.agent
            // Accept the historical flat form once and normalize it into the canonical
            // nested contract. This prevents a model formatting slip from causing a
            // second inference/search loop while retaining strict field validation.
            const rawSave = args.save === undefined
              ? args
              : object(args.save, 'save')
            const normalized = saveRequest(rawSave)
            const owner = ctx.hivemindExecutionScope.require()
            const [prepared] = prepareCheckpoint(
              execution, [provider.prepareSave?.(agent, normalized) ?? normalized], owner,
            )
            if (prepared === undefined) throw new Error('hivemind-memory: prepared save is unavailable')
            const approved = await approveSaveDestination(ctx, execution, prepared, hqFullAccessAllowed)
            if (approved !== undefined && 'pending' in approved) return approved as unknown as Record<string, JsonValue>
            return approved === undefined
              ? { operation: 'save', status: 'cancelled' }
              : runCheckpointedSave(ctx, execution, approved.scope, () =>
                provider.save(agent, approved, execution.signal, execution))
          }
          if (operation === 'save_status') {
            const input = object(args.save_status, 'save_status')
            if (provider.saveStatus === undefined) return { operation: 'save_status', status: 'capability_unavailable' }
            return provider.saveStatus({ idempotencyKey: text(input['idempotency_key'], 'idempotency_key') }, execution.signal)
          }
          if (operation !== 'recall') throw new TypeError('hivemind-memory: unsupported operation')
          const input = readInput(args, 'recall')
          const rawLimit = input['limit'] ?? config.defaultLimit
          if (!Number.isInteger(rawLimit) || (rawLimit as number) < 1 || (rawLimit as number) > 25) throw new TypeError('hivemind-memory: recall limit must be an integer from 1 to 25')
          const mode = text(input['mode'] ?? 'memory', 'mode')
          if (!['memory', 'auto', 'hybrid', 'evidence'].includes(mode)) throw new TypeError('hivemind-memory: recall mode is unsupported')
          const request: RecallRequest = { query: text(input['query'], 'query'), mode: mode as RecallRequest['mode'], limit: rawLimit as number }
          const scopeFilter = optionalScope(input['scope_filter'] ?? input['scope'], 'recall.scope_filter')
          if (scopeFilter !== undefined) request.scopeFilter = scopeFilter
          const tags = tagsFor(input)
          const sourcePlatforms = strings(input['source_platforms'], 'source_platforms')
          if (tags !== undefined) request.tags = tags
          if (sourcePlatforms !== undefined) request.sourcePlatforms = sourcePlatforms
          for (const [source, target] of [['valid_at', 'validAt'], ['transaction_at', 'transactionAt']] as const) {
            const value = input[source]
            if (value !== undefined) request[target] = text(value, source)
          }
          const project = input['project']
          if (project !== undefined && !['all', 'any', '*'].includes(text(project, 'project').toLowerCase())) request.project = text(project, 'project')
          if (input['sort'] !== undefined) request.sort = text(input['sort'], 'sort') as NonNullable<RecallRequest['sort']>
          if (input['include_superseded'] !== undefined) request.includeSuperseded = input['include_superseded'] === true
          return provider.recall(request, execution.signal, execution)
        },
      })
      ctx.effect(() => ctx.tools.register({
        ...metaTool,
        execute(args, execution) {
          return metaTool.execute(repairMissingReadOperation(args), execution)
        },
        isConcurrencySafe(args) {
          return metaTool.isConcurrencySafe?.(repairMissingReadOperation(args)) === true
        },
      }))
    },
  }
}
