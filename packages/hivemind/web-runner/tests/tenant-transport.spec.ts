import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import ExecutionScope from '@deepseek-ai/dsh-hivemind-execution-scope'
import { installTenantTransport } from '../src/tenant-transport.ts'

const secret = 'a'.repeat(40)
const principal = { orgId: 'org-a', userId: 'user-a', profile: 'hivemind-chat' as const, variation: 'company', nativeSessionHash: 'a'.repeat(64) }

async function mounted(active = true, overrides: {
  membershipActive?: (signal: AbortSignal) => Promise<boolean>
  referencedSessionAuthorized?: (sessionId: string, signal: AbortSignal) => Promise<boolean>
} = {}) {
  const ctx = new Context()
  await ctx.plugin(ExecutionScope)
  let activeNow = active
  let peerAuthenticator: ((request: { headers: Headers }) => unknown) | undefined
  let rpcAdmission: ((
    request: { request: Request; endpoint: string; payload: unknown },
    next: () => Promise<{ ok: true; value: unknown }>,
  ) => Promise<unknown>) | undefined
  let gatewayAdmission: ((request: { kind: 'invoke' | 'stream' | 'event'; endpoint: string; payload: unknown; signal: AbortSignal; peer: never }, next: () => Promise<unknown>) => Promise<unknown>) | undefined
  ctx.provide('connection', {
    operator: { ctx },
    registerPeerAuthenticator(callback: typeof peerAuthenticator) { peerAuthenticator = callback; return async () => {} },
    rpc: { registerAdmission(callback: typeof rpcAdmission) { rpcAdmission = callback; return async () => {} } },
  } as never)
  ctx.provide('typertGateway', {
    registerAdmission(callback: typeof gatewayAdmission) { gatewayAdmission = callback; return async () => {} },
  } as never)
  ctx.provide('sessionPersistence', { stat: async (id: string) => {
    const owner = ctx.hivemindExecutionScope.require()
    return id === 'session-owned' && owner.orgId === 'org-a' && owner.userId === 'user-a' ? { id } : undefined
  } } as never)
  await installTenantTransport(ctx, {
    secret,
    membershipActive: async (_owner, signal) => overrides.membershipActive?.(signal) ?? activeNow,
    referencedSessionIds: (payload) => {
      const ids = new Set<string>()
      const visit = (value: unknown, depth = 0): void => {
        if (depth > 8 || value === null || typeof value !== 'object') return
        if (Array.isArray(value)) { value.forEach(item => visit(item, depth + 1)); return }
        for (const [key, item] of Object.entries(value)) {
          if (['agentId', 'sessionId', 'parentSessionId', 'childSessionId', 'workspaceFileScopeId'].includes(key) && typeof item === 'string') ids.add(item)
          else visit(item, depth + 1)
        }
      }
      visit(payload)
      return ids
    },
    referencedSessionAuthorized: async (_owner, sessionId, signal) => overrides.referencedSessionAuthorized?.(sessionId, signal) ?? sessionId === 'session-owned',
    employeeRoomAuthorized: async (_owner, employeeId) => employeeId === 'employee-active',
    resolveAgentPreset: async (requested) => {
      expect(ctx.hivemindExecutionScope.require()).toMatchObject(principal)
      return requested ?? 'hivemind-chat'
    },
  })
  return {
    ctx,
    setActive(value: boolean) { activeNow = value },
    get peerAuthenticator() { return peerAuthenticator },
    get rpcAdmission() { return rpcAdmission },
    get gatewayAdmission() { return gatewayAdmission },
  }
}

describe('native tenant transport adapter', () => {
  it('issues a host-only authority-bound cookie and rejects authority changes', async () => {
    const { ctx } = await mounted()
    const transport = ctx.get('hivemindTenantTransport')!
    const setCookie = transport.issueCookie(principal, 'hive.example.test')
    expect(setCookie).toContain('__Host-hive-tenant=')
    expect(setCookie).toContain('Path=/;')
    expect(setCookie).toContain('HttpOnly; Secure; SameSite=Strict')
    const cookie = setCookie.split(';', 1)[0]!
    expect(transport.principal({ headers: { host: 'hive.example.test', cookie } })).toMatchObject(principal)
    expect(transport.principal({ headers: { host: 'attacker.example.test', cookie } })).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('selects a tenant peer and scopes the decoded dispatch after membership/session checks', async () => {
    const { ctx, peerAuthenticator, rpcAdmission } = await mounted()
    const cookie = ctx.get('hivemindTenantTransport')!.issueCookie(principal, 'hive.example.test').split(';', 1)[0]!
    const headers = new Headers({ host: 'hive.example.test', cookie })
    expect(peerAuthenticator?.({ headers })).toBeDefined()
    const result = await rpcAdmission!({
      request: new Request('https://hive.example.test/api/agents/run', { headers }),
      endpoint: 'agents/run',
      payload: 'session-ref',
    }, async () => {
      expect(ctx.hivemindExecutionScope.require()).toMatchObject(principal)
      return { ok: true, value: 'dispatched' }
    })
    expect(result).toEqual({ ok: true, value: 'dispatched' })
    expect(() => ctx.hivemindExecutionScope.require()).toThrow('scope is unavailable')
    await ctx.fiber.dispose()
  })

  it('keeps tenant peers stable per identity and distinct across organizations', async () => {
    const { ctx, peerAuthenticator } = await mounted()
    const transport = ctx.get('hivemindTenantTransport')!
    const cookieA = transport.issueCookie(principal, 'hive.example.test').split(';', 1)[0]!
    const cookieB = transport.issueCookie({ ...principal, orgId: 'org-b' }, 'hive.example.test').split(';', 1)[0]!
    const peer = (cookie: string) => peerAuthenticator!({ headers: new Headers({ host: 'hive.example.test', cookie }) })
    expect(peer(cookieA)).toBe(peer(cookieA))
    expect(peer(cookieA)).not.toBe(peer(cookieB))
    await ctx.fiber.dispose()
  })

  it('fails closed for inactive membership and refuses invalid product cookies without fallback', async () => {
    const { ctx, peerAuthenticator, rpcAdmission } = await mounted(false)
    const cookie = ctx.get('hivemindTenantTransport')!.issueCookie(principal, 'hive.example.test').split(';', 1)[0]!
    const headers = new Headers({ host: 'hive.example.test', cookie })
    const invalid = new Headers({ host: 'hive.example.test', cookie: `${cookie}x` })
    expect(() => peerAuthenticator?.({ headers: invalid })).toThrow('tenant authentication is invalid')
    const result = await rpcAdmission!({ request: new Request('https://hive.example.test/api/test', { headers }), endpoint: 'test/run', payload: null }, async () => ({ ok: true, value: true }))
    expect(result).toMatchObject({ ok: false, error: { code: 'auth/unauthorized' } })
    await ctx.fiber.dispose()
  })

  it('rejects a foreign session before opening a tenant Remote stream', async () => {
    const { ctx, peerAuthenticator, gatewayAdmission } = await mounted()
    const cookie = ctx.hivemindTenantTransport.issueCookie(principal, 'hive.example.test').split(';', 1)[0]!
    const peer = peerAuthenticator!({ headers: new Headers({ host: 'hive.example.test', cookie }) }) as never
    const next = async () => (async function* () { yield 'sensitive' })()
    await expect(gatewayAdmission!({ kind: 'stream', endpoint: 'feed/follow', payload: { args: { agentId: 'session-foreign' } }, signal: new AbortController().signal, peer }, next))
      .rejects.toThrow('tenant Remote authorization is no longer active')
    await ctx.fiber.dispose()
  })

  it('revalidates access for each stream item and tears down the Peer after revocation', async () => {
    const fixture = await mounted()
    const { ctx, peerAuthenticator, gatewayAdmission } = fixture
    const cookie = ctx.hivemindTenantTransport.issueCookie(principal, 'hive.example.test').split(';', 1)[0]!
    const peer = peerAuthenticator!({ headers: new Headers({ host: 'hive.example.test', cookie }) }) as never
    let returned = false
    const result = await gatewayAdmission!({ kind: 'stream', endpoint: 'feed/follow', payload: { args: { agentId: 'session-owned' } }, signal: new AbortController().signal, peer }, async () => ({
      async *[Symbol.asyncIterator]() { try { yield 'first'; yield 'second' } finally { returned = true } },
    })) as AsyncIterable<string>
    const iterator = result[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ value: 'first', done: false })
    fixture.setActive(false)
    await expect(iterator.next()).rejects.toThrow('tenant Remote authorization was revoked')
    expect(returned).toBe(true)
    await ctx.fiber.dispose()
  })

  it('cancels a pending stream authorization without revoking its tenant Peer', async () => {
    let checks = 0
    let resolvePending!: (active: boolean) => void
    const pending = new Promise<boolean>((resolve) => { resolvePending = resolve })
    const fixture = await mounted(true, {
      referencedSessionAuthorized: async () => ++checks === 1 ? true : pending,
    })
    const { ctx, peerAuthenticator, gatewayAdmission } = fixture
    const cookie = ctx.hivemindTenantTransport.issueCookie(principal, 'hive.example.test').split(';', 1)[0]!
    const headers = new Headers({ host: 'hive.example.test', cookie })
    const peer = peerAuthenticator!({ headers })
    const controller = new AbortController()
    const result = await gatewayAdmission!({ kind: 'stream', endpoint: 'feed/follow', payload: { args: { agentId: 'session-owned' } }, signal: controller.signal, peer: peer as never }, async () => ({
      async *[Symbol.asyncIterator]() { yield 'first' },
    })) as AsyncIterable<string>
    const iterator = result[Symbol.asyncIterator]()
    const next = iterator.next()
    await vi.waitFor(() => expect(checks).toBe(2))
    controller.abort()
    resolvePending(false)
    await expect(next).resolves.toMatchObject({ done: true })
    expect(peerAuthenticator!({ headers })).toBe(peer)
    await ctx.fiber.dispose()
  })

  it('cancels a pending source.next result without revoking its tenant Peer', async () => {
    const fixture = await mounted()
    const { ctx, peerAuthenticator, gatewayAdmission } = fixture
    const cookie = ctx.hivemindTenantTransport.issueCookie(principal, 'hive.example.test').split(';', 1)[0]!
    const headers = new Headers({ host: 'hive.example.test', cookie })
    const peer = peerAuthenticator!({ headers })
    const controller = new AbortController()
    let resolveNext!: (item: IteratorResult<string>) => void
    const result = await gatewayAdmission!({ kind: 'stream', endpoint: 'feed/updates', payload: { args: {} }, signal: controller.signal, peer: peer as never }, async () => ({
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<string>>((resolve) => { resolveNext = resolve }),
          return: vi.fn(async () => ({ done: true as const, value: undefined })),
        }
      },
    })) as AsyncIterable<string>
    const next = result[Symbol.asyncIterator]().next()
    await vi.waitFor(() => expect(resolveNext).toBeTypeOf('function'))
    controller.abort()
    resolveNext({ done: false, value: 'late item' })
    await expect(next).resolves.toMatchObject({ done: true })
    expect(peerAuthenticator!({ headers })).toBe(peer)
    await ctx.fiber.dispose()
  })

  it('polls an idle stream and revokes its Peer after membership is removed', async () => {
    vi.useFakeTimers()
    try {
      const fixture = await mounted()
      const { ctx, peerAuthenticator, gatewayAdmission } = fixture
      const cookie = ctx.hivemindTenantTransport.issueCookie(principal, 'hive.example.test').split(';', 1)[0]!
      const peer = peerAuthenticator!({ headers: new Headers({ host: 'hive.example.test', cookie }) }) as never
      const result = await gatewayAdmission!({ kind: 'stream', endpoint: 'feed/updates', payload: { args: {} }, signal: new AbortController().signal, peer },
        async () => ({ async *[Symbol.asyncIterator]() { yield 'unused' } })) as AsyncIterable<string>
      const iterator = result[Symbol.asyncIterator]()
      fixture.setActive(false)
      await vi.advanceTimersByTimeAsync(15_000)
      await expect(iterator.next()).rejects.toThrow('tenant Remote authorization was revoked')
      await ctx.fiber.dispose()
    } finally { vi.useRealTimers() }
  })

  it('suppresses Remote events whose payload references a foreign session', async () => {
    const { ctx, peerAuthenticator, gatewayAdmission } = await mounted()
    const cookie = ctx.hivemindTenantTransport.issueCookie(principal, 'hive.example.test').split(';', 1)[0]!
    const headers = new Headers({ host: 'hive.example.test', cookie })
    const peer = peerAuthenticator!({ headers }) as never
    const next = vi.fn(async () => true)
    await expect(gatewayAdmission!({ kind: 'event', endpoint: 'session/event', payload: { agentId: 'session-foreign' }, signal: new AbortController().signal, peer }, next)).resolves.toBe(false)
    await expect(gatewayAdmission!({ kind: 'event', endpoint: 'organization/changed', payload: { args: [{ changed: true }] }, signal: new AbortController().signal, peer }, next)).resolves.toBe(false)
    await expect(gatewayAdmission!({ kind: 'event', endpoint: 'session/event', payload: { args: [{ agentId: 'session-owned' }] }, signal: new AbortController().signal, peer }, next)).resolves.toBe(true)
    expect(next).toHaveBeenCalledOnce()
    expect(peerAuthenticator!({ headers })).toBe(peer)
    await ctx.fiber.dispose()
  })

  it('still revokes a tenant Peer when membership becomes inactive during a broadcast event', async () => {
    const fixture = await mounted()
    const { ctx, peerAuthenticator, gatewayAdmission } = fixture
    const cookie = ctx.hivemindTenantTransport.issueCookie(principal, 'hive.example.test').split(';', 1)[0]!
    const headers = new Headers({ host: 'hive.example.test', cookie })
    const peer = peerAuthenticator!({ headers }) as never
    const dispose = vi.spyOn(peer as { dispose: () => Promise<void> }, 'dispose')
    fixture.setActive(false)
    await expect(gatewayAdmission!({ kind: 'event', endpoint: 'organization/changed', payload: { args: [] }, signal: new AbortController().signal, peer }, async () => true)).resolves.toBe(false)
    expect(dispose).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('denies non-HIVE preset creation and selection before native dispatch', async () => {
    const { ctx, rpcAdmission } = await mounted()
    const cookie = ctx.hivemindTenantTransport.issueCookie(principal, 'hive.example.test').split(';', 1)[0]!
    const request = new Request('https://hive.example.test/api/session/create', { headers: new Headers({ host: 'hive.example.test', cookie }) })
    const next = async () => ({ ok: true as const, value: 'should-not-run' })
    for (const [endpoint, payload] of [
      ['session/create', { args: { agentPreset: 'code' } }],
      ['agentPresets/select', { args: { agentId: 'session-owned', agentPreset: 'minimal' } }],
    ] as const) {
      await expect(rpcAdmission!({ request, endpoint, payload }, next)).resolves.toMatchObject({
        ok: false, error: { code: 'auth/forbidden' },
      })
    }
    await ctx.fiber.dispose()
  })

  it('checks native named request envelopes without dropping preset or employee identity', async () => {
    const { ctx, rpcAdmission } = await mounted()
    const cookie = ctx.hivemindTenantTransport.issueCookie(principal, 'hive.example.test').split(';', 1)[0]!
    const request = new Request('https://hive.example.test/api/session/create', { headers: new Headers({ host: 'hive.example.test', cookie }) })
    const next = vi.fn(async () => ({ ok: true as const, value: 'dispatched' }))
    await expect(rpcAdmission!({ request, endpoint: 'session/create', payload: { args: { request: { agentPreset: 'minimal' } } } }, next)).resolves.toMatchObject({ ok: false, error: { code: 'auth/forbidden' } })
    expect(next).not.toHaveBeenCalled()
    await expect(rpcAdmission!({ request, endpoint: 'session/create', payload: { args: { request: { agentPreset: 'hivemind-hq' } } } }, next)).resolves.toMatchObject({ ok: true })
    await expect(rpcAdmission!({ request, endpoint: 'session/employeeRoom', payload: { args: { request: { employeeId: 'employee-active' } } } }, next)).resolves.toMatchObject({ ok: true })
    await ctx.fiber.dispose()
  })

  it('validates named employee requests on the Remote gateway as well as HTTP', async () => {
    const { ctx, peerAuthenticator, gatewayAdmission } = await mounted()
    const cookie = ctx.hivemindTenantTransport.issueCookie(principal, 'hive.example.test').split(';', 1)[0]!
    const peer = peerAuthenticator!({ headers: new Headers({ host: 'hive.example.test', cookie }) }) as never
    const next = vi.fn(async () => 'authorized-room')
    const invoke = (employeeId: string) => gatewayAdmission!({ kind: 'invoke', endpoint: 'session/employeeRoom', payload: { args: { request: { employeeId } } }, signal: new AbortController().signal, peer }, next)
    await expect(invoke('foreign-employee')).rejects.toThrow('tenant employee room authorization was denied')
    expect(next).not.toHaveBeenCalled()
    await expect(invoke('employee-active')).resolves.toBe('authorized-room')
    expect(next).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('denies an employee room outside the freshly authorized tenant directory', async () => {
    const { ctx, rpcAdmission } = await mounted()
    const cookie = ctx.hivemindTenantTransport.issueCookie(principal, 'hive.example.test').split(';', 1)[0]!
    const request = new Request('https://hive.example.test/api/session/employeeRoom', {
      headers: new Headers({ host: 'hive.example.test', cookie }),
    })
    await expect(rpcAdmission!({ request, endpoint: 'session/employeeRoom', payload: { args: { employeeId: 'foreign-employee' } } },
      async () => ({ ok: true as const, value: 'should-not-run' }))).resolves.toMatchObject({
      ok: false, error: { code: 'auth/forbidden' },
    })
    await ctx.fiber.dispose()
  })
})
