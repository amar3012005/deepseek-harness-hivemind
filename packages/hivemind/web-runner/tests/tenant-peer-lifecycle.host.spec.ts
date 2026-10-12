import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import ExecutionScope from '@deepseek-ai/dsh-hivemind-execution-scope'
import { OperatorPeer } from '@deepseek-ai/dsh-client-connection'
import { installTenantTransport } from '../src/tenant-transport.ts'

const principal = {
  orgId: 'org-a', userId: 'user-a', profile: 'hivemind-chat' as const,
  variation: 'company', nativeSessionHash: 'a'.repeat(64),
}

describe('mounted tenant Peer lifetime', () => {
  it('keeps the authenticated Peer alive across unary RPC and binds its cleanup to the Connection owner', async () => {
    const ctx = new Context()
    await ctx.plugin(ExecutionScope)
    const operator = new OperatorPeer(ctx)
    let authenticate: ((request: { headers: Headers }) => unknown) | undefined
    let admitRpc: ((
      request: { request: Request; endpoint: string; payload: unknown },
      next: () => Promise<{ ok: true; value: unknown }>,
    ) => Promise<unknown>) | undefined

    ctx.provide('connection', {
      operator,
      registerPeerAuthenticator(callback: typeof authenticate) { authenticate = callback; return async () => {} },
      rpc: { registerAdmission(callback: typeof admitRpc) { admitRpc = callback; return async () => {} } },
    } as never)
    ctx.provide('typertGateway', { registerAdmission: () => async () => {} } as never)
    ctx.provide('sessionPersistence', { stat: async () => undefined } as never)

    await installTenantTransport(ctx, {
      secret: 'a'.repeat(40),
      membershipActive: async () => true,
      referencedSessionIds: () => new Set(),
      referencedSessionAuthorized: async () => true,
      employeeRoomAuthorized: async () => true,
      resolveAgentPreset: async requested => requested ?? 'hivemind-chat',
    })

    const transport = ctx.get('hivemindTenantTransport')!
    const cookie = transport.issueCookie(principal, 'hive.example.test').split(';', 1)[0]!
    const request = { headers: new Headers({ host: 'hive.example.test', cookie }) }
    const tenantPeer = authenticate!(request) as OperatorPeer
    const cleanup: string[] = []
    tenantPeer.ctx.effect(() => () => { cleanup.push('tenant') }, 'test: tenant Peer lifetime')

    await expect(admitRpc!({
      request: new Request('https://hive.example.test/api/session/list', { headers: request.headers }),
      endpoint: 'session/list',
      payload: { args: {} },
    }, async () => ({ ok: true, value: 'listed' }))).resolves.toEqual({ ok: true, value: 'listed' })

    expect(authenticate!(request)).toBe(tenantPeer)
    expect(cleanup).toEqual([])

    await operator.dispose()
    expect(cleanup).toEqual(['tenant'])
    await ctx.fiber.dispose()
  })
})
