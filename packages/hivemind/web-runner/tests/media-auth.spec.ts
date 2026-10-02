import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import ExecutionScope from '@deepseek-ai/dsh-hivemind-execution-scope'
import { registerMediaAuth } from '../src/media-auth.ts'

describe('server-derived media ownership', () => {
  it('uses the authenticated principal and rejects inaccessible sessions and missing scope', async () => {
    const ctx = new Context()
    await ctx.plugin(ExecutionScope)
    const principal = { orgId: 'org-a', userId: 'user-a', profile: 'hivemind-chat' as const, variation: 'company' }
    ctx.provide('sessionPersistence', { stat: async (session: string) => {
      const p = ctx.hivemindExecutionScope.require()
      return session === 'owned-session' && p.orgId === principal.orgId && p.userId === principal.userId ? { id: session } : undefined
    } } as never)
    registerMediaAuth(ctx)
    try {
      await expect(ctx.serial('hivemind/media-owner', { sessionId: 'owned-session' })).rejects.toThrow('scope is unavailable')
      await expect(ctx.hivemindExecutionScope.run(principal, () => ctx.serial('hivemind/media-owner', { sessionId: 'owned-session' }))).resolves.toEqual({ orgId: 'org-a', userId: 'user-a', sessionId: 'owned-session' })
      for (const p of [{ ...principal, orgId: 'org-b' }, { ...principal, userId: 'user-b' }]) {
        await expect(ctx.hivemindExecutionScope.run(p, () => ctx.serial('hivemind/media-owner', { sessionId: 'owned-session' }))).rejects.toThrow('unavailable')
      }
      await expect(ctx.hivemindExecutionScope.run(principal, () => ctx.serial('hivemind/media-owner', { sessionId: 'foreign-session' }))).rejects.toThrow('unavailable')
    } finally { await ctx.fiber.dispose() }
  })
})
