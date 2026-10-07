/** Narrow authenticated HTTP facade over existing native Codex capabilities. */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { HivemindPrincipal } from '@deepseek-ai/dsh-hivemind-execution-scope'
import type {} from './media-auth.ts'

export interface ProviderApiConfig {
  enabled: boolean
  keyEnv: string
  orgId: string
  userId: string
  sessionId: string
  variation: string
  model: string
}
export const PROVIDER_PREFIX = '/api/hivemind/provider/v1'
function reply(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value))
}
export function providerPrincipal(req: IncomingMessage, config: ProviderApiConfig, key: string): HivemindPrincipal | undefined {
  if (!config.enabled || key.length < 32 || !req.url?.startsWith(PROVIDER_PREFIX + '/')) return undefined
  const supplied = req.headers.authorization
  if (typeof supplied !== 'string' || supplied.length > 512 || !supplied.startsWith('Bearer ')) return undefined
  const expectedHash = createHash('sha256').update(key).digest()
  const actualHash = createHash('sha256').update(supplied.slice(7)).digest()
  if (!timingSafeEqual(expectedHash, actualHash)) return undefined
  return { orgId: config.orgId, userId: config.userId, profile: 'hivemind-chat', variation: config.variation }
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let bytes = 0; const chunks: Buffer[] = []
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 100_000) throw new Error('invalid_request'); chunks.push(Buffer.from(chunk)) }
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_request')
  return input as Record<string, unknown>
}
function prompt(input: Record<string, unknown>): { instructions: string; input: { role: string; content: string }[] } {
  const messages = input.messages ?? (typeof input.input === 'string' ? [{ role: 'user', content: input.input }] : input.input)
  if (!Array.isArray(messages) || !messages.length || messages.length > 32) throw new Error('invalid_request')
  const result: { role: string; content: string }[] = []; const instructions: string[] = []
  for (const message of messages) {
    if (!message || typeof message !== 'object' || typeof message.content !== 'string' || message.content.length > 32000) throw new Error('invalid_request')
    if (message.role === 'system' || message.role === 'developer') instructions.push(message.content)
    else if (message.role === 'user' || message.role === 'assistant') result.push({ role: message.role, content: message.content })
    else throw new Error('invalid_request')
  }
  if (!result.length) throw new Error('invalid_request')
  return { instructions: instructions.join('\n') || 'Answer the authenticated caller accurately and concisely.', input: result }
}
/** SSE parser bounded to one event, never logs provider payloads. */
async function* events(response: Response): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) throw new Error('provider_unavailable')
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = ''
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break
      pending += decoder.decode(chunk.value, { stream: true })
      pending = pending.replace(/\r\n/g, '\n')
      if (pending.length > 2_000_000) throw new Error('provider_unavailable')
      let end: number
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const event = pending.slice(0, end); pending = pending.slice(end + 2)
        const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (!data || data === '[DONE]') continue
        const value: unknown = JSON.parse(data)
        if (value && typeof value === 'object' && !Array.isArray(value)) yield value as Record<string, unknown>
      }
    }
  } finally { await reader.cancel().catch(() => {}) }
}
export function registerProviderApi(ctx: Context, config: ProviderApiConfig, key: () => Promise<string>,
  active: (principal: HivemindPrincipal, signal: AbortSignal) => Promise<boolean>): void {
  if (!config.enabled) return
  if (!config.orgId || !config.userId || !config.sessionId || !config.variation || !config.model) throw new Error('Provider API requires a complete fixed owner and dedicated key')
  let concurrent = 0
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PROVIDER_PREFIX, handler: async (req, res) => {
    let principal: HivemindPrincipal | undefined
    try { principal = providerPrincipal(req, config, await key()) } catch { /* Credential failures fail closed. */ }
    if (!principal) { reply(res, 401, { error: { message: 'Provider authentication required', type: 'authentication_error' } }); return }
    const path = req.url?.split('?')[0]
    // Native live voice owns these same-key routes and their connection lifetime.
    if (path?.startsWith(PROVIDER_PREFIX + '/realtime/')) return
    if (concurrent >= 2) { reply(res, 429, { error: { message: 'Provider is busy; retry later' } }); return }
    const lifetime = new AbortController(); res.once('close', () => { if (!res.writableFinished) lifetime.abort() })
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(600_000)])
    concurrent++
    try {
      if (!await active(principal, signal)) { reply(res, 403, { error: { message: 'Provider owner is no longer authorized' } }); return }
      await ctx.hivemindExecutionScope.run(principal, async () => {
        if (req.method === 'GET' && path === PROVIDER_PREFIX + '/models') {
          reply(res, 200, { object: 'list', data: [config.model, 'codex-image', 'codex-live-voice'].map(id => ({ id, object: 'model', owned_by: 'singulance' })) }); return
        }
        if (req.method !== 'POST' || req.headers['content-type']?.split(';')[0] !== 'application/json') { reply(res, 400, { error: { message: 'POST with application/json required' } }); return }
        const input = await body(req)
        if (path === PROVIDER_PREFIX + '/images/generations') {
          if (input.model !== undefined && input.model !== 'codex-image') throw new Error('invalid_request')
          if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 16000 || (input.n !== undefined && input.n !== 1)) throw new Error('invalid_request')
          const nonce = req.headers['idempotency-key']
          if (typeof nonce !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(nonce)) throw new Error('invalid_request')
          const sessionId = SessionId(config.sessionId)
          if (!await ctx.sessionPersistence.stat(sessionId, { signal })) throw new Error('provider_session_unavailable')
          const resolved = await ctx.sessionController.resolveAgent(sessionId)
          if ('error' in resolved) throw new Error('provider_session_unavailable')
          const generated = await agentEvents(ctx, resolved.agent).serial('hivemind/provider-image', {
            prompt: input.prompt, sessionId: config.sessionId, operationId: createHash('sha256').update(`${config.orgId}:${config.userId}:${nonce}`).digest('hex'), signal,
            ...(typeof input.transparent_background === 'boolean' ? { transparentBackground: input.transparent_background } : {}),
          })
          if (!generated?.data.byteLength) throw new Error('provider_unavailable')
          reply(res, 200, { created: Math.floor(Date.now()/1000), data: [{ b64_json: Buffer.from(generated.data).toString('base64') }] }); return
        }
        const search = path === PROVIDER_PREFIX + '/web/search'
        const chat = path === PROVIDER_PREFIX + '/chat/completions'
        if (!search && !chat && path !== PROVIDER_PREFIX + '/responses') { reply(res, 404, { error: { message: 'Unknown provider endpoint' } }); return }
        if (input.model !== undefined && input.model !== config.model) throw new Error('invalid_request')
        const query = search && typeof input.query === 'string' ? input.query : undefined
        const request = prompt(query === undefined ? input : { input: query })
        const auth = await ctx.serial('hivemind/codex-image-auth', { signal })
        if (!auth) throw new Error('provider_authorization_unavailable')
        const upstream = await fetch('https://chatgpt.com/backend-api/codex/responses', {
          method: 'POST', redirect: 'error', signal, headers: { authorization: `Bearer ${auth.accessToken}`, 'chatgpt-account-id': auth.chatgptAccountId, 'OpenAI-Beta': 'responses=experimental', 'content-type': 'application/json' },
          body: JSON.stringify({ model: config.model, store: false, stream: true, ...request,
            ...(search || input.web_search === true ? { tools: [{ type: 'web_search', search_context_size: 'low' }], ...(search ? { tool_choice: 'required' } : {}), include: ['web_search_call.action.sources'] } : {}),
          }),
        })
        if (!upstream.ok) { await upstream.body?.cancel(); throw new Error('provider_unavailable') }
        let text = ''; let completed = false; let terminal: unknown; const output = new Map<number, unknown>(); const id = `chatcmpl-${randomUUID()}`
        const streaming = input.stream === true && !search
        const send = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`)
        if (streaming) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
        for await (const event of events(upstream)) {
          if (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.incomplete') throw new Error('provider_unavailable')
          if (event.type === 'response.output_item.done' && typeof event.output_index === 'number') output.set(event.output_index, event.item)
          if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
            text += event.delta; if (text.length > 1_000_000) throw new Error('provider_unavailable')
            if (streaming && chat) send({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: config.model, choices: [{ index: 0, delta: { content: event.delta }, finish_reason: null }] })
          }
          if (streaming && !chat && ['response.created','response.output_text.delta','response.output_text.done','response.output_item.done','response.completed'].includes(String(event.type))) send(event)
          if (event.type === 'response.completed') { completed = true; terminal = event.response; break }
        }
        if (!completed) throw new Error('provider_unavailable')
        if (streaming) {
          if (chat) { send({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: config.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }); res.write('data: [DONE]\n\n') }
          res.end(); return
        }
        const final = terminal && typeof terminal === 'object' ? terminal as Record<string, unknown> : {}
        const items = [...output.entries()].sort(([a],[b]) => a-b).map(([,item]) => item)
        if (chat) reply(res, 200, { id, object: 'chat.completion', created: Math.floor(Date.now()/1000), model: config.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] })
        else reply(res, 200, search ? { query, text, output: items }
          : { ...final, output: items.length ? items : final.output, output_text: text })
      })
    } catch (error) {
      const invalid = error instanceof Error && error.message === 'invalid_request'
      const value = { error: { message: invalid ? 'Unsupported or invalid request; images require a stable Idempotency-Key' : 'Provider request could not complete', type: invalid ? 'invalid_request_error' : 'provider_error' } }
      if (!res.headersSent) reply(res, invalid ? 400 : 503, value)
      else { res.write(`data: ${JSON.stringify(value)}\n\n`); res.end() }
    } finally { concurrent-- }
  } }))
}
