/** Server-to-server OpenDot voice transport; never exposes provider credentials. */
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import WebSocket from 'ws'

const DOTS_ORIGIN = 'https://dots.singulancelabs.com'
const START = '/api/hivemind/voice/opendot/start'
const STOP = '/api/hivemind/voice/opendot/stop'
const UPDATE = '/api/hivemind/voice/opendot/update'
const MAX_CALLS = 4
const MAX_CONTEXT = 32_000
const MAX_SDP = 100_000
const MAX_CALL_MS = 10 * 60_000
const REQUEST_MS = 30_000

interface BrokerContext {
  organizationId: string
  userId: string
  dotId: string
  conversationId: string
  instructions: string
  context: string
}
interface BrokerRoom {
  callId: string
  owner: string
  dotId: string
  conversationId: string
  cookie: string
  socket: WebSocket
  timer: NodeJS.Timeout
  closed: boolean
  seen: Set<string>
}
export interface OpenDotVoiceBrokerOptions {
  token: string | undefined
  model: string
  voice: string
  getAuth(signal: AbortSignal): Promise<string | undefined>
  accountId(token: string): string
  makeSession(model: string, voice: string, instructions: string, context: string): unknown
  contextChunks(text: string): string[]
  withPrincipal<T>(organizationId: string, userId: string, operation: () => Promise<T>): Promise<T>
  createQueryBuffer(): { record(role: string, text: string): void; take(signal: AbortSignal): Promise<string> }
}
export interface OpenDotVoiceBroker {
  (req: IncomingMessage, res: ServerResponse): Promise<boolean>
  dispose(): void
}

function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_SDP + 16_000) throw new Error('invalid_request')
    chunks.push(Buffer.from(chunk))
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_request')
  return value as Record<string, unknown>
}
function sameSecret(actual: string | undefined, expected: string | undefined): boolean {
  if (!actual || !expected) return false
  const a = Buffer.from(actual); const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
function bearer(req: IncomingMessage): string | undefined {
  const value = req.headers.authorization
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : undefined
}
function cookie(req: IncomingMessage): string | undefined {
  const value = req.headers.cookie
  if (typeof value !== 'string' || value.length > 16_384) return undefined
  const session = value.split(';').map(part => part.trim()).find(part => part.startsWith('hm_cp_session='))
  return session && session.length <= 12_000 ? session : undefined
}
function bounded(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max }
async function jsonBody(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) throw new Error('voice_response_invalid')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) { await reader.cancel(); throw new Error('voice_response_too_large') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

/** Register by handling exact routes from the existing native voice prefix. */
export function createOpenDotVoiceBroker(options: OpenDotVoiceBrokerOptions): OpenDotVoiceBroker {
  const rooms = new Map<string, BrokerRoom>()
  const principals = new Set<string>()
  let disposed = false

  const requestContext = async (callId: string, sessionCookie: string, signal: AbortSignal): Promise<BrokerContext> => {
    const url = new URL('/api/hivemind/voice/context', DOTS_ORIGIN)
    url.searchParams.set('callId', callId)
    const response = await fetch(url, { headers: { authorization: `Bearer ${options.token}`, cookie: sessionCookie }, signal, redirect: 'error' })
    if (!response.ok) throw new Error('voice_context_rejected')
    const value: unknown = await jsonBody(response, MAX_CONTEXT + 16_000)
    if (!value || typeof value !== 'object') throw new Error('voice_context_invalid')
    const context = value as Record<string, unknown>
    if (!bounded(context.organizationId, 256) || !bounded(context.userId, 256) || !bounded(context.dotId, 256)
      || !bounded(context.conversationId, 256) || typeof context.instructions !== 'string' || context.instructions.length > 12_000
      || typeof context.context !== 'string' || context.context.length > MAX_CONTEXT) throw new Error('voice_context_invalid')
    return { organizationId: context.organizationId, userId: context.userId, dotId: context.dotId,
      conversationId: context.conversationId, instructions: context.instructions, context: context.context }
  }
  const callback = async (room: BrokerRoom, payload: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> => {
    const current = await requestContext(room.callId, room.cookie, signal)
    if (`${current.organizationId}:${current.userId}` !== room.owner || current.dotId !== room.dotId || current.conversationId !== room.conversationId) {
      close(room)
      throw new Error('voice_context_changed')
    }
    const response = await fetch(`${DOTS_ORIGIN}/api/hivemind/voice/events`, {
      method: 'POST', redirect: 'error', signal,
      headers: { authorization: `Bearer ${options.token}`, cookie: room.cookie, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) throw new Error('voice_event_rejected')
    const value: unknown = await jsonBody(response, 16_000)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  }
  const close = (room: BrokerRoom): void => {
    if (room.closed) return
    room.closed = true
    clearTimeout(room.timer)
    rooms.delete(room.callId); principals.delete(room.owner)
    try { if (room.socket.readyState === WebSocket.OPEN) room.socket.send(JSON.stringify({ type: 'session.close' })) } catch { /* closing */ }
    room.socket.close()
    const terminate = setTimeout(() => room.socket.terminate(), 1000); terminate.unref()
  }
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const path = req.url?.split('?')[0]
    if (path !== START && path !== STOP && path !== UPDATE) return false
    if (req.method !== 'POST' || !sameSecret(bearer(req), options.token) || !cookie(req)) {
      json(res, 401, { error: 'authentication_required' }); return true
    }
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') { json(res, 415, { error: 'invalid_request' }); return true }
    let input: Record<string, unknown>
    try { input = await readBody(req) } catch { json(res, 400, { error: 'invalid_request' }); return true }
    const sessionCookie = cookie(req)
    if (!sessionCookie) { json(res, 401, { error: 'authentication_required' }); return true }
    if (path === STOP || path === UPDATE) {
      if (!bounded(input.callId, 256)) { json(res, 400, { error: 'invalid_request' }); return true }
      try {
        const context = await requestContext(input.callId, sessionCookie, AbortSignal.timeout(REQUEST_MS))
        const room = rooms.get(input.callId)
        if (!room || room.owner !== `${context.organizationId}:${context.userId}`) { json(res, 404, { error: 'voice_call_not_found' }); return true }
        if (path === STOP) { close(room); json(res, 200, { ok: true }); return true }
        if (!bounded(input.text, 4000)) { json(res, 400, { error: 'invalid_request' }); return true }
        if (room.socket.readyState !== WebSocket.OPEN) { json(res, 409, { error: 'voice_call_closed' }); return true }
        for (const chunk of options.contextChunks(input.text)) room.socket.send(JSON.stringify({ type: 'session.context.append', channel: 'commentary', content: [{ type: 'input_text', text: chunk }] }))
        json(res, 200, { ok: true })
      } catch { json(res, 401, { error: 'voice_call_not_found' }) }
      return true
    }
    if (disposed || !bounded(input.callId, 256) || !bounded(input.dotId, 256) || !bounded(input.conversationId, 256)
      || !bounded(input.sdp, MAX_SDP)) { json(res, 400, { error: 'invalid_request' }); return true }
    let owner = ''
    try {
      const disconnected = new AbortController()
      res.once('close', () => { if (!res.writableFinished) disconnected.abort() })
      const signal = AbortSignal.any([AbortSignal.timeout(REQUEST_MS), disconnected.signal])
      const context = await requestContext(input.callId, sessionCookie, signal)
      owner = `${context.organizationId}:${context.userId}`
      if (context.dotId !== input.dotId || context.conversationId !== input.conversationId) throw new Error('voice_context_invalid')
      if (principals.has(owner)) { json(res, 409, { error: 'voice_call_already_active' }); return true }
      if (principals.size >= MAX_CALLS) { json(res, 429, { error: 'voice_capacity_reached' }); return true }
      principals.add(owner)
      try {
        const token = await options.withPrincipal(context.organizationId, context.userId, async () => {
          const granted = await options.getAuth(signal)
          if (!granted) throw new Error('voice_authorization_unavailable')
          return granted
        })
        const headers = { authorization: `Bearer ${token}`, 'ChatGPT-Account-Id': options.accountId(token), originator: 'hivemind', 'OpenAI-Alpha': 'quicksilver=v2', 'content-type': 'application/json' }
        const provider = await options.withPrincipal(context.organizationId, context.userId, () => fetch('https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas', {
          method: 'POST', headers, redirect: 'error', signal,
          body: JSON.stringify({ sdp: input.sdp,
            session: options.makeSession(options.model, options.voice, context.instructions, context.context) }),
        }))
        if (!provider.ok) throw new Error('voice_provider_rejected')
        const location = provider.headers.get('location') ?? ''
        const id = location.split('?')[0]?.split('/').filter(Boolean).at(-1)
        if (!id || !/^[\w-]{1,256}$/.test(id)) throw new Error('voice_provider_rejected')
        const answerSdp = await provider.text()
        if (answerSdp.length > MAX_SDP) throw new Error('voice_provider_rejected')
        const socket = new WebSocket(`wss://api.openai.com/v1/live/${encodeURIComponent(id)}`, { headers, handshakeTimeout: REQUEST_MS, maxPayload: 1_000_000 })
        const closeOnAbort = () => socket.close()
        signal.addEventListener('abort', closeOnAbort, { once: true })
        try {
          await new Promise<void>((resolve, reject) => {
            socket.once('open', resolve); socket.once('error', reject); socket.once('close', () => reject(new Error('voice_connection_failed')))
          })
          signal.throwIfAborted()
        } finally { signal.removeEventListener('abort', closeOnAbort) }
        const room: BrokerRoom = { callId: input.callId, owner, dotId: context.dotId,
          conversationId: context.conversationId, cookie: sessionCookie, socket, closed: false,
          seen: new Set(), timer: setTimeout(() => close(room), MAX_CALL_MS) }
        const queries = options.createQueryBuffer()
        room.timer.unref(); rooms.set(room.callId, room)
        socket.on('close', () => close(room)); socket.on('error', () => close(room))
        socket.on('message', (raw) => {
          let event: Record<string, unknown>
          try { const value: unknown = JSON.parse(raw.toString()); if (!value || typeof value !== 'object') return; event = value as Record<string, unknown> } catch { return }
          const type = event.type
          if (type === 'turn.done') {
            const turn = event.turn as Record<string, unknown> | undefined
            if ((turn?.role === 'user' || turn?.role === 'assistant') && typeof turn.transcript === 'string' && turn.transcript.length <= 8000) {
              queries.record(turn.role, turn.transcript)
              const eventId = randomUUID()
              void callback(room, { callId: room.callId, eventId, type: 'transcript', who: turn.role === 'user' ? 'you' : 'dot', text: turn.transcript }, AbortSignal.timeout(REQUEST_MS)).catch(() => close(room))
            }
          }
          if (type === 'delegation.created') {
            const item = event.item as Record<string, unknown> | undefined
            if (item?.target !== 'client' || typeof item.id !== 'string' || room.seen.has(item.id) || item.id.length > 256) return
            room.seen.add(item.id)
            const eventId = randomUUID()
            void queries.take(AbortSignal.timeout(REQUEST_MS)).then(request => callback(room, { callId: room.callId, eventId, type: 'task', request }, AbortSignal.timeout(REQUEST_MS))).then((result) => {
              const text = result.status === 'completed' && typeof result.text === 'string'
                ? result.text.slice(0, 4000) : 'I have sent that request to your Dot. I will wait for its result.'
              if (!room.closed && socket.readyState === WebSocket.OPEN) for (const chunk of options.contextChunks(text)) socket.send(JSON.stringify({ type: 'delegation.context.append', delegation_item_id: item.id, channel: 'speakable', content: [{ type: 'input_text', text: chunk }] }))
            }).catch(() => close(room))
          }
        })
        json(res, 200, { callId: room.callId, answerSdp, protocol: 'dsh' })
      } catch (error) { principals.delete(owner); throw error }
    } catch (error) {
      principals.delete(owner)
      const code = error instanceof Error && error.message === 'voice_context_invalid' ? 'voice_context_invalid' : 'voice_unavailable'
      json(res, code === 'voice_context_invalid' ? 403 : 502, { error: code })
    }
    return true
  }
  const dispatch = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => handle(req, res)
  dispatch.dispose = () => { disposed = true; for (const room of rooms.values()) close(room) }
  return dispatch
}
