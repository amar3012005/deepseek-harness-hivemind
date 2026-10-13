import { createHash, createHmac, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import type { HivemindPrincipal } from '@deepseek-ai/dsh-hivemind-execution-scope'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createOpenDotModelBrokerHandler, OPEN_DOT_MODEL_ID, OPEN_DOT_MODEL_PROVIDER, OPEN_DOT_MODEL_STREAM_PATH, OPEN_DOT_PRIMARY_MODEL_ID, OPEN_DOT_PRIMARY_PROVIDER } from '../src/open-dot-model-broker.ts'

const secret = 'purpose-bound-test-secret-with-at-least-32-bytes'
const id = '12345678-1234-4234-8234-123456789abc'
const body = {
  organization_id: id, user_id: id, employee_id: id, dot_id: 'dot_fixture', session_id: 'conversation_fixture',
  request_id: 'request_fixture', provider: OPEN_DOT_PRIMARY_PROVIDER, model: OPEN_DOT_PRIMARY_MODEL_ID,
  messages: [{ role: 'user', content: 'Summarize the supplied fixture.' }], max_tokens: 512,
  parallel_tool_calls: false, stream_options: { include_usage: true }, stream: true,
}

function sign(raw: string, claimsPatch: Record<string, unknown> = {}, key = secret): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const signedBody = JSON.parse(raw) as typeof body & { fallback_from?: unknown }
  const claims = {
    iss: 'hivemind-control-plane', aud: 'hivemind-open-dot-model-broker', sub: signedBody.user_id, org_id: signedBody.organization_id,
    profile: 'hivemind-chat', variation: 'harness', jti: randomUUID(), body_sha256: createHash('sha256').update(raw).digest('hex'),
    iat: 1000, exp: 1030, employee_id: signedBody.employee_id, dot_id: signedBody.dot_id, session_id: signedBody.session_id,
    request_id: signedBody.request_id, provider: signedBody.provider, model: signedBody.model,
    ...(signedBody.fallback_from === undefined ? {} : { fallback_from: signedBody.fallback_from }), ...claimsPatch,
  }
  const input = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`
  return `Bearer ${input}.${createHmac('sha256', key).update(input).digest('base64url')}`
}

const principal: HivemindPrincipal = { orgId: id, userId: id, profile: 'hivemind-chat', variation: 'harness' }
const servers: ReturnType<typeof createServer>[] = []
const fallbackKey = (proof: { principal: HivemindPrincipal; employeeId: string; dotId: string; sessionId: string; requestId: string }) =>
  [proof.principal.orgId, proof.principal.userId, proof.employeeId, proof.dotId, proof.sessionId, proof.requestId].join('|')

async function endpoint(options: {
  stream?: (scope: HivemindPrincipal, input: GenerateOptions) => AsyncIterable<StreamChunk>
  consumeJti?: (jti: string, ttlSeconds: number) => Promise<boolean>
  consumeFallback?: (proof: { requestId: string; failureCode: string }) => Promise<boolean>
  validateImages?: () => Promise<void>
  primarySelection?: () => { provider: string; model: string }
} = {}) {
  const calls: Array<{ scope: HivemindPrincipal; input: GenerateOptions }> = []
  const fallbackProofs = new Map<string, string>()
  const handler = createOpenDotModelBrokerHandler({
    secret, now: () => 1_000_000,
    primarySelection: options.primarySelection ?? (() => ({ provider: 'cloudflare-workers-ai', model: '@cf/zai-org/glm-5.3-flash' })),
    consumeJti: options.consumeJti ?? (async () => true),
    recordFallback: async (proof) => { fallbackProofs.set(fallbackKey(proof), proof.failureCode) },
    consumeFallback: options.consumeFallback ?? (async (proof) => {
      const key = fallbackKey(proof)
      if (fallbackProofs.get(key) !== proof.failureCode) return false
      fallbackProofs.delete(key)
      return true
    }),
    stream: (scope, input) => { calls.push({ scope, input }); return options.stream?.(scope, input) ?? (async function* () {
      yield { type: 'text-delta', index: 0, text: 'fixture response' }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13, cacheReadTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })() },
    saveImages: async images => images.map((_, index) => ({ id: `image-${index}`, mediaType: 'image/png' } as never)),
    validateImages: options.validateImages ?? (async () => {}),
  })
  const server = createServer(handler)
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as { port: number }
  return { calls, fallbackProofs, url: `http://127.0.0.1:${address.port}${OPEN_DOT_MODEL_STREAM_PATH}` }
}

async function post(url: string, raw = JSON.stringify(body), authorization = sign(raw)) {
  return fetch(url, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: raw })
}

afterEach(() => { for (const server of servers.splice(0)) { server.close(); server.closeAllConnections() } })

describe('Open Dot native model broker', () => {
  it('streams Chat Completions deltas and usage from one scoped native call', async () => {
    const { url, calls } = await endpoint()
    const response = await post(url)
    const text = await response.text()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(text).toContain('"content":"fixture response"')
    expect(text).toContain('"prompt_tokens":12')
    expect(text).toContain('"cached_tokens":2')
    expect(text).toContain('"finish_reason":"stop"')
    expect(text).toContain('data: [DONE]')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.scope).toEqual(principal)
    expect(calls[0]!.input).toMatchObject({ provider: 'cloudflare-workers-ai', model: '@cf/zai-org/glm-5.3-flash', maxTokens: 512 })
    expect(calls[0]!.input).not.toHaveProperty('sessionId')
  })

  it('accepts only the signed global-default route in addition to the Codex fallback', async () => {
    const { url, calls } = await endpoint()
    const primary = { ...body, provider: OPEN_DOT_PRIMARY_PROVIDER, model: OPEN_DOT_PRIMARY_MODEL_ID }
    const primaryRaw = JSON.stringify(primary)
    const response = await post(url, primaryRaw, sign(primaryRaw, { provider: primary.provider, model: primary.model }))
    expect(response.status).toBe(200)
    expect(calls[0]!.input).toMatchObject({ provider: 'cloudflare-workers-ai', model: '@cf/zai-org/glm-5.3-flash' })
    const unsupported = { ...body, provider: OPEN_DOT_PRIMARY_PROVIDER, model: 'arbitrary-model' }
    const unsupportedRaw = JSON.stringify(unsupported)
    const unsupportedResponse = await post(url, unsupportedRaw, sign(unsupportedRaw, {
      provider: unsupported.provider, model: unsupported.model,
    }))
    expect(unsupportedResponse.status).toBe(401)
    expect(calls).toHaveLength(1)
  })

  it('uses a changed global model in the same conversation without changing its history', async () => {
    let selection = { provider: 'cloudflare-workers-ai', model: '@cf/zai-org/glm-5.3-flash' }
    const { url, calls } = await endpoint({ primarySelection: () => selection })
    await (await post(url)).text()
    selection = { provider: 'another-registered-provider', model: 'another-global-model' }
    const raw = JSON.stringify({ ...body, request_id: 'same_conversation_next_request' })
    await (await post(url, raw, sign(raw))).text()
    expect(calls.map(call => ({ provider: call.input.provider, model: call.input.model }))).toEqual([
      { provider: 'cloudflare-workers-ai', model: '@cf/zai-org/glm-5.3-flash' }, selection,
    ])
    expect(calls.every(call => !('sessionId' in call.input))).toBe(true)
  })

  it('records only a pre-output GLM failure and consumes its identity-bound proof for Codex fallback', async () => {
    const { url, calls, fallbackProofs } = await endpoint({ stream: async function* (_scope, request) {
      if (request.provider === 'cloudflare-workers-ai') {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'provider detail' } } }
        return
      }
      yield { type: 'text-delta', index: 0, text: 'fallback answer' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } })
    const primary = { ...body, provider: OPEN_DOT_PRIMARY_PROVIDER, model: OPEN_DOT_PRIMARY_MODEL_ID, request_id: 'glm_attempt_1' }
    const primaryRaw = JSON.stringify(primary)
    const primaryResponse = await post(url, primaryRaw, sign(primaryRaw))
    expect(primaryResponse.status).toBe(502)
    expect(primaryResponse.headers.get('x-request-id')).toBe('glm_attempt_1')
    const proofIdentity = { principal, employeeId: id, dotId: body.dot_id, sessionId: body.session_id, requestId: 'glm_attempt_1' }
    expect(fallbackProofs.get(fallbackKey(proofIdentity))).toBe('RATE_LIMIT')

    const fallbackFrom = { provider: OPEN_DOT_PRIMARY_PROVIDER, model: OPEN_DOT_PRIMARY_MODEL_ID,
      request_id: 'glm_attempt_1', failure_code: 'RATE_LIMIT', output_started: false }
    const fallback = { ...body, request_id: 'codex_attempt_1', provider: OPEN_DOT_MODEL_PROVIDER,
      model: OPEN_DOT_MODEL_ID, fallback_from: fallbackFrom }
    const fallbackRaw = JSON.stringify(fallback)
    const response = await post(url, fallbackRaw, sign(fallbackRaw, { fallback_from: {
      output_started: false, failure_code: 'RATE_LIMIT', request_id: 'glm_attempt_1', model: OPEN_DOT_PRIMARY_MODEL_ID,
      provider: OPEN_DOT_PRIMARY_PROVIDER,
    } }))
    expect(response.status).toBe(200)
    expect((await response.text())).toContain('fallback answer')
    expect(fallbackProofs.has(fallbackKey(proofIdentity))).toBe(false)
    expect(calls.map(call => call.input.provider)).toEqual(['cloudflare-workers-ai', OPEN_DOT_MODEL_PROVIDER])
  })

  it('rejects direct Codex use without a matching signed GLM failure proof', async () => {
    const { url, calls } = await endpoint()
    const raw = JSON.stringify({ ...body, provider: OPEN_DOT_MODEL_PROVIDER, model: OPEN_DOT_MODEL_ID,
      request_id: 'codex_attempt_no_proof', fallback_from: { provider: OPEN_DOT_PRIMARY_PROVIDER,
        model: OPEN_DOT_PRIMARY_MODEL_ID, request_id: 'missing_glm_attempt', failure_code: 'RATE_LIMIT', output_started: false } })
    expect((await post(url, raw, sign(raw))).status).toBe(409)
    expect(calls).toHaveLength(0)
  })

  it('rejects wrong signature, body changes, principal mismatch, and replay before native I/O', async () => {
    const { url, calls } = await endpoint({ consumeJti: async () => false })
    let response = await post(url, JSON.stringify(body), sign(JSON.stringify(body), {}, 'wrong-secret-with-over-32-bytes'))
    expect(response.status).toBe(401)
    const raw = JSON.stringify(body)
    const changed = JSON.stringify({ ...body, max_tokens: 513 })
    response = await post(url, changed, sign(raw))
    expect(response.status).toBe(401)
    response = await post(url, raw, sign(raw, { org_id: '22345678-1234-4234-8234-123456789abc' }))
    expect(response.status).toBe(403)
    response = await post(url, raw)
    expect(response.status).toBe(409)
    expect(calls).toHaveLength(0)
  })

  it('requires the fixed serialized tool policy and refuses non-text or remote image content before I/O', async () => {
    const { url, calls } = await endpoint()
    const invalidPolicy = JSON.stringify({ ...body, parallel_tool_calls: true })
    expect((await post(url, invalidPolicy)).status).toBe(400)
    const remoteImage = JSON.stringify({ ...body, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/image.png' } }] }] })
    expect((await post(url, remoteImage)).status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('preserves strict JSON Schema response formats and rejects non-strict formats', async () => {
    const { url, calls } = await endpoint()
    const format = { type: 'json_schema', json_schema: { name: 'policy_review', strict: true,
      description: 'Return the structured policy review.', schema: { type: 'object', additionalProperties: false,
        properties: { accepted: { type: 'boolean' } }, required: ['accepted'] } } }
    const raw = JSON.stringify({ ...body, response_format: format })
    expect((await post(url, raw)).status).toBe(200)
    expect(calls[0]!.input.responseFormat).toEqual(format)
    const invalid = JSON.stringify({ ...body, response_format: { ...format, json_schema: { ...format.json_schema, strict: false } } })
    expect((await post(url, invalid)).status).toBe(400)
    expect(calls).toHaveLength(1)
  })

  it('accepts a bounded base64 image through native attachment admission', async () => {
    let imageValidation = 0
    const { url, calls } = await endpoint({ validateImages: async () => { imageValidation++ } })
    const png = Buffer.from('iVBORw0KGgo=', 'base64').toString('base64')
    const imageBody = JSON.stringify({ ...body, messages: [{ role: 'user', content: [
      { type: 'text', text: 'Describe this bounded image.' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${png}`, detail: 'auto' } },
    ] }] })
    expect((await post(url, imageBody)).status).toBe(200)
    expect(imageValidation).toBe(1)
    expect(calls[0]!.input.messages[0]!.content.some(block => block.type === 'image')).toBe(true)
  })

  it('refuses a second parallel tool call without a successful terminal frame', async () => {
    const { url } = await endpoint({ stream: async function* () {
      yield { type: 'tool-call-delta', index: 0, id: 'call_one' as never, name: 'lookup', argumentsDelta: '{"q":"a"}' }
      yield { type: 'tool-call-delta', index: 1, id: 'call_two' as never, name: 'lookup', argumentsDelta: '{"q":"b"}' }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } })
    const text = await (await post(url)).text()
    expect(text).toContain('open_dot_model_parallel_tool_call_rejected')
    expect(text).not.toContain('data: [DONE]')
    expect(text).not.toContain('"finish_reason":"tool_calls"')
  })

  it('does not retry or claim completion after a partial native stream failure', async () => {
    let attempts = 0
    const { url, calls, fallbackProofs } = await endpoint({ stream: async function* () {
      attempts++
      yield { type: 'text-delta', index: 0, text: 'partial' }
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UPSTREAM_FAILED', message: 'private detail' } } }
    } })
    const text = await (await post(url)).text()
    expect(text).toContain('"content":"partial"')
    expect(text).toContain('event: error')
    expect(text).toContain('UPSTREAM_FAILED')
    expect(text).not.toContain('private detail')
    expect(text).not.toContain('data: [DONE]')
    expect(attempts).toBe(1)
    expect(calls).toHaveLength(1)
    expect(fallbackProofs.size).toBe(0)
  })

  it('records an explicit native pre-output rejection for the one authorized fallback', async () => {
    const { url, fallbackProofs } = await endpoint({ stream: async function* () {
      throw Object.assign(new Error('image input unsupported'), { code: 'UNSUPPORTED_CONTENT' })
    } })
    const request = { ...body, request_id: 'glm_unsupported_image' }
    const raw = JSON.stringify(request)
    const response = await post(url, raw, sign(raw))
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: { code: 'UNSUPPORTED_CONTENT' } })
    expect(fallbackProofs.get(fallbackKey({ principal, employeeId: id, dotId: body.dot_id,
      sessionId: body.session_id, requestId: request.request_id }))).toBe('UNSUPPORTED_CONTENT')
  })

  it('rejects requests over the 512 KiB whole-body budget', async () => {
    const { url, calls } = await endpoint()
    const raw = JSON.stringify({ ...body, messages: [{ role: 'user', content: 'x'.repeat(512 * 1024) }] })
    const response = await post(url, raw)
    expect(response.status).toBe(413)
    expect(calls).toHaveLength(0)
  })
})
