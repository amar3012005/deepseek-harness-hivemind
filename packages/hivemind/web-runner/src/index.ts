/** HIVE-MIND embedded Web authentication and production health routes. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createClient, type RedisClientType } from 'redis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-hivemind-execution-scope'

export const name = 'hivemind-web-runner'
export const inject = ['webServer', 'connection', 'sessionPersistence', 'hivemindExecutionScope']

const EXCHANGE_PATH = '/api/hivemind/embed/exchange'
const ESTABLISH_PATH = '/api/hivemind/session/establish'
const HEALTH_PATH = '/health'
const TICKET_NONCE_PREFIX = 'hive:harness-ticket:'
const MAX_BODY_BYTES = 8192
const MAX_TICKET_TTL_SECONDS = 60
const CLOCK_SKEW_SECONDS = 5
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u

export interface Config {
  parentOrigins: string[]
  ticketSecretEnv: string
  redisUrlEnv: string
  redisJtiPrefix: string
  sessionMaxAgeSeconds: number
}

export const Config: z<Config> = z.object({
  parentOrigins: z.array(String).required(),
  ticketSecretEnv: z.string().required(),
  redisUrlEnv: z.string().required(),
  redisJtiPrefix: z.string().required(),
  sessionMaxAgeSeconds: z.natural().min(60).max(86400).required(),
})

export interface TicketClaims {
  iss: 'hivemind-control-plane'
  aud: 'hivemind-harness-runner'
  sub: string
  org_id: string
  profile: 'hivemind-chat'
  project_id?: string
  variation: string
  jti: string
  iat: number
  exp: number
}

function json(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  res.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8', ...headers })
  res.end(JSON.stringify(body))
}

function base64url(value: string): Buffer {
  return Buffer.from(value, 'base64url')
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function ticketHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function equalText(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

class AdmissionError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.code = code
  }
}

/** Verify the compact HMAC ticket and its fixed runner audience. */
export function verifyTicket(token: string, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): TicketClaims {
  if (!TOKEN_PATTERN.test(token)) throw new AdmissionError('invalid_ticket')
  const [encodedHeader, encodedPayload, encodedSignature] = token.split('.') as [string, string, string]
  const expected = createHmac('sha256', secret).update(`${encodedHeader}.${encodedPayload}`).digest()
  const actual = base64url(encodedSignature)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new AdmissionError('invalid_ticket_signature')
  let header: unknown
  let claims: unknown
  try {
    header = JSON.parse(base64url(encodedHeader).toString('utf8'))
    claims = JSON.parse(base64url(encodedPayload).toString('utf8'))
  } catch {
    throw new AdmissionError('invalid_ticket')
  }
  if (typeof header !== 'object' || header === null
    || (header as Record<string, unknown>).alg !== 'HS256'
    || (header as Record<string, unknown>).typ !== 'JWT') {
    throw new AdmissionError('invalid_ticket')
  }
  if (typeof claims !== 'object' || claims === null) throw new AdmissionError('invalid_ticket_claims')
  const value = claims as Record<string, unknown>
  if (value.iss !== 'hivemind-control-plane' || value.aud !== 'hivemind-harness-runner'
    || value.profile !== 'hivemind-chat' || !nonEmpty(value.sub) || !nonEmpty(value.org_id)
    || !nonEmpty(value.variation) || !nonEmpty(value.jti)
    || !Number.isSafeInteger(value.iat) || !Number.isSafeInteger(value.exp)
    || (value.project_id !== undefined && !nonEmpty(value.project_id))) {
    throw new AdmissionError('invalid_ticket_claims')
  }
  const issuedAt = value.iat as number
  const expiresAt = value.exp as number
  if (issuedAt > nowSeconds + CLOCK_SKEW_SECONDS || expiresAt <= nowSeconds
    || expiresAt <= issuedAt || expiresAt - issuedAt > MAX_TICKET_TTL_SECONDS) {
    throw new AdmissionError('expired_ticket')
  }
  return value as unknown as TicketClaims
}

/** Verify one ticket and atomically consume its replay identifier. */
export async function consumeTicket(
  token: string,
  secret: string,
  consume: (jti: string) => Promise<boolean>,
  nowSeconds?: number,
): Promise<TicketClaims> {
  const claims = verifyTicket(token, secret, nowSeconds)
  if (!await consume(claims.jti)) throw new AdmissionError('ticket_already_consumed')
  return claims
}

async function body(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += bytes.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function publicHost(req: IncomingMessage): string | undefined {
  const forwarded = req.headers['x-forwarded-host']
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',', 1)[0]?.trim()
  return typeof req.headers.host === 'string' ? req.headers.host : undefined
}

function sameOrigin(req: IncomingMessage): boolean {
  const host = publicHost(req)
  const origin = req.headers.origin
  if (host === undefined || origin === undefined) return false
  try {
    const parsed = new URL(origin)
    const forwarded = req.headers['x-forwarded-proto']
    const protocol = typeof forwarded === 'string' ? forwarded.split(',', 1)[0]?.trim() : undefined
    const expectedProtocol = protocol === 'http' || protocol === 'https' ? `${protocol}:` : parsed.protocol
    return parsed.protocol === expectedProtocol && parsed.host === host
  } catch {
    return false
  }
}

function referencedSessionIds(value: unknown, depth = 0, ids = new Set<string>()): Set<string> {
  if (depth > 8 || value === null || typeof value !== 'object') return ids
  if (Array.isArray(value)) {
    for (const item of value) referencedSessionIds(item, depth + 1, ids)
    return ids
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if ((key === 'sessionId' || key === 'parentSessionId' || key === 'childSessionId')
      && typeof item === 'string' && item.length > 0) ids.add(item)
    else referencedSessionIds(item, depth + 1, ids)
  }
  return ids
}

function env(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`hivemind-web-runner: ${name} is required`)
  return value
}

/** Mount the one-time ticket exchange and health routes. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const secret = env(config.ticketSecretEnv)
  if (Buffer.byteLength(secret, 'utf8') < 32) throw new Error('hivemind-web-runner: ticket secret must be at least 32 bytes')
  const parentOrigins = config.parentOrigins.map((value) => {
    const origin = new URL(value)
    if (origin.origin !== value || (origin.protocol !== 'https:' && origin.hostname !== 'localhost')) {
      throw new Error(`hivemind-web-runner: invalid parent origin ${JSON.stringify(value)}`)
    }
    return origin.origin
  })
  if (parentOrigins.length === 0) throw new Error('hivemind-web-runner: at least one parent origin is required')
  const redis = createClient({ url: env(config.redisUrlEnv) }) as RedisClientType
  redis.on('error', (error) => { ctx.logger.warn('hivemind-web-runner: Redis error', error) })
  await redis.connect()
  ctx.effect(() => ctx.connection.registerPrincipalScope((principal, action) => {
    if (principal['profile'] !== 'hivemind-chat' || principal['org_id'] === undefined
      || principal['user_id'] === undefined || principal['variation'] === undefined) {
      throw new Error('hivemind-web-runner: authenticated principal is incomplete')
    }
    return (ctx.hivemindExecutionScope).run({
      orgId: principal['org_id'], userId: principal['user_id'], profile: 'hivemind-chat',
      variation: principal['variation'],
      ...principal['project_id'] === undefined ? {} : { projectId: principal['project_id'] },
    }, action)
  }), 'hivemind-web-runner: principal execution scope')
  ctx.effect(() => ctx.connection.registerPrincipalRpcGuard(async (_principal, endpoint, args, signal) => {
    const ids = referencedSessionIds(args)
    if (endpoint === 'session/create' && ids.size > 0) {
      return { code: 'session/not-found', message: 'session not found', details: {} }
    }
    for (const id of ids) {
      signal.throwIfAborted()
      const visible = await ctx.sessionPersistence.stat(SessionId(id), { signal })
      if (visible === undefined) return { code: 'session/not-found', message: 'session not found', details: {} }
    }
    return undefined
  }), 'hivemind-web-runner: tenant session authorization')
  ctx.effect(() => async () => { await redis.quit() }, 'hivemind-web-runner: Redis connection')
  ctx.on('webserver/index-inject', table => table.push({
    kind: 'global',
    name: '__HIVEMIND_EMBED_CONFIG__',
    value: { version: 1, parentOrigins },
  }))
  const exchange = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const origin = req.headers.origin
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, diagnostic: 'method_not_allowed' })
      return
    }
    if (typeof origin !== 'string' || !parentOrigins.includes(origin) || !sameOrigin(req)) {
      json(res, 403, { ok: false, diagnostic: 'origin_denied' })
      return
    }
    if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      json(res, 400, { ok: false, diagnostic: 'invalid_request' })
      return
    }
    try {
      const input = await body(req)
      if (typeof input !== 'object' || input === null) throw new AdmissionError('invalid_request')
      const request = input as Record<string, unknown>
      if (!nonEmpty(request.ticket) || !nonEmpty(request.request_id)) throw new AdmissionError('invalid_request')
      const ticket = request.ticket
      const noncePrefix = config.redisJtiPrefix || TICKET_NONCE_PREFIX
      const claims = await consumeTicket(ticket, secret, async (jti) => {
        const stored = await redis.getDel(`${noncePrefix}${jti}`)
        return typeof stored === 'string' && equalText(stored, ticketHash(ticket))
      })
      const expiresAt = Date.now() + config.sessionMaxAgeSeconds * 1000
      const principal: Record<string, string> = {
        user_id: claims.sub,
        org_id: claims.org_id,
        profile: claims.profile,
        variation: claims.variation,
        ...claims.project_id === undefined ? {} : { project_id: claims.project_id },
      }
      const authorityHost = publicHost(req)
      const cookie = ctx.connection.authorizePrincipal({
        headers: { host: authorityHost || req.headers.host, cookie: req.headers.cookie },
      }, principal, expiresAt)
      json(res, 200, { ok: true, expires_at: expiresAt, profile: 'hivemind-chat' }, { 'set-cookie': cookie })
    } catch (error) {
      const diagnostic = error instanceof AdmissionError ? error.code : 'admission_denied'
      ctx.logger.warn('hivemind-web-runner: ticket exchange rejected', diagnostic)
      json(res, diagnostic === 'origin_denied' ? 403 : 401, { ok: false, diagnostic })
    }
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: EXCHANGE_PATH, handler: exchange }), 'hivemind-web-runner: embed ticket exchange')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ESTABLISH_PATH, handler: exchange }), 'hivemind-web-runner: session establish')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: HEALTH_PATH, handler: async (_req, res) => {
    try {
      const persistence = ctx.sessionPersistence as typeof ctx.sessionPersistence & { health?: () => Promise<void> }
      if (persistence.health === undefined) throw new Error('hivemind-web-runner: persistence health check is unavailable')
      await Promise.all([redis.ping(), persistence.health()])
      json(res, 200, { ok: true, profile: 'hivemind-chat' })
    } catch {
      json(res, 503, { ok: false, profile: 'hivemind-chat' })
    }
  } }), 'hivemind-web-runner: health route')
}
