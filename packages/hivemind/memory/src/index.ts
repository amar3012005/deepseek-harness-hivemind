/** Progressive model-facing HIVE-MIND memory capability. @module @deepseek-ai/dsh-hivemind-memory */
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
}

/** A bounded lookup against the authenticated organization's canonical entity index. */
export interface EntitySearchRequest {
  query: string
  limit: number
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
}

export interface SaveStatusRequest { idempotencyKey: string }

export interface MemoryProvider {
  context(agent: Agent, signal: AbortSignal): Promise<Record<string, JsonValue>>
  entities(request: EntitySearchRequest, signal: AbortSignal, execution: ToolExecution): Promise<Record<string, JsonValue>>
  recall(request: RecallRequest, signal: AbortSignal, execution: ToolExecution): Promise<Record<string, JsonValue>>
  save(agent: Agent, request: SaveRequest, signal: AbortSignal, execution: ToolExecution): Promise<Record<string, JsonValue>>
  saveStatus(request: SaveStatusRequest, signal: AbortSignal): Promise<Record<string, JsonValue>>
  profiles(signal: AbortSignal): Promise<Record<string, JsonValue>>
}

export interface MemoryPluginConfig { defaultLimit: number }

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

/** Parse the one canonical shape accepted by both the compatibility gateway and save tool. */
function saveRequest(input: Record<string, unknown>): SaveRequest {
  const sourceType = text(input['source_type'] ?? 'conversation', 'source_type')
  if (!['text', 'conversation', 'documentation', 'decision'].includes(sourceType)) throw new TypeError('hivemind-memory: source_type is unsupported')
  const relationship = input['relationship'] === undefined ? undefined : text(input['relationship'], 'relationship')
  if (relationship !== undefined && !['update', 'extend', 'derive'].includes(relationship)) throw new TypeError('hivemind-memory: relationship is unsupported')
  const relatedTo = input['related_to'] === undefined ? undefined : memoryId(input['related_to'], 'related_to')
  if (relationship !== undefined && relatedTo === undefined) throw new TypeError('hivemind-memory: related_to is required when relationship is set')
  if (relationship === undefined && relatedTo !== undefined) throw new TypeError('hivemind-memory: relationship is required when related_to is set')
  const tags = strings(input['tags'], 'tags')
  if (tags !== undefined && tags.length > 20) throw new TypeError('hivemind-memory: tags may contain at most 20 items')
  const request: SaveRequest = {
    title: boundedText(input['title'], 'save.title', 240),
    content: boundedText(input['content'], 'save.content', 2_000),
    sourceType: sourceType as SaveRequest['sourceType'],
    ...tags === undefined ? {} : { tags },
    ...input['project'] === undefined ? {} : { project: boundedText(input['project'], 'project', 255) },
    ...relationship === undefined ? {} : { relationship: relationship as NonNullable<SaveRequest['relationship']> },
    ...relatedTo === undefined ? {} : { relatedTo },
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
      ctx.tools.register(defineTool({
        name: 'hivemind_save_memory',
        description: 'Durably save one confirmed, stable HIVE-MIND memory. Use this direct tool for a standalone fact, preference, decision, correction, relationship, or completed outcome. A successful result must include the saved memory receipt. Never save secrets, credentials, ephemeral chat, guesses, or unverified claims.',
        parameters: {
          title: { type: 'string', required: true },
          content: { type: 'string', required: true },
          source_type: { type: 'string', enum: ['text', 'conversation', 'documentation', 'decision'] },
          tags: { type: 'array', items: { type: 'string' } },
          project: { type: 'string' },
          relationship: { type: 'string', enum: ['update', 'extend', 'derive'], description: 'Optional relation to an existing recalled memory. Omit for a new standalone memory. When set, related_to is required.' },
          related_to: { type: 'string', description: 'The exact recalled memory UUID that the relationship targets. Never use a person, project, topic, or label.' },
        },
        output,
        isConcurrencySafe: () => true,
        async execute(args, execution) {
          if (execution.agent === undefined) throw new TypeError('hivemind-memory: active agent required')
          return provider.save(execution.agent, saveRequest(args), execution.signal, execution)
        },
      }))
      ctx.tools.register(defineTool({
        name: 'hivemind_meta',
        description: 'HIVE-MIND gateway for authenticated context, canonical entity discovery, bounded memory recall, governed durable memory saves, or the exact HyperAgent directory. Use context for questions about the caller or company profile. Use entities first for a named person, topic, project, organization, document, or other subject when its canonical name could narrow recall. Use save only for a stable user preference, confirmed decision, correction, or completed outcome that will matter later; never save secrets, credentials, ephemeral chat, guesses, or unverified claims. Tenant scope is derived from the current HIVE-MIND credential.',
        parameters: {
          operation: { type: 'string', required: true, enum: ['context', 'entities', 'recall', 'save', 'save_status', 'profiles'], description: 'Select exactly one operation. recall requires the nested recall object; entities requires entities; save requires save; save_status requires save_status.' },
          entities: {
            type: 'object',
            additionalProperties: false,
            properties: {
              query: { type: 'string', required: true, description: 'Exact named subject to match against canonical names and aliases.' },
              limit: { type: 'integer', description: 'Maximum canonical matches to return.' },
            },
          },
          recall: {
            type: 'object',
            additionalProperties: false,
            properties: {
              query: { type: 'string', required: true },
              mode: { type: 'string', enum: ['memory', 'auto', 'hybrid', 'evidence'] },
              limit: { type: 'integer' },
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
            },
          },
          save: {
            type: 'object',
            description: 'For a new standalone memory, omit both relationship and related_to. A relationship is only for a confirmed link to an existing recalled memory and requires related_to.',
            additionalProperties: false,
            properties: {
              title: { type: 'string', required: true },
              content: { type: 'string', required: true },
              source_type: { type: 'string', enum: ['text', 'conversation', 'documentation', 'decision'] },
              tags: { type: 'array', items: { type: 'string' } },
              project: { type: 'string' },
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
          if (operation === 'save_status') {
            const input = object(args.save_status, 'save_status')
            return provider.saveStatus({ idempotencyKey: boundedText(input['idempotency_key'], 'save_status.idempotency_key', 180) }, execution.signal)
          }
          if (operation === 'entities') {
            const input = object(args.entities, 'entities')
            const rawLimit = input['limit'] ?? config.defaultLimit
            if (!Number.isInteger(rawLimit) || (rawLimit as number) < 1 || (rawLimit as number) > 25) throw new TypeError('hivemind-memory: entity limit must be an integer from 1 to 25')
            return provider.entities({ query: text(input['query'], 'entities.query'), limit: rawLimit as number }, execution.signal, execution)
          }
          if (operation === 'save') {
            if (execution.agent === undefined) throw new TypeError('hivemind-memory: active agent required')
            return provider.save(execution.agent, saveRequest(object(args.save, 'save')), execution.signal, execution)
          }
          if (operation !== 'recall') throw new TypeError('hivemind-memory: unsupported operation')
          const input = object(args.recall, 'recall')
          const rawLimit = input['limit'] ?? config.defaultLimit
          if (!Number.isInteger(rawLimit) || (rawLimit as number) < 1 || (rawLimit as number) > 25) throw new TypeError('hivemind-memory: recall limit must be an integer from 1 to 25')
          const mode = text(input['mode'] ?? 'memory', 'mode')
          if (!['memory', 'auto', 'hybrid', 'evidence'].includes(mode)) throw new TypeError('hivemind-memory: recall mode is unsupported')
          const request: RecallRequest = { query: text(input['query'], 'query'), mode: mode as RecallRequest['mode'], limit: rawLimit as number }
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
      }))
    },
  }
}
