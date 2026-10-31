import { createHash, createHmac } from 'node:crypto'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { BrowserAuth } from '../../../client/connection/src/browser-auth.ts'
import { nativePrincipalAllowed, nativeSessionBinding } from '../src/native-consent.ts'
import { principalMembershipActive } from '../src/principal-membership.ts'

const state = vi.hoisted(() => ({ ticket: '', status: 200, tokens: [] as string[], urls: [] as string[] }))
vi.mock('redis', () => ({ createClient: () => ({
  on() {}, async connect() {}, async quit() {},
  async getDel() { return createHash('sha256').update(state.ticket).digest('hex') },
}) }))
vi.mock('../src/media-auth.ts', () => ({ registerMediaAuth() {} }))
vi.mock('../src/live-voice.ts', () => ({ liveVoicePlugin() { return {} } }))
vi.mock('../src/codex-connections.ts', () => ({ installCodexConnections() {} }))
import { apply, verifyTicket } from '../src/index.ts'

const secret = 'native-consent-test-secret-at-least-32-bytes'
const hash = 'a'.repeat(64)

function ticket(extra: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000)
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const input = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    iss: 'hivemind-control-plane', aud: 'hivemind-harness-runner', sub: 'user-1', org_id: 'org-1',
    profile: 'hivemind-chat', variation: 'harness', jti: 'once', iat: now, exp: now + 60, ...extra,
  })}`
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`
}

type Handler = (req: unknown, res: unknown) => Promise<void>
type Guard = (principal: Readonly<Record<string, string>>, endpoint: string, args: unknown, signal: AbortSignal) => Promise<unknown>

async function runner() {
  process.env.NATIVE_CONSENT_SECRET = secret
  process.env.NATIVE_CONSENT_REDIS = 'redis://localhost:6379'
  const auth = await BrowserAuth.create({}, { async modifyRecord(_key: unknown, update: (value: undefined) => unknown) {
    return update(undefined)
  } } as never, 1)
  const routes = new Map<string, Handler>()
  let guard: Guard | undefined
  const ctx = {
    plugin() {}, on() {}, emit() {}, logger: { warn() {} }, effect(action: () => unknown) { action() },
    webServer: { register(route: { path: string; handler: Handler }) { routes.set(route.path, route.handler) } },
    connection: { authorizePrincipal: auth.authorizePrincipal.bind(auth), principal: auth.principal.bind(auth),
      registerPrincipalScope() {}, registerPrincipalRpcGuard(value: Guard) { guard = value } },
    sessionPersistence: { async stat() { return {} } },
  }
  vi.stubGlobal('fetch', async (url: string, init: { headers: { authorization: string } }) => {
    state.urls.push(url)
    state.tokens.push(init.headers.authorization.slice(7))
    return new Response(JSON.stringify(state.status === 200 ? { active: true, runtime_enabled: true } : { error: 'denied' }), { status: state.status })
  })
  await apply(ctx as never, { ticketSecretEnv: 'NATIVE_CONSENT_SECRET', serviceSecretEnv: 'NATIVE_CONSENT_SECRET',
    redisUrlEnv: 'NATIVE_CONSENT_REDIS', redisJtiPrefix: 'hive:harness-ticket:', parentOrigins: ['https://chat.example.com'],
    serviceApiBase: 'https://core.example.com', serviceHttpOrigins: [], sessionMaxAgeSeconds: 3600 } as never)
  const exchange = async (value: string) => {
    state.ticket = value
    const req = Readable.from([JSON.stringify({ ticket: value, request_id: 'request-1' })])
    Object.assign(req, { method: 'POST', headers: { host: 'chat.example.com', origin: 'https://chat.example.com',
      'x-forwarded-proto': 'https', 'content-type': 'application/json' } })
    let status = 0
    let cookie = ''
    let body = ''
    const res = {
      writeHead(code: number, headers: Record<string, string>) { status = code; cookie = headers['set-cookie'] ?? '' },
      end(text: string) { body = text },
    }
    await routes.get('/api/hivemind/session/establish')!(req, res)
    return { status, cookie: cookie.split(';')[0] ?? '', body: JSON.parse(body) as Record<string, unknown> }
  }
  const boot = async (cookie: string) => {
    let status = 0
    const res = { writeHead(code: number) { status = code }, end() {} }
    await routes.get('/api/hivemind/boot')!({ method: 'GET', headers: { host: 'chat.example.com', cookie } }, res)
    return status
  }
  return { auth, guard: () => guard!, exchange, boot }
}

function decodedClaims(token: string): Record<string, unknown> {
  const [header, payload, signature] = token.split('.')
  if (header === undefined || payload === undefined || signature === undefined) throw new Error('malformed service token')
  expect(signature).toBe(createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url'))
  return JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>
}

describe('native consent binding', () => {
  it('accepts an absent or well-formed binding and rejects a malformed one', async () => {
    expect(nativeSessionBinding(undefined)).toBeUndefined()
    expect(() => nativeSessionBinding('bad')).toThrow()
    expect(() => verifyTicket(ticket({ native_session_hash: 'bad' }), secret)).toThrow(/invalid_ticket_claims/u)
    expect(verifyTicket(ticket({ native_session_hash: hash }), secret).native_session_hash).toBe(hash)
    let calls = 0
    expect(await nativePrincipalAllowed({ profile: 'hivemind-chat' }, async () => { calls++; return false })).toBe(true)
    expect(calls).toBe(0)
    expect(await nativePrincipalAllowed({ native_session_hash: hash }, async () => { throw new Error('offline') })).toBe(false)
  })

  it('reads the Control principal endpoint and fails closed on refusal', async () => {
    const fetcher = (async () => new Response(JSON.stringify({ active: true }), { status: 200 })) as typeof fetch
    expect(await principalMembershipActive('https://core.test', 'token', new AbortController().signal, fetcher)).toBe(true)
    const refused = (async () => new Response('{}', { status: 403 })) as typeof fetch
    expect(await principalMembershipActive('https://core.test', 'token', new AbortController().signal, refused)).toBe(false)
  })

  it('keeps the signed binding in the cookie and revalidates it on boot and every RPC without caching', async () => {
    state.status = 200; state.tokens = []; state.urls = []
    const { auth, guard, exchange, boot } = await runner()
    const admitted = await exchange(ticket({ native_session_hash: hash }))
    expect(admitted.status).toBe(200)
    const principal = auth.principal({ headers: { host: 'chat.example.com', cookie: admitted.cookie } })!
    expect(principal.native_session_hash).toBe(hash)
    expect(await boot(admitted.cookie)).toBe(200)
    expect(await guard()(principal, 'session/list', {}, new AbortController().signal)).toBeUndefined()
    expect(await guard()(principal, 'session/list', {}, new AbortController().signal)).toBeUndefined()
    state.status = 403
    expect(await guard()(principal, 'session/list', {}, new AbortController().signal)).toMatchObject({ code: 'auth/unauthorized' })
    expect(await boot(admitted.cookie)).toBe(403)
    expect(state.urls.every(url => url === 'https://core.example.com/internal/v1/harness-chat/core/principal')).toBe(true)
    expect(state.tokens).toHaveLength(6)
    for (const token of state.tokens) {
      expect(decodedClaims(token)).toMatchObject({ native_session_hash: hash, sub: 'user-1', org_id: 'org-1',
        iss: 'hivemind-harness-runner', aud: 'hivemind-control-plane-harness-proxy' })
    }
    vi.unstubAllGlobals()
  })

  it('refuses a native ticket whose session or consent Control no longer accepts', async () => {
    state.status = 403; state.tokens = []
    const { exchange } = await runner()
    const refused = await exchange(ticket({ native_session_hash: hash }))
    expect(refused).toMatchObject({ status: 401, cookie: '', body: { ok: false, diagnostic: 'native_session_denied' } })
    vi.unstubAllGlobals()
  })

  it('leaves web principals without a binding and without Control round trips', async () => {
    state.status = 403; state.tokens = []
    const { auth, guard, exchange, boot } = await runner()
    const admitted = await exchange(ticket({}))
    expect(admitted.status).toBe(200)
    const principal = auth.principal({ headers: { host: 'chat.example.com', cookie: admitted.cookie } })!
    expect(principal.native_session_hash).toBeUndefined()
    expect(await boot(admitted.cookie)).toBe(200)
    expect(await guard()(principal, 'session/list', {}, new AbortController().signal)).toBeUndefined()
    expect(state.tokens).toHaveLength(0)
    vi.unstubAllGlobals()
  })
})
