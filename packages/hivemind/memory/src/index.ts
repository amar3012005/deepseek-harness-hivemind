/** Progressive model-facing HIVE-MIND memory capability. @module @deepseek-ai/dsh-hivemind-memory */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
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
  interface Events {
    'schedule/prepare-create'(agent: Agent, id: string, prompt: string, destination: string | undefined, project: string | undefined, signal: AbortSignal, next: () => Promise<boolean>): Promise<boolean>
  }
  interface Context {
    hivemindMemory: MemoryProvider
    hivemindFlashbacksDestination: { resolve(agent: Agent, signal: AbortSignal): Promise<string | undefined> }
    hivemindScheduledMemoryPolicy: {
      prepare(
        agent: Agent, id: string, prompt: string, destination: string | undefined,
        project: string | undefined, signal: AbortSignal,
      ): Promise<void>
    }
  }
}

export interface MemoryPluginConfig { defaultLimit: number }

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Records the governed HIVE memory-save lifecycle, destination, and idempotency key. */
    'hivemind/memory-save': {
      operation_id: string
      status: 'prepared' | 'approved' | 'executing' | 'completed' | 'cancelled'
      destination?: 'personal' | 'organization' | 'project'
      idempotency_key?: string
    }
    'hivemind/scheduled-memory-pending': {
      pending_id: string
      occurrence_key: string
      requests: SaveRequest[]
      state: 'awaiting_approval' | 'completed'
      results?: Record<string, JsonValue>[]
    }
    'hivemind/schedule-memory-permission': {
      schedule_id: string
      prompt_hash: string
      decision: 'approved' | 'denied'
      destination: 'personal' | 'organization' | 'project'
      project?: string
    }
  }
}

const SAVE_DESTINATIONS = {
  personal: 'Personal',
  organization: 'Organization',
  project: 'Project',
} as const

/** Pause one prepared save for a native destination approval, then return the
 * final request to the same invocation. A declined/cancelled card performs no
 * provider write and never asks the model to reconstruct the save. */
async function approveSaveDestination(
  ctx: Context,
  execution: ToolExecution,
  request: SaveRequest,
): Promise<SaveRequest | undefined> {
  if (execution.agent === undefined) throw new TypeError('hivemind-memory: active agent required')
  // Private operating history has a different schema and storage service.
  // Never treat its reserved name as a company-memory destination.
  if (/^hyper[-_ ]?agents$/i.test(request.project ?? '')) return undefined
  const scheduled = scheduledMemoryContext(execution.agent)
  const dreaming = scheduled !== undefined && scheduled.reminders.length > 0
    && scheduled.reminders.every(reminder => /\bdream(?:er|ing)?\b/i.test(reminder.prompt) && /\bflashbacks?\b/i.test(reminder.prompt))
  if (dreaming || request.project !== undefined) {
    const project = await execution.agent.ctx.get('hivemindFlashbacksDestination')?.resolve(execution.agent, execution.signal)
    // Resolve the reserved project through tenant-authenticated storage, never
    // accept a model-supplied UUID as an approval exemption.
    if (dreaming || /^(flashbacks)$/i.test(request.project ?? '') || request.project === project) {
      if (project === undefined) return undefined
      return { ...request, scope: 'project', project, derived: true,
        tags: [...new Set([...(request.tags ?? []), 'flashback', 'derived'])],
        metadata: { ...request.metadata, derived: true,
          source_memory_ids: request.relatedTo === undefined ? [] : [request.relatedTo],
          ...(scheduled === undefined ? {} : { scheduled_occurrence: scheduled.key }),
        },
      }
    }
  }
  if (scheduled !== undefined) {
    // A matching creation grant permits unattended writes. A non-grant asks
    // again through the native human channel; it never authorizes by default.
    const events = execution.agent.session.snapshotEvents()
    const permissions = scheduled.reminders.map(reminder => events.findLast(event =>
      event.type === 'hivemind/schedule-memory-permission'
      && event.data.schedule_id === reminder.id && event.data.prompt_hash === promptHash(reminder.prompt)))
    const first = permissions[0]
    if (first?.type === 'hivemind/schedule-memory-permission' && first.data.decision === 'approved'
      && permissions.every(event => event?.type === 'hivemind/schedule-memory-permission'
        && event.data.decision === 'approved' && event.data.destination === first.data.destination
        && event.data.project === first.data.project)
      && (request.scope === undefined || request.scope === first.data.destination)
      && (request.project === undefined || request.project === first.data.project)) {
      return { ...request, scope: first.data.destination, ...(first.data.project === undefined ? {} : { project: first.data.project }) }
    }
  }
  const choices: Array<keyof typeof SAVE_DESTINATIONS> = ['personal', 'organization']
  if (request.project !== undefined) choices.push('project')
  const operationId = saveOperationId(execution, request, request.idempotencyKey ?? scheduled?.key)
  const questionId = `hivemind-memory-save-destination:${operationId}`
  const prior = latestSaveEvent(execution.agent, operationId)
  if (prior?.status === 'completed' && prior.destination !== undefined) {
    return { ...request, scope: prior.destination }
  }
  if (prior?.status === 'approved' && prior.destination !== undefined) {
    return { ...request, scope: prior.destination }
  }
  appendSaveEvent(execution.agent, { operation_id: operationId, status: 'prepared' })
  try {
    const userQuestions = ctx.get('userQuestions') as {
      ask(input: {
        agent: Agent
        signal: AbortSignal
        questions: readonly {
          id: string
          question: string
          detail: string
          options: readonly { label: string; description: string }[]
          intent?: { kind: 'memory-save-destination' }
        }[]
      }): Promise<{ answers: readonly { id: string; selected: readonly string[] }[] }>
    } | undefined
    if (userQuestions === undefined) {
      if (scheduled !== undefined || request.idempotencyKey?.startsWith('hive-pending:')) return undefined
      throw new Error('hivemind-memory: save approval channel is unavailable')
    }
    const answer = await userQuestions.ask({
      agent: execution.agent,
      signal: execution.signal,
      questions: [{
        id: questionId,
        question: `Save “${request.title}” to HIVE-MIND?`,
        detail: 'Choose one destination, then approve this prepared memory save.',
        intent: { kind: 'memory-save-destination' },
        options: choices.map(scope => ({
          label: SAVE_DESTINATIONS[scope],
          description: scope === 'project'
            ? `Save to the selected project: ${request.project}`
            : `Save this memory to your ${scope} scope.`,
        })),
      }],
    })
    const selected = answer.answers.find(item => item.id === questionId)?.selected ?? []
    const scope = choices.find(candidate => selected.includes(SAVE_DESTINATIONS[candidate]))
    if (scope === undefined) {
      appendSaveEvent(execution.agent, { operation_id: operationId, status: 'cancelled' })
      return undefined
    }
    appendSaveEvent(execution.agent, { operation_id: operationId, status: 'approved', destination: scope })
    return { ...request, scope }
  } catch (error: unknown) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined
    if (execution.signal.aborted || code === 'ASK_ABORTED' || code === 'ASK_CANCELLED'
      || scheduled !== undefined || request.idempotencyKey?.startsWith('hive-pending:')) {
      appendSaveEvent(execution.agent, { operation_id: operationId, status: 'cancelled' })
      return undefined
    }
    throw error
  }
}

type SaveEventStatus = 'prepared' | 'approved' | 'executing' | 'completed' | 'cancelled'

interface SaveEventData {
  operation_id: string
  status: SaveEventStatus
  destination?: 'personal' | 'organization' | 'project'
  idempotency_key?: string
}

export function saveOperationId(execution: ToolExecution, request: SaveRequest, occurrence?: string): string {
  const sessionId = execution.agent?.session?.header.id || 'session-unavailable'
  const canonical = JSON.stringify({
    session_id: sessionId,
    ...(occurrence === undefined ? {} : { occurrence }),
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

function promptHash(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex')
}

/** Read only native scheduled messages belonging to the current turn. Text
 * supplied by a human or model cannot grant scheduled write authority. */
export function scheduledMemoryContext(agent: Agent): { key: string; reminders: { id: string; prompt: string }[] } | undefined {
  const events = agent.session.snapshotEvents()
  const start = events.findLast(event => event.type === 'turn/start')
  if (start === undefined) return undefined
  const messages = events.filter(event => event.seq > start.seq && event.type === 'user/message')
  if (!messages.some(event => event.type === 'user/message' && String(event.data.source.kind) === 'schedule')) return undefined
  const reminders: { id: string; prompt: string }[] = []
  const keys: string[] = []
  for (const event of messages) {
    if (event.type !== 'user/message' || String(event.data.source.kind) !== 'schedule') continue
    const text = event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    const source = event.data.source as unknown as { deliveryKey?: string; occurrenceAt?: number }
    keys.push(source.deliveryKey ?? `${event.seq}:${source.occurrenceAt ?? ''}`)
    try {
      const batch = text.split('\n').find(line => line.startsWith('reminders_json: '))
      if (batch !== undefined) {
        const rows: unknown = JSON.parse(batch.slice('reminders_json: '.length))
        if (Array.isArray(rows)) for (const row of rows) {
          if (typeof row === 'object' && row !== null && typeof row.schedule_id === 'string' && typeof row.reminder_prompt === 'string') reminders.push({ id: row.schedule_id, prompt: row.reminder_prompt })
        }
      } else {
        const id = text.split('\n').find(line => line.startsWith('schedule_id_json: '))
        const prompt = text.split('\n').find(line => line.startsWith('reminder_prompt_json: '))
        if (id !== undefined && prompt !== undefined) {
          const parsedId: unknown = JSON.parse(id.slice('schedule_id_json: '.length))
          const parsedPrompt: unknown = JSON.parse(prompt.slice('reminder_prompt_json: '.length))
          if (typeof parsedId === 'string' && typeof parsedPrompt === 'string') reminders.push({ id: parsedId, prompt: parsedPrompt })
        }
      }
    } catch { /* Malformed native framing has no write grant. */ }
  }
  return { key: keys.join('|'), reminders }
}

function appendSaveEvent(agent: Agent, data: SaveEventData): void {
  agent.session.append('hivemind/memory-save', data)
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
  if (nested !== undefined) return object(nested, key)
  const { operation: _operation, ...flat } = args
  if (flat['query'] === undefined) return object(nested, key)
  return flat
}

/** Repair only an unambiguous single read envelope before native validation.
 * Writes and mixed/unknown shapes still fail the required-operation schema. */
function repairMissingReadOperation(args: unknown): unknown {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return args
  const input = args as Record<string, unknown>
  const keys = Object.keys(input)
  const operation = input['operation'] ?? (keys.length === 1 ? keys[0] : undefined)
  if (operation !== 'entities' && operation !== 'recall') return args
  if (!Object.hasOwn(input, 'operation') && keys.length !== 1) return args
  let nested = input[operation]
  if (nested === undefined && typeof input['query'] === 'string') nested = readInput(input, operation)
  if (typeof nested !== 'object' || nested === null || Array.isArray(nested)) return args
  const envelope = nested as Record<string, unknown>
  if (Object.keys(envelope).length === 1 && Object.hasOwn(envelope, operation)) nested = envelope[operation]
  if (typeof nested !== 'object' || nested === null || Array.isArray(nested)) return args
  const read = { ...nested as Record<string, unknown> }
  // Bounded read recovery never changes a write or drops an unknown field.
  if (Number.isInteger(read['limit']) && Number(read['limit']) > 25) read['limit'] = 25
  if (input[operation] === undefined) return { ...input, operation, ...read }
  return { ...input, operation, [operation]: read }
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

/** Persist prepared scheduled writes before opening a human question. The native
 * question waits while connected; an unavailable/disconnected answerer returns
 * awaiting_approval, preserving the exact payload for a later human resume. */
async function executeSaveRequests(
  ctx: Context, provider: MemoryProvider, execution: ToolExecution, requests: SaveRequest[],
  batch = false, resume?: { pending_id: string; occurrence_key: string },
): Promise<Record<string, JsonValue>> {
  const agent = execution.agent
  if (agent === undefined) throw new TypeError('hivemind-memory: active agent required')
  const occurrence = resume?.occurrence_key ?? scheduledMemoryContext(agent)?.key
  const pendingId = occurrence === undefined ? undefined : resume?.pending_id ?? `pending:${createHash('sha256').update(JSON.stringify({ session: agent.session.header.id, occurrence, requests })).digest('hex')}`
  const prior = pendingId === undefined ? undefined : agent.session.snapshotEvents().findLast(event => event.type === 'hivemind/scheduled-memory-pending' && event.data.pending_id === pendingId)
  if (prior?.type === 'hivemind/scheduled-memory-pending' && prior.data.state === 'completed') {
    const results = prior.data.results ?? []
    return batch ? { operation: 'batch_save', status: 'completed', count: results.length, results } : results[0] ?? { status: 'completed' }
  }
  const durable = requests.map((request, index) => pendingId === undefined ? request : { ...request, idempotencyKey: `hive-pending:${createHash('sha256').update(`${pendingId}:${index}`).digest('hex')}` })
  if (pendingId !== undefined && occurrence !== undefined && prior === undefined) {
    agent.session.append('hivemind/scheduled-memory-pending', { pending_id: pendingId, occurrence_key: occurrence, requests: durable, state: 'awaiting_approval' })
    if (!await ctx.get('sessions')?.flush(agent.session)) return { operation: batch ? 'batch_save' : 'save', status: 'awaiting_approval', pending_id: pendingId, reason: 'Prepared write could not be acknowledged. No memory was written; retry only after Session storage is healthy.' }
  }
  const first = durable[0]
  if (first === undefined) throw new TypeError('No memory requests')
  const approval = batch ? { ...first, title: `${durable.length} memories: ${durable.map(request => request.title).join('; ')}`, content: durable.map(request => request.content).join('\n\n') } : first
  const approved = await approveSaveDestination(ctx, execution, approval)
  if (approved === undefined) return { operation: batch ? 'batch_save' : 'save', status: pendingId === undefined ? 'cancelled' : 'awaiting_approval', ...(pendingId === undefined ? {} : { pending_id: pendingId }), reason: pendingId === undefined ? 'Memory save was declined.' : 'Waiting for human approval. No memory was written. Do not repeat this call; use hivemind_pending_memory list/resume when the user returns.' }
  const results: Record<string, JsonValue>[] = []
  for (const request of durable) results.push(await provider.save(agent, {
    ...request, ...(approved.scope === undefined ? {} : { scope: approved.scope }),
    ...(approved.project === undefined ? {} : { project: approved.project }),
    ...(approved.derived === undefined ? {} : { derived: approved.derived }),
    tags: [...new Set([...(request.tags ?? []), ...(approved.tags ?? [])])],
    metadata: { ...request.metadata, ...approved.metadata },
  }, execution.signal, execution))
  const completed = results.every(result => result['status'] === 'saved' || result['status'] === 'completed')
  if (completed && pendingId !== undefined && occurrence !== undefined) {
    agent.session.append('hivemind/scheduled-memory-pending', { pending_id: pendingId, occurrence_key: occurrence, requests: durable, state: 'completed', results })
    await ctx.get('sessions')?.flush(agent.session)
  }
  return batch ? { operation: 'batch_save', status: completed ? 'completed' : 'indeterminate', count: results.length, destination: approved.scope ?? 'organization', results } : results[0] ?? { status: 'indeterminate' }
}

/** Register the authenticated HIVE-MIND context, recall, governed save, and employee-directory router. */
export function memoryPlugin(config: MemoryPluginConfig, provider: MemoryProvider) {
  return {
    name: 'hivemind-memory',
    inject: ['tools'],
    apply(ctx: Context): void {
      ctx.provide('hivemindMemory', provider)
      ctx.provide('hivemindScheduledMemoryPolicy', {
        async prepare(agent, id, prompt, requestedDestination, project, signal) {
          const companyWrite = /hivemind|hive-mind|company (?:brain|memor)|organization/i.test(prompt)
          const privateOnly = /^hyper[-_ ]?agents$/i.test(project ?? '')
            || (requestedDestination === undefined && /\bhyperagents_memory\b/i.test(prompt)
              && !companyWrite)
          if (privateOnly) return
          const wantsWrite = requestedDestination !== undefined
            || /\b(save|write|store|persist)\b[\s\S]{0,160}\b(memor(?:y|ies)|hivemind|hive-mind|company brain)\b/i.test(prompt)
          if (!wantsWrite) return
          const flashbacks = await agent.ctx.get('hivemindFlashbacksDestination')?.resolve(agent, signal)
          if (flashbacks !== undefined && ((/\bdream(?:er|ing)?\b/i.test(prompt) && /\bflashbacks?\b/i.test(prompt)) || /^flashbacks$/i.test(project ?? '') || project === flashbacks)) return
          const destination = requestedDestination ?? 'organization'
          if (destination !== 'personal' && destination !== 'organization' && destination !== 'project') throw new TypeError('Invalid schedule memory destination')
          if (destination === 'project' && !project) throw new TypeError('Schedule project memory destination requires a project')
          const questionId = `hivemind-schedule-memory:${id}`
          const questions = ctx.get('userQuestions') as { ask(input: { agent: Agent; signal: AbortSignal; questions: { id: string; question: string; detail: string; options: { label: string; description: string }[] }[] }): Promise<{ answers: { id: string; selected: string[] }[] }> } | undefined
          if (questions === undefined) throw new Error('Schedule memory permission channel is unavailable')
          const result = await questions.ask({ agent, signal, questions: [{ id: questionId,
            question: `Allow this scheduled task to save memories to ${destination === 'project' ? project : destination}?`,
            detail: 'Approval applies only to this exact task prompt and destination. If declined, the run asks again. Without a connected human, the prepared write remains awaiting approval for later resume.',
            options: [{ label: 'Allow', description: 'Authorize future occurrences of this task to save here.' }, { label: 'Do not allow', description: 'Run the task without company-memory writes.' }],
          }] })
          const selected = result.answers.find(answer => answer.id === questionId)?.selected ?? []
          const approved = selected.length === 1 && selected[0] === 'Allow'
          agent.session.append('hivemind/schedule-memory-permission', {
            schedule_id: id, prompt_hash: promptHash(prompt), decision: approved ? 'approved' : 'denied',
            destination, ...(project === undefined ? {} : { project }),
          })
          if (!await agent.ctx.get('sessions')?.flush(agent.session)) throw new Error('Schedule memory permission was not durably acknowledged')
        },
      })
      // The policy lives in the agent's capability group, outside agent.ctx's service lens.
      // Scoped Cordis events reach the owning group without exposing another tenant's policy.
      ctx.on('schedule/prepare-create', async (agent, id, prompt, destination, project, signal) => {
        const policy = ctx.get('hivemindScheduledMemoryPolicy')
        if (policy === undefined) throw new Error('Schedule memory permission policy is unavailable')
        await policy.prepare(agent, id, prompt, destination, project, signal)
        return true
      })
      ctx.effect(() => ctx.tools.register(defineTool({
        name: 'hivemind_pending_memory',
        description: 'List or resume durable scheduled company-memory writes awaiting human approval in this owning session. Resume asks the user again using the saved exact payload; never invent or reconstruct a memory. Flashbacks and hyperagents_memory are exempt and do not wait here.',
        parameters: { action: { type: 'string', required: true, enum: ['list', 'resume'] }, pending_id: { type: 'string', description: 'Exact pending ID returned by list, required for resume.' } },
        output, isConcurrencySafe: () => false,
        async execute(args, execution) {
          const agent = execution.agent
          if (agent === undefined) throw new TypeError('Active agent required')
          const pending = new Map<string, { pending_id: string; occurrence_key: string; requests: SaveRequest[]; state: 'awaiting_approval' | 'completed' }>()
          for (const event of agent.session.snapshotEvents()) if (event.type === 'hivemind/scheduled-memory-pending') pending.set(event.data.pending_id, event.data)
          if (args.action === 'list') return { operation: 'pending_memory', items: [...pending.values()].filter(item => item.state === 'awaiting_approval').map(item => ({ pending_id: item.pending_id, status: item.state, titles: item.requests.map(request => request.title), count: item.requests.length })) }
          const item = args.pending_id === undefined ? undefined : pending.get(args.pending_id)
          if (item === undefined) return { operation: 'pending_memory', status: 'not_found' }
          return executeSaveRequests(ctx, provider, execution, item.requests, item.requests.length > 1, item)
        },
      })))
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
          if (execution.agent === undefined) throw new TypeError('hivemind-memory: active agent required')
          const prepared = provider.prepareSave?.(execution.agent, saveRequest(args)) ?? saveRequest(args)
          return executeSaveRequests(ctx, provider, execution, [prepared])
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
          const prepared = args.items.map((item, index) => {
            const raw = object(item, `items[${index}]`)
            const request = saveRequest({ ...raw, ...(requestedScope === undefined ? {} : { scope: requestedScope }) })
            return provider.prepareSave?.(agent, request) ?? request
          })
          const projects = [...new Set(prepared.flatMap(item => item.project === undefined ? [] : [item.project]))]
          if (requestedScope === 'project' && projects.length !== 1) {
            throw new TypeError('hivemind-memory: project batch requires one shared project')
          }
          return executeSaveRequests(ctx, provider, execution, prepared, true)
        },
      })))
      const metaTool = defineTool({
        name: 'hivemind_meta',
        description: 'HIVE-MIND gateway. REQUIRED top-level operation: "context", "entities", "recall", "save", "save_status", or "profiles". Put entity-search arguments under entities and memory-search arguments under recall. An unambiguous omitted read operation is repaired once before dispatch; mixed forms and writes are rejected. For questions about a named person, organization, topic, project, or document, call {operation:"recall",recall:{query:"exact user question"}} directly; append recent conversation context only to resolve an ambiguous reference, never an inferred profile identity. Entity search is optional, not a prerequisite. For an explicit entity-search request, call {operation:"entities",entities:{query:"name"}} and report actual matches only. Empty entity matches are not evidence of absent memories. Do not merge same-name people or personal and company facts without an evidence-backed identity link. Use context for the caller or company profile. Proactively save a confirmed stable preference, decision, project direction, role assignment, correction, or completed outcome, but never a proposal, question, transient remark, guess, secret, or credential. Add every concrete named detail to save.entities. Read limits are integers from 1 to 25. Never nest entities inside entities or recall inside recall. An unknown write outcome must be reconciled using save_status and its idempotency_key; empty recall is not proof that the save failed. When creating a schedule that saves company memories, declare memory_destination and memory_project on schedule_create; creation captures permission. Cancelled scheduled writes must stop without retrying or requesting approval. Dream outputs use the dedicated Flashbacks project. Private agent operating memories use hyperagents_memory, not company save tools. Tenant scope comes from the current credential.',
        parameters: {
          operation: { type: 'string', required: true, enum: ['context', 'entities', 'recall', 'save', 'save_status', 'profiles'], description: 'REQUIRED at the top level on every call. Do not place it inside entities or recall. If validation reports a missing operation, correct the next call once; do not repeat the malformed call.' },
          entities: {
            type: 'object',
            additionalProperties: false,
            properties: {
              query: { type: 'string', required: true, description: 'Exact named subject to match against canonical names and aliases.' },
              limit: { type: 'integer', description: 'Maximum canonical matches, an integer from 1 to 25. Larger read limits are capped at 25.' },
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
              limit: { type: 'integer', description: 'Maximum results, an integer from 1 to 25. Larger read limits are capped at 25.' },
              tags: { type: 'array', items: { type: 'string' } },
              source_platforms: { type: 'array', items: { type: 'string' } },
              media_kind: { type: 'string', enum: ['image', 'document'] },
              filename: { type: 'string' },
              entities: { type: 'array', items: { type: 'string' } },
              project: { type: 'string' },
              valid_at: { type: 'string' },
              transaction_at: { type: 'string' },
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
            // Accept the historical flat form once and normalize it into the canonical
            // nested contract. This prevents a model formatting slip from causing a
            // second inference/search loop while retaining strict field validation.
            const rawSave = args.save === undefined
              ? args
              : object(args.save, 'save')
            const prepared = provider.prepareSave?.(execution.agent, saveRequest(rawSave)) ?? saveRequest(rawSave)
            return executeSaveRequests(ctx, provider, execution, [prepared])
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
