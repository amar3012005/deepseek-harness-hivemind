/** Progressive model-facing HIVE-MIND memory capability. @module @deepseek-ai/dsh-hivemind-memory */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { registerProfileUpdate, type ProfileUpdateRequest } from './profile-update.ts'
export type { ProfileUpdateRequest } from './profile-update.ts'

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
  updateProfile?(agent: Agent, request: ProfileUpdateRequest, signal: AbortSignal): Promise<Record<string, JsonValue>>
  context(agent: Agent, signal: AbortSignal): Promise<Record<string, JsonValue>>
  entities(request: EntitySearchRequest, signal: AbortSignal, execution: ToolExecution): Promise<Record<string, JsonValue>>
  recall(request: RecallRequest, signal: AbortSignal, execution: ToolExecution): Promise<Record<string, JsonValue>>
  /** Apply a durable session-derived default before the one native approval. */
  prepareSave?(agent: Agent, request: SaveRequest): SaveRequest
  save(agent: Agent, request: SaveRequest, signal: AbortSignal, execution: ToolExecution): Promise<Record<string, JsonValue>>
  saveStatus?(request: SaveStatusRequest, signal: AbortSignal): Promise<Record<string, JsonValue>>
  profiles(signal: AbortSignal): Promise<Record<string, JsonValue>>
}

export interface MemoryPluginConfig { defaultLimit: number }

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'hivemind/memory-save': {
      operation_id: string
      status: 'prepared' | 'approved' | 'executing' | 'completed' | 'cancelled'
      destination?: 'personal' | 'organization' | 'project'
      idempotency_key?: string
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
  const choices: Array<keyof typeof SAVE_DESTINATIONS> = ['personal', 'organization']
  if (request.project !== undefined) choices.push('project')
  const operationId = saveOperationId(execution, request)
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
    if (userQuestions === undefined) throw new Error('hivemind-memory: save approval channel is unavailable')
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
    if (execution.signal.aborted || code === 'ASK_ABORTED' || code === 'ASK_CANCELLED') {
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
  // The host must be able to observe a session before this preset is mounted.
  // Keep the event durable for resumed approvals, but allow older/newer hosts
  // without this optional HIVE plugin to skip the telemetry safely.
  agent.session.append('hivemind/memory-save', data, { ignorable: true })
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

/** Normalize the small historical flat read shape emitted by older models.
 * The canonical public schema stays nested, but a formatting slip must not
 * spend another model turn or turn a valid read into a user-visible failure. */
function readInput(args: Record<string, unknown>, key: 'recall' | 'entities'): Record<string, unknown> {
  const nested = args[key]
  if (nested !== undefined) return object(nested, key)
  const { operation: _operation, ...flat } = args
  if (flat['query'] === undefined) return object(nested, key)
  return flat
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
  const tags = strings(input['tags'], 'tags')
  if (tags !== undefined && tags.length > 50) throw new TypeError('hivemind-memory: tags may contain at most 50 items')
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
  if (containsCredentialMaterial(`${request.title}\n${request.content}`)) throw new TypeError('hivemind-memory: save refuses credential material')
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
    inject: ['tools'],
    apply(ctx: Context): void {
      const updateProfile = provider.updateProfile?.bind(provider)
      if (updateProfile) ctx.effect(() => registerProfileUpdate(ctx, updateProfile))
      ctx.effect(() => ctx.tools.register(defineTool({
        name: 'hivemind_save_memory',
        description: 'Durably save one confirmed, stable HIVE-MIND memory. Use this direct tool for a standalone fact, preference, decision, correction, relationship, or completed outcome. A successful result must include the saved memory receipt. Never save secrets, credentials, ephemeral chat, guesses, or unverified claims.',
        parameters: {
          title: { type: 'string', required: true },
          content: { type: 'string', required: true },
          source_type: { type: 'string', enum: ['text', 'conversation', 'documentation', 'decision'] },
          tags: { type: 'array', items: { type: 'string' }, description: 'Before calling, scan the complete title and content and tag every explicitly named reusable proper noun: entity:<lowercase-hyphenated-name> for people, organizations, stock symbols, products, projects, initiatives, systems, apps, places, documents, and named events; topic:<normalized-topic> for explicitly stated reusable strategic themes; time:<normalized-time> for material named periods. Include secondary named details, not only the main subject. Never invent entities, convert raw metrics into entities, or tag generic words.' },
          project: { type: 'string' },
          scope: { type: 'string', enum: ['personal', 'organization', 'project'], description: 'Concrete write destination. Full scope is read-only and cannot be used for a save. Project scope requires project.' },
          relationship: { type: 'string', enum: ['update', 'extend', 'derive'], description: 'Optional relation to an existing recalled memory. Omit for a new standalone memory. When set, related_to is required.' },
          related_to: { type: 'string', description: 'The exact recalled memory UUID that the relationship targets. Never use a person, project, topic, or label.' },
        },
        output,
        isConcurrencySafe: () => true,
        async execute(args, execution) {
          if (execution.agent === undefined) throw new TypeError('hivemind-memory: active agent required')
          const prepared = provider.prepareSave?.(execution.agent, saveRequest(args)) ?? saveRequest(args)
          const approved = await approveSaveDestination(ctx, execution, prepared)
          return approved === undefined
            ? { operation: 'save', status: 'cancelled' }
            : provider.save(execution.agent, approved, execution.signal, execution)
        },
      })))
      ctx.effect(() => ctx.tools.register(defineTool({
        name: 'hivemind_meta',
        description: 'HIVE-MIND gateway for authenticated context, canonical entity discovery, bounded memory recall, governed durable memory saves, or the exact HyperAgent directory. Use context for questions about the caller or company profile. Use entities first for a named person, topic, project, organization, document, or other subject when its canonical name could narrow recall. Use save only for a stable user preference, confirmed decision, correction, or completed outcome that will matter later; never save secrets, credentials, ephemeral chat, guesses, or unverified claims. Tenant scope is derived from the current HIVE-MIND credential.',
        parameters: {
          operation: { type: 'string', required: true, enum: ['context', 'entities', 'recall', 'save', 'save_status', 'profiles'] },
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
              query: { type: 'string', required: true },
              mode: { type: 'string', enum: ['memory', 'auto', 'hybrid', 'evidence'] },
              limit: { type: 'integer' },
              tags: { type: 'array', items: { type: 'string' }, description: 'Filters only. Use exact saved tags when the request supplies a tag constraint.' },
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
              tags: { type: 'array', items: { type: 'string' } },
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
        isConcurrencySafe: () => true,
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
            const approved = await approveSaveDestination(ctx, execution, prepared)
            return approved === undefined
              ? { operation: 'save', status: 'cancelled' }
              : provider.save(execution.agent, approved, execution.signal, execution)
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
      })))
    },
  }
}
