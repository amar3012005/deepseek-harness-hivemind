import { createHash, createHmac } from 'node:crypto'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { BrowserAuth } from '../../../client/connection/src/browser-auth.ts'

const state = vi.hoisted(() => ({ ticket: '', active: true, tokens: [] as string[] }))
vi.mock('redis', () => ({ createClient: () => ({
  on() {}, async connect() {}, async quit() {},
  async getDel() { return createHash('sha256').update(state.ticket).digest('hex') },
}) }))
vi.mock('../src/media-auth.ts', () => ({ registerMediaAuth() {} }))
vi.mock('../src/live-voice.ts', () => ({ liveVoicePlugin() {} }))
vi.mock('../src/chatgpt-plan.ts', () => ({ registerBrainPlan() {} }))
vi.mock('../src/chatgpt-plan-connection.ts', () => ({ registerPlanConnection() {} }))
vi.mock('../src/runner-drain.ts', () => ({ registerRunnerDrainStatus() {} }))
import { apply } from '../src/index.ts'

describe('native admission cookie and service token', () => {
  it('retains the actual signed ticket binding through emitted cookie and subsequent RPC validation', async () => {
    const secret = 'native-cookie-test-secret-at-least-32-bytes'
    process.env.NATIVE_COOKIE_SECRET = secret
    process.env.NATIVE_COOKIE_REDIS = 'redis://localhost:6379'
    const hash = 'a'.repeat(64)
    const now = Math.floor(Date.now() / 1000)
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const input = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
      iss: 'hivemind-control-plane', aud: 'hivemind-harness-runner', sub: 'user-1', org_id: 'org-1',
      profile: 'hivemind-chat', variation: 'control', jti: 'once', iat: now, exp: now + 60,
      native_session_hash: hash,
    })}`
    state.ticket = `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`
    const auth = await BrowserAuth.create({}, { async modifyRecord(_key, update) {
      return update(undefined)
    } } as never, 1)
    type Handler = (req: unknown, res: unknown) => Promise<void>
    type Guard = (principal: unknown, endpoint: string, args: unknown, signal: AbortSignal) => Promise<unknown>
    const routes = new Map<string, Handler>()
    let guard: Guard | undefined
    const ctx = {
      plugin() {}, on() {}, emit() {}, logger: { warn() {} },
      effect(action: () => unknown) { action() },
      webServer: { register(route: { path: string; handler: Handler }) { routes.set(route.path, route.handler) } },
      connection: { authorizePrincipal: auth.authorizePrincipal.bind(auth), principal: auth.principal.bind(auth),
        registerPrincipalScope() {}, registerPrincipalRpcGuard(value: Guard) { guard = value } },
      hivemindExecutionScope: { run(_principal: unknown, action: () => unknown) { return action() } },
    }
    vi.stubGlobal('fetch', async (_url: unknown, init: { headers: { authorization: string } }) => {
      state.tokens.push(init.headers.authorization.slice(7))
      return new Response(JSON.stringify({ active: state.active }), { status: state.active ? 200 : 403 })
    })
    await apply(ctx as never, { ticketSecretEnv: 'NATIVE_COOKIE_SECRET', serviceSecretEnv: 'NATIVE_COOKIE_SECRET',
      redisUrlEnv: 'NATIVE_COOKIE_REDIS', parentOrigins: ['https://chat.example.com'],
      serviceApiBase: 'https://core.example.com', serviceHttpOrigins: [], sessionMaxAgeSeconds: 3600,
      sharedOrganizationAgents: false } as never)
    const req = Readable.from([JSON.stringify({ ticket: state.ticket, request_id: 'request-1' })])
    Object.assign(req, { method: 'POST', headers: { host: 'chat.example.com', origin: 'https://chat.example.com',
      'x-forwarded-proto': 'https', 'content-type': 'application/json' } })
    let status = 0
    let cookie = ''
    const res = { writeHead(code: number, headers: Record<string, string>) { status = code; cookie = headers['set-cookie'] ?? '' }, end() {} }
    await routes.get('/api/hivemind/embed/exchange')!(req, res)
    expect(status).toBe(200)
    const principal = auth.principal({ headers: { host: 'chat.example.com', cookie: cookie.split(';')[0] } })!
    expect(principal.native_session_hash).toBe(hash)
    expect(await guard!(principal, 'session/list', {}, new AbortController().signal)).toBeUndefined()
    state.active = false
    expect(await guard!(principal, 'session/list', {}, new AbortController().signal)).toMatchObject({ code: 'auth/unauthorized' })
    for (const token of state.tokens) {
      const [header, payload, signature] = token.split('.')
      expect(signature).toBe(createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url'))
      expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toMatchObject({ native_session_hash: hash, sub: 'user-1', org_id: 'org-1' })
    }
    expect(state.tokens.length).toBe(3)
    vi.unstubAllGlobals()
  })
})
