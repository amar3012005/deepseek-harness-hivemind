import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { fallbackEligible, installRequestFallback } from '../src/request-recovery.ts'
it('excludes policy, authorization, quota, cancellation and unknown effects', () => {
  for (const code of ['POLICY', 'AUTH', 'QUOTA', 'CANCELLED', 'TOOL_OUTCOME_UNKNOWN', 'UNKNOWN']) expect(fallbackEligible({ code, message: '' })).toBe(false)
  expect(fallbackEligible({ code: 'SERVER', message: 'policy rejection' })).toBe(false)
  expect(fallbackEligible({ code: 'SERVER', message: '', status: 403 })).toBe(false)
  expect(fallbackEligible({ code: 'TRANSPORT', message: '' })).toBe(true)
})
it('uses one explicit route in the same native turn and persists before retry', async () => {
  const hooks = new Map<string, (...args: unknown[]) => unknown>()
  const events: { type: string; data: unknown }[] = []
  const flush = vi.fn(async () => true)
  const ctx = {
    effect: (f: () => unknown) => f(),
    on: (name: string, f: (...args: unknown[]) => unknown) => { hooks.set(name, f); return () => {} },
    llm: { listModels: async () => [{ id: 'configured' }] }, sessions: { flush } } as unknown as Context
  installRequestFallback(ctx, { provider: 'configured-provider', model: 'configured' })
  const agent = { session: { ownEvents: () => events, append: (type: string, data: unknown) => events.push({ type, data }) } }
  const payload = { agent, turn: 2, step: 3, signal: new AbortController().signal, failure: { code: 'TRANSPORT', message: '' } }
  const next = vi.fn(async () => undefined)
  expect(await hooks.get('agent/request-error')!(payload, next)).toEqual({ kind: 'retry' })
  expect(flush).toHaveBeenCalledTimes(1)
  expect(await hooks.get('agent/request')!({ agent }, async () => ({ provider: 'original', model: 'original' }))).toMatchObject({ provider: 'configured-provider', model: 'configured' })
  expect(await hooks.get('agent/request-error')!(payload, next)).toBeUndefined()
  expect(next).toHaveBeenCalledTimes(1)
  expect(events).toHaveLength(1)
  expect(await hooks.get('agent/request')!({ agent }, async () => ({ provider: 'original', model: 'original' }))).toEqual({ provider: 'original', model: 'original' })
})

it('keeps disabled, unavailable and cancelled recovery on native terminal paths', async () => {
  const hooks = new Map<string, (...args: unknown[]) => unknown>()
  const events: { type: string; data: unknown }[] = []
  const controller = new AbortController()
  const ctx = {
    effect: (f: () => unknown) => f(),
    on: (name: string, f: (...args: unknown[]) => unknown) => { hooks.set(name, f); return () => {} },
    llm: { listModels: async () => [] }, sessions: { flush: vi.fn(async () => true) } } as unknown as Context
  installRequestFallback(ctx, undefined)
  expect(hooks.size).toBe(0)
  installRequestFallback(ctx, { provider: 'configured-provider', model: 'configured' })
  const agent = { session: { ownEvents: () => events, append: vi.fn() } }
  const payload = { agent, turn: 1, step: 1, signal: controller.signal, failure: { code: 'TRANSPORT', message: '' } }
  const next = vi.fn(async () => undefined)
  await hooks.get('agent/request-error')!(payload, next)
  expect(next).toHaveBeenCalledTimes(1)
  controller.abort()
  await hooks.get('agent/request-error')!(payload, next)
  expect(next).toHaveBeenCalledTimes(1)
  expect(agent.session.append).not.toHaveBeenCalled()
})
