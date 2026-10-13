/** Authenticated, single-attempt Open Dot text inference over the native DSH LLM route. */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { HivemindPrincipal } from '@deepseek-ai/dsh-hivemind-execution-scope'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { createMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, JsonSchemaResponseFormat, Message, StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm'

export const OPEN_DOT_MODEL_STREAM_PATH = '/internal/hivemind/open-dot/model/stream'
export const OPEN_DOT_PRIMARY_PROVIDER = 'hivemind-global'
export const OPEN_DOT_PRIMARY_MODEL_ID = 'default'
export const OPEN_DOT_MODEL_PROVIDER = 'openai-codex'
export const OPEN_DOT_MODEL_ID = 'gpt-6-luna'
const ALLOWED_ROUTES = new Set([
  `${OPEN_DOT_PRIMARY_PROVIDER}/${OPEN_DOT_PRIMARY_MODEL_ID}`,
  `${OPEN_DOT_MODEL_PROVIDER}/${OPEN_DOT_MODEL_ID}`,
])

const MAX_REQUEST_BYTES = 512 * 1024
const MAX_RESPONSE_BYTES = 6 * 1024 * 1024
const MAX_MESSAGES = 64
const MAX_TOOLS = 64
const MAX_IMAGES = 8
const MAX_IMAGE_BYTES = 300 * 1024
const MAX_IMAGE_TOTAL_BYTES = 350 * 1024
const MAX_TOKENS = 8192
const MAX_STREAM_MS = 120_000
const FALLBACK_PROOF_TTL_SECONDS = 30
const FALLBACK_FAILURE_CODES = new Set(['RATE_LIMIT', 'QUOTA', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'UNSUPPORTED_CONTENT'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const DOT_ID = /^dot_[A-Za-z0-9_-]{1,176}$/u
const ASCII_ID = /^[\x21-\x7e]{1,180}$/u
const NAME = /^[A-Za-z0-9_-]{1,128}$/u
const REASONING = new Set(['off', 'low', 'medium', 'high'])

type JsonRecord = Record<string, unknown>
type ParsedImage = { readonly bytes: Uint8Array; readonly mediaType: ImageMediaType }
type PlannedBlock = { readonly type: 'text'; readonly text: string } | { readonly type: 'image-input'; readonly image: ParsedImage }
type ModelBrokerBody = {
  organization_id: string
  user_id: string
  employee_id: string
  dot_id: string
  session_id: string
  request_id: string
  provider: string
  model: string
  messages: unknown[]
  tools?: unknown[]
  max_tokens: number
  temperature?: number
  stop?: string[]
  reasoning_effort?: string
  parallel_tool_calls: false
  stream_options: { include_usage: true }
  stream: true
  response_format?: JsonSchemaResponseFormat
  fallback_from?: FallbackFrom
}
export interface FallbackFrom {
  readonly provider: typeof OPEN_DOT_PRIMARY_PROVIDER
  readonly model: typeof OPEN_DOT_PRIMARY_MODEL_ID
  readonly request_id: string
  readonly failure_code: string
  readonly output_started: false
}
export interface OpenDotFallbackProof {
  readonly principal: HivemindPrincipal
  readonly employeeId: string
  readonly dotId: string
  readonly sessionId: string
  readonly requestId: string
  readonly failureCode: string
}
export interface OpenDotModelRequest {
  readonly principal: HivemindPrincipal
  readonly employeeId: string
  readonly dotId: string
  /** Open Dot conversation identity, deliberately not a DSH SessionId. */
  readonly sessionId: string
  readonly requestId: string
  readonly body: GenerateOptions
}
export interface OpenDotModelBrokerOptions {
  readonly secret: string
  /** Read the native global model at each request, never a session-pinned copy. */
  readonly primarySelection: () => { provider: string; model: string; reasoningEffort?: string }
  readonly now?: () => number
  /** Atomic Redis SET NX with an expiry covering the signed grant lifetime. */
  readonly consumeJti: (jti: string, ttlSeconds: number) => Promise<boolean>
  readonly recordFallback: (proof: OpenDotFallbackProof, ttlSeconds: number) => Promise<void>
  readonly consumeFallback: (proof: OpenDotFallbackProof) => Promise<boolean>
  readonly stream: (principal: HivemindPrincipal, options: GenerateOptions) => AsyncIterable<StreamChunk>
  readonly saveImages: (images: readonly { data: Uint8Array; mediaType: ImageMediaType }[]) => Promise<readonly import('@deepseek-ai/dsh-attachment').ImageAttachmentRef[]>
  readonly validateImages: (images: readonly { data: Uint8Array; mediaType: ImageMediaType }[]) => Promise<void>
}

class BrokerRejection extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}

function reject(status = 400, code = 'invalid_open_dot_model_request'): never { throw new BrokerRejection(status, code) }

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function exactKeys(value: unknown, allowed: readonly string[], required: readonly string[] = []): asserts value is JsonRecord {
  if (!isRecord(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !(key in value))) reject()
}

function decode(part: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/u.test(part)) reject(401, 'invalid_open_dot_model_authorization')
  const bytes = Buffer.from(part, 'base64url')
  if (bytes.toString('base64url') !== part) reject(401, 'invalid_open_dot_model_authorization')
  try { return JSON.parse(bytes.toString('utf8')) as unknown } catch { return reject(401, 'invalid_open_dot_model_authorization') }
}

function equalBytes(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right)
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function validText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}

function parseFallbackFrom(value: unknown): FallbackFrom {
  exactKeys(value, ['provider', 'model', 'request_id', 'failure_code', 'output_started'], ['provider', 'model', 'request_id', 'failure_code', 'output_started'])
  if (value.provider !== OPEN_DOT_PRIMARY_PROVIDER || value.model !== OPEN_DOT_PRIMARY_MODEL_ID
    || !ASCII_ID.test(String(value.request_id)) || typeof value.failure_code !== 'string'
    || !FALLBACK_FAILURE_CODES.has(value.failure_code) || value.output_started !== false) reject(403, 'invalid_open_dot_model_fallback')
  return value as unknown as FallbackFrom
}

function sameFallback(left: FallbackFrom, right: FallbackFrom): boolean {
  return left.provider === right.provider && left.model === right.model && left.request_id === right.request_id
    && left.failure_code === right.failure_code && left.output_started === right.output_started
}

function verifyToken(raw: string, authorization: string, secret: string, nowMs: number): {
  jti: string
  exp: number
  body: ModelBrokerBody
  fallbackFrom?: FallbackFrom
} {
  if (Buffer.byteLength(secret) < 32) reject(503, 'open_dot_model_broker_unavailable')
  const token = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u.exec(authorization)?.[1]
  if (!token || token.length > 8192) reject(401, 'invalid_open_dot_model_authorization')
  const [encodedHeader, encodedPayload, encodedSignature] = token.split('.') as [string, string, string]
  const expected = createHmac('sha256', secret).update(`${encodedHeader}.${encodedPayload}`).digest()
  const signature = Buffer.from(encodedSignature, 'base64url')
  if (signature.toString('base64url') !== encodedSignature || !equalBytes(expected, signature)) reject(401, 'invalid_open_dot_model_authorization')
  const header = decode(encodedHeader)
  const claims = decode(encodedPayload)
  exactKeys(header, ['alg', 'typ'], ['alg', 'typ'])
  if (header.alg !== 'HS256' || header.typ !== 'JWT') reject(401, 'invalid_open_dot_model_authorization')
  exactKeys(claims, ['iss', 'aud', 'sub', 'org_id', 'profile', 'variation', 'jti', 'body_sha256', 'iat', 'exp',
    'employee_id', 'dot_id', 'session_id', 'request_id', 'provider', 'model', 'fallback_from'],
  ['iss', 'aud', 'sub', 'org_id', 'profile', 'variation', 'jti', 'body_sha256', 'iat', 'exp',
    'employee_id', 'dot_id', 'session_id', 'request_id', 'provider', 'model'])
  const now = Math.floor(nowMs / 1000)
  if (claims.iss !== 'hivemind-control-plane' || claims.aud !== 'hivemind-open-dot-model-broker'
    || claims.profile !== 'hivemind-chat' || claims.variation !== 'harness'
    || !UUID.test(String(claims.sub)) || !UUID.test(String(claims.org_id)) || !UUID.test(String(claims.employee_id))
    || !UUID.test(String(claims.jti)) || !DOT_ID.test(String(claims.dot_id))
    || !ASCII_ID.test(String(claims.session_id)) || !ASCII_ID.test(String(claims.request_id))
    || typeof claims.provider !== 'string' || typeof claims.model !== 'string'
    || !ALLOWED_ROUTES.has(`${claims.provider}/${claims.model}`)
    || typeof claims.body_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(claims.body_sha256)
    || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)
    || Number(claims.exp) <= Number(claims.iat) || Number(claims.exp) - Number(claims.iat) > 30
    || Number(claims.iat) > now + 5 || Number(claims.exp) < now - 5
    || claims.body_sha256 !== createHash('sha256').update(raw).digest('hex')) reject(401, 'invalid_open_dot_model_authorization')
  const bodyValue: unknown = (() => { try { return JSON.parse(raw) as unknown } catch { return undefined } })()
  exactKeys(bodyValue, ['organization_id', 'user_id', 'employee_id', 'dot_id', 'session_id', 'request_id', 'provider', 'model',
    'messages', 'tools', 'max_tokens', 'temperature', 'stop', 'reasoning_effort', 'parallel_tool_calls', 'stream_options',
    'stream', 'tool_choice', 'response_format', 'fallback_from'],
  ['organization_id', 'user_id', 'employee_id', 'dot_id', 'session_id', 'request_id', 'provider', 'model', 'messages', 'max_tokens', 'stream'])
  if (bodyValue.organization_id !== claims.org_id || bodyValue.user_id !== claims.sub
    || bodyValue.employee_id !== claims.employee_id || bodyValue.dot_id !== claims.dot_id
    || bodyValue.session_id !== claims.session_id || bodyValue.request_id !== claims.request_id
    || bodyValue.provider !== claims.provider || bodyValue.model !== claims.model) reject(403, 'open_dot_model_principal_mismatch')
  if (bodyValue.tool_choice !== undefined) reject(400, 'unsupported_open_dot_model_tool_choice')
  if (bodyValue.parallel_tool_calls !== false) reject(400, 'invalid_open_dot_model_tool_policy')
  exactKeys(bodyValue.stream_options, ['include_usage'], ['include_usage'])
  if (bodyValue.stream_options.include_usage !== true) reject(400, 'invalid_open_dot_model_stream_options')
  let fallbackFrom: FallbackFrom | undefined
  if (bodyValue.provider === OPEN_DOT_PRIMARY_PROVIDER) {
    if (bodyValue.fallback_from !== undefined || claims.fallback_from !== undefined) reject(403, 'invalid_open_dot_model_fallback')
  } else {
    fallbackFrom = parseFallbackFrom(bodyValue.fallback_from)
    const signedFallback = parseFallbackFrom(claims.fallback_from)
    if (!sameFallback(fallbackFrom, signedFallback) || fallbackFrom.request_id === bodyValue.request_id) {
      reject(403, 'invalid_open_dot_model_fallback')
    }
  }
  return { jti: String(claims.jti), exp: Number(claims.exp), body: bodyValue as ModelBrokerBody,
    ...(fallbackFrom === undefined ? {} : { fallbackFrom }) }
}

function parseImageUrl(value: unknown): ParsedImage {
  if (!isRecord(value)) return reject()
  exactKeys(value, ['url', 'detail'], ['url'])
  if (value.detail !== undefined && value.detail !== 'auto') reject(400, 'unsupported_open_dot_model_image_detail')
  if (typeof value.url !== 'string') return reject()
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/u.exec(value.url)
  const mediaType = match?.[1]
  const encoded = match?.[2]
  if (mediaType === undefined || encoded === undefined || encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
    reject(400, 'unsupported_open_dot_model_image')
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== encoded) reject(413, 'open_dot_model_image_too_large')
  return { bytes: new Uint8Array(bytes), mediaType: mediaType as ImageMediaType }
}

function parseTool(value: unknown): { name: string; description: string; parameters: Record<string, unknown> } {
  exactKeys(value, ['type', 'function'], ['type', 'function'])
  if (value.type !== 'function') reject(400, 'unsupported_open_dot_model_tool')
  const fn = value.function
  exactKeys(fn, ['name', 'description', 'parameters'], ['name'])
  if (typeof fn.name !== 'string' || !NAME.test(fn.name)
    || (fn.description !== undefined && !validText(fn.description, 4000))
    || (fn.parameters !== undefined && !isRecord(fn.parameters))) reject()
  return { name: fn.name, description: (fn.description as string | undefined) ?? '', parameters: (fn.parameters as Record<string, unknown> | undefined) ?? { type: 'object', properties: {} } }
}

function parseResponseFormat(value: unknown): JsonSchemaResponseFormat {
  exactKeys(value, ['type', 'json_schema'], ['type', 'json_schema'])
  if (value.type !== 'json_schema') reject(400, 'unsupported_open_dot_model_response_format')
  const schema = value.json_schema
  exactKeys(schema, ['name', 'strict', 'schema', 'description'], ['name', 'strict', 'schema'])
  if (typeof schema.name !== 'string' || !NAME.test(schema.name) || schema.strict !== true || !isRecord(schema.schema)
    || (schema.description !== undefined && !validText(schema.description, 4000))) reject(400, 'invalid_open_dot_model_response_format')
  return structuredClone(value) as unknown as JsonSchemaResponseFormat
}

function parseCall(value: unknown): { id: ToolCallId; name: string; arguments: string } {
  exactKeys(value, ['id', 'type', 'function'], ['id', 'type', 'function'])
  if (!boundedString(value.id, 128) || value.type !== 'function') reject()
  const fn = value.function
  exactKeys(fn, ['name', 'arguments'], ['name', 'arguments'])
  if (typeof fn.name !== 'string' || !NAME.test(fn.name) || typeof fn.arguments !== 'string') reject()
  try { if (!isRecord(JSON.parse(fn.arguments) as unknown)) reject() } catch { reject() }
  return { id: brandString<ToolCallId>(value.id), name: fn.name, arguments: fn.arguments }
}

type ParsedMessage = { role: 'system' | 'user' | 'assistant'; text: string; blocks: PlannedBlock[]; calls?: ReturnType<typeof parseCall>[]; toolCallId?: ToolCallId }

function parseMessage(value: unknown): ParsedMessage {
  exactKeys(value, ['role', 'content', 'tool_calls', 'tool_call_id'], ['role', 'content'])
  if (value.role === 'system') {
    if (typeof value.content !== 'string' || !validText(value.content, MAX_REQUEST_BYTES)) reject()
    return { role: 'system', text: value.content, blocks: [{ type: 'text', text: value.content }] }
  }
  if (value.role === 'tool') {
    if (!boundedString(value.tool_call_id, 128) || typeof value.content !== 'string' || !validText(value.content, MAX_REQUEST_BYTES)) reject()
    return { role: 'user', text: value.content, blocks: [{ type: 'text', text: value.content }], toolCallId: brandString<ToolCallId>(value.tool_call_id) }
  }
  if (value.role !== 'user' && value.role !== 'assistant') reject(400, 'unsupported_open_dot_model_role')
  if (value.role === 'assistant' && value.content === null) {
    if (!Array.isArray(value.tool_calls) || value.tool_calls.length === 0) reject()
    const calls = value.tool_calls.map(parseCall)
    return { role: 'assistant', text: '', blocks: [], calls }
  }
  if (value.role === 'assistant' && value.tool_calls !== undefined) reject(400, 'unsupported_open_dot_model_message_shape')
  if (typeof value.content === 'string') {
    if (!validText(value.content, MAX_REQUEST_BYTES)) reject()
    return { role: value.role, text: value.content, blocks: [{ type: 'text', text: value.content }] }
  }
  if (value.role !== 'user' || !Array.isArray(value.content) || value.content.length > 32) reject(400, 'unsupported_open_dot_model_message_shape')
  const blocks: PlannedBlock[] = value.content.map((part) => {
    exactKeys(part, ['type', 'text', 'image_url'], ['type'])
    if (part.type === 'text' && typeof part.text === 'string' && validText(part.text, MAX_REQUEST_BYTES)) return { type: 'text', text: part.text }
    if (part.type === 'image_url') return { type: 'image-input', image: parseImageUrl(part.image_url) }
    return reject(400, 'unsupported_open_dot_model_content')
  })
  return { role: 'user', text: '', blocks }
}

function prepareMessages(parsed: ParsedMessage[], images: readonly import('@deepseek-ai/dsh-attachment').ImageAttachmentRef[]): Message[] {
  let imageIndex = 0
  return parsed.map((item) => {
    const content: ContentBlock[] = item.blocks.map((block) => {
      if (block.type === 'text') return block
      const attachment = images[imageIndex]
      imageIndex++
      if (attachment === undefined) throw new Error('open_dot_model_image_projection_mismatch')
      return { type: 'image' as const, attachment }
    })
    if (item.calls) content.push(...item.calls.map(call => ({ type: 'tool-call' as const, ...call })))
    if (item.toolCallId) {
      return {
        ...createMessage({ role: 'user', content: [{ type: 'tool-result', toolCallId: item.toolCallId, content: [{ type: 'text', text: item.text }] }],
          source: { kind: 'tool', callId: item.toolCallId } }),
      }
    }
    const source = { kind: 'plugin' as const, plugin: 'hivemind-open-dot-model-broker' }
    return createMessage({ role: item.role, content, source })
  })
}

function parseInput(value: ModelBrokerBody, saveImages: OpenDotModelBrokerOptions['saveImages'], validateImages: OpenDotModelBrokerOptions['validateImages']): Promise<GenerateOptions> {
  return (async () => {
    if (value.stream !== true || !Array.isArray(value.messages) || value.messages.length === 0 || value.messages.length > MAX_MESSAGES
      || !Number.isSafeInteger(value.max_tokens) || value.max_tokens < 1 || value.max_tokens > MAX_TOKENS
      || (value.temperature !== undefined && (typeof value.temperature !== 'number' || !Number.isFinite(value.temperature) || value.temperature < 0 || value.temperature > 2))
      || (value.reasoning_effort !== undefined && !REASONING.has(value.reasoning_effort))) reject()
    if (value.stop !== undefined && !(Array.isArray(value.stop) && value.stop.length <= 4 && value.stop.every(item => typeof item === 'string' && item.length <= 128))) reject()
    if (value.tools !== undefined && (!Array.isArray(value.tools) || value.tools.length > MAX_TOOLS)) reject()
    const parsed = value.messages.map(parseMessage)
    const imageInputs = parsed.flatMap(message => message.blocks.flatMap(block => block.type === 'image-input'
      ? [{ data: block.image.bytes, mediaType: block.image.mediaType }] : []))
    if (imageInputs.length > MAX_IMAGES || imageInputs.reduce((sum, image) => sum + image.data.byteLength, 0) > MAX_IMAGE_TOTAL_BYTES) reject(413, 'open_dot_model_image_too_large')
    await validateImages(imageInputs)
    const refs = imageInputs.length === 0 ? [] : await saveImages(imageInputs)
    const messages = prepareMessages(parsed, refs)
    const tools = value.tools?.map(parseTool)
    const responseFormat = value.response_format === undefined ? undefined : parseResponseFormat(value.response_format)
    return {
      provider: value.provider, model: value.model, messages,
      ...(tools === undefined ? {} : { tools }), maxTokens: value.max_tokens,
      ...(responseFormat === undefined ? {} : { responseFormat }),
      ...(value.temperature === undefined ? {} : { temperature: value.temperature }),
      ...(value.stop === undefined ? {} : { stop: value.stop }),
      ...(value.reasoning_effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(value.reasoning_effort) }),
    }
  })()
}

function safeCode(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/u.test(value) ? value : 'model_provider_error'
}

function sse(value: unknown): string { return `data: ${JSON.stringify(value)}\n\n` }

function write(res: ServerResponse, value: string, signal: AbortSignal, state: { bytes: number }): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  state.bytes += Buffer.byteLength(value)
  if (state.bytes > MAX_RESPONSE_BYTES) return Promise.reject(new BrokerRejection(502, 'open_dot_model_response_too_large'))
  if (res.write(value)) return Promise.resolve()
  return new Promise((resolve, rejectWrite) => {
    const cleanup = () => { res.off('drain', onDrain); res.off('close', onClose); signal.removeEventListener('abort', onAbort) }
    const onDrain = () => { cleanup(); resolve() }
    const onClose = () => { cleanup(); rejectWrite(new Error('client_disconnected')) }
    const onAbort = () => { cleanup(); rejectWrite(signal.reason ?? new Error('request_cancelled')) }
    res.once('drain', onDrain); res.once('close', onClose); signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Verify one signed grant, consume its jti once, then translate native DSH chunks to Chat Completions SSE. */
export function createOpenDotModelBrokerHandler(options: OpenDotModelBrokerOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const controller = new AbortController()
    const abort = () => controller.abort(new Error('client_disconnected'))
    const onClose = () => { if (!res.writableEnded) abort() }
    let responseRequestId: string | undefined
    req.once('aborted', abort); res.once('close', onClose)
    const respond = (status: number, code: string) => {
      if (res.destroyed || res.writableEnded || res.headersSent) return
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
        ...(responseRequestId === undefined ? {} : { 'x-request-id': responseRequestId }) })
      res.end(JSON.stringify({ error: { message: code, type: 'hivemind_model_error', code } }))
    }
    try {
      if (req.url !== OPEN_DOT_MODEL_STREAM_PATH) reject(404, 'not_found')
      if (req.method !== 'POST') reject(405, 'method_not_allowed')
      for (const key of ['authorization', 'content-type']) {
        if (req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === key).length !== 1) reject()
      }
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(String(req.headers['content-type']))) reject(415, 'unsupported_media_type')
      if (req.headers['content-encoding'] || Number(req.headers['content-length'] ?? 0) > MAX_REQUEST_BYTES) reject(413, 'request_too_large')
      const chunks: Buffer[] = []; let size = 0
      for await (const chunk of req) {
        if (controller.signal.aborted) reject(499, 'request_cancelled')
        const bytes = Buffer.from(chunk); size += bytes.length
        if (size > MAX_REQUEST_BYTES) reject(413, 'request_too_large')
        chunks.push(bytes)
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      if (controller.signal.aborted) reject(499, 'request_cancelled')
      const verified = verifyToken(raw, String(req.headers.authorization ?? ''), options.secret, (options.now ?? Date.now)())
      responseRequestId = verified.body.request_id
      const ttl = Math.max(1, verified.exp - Math.floor((options.now ?? Date.now)() / 1000) + 5)
      if (!await options.consumeJti(verified.jti, ttl)) reject(409, 'open_dot_model_request_replayed')
      const selection = verified.body.provider === OPEN_DOT_PRIMARY_PROVIDER ? options.primarySelection() : undefined
      const selectedBody = selection === undefined ? verified.body : {
        ...verified.body, provider: selection.provider, model: selection.model,
        reasoning_effort: selection.reasoningEffort,
      }
      const input = await parseInput(selectedBody, options.saveImages, options.validateImages)
      const principal: HivemindPrincipal = {
        orgId: verified.body.organization_id, userId: verified.body.user_id,
        profile: 'hivemind-chat', variation: 'harness',
      }
      if (verified.fallbackFrom !== undefined) {
        const proof: OpenDotFallbackProof = {
          principal, employeeId: verified.body.employee_id, dotId: verified.body.dot_id,
          sessionId: verified.body.session_id, requestId: verified.fallbackFrom.request_id,
          failureCode: verified.fallbackFrom.failure_code,
        }
        if (!await options.consumeFallback(proof)) reject(409, 'open_dot_model_fallback_not_authorized')
      }
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(MAX_STREAM_MS)])
      const stream = options.stream(principal, { ...input, signal })
      const state = { bytes: 0 }
      let headersSent = false
      let roleSent = false
      let finished = false
      const createdAt = Math.floor((options.now ?? Date.now)() / 1000)
      const completionId = `chatcmpl-${randomUUID()}`
      const model = input.model
      const toolIndices = new Map<number, number>()
      let nextToolIndex = 0
      const recordFallback = async (failureCode: string): Promise<void> => {
        if (verified.body.provider !== OPEN_DOT_PRIMARY_PROVIDER || signal.aborted || !FALLBACK_FAILURE_CODES.has(failureCode)) return
        const proof: OpenDotFallbackProof = {
          principal, employeeId: verified.body.employee_id, dotId: verified.body.dot_id,
          sessionId: verified.body.session_id, requestId: verified.body.request_id, failureCode,
        }
        await options.recordFallback(proof, FALLBACK_PROOF_TTL_SECONDS).catch(() => undefined)
      }
      const start = () => {
        if (headersSent) return
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
          'x-request-id': verified.body.request_id,
        })
        headersSent = true
      }
      const frame = (choices: unknown[], usage?: unknown) => ({ id: completionId, object: 'chat.completion.chunk', created: createdAt, model,
        choices, ...(usage === undefined ? {} : { usage }) })
      const send = async (chunk: unknown) => { start(); await write(res, sse(chunk), signal, state) }
      const sendRole = async () => {
        if (roleSent) return
        roleSent = true
        await send(frame([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]))
      }
      try {
        for await (const chunk of stream) {
          if (signal.aborted) throw signal.reason
          if (chunk.type === 'text-delta') {
            await sendRole()
            await send(frame([{ index: 0, delta: { content: chunk.text }, finish_reason: null }]))
          } else if (chunk.type === 'reasoning-delta') {
            await sendRole()
            await send(frame([{ index: 0, delta: { reasoning_content: chunk.text }, finish_reason: null }]))
          } else if (chunk.type === 'tool-call-delta') {
            await sendRole()
            let callIndex = toolIndices.get(chunk.index)
            if (callIndex === undefined) {
              if (nextToolIndex > 0) throw new BrokerRejection(502, 'open_dot_model_parallel_tool_call_rejected')
              callIndex = nextToolIndex++; toolIndices.set(chunk.index, callIndex)
            }
            const toolCall: JsonRecord = { index: callIndex, type: 'function', function: { arguments: chunk.argumentsDelta } }
            if (chunk.id) toolCall['id'] = chunk.id
            if (chunk.name) (toolCall['function'] as JsonRecord)['name'] = chunk.name
            await send(frame([{ index: 0, delta: { tool_calls: [toolCall] }, finish_reason: null }]))
          } else if (chunk.type === 'usage') {
            const usage = chunk.usage
            const cached = (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
            const prompt = usage.inputTokens + cached
            const total = usage.totalTokens ?? prompt + usage.outputTokens
            await send(frame([], { prompt_tokens: prompt, completion_tokens: usage.outputTokens, total_tokens: total,
              ...(cached === 0 ? {} : { prompt_tokens_details: { cached_tokens: usage.cacheReadTokens ?? 0,
                cache_creation_input_tokens: usage.cacheWriteTokens ?? 0 } }),
              ...(usage.reasoningTokens === undefined ? {} : { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } }),
            }))
          } else if (chunk.type === 'finish') {
            if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
              const code = safeCode(chunk.reason.failure.code)
              if (!headersSent) {
                if (chunk.reason.kind === 'error') await recordFallback(code)
                respond(chunk.reason.kind === 'aborted' ? 504 : 502, code)
              }
              else if (!signal.aborted) {
                start()
                await write(res, `event: error\ndata: ${JSON.stringify({ error: { message: code, type: 'hivemind_model_error', code } })}\n\n`, signal, state)
                res.end()
              }
              finished = true
              return
            }
            await sendRole()
            const finishReason = chunk.reason.kind === 'tool-calls' ? 'tool_calls'
              : chunk.reason.kind === 'max-tokens' ? 'length' : 'stop'
            await send(frame([{ index: 0, delta: {}, finish_reason: finishReason }]))
            start()
            await write(res, 'data: [DONE]\n\n', signal, state)
            res.end()
            finished = true
            return
          }
        }
        if (!finished && !signal.aborted) {
          const code = 'open_dot_model_missing_finish'
          if (!headersSent) respond(502, code)
          else {
            start()
            await write(res, `event: error\ndata: ${JSON.stringify({ error: { message: code, type: 'hivemind_model_error', code } })}\n\n`, signal, state)
            res.end()
          }
        }
      } catch (error) {
        if (!signal.aborted) {
          const code = error instanceof BrokerRejection ? error.code
            : safeCode(typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined)
          if (!headersSent) {
            await recordFallback(code)
            respond(error instanceof BrokerRejection ? error.status : 502, code)
          }
          else {
            start()
            await write(res, `event: error\ndata: ${JSON.stringify({ error: { message: code, type: 'hivemind_model_error', code } })}\n\n`, signal, state).catch(() => undefined)
            if (!res.writableEnded) res.end()
          }
        }
      }
    } catch (error) {
      const rejection = error instanceof BrokerRejection ? error : undefined
      respond(rejection?.status ?? (controller.signal.aborted ? 499 : 503), rejection?.code ?? (controller.signal.aborted ? 'request_cancelled' : 'open_dot_model_unavailable'))
    } finally {
      req.off('aborted', abort); res.off('close', onClose)
    }
  }
}

/** Compose the runner-side verifier with native authenticated scope and LLM services. */
export function createOpenDotModelBroker(ctx: Context, options: Omit<OpenDotModelBrokerOptions, 'stream' | 'saveImages' | 'validateImages' | 'primarySelection'>) {
  return createOpenDotModelBrokerHandler({
    ...options,
    primarySelection: () => ctx.sessionController.currentDefaultModelSelection(),
    consumeJti: options.consumeJti,
    stream: (principal, request) => scopedChunks(ctx, principal, request),
    saveImages: images => ctx.attachments.saveImages(images),
    validateImages: async (images) => { for (const image of images) await ctx.attachments.validateImage(image) },
  })
}

/** Keep lazy native stream advancement inside the authenticated execution scope. */
async function* scopedChunks(ctx: Context, principal: HivemindPrincipal, request: GenerateOptions): AsyncIterable<StreamChunk> {
  const iterator = await ctx.hivemindExecutionScope.run(principal, () => ctx.llm.stream(request)[Symbol.asyncIterator]())
  try {
    while (true) {
      const next = await ctx.hivemindExecutionScope.run(principal, () => iterator.next())
      if (next.done) return
      yield next.value
    }
  } finally {
    const close = iterator.return
    if (close) await ctx.hivemindExecutionScope.run(principal, () => close.call(iterator))
  }
}
