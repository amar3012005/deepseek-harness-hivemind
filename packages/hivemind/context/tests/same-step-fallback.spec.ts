import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { registerSameStepFallback } from '../src/same-step-fallback.ts'

it('records the native retry route and restores it only for the failed step after cold projection', async () => {
  const hooks = new Map<string, (...args: never[]) => unknown>()
  const events: { type: string; data: unknown }[] = []
  const flush = vi.fn(async () => true)
  let projection: { apply(state: unknown, event: { type: string; data: unknown }): unknown; init(): unknown } | undefined
  const ctx = {
    sessionProjections: {
      register(value: typeof projection & { key?: string; stateVersion?: number; stateSchema?: unknown }) {
        projection = value as NonNullable<typeof projection>
      },
      stateOf: vi.fn((_session: unknown, key: string) => {
        expect(key).toBe('llmStepFallback')
        return events.reduce((state, event) => projection!.apply(state, event), projection!.init())
      }),
    },
    sessions: { flush },
    on(name: string, hook: (...args: never[]) => unknown) { hooks.set(name, hook); return () => {} },
  } as unknown as Context

  registerSameStepFallback(ctx, [{ fromProvider: 'primary-provider', provider: 'recovery-provider', model: 'recovery-model', maxTokens: 300 }])
  const session = {
    requestHeader: () => ({ config: { provider: 'primary-provider', model: 'primary-model', maxTokens: 500 } }),
    append: (type: string, data: unknown) => { events.push({ type, data }) },
  }
  const agent = { session }
  const beforeFailure = { completedToolCalls: 1, approvalCommits: 1 }
  const failedRequest = {
    agent, turn: 4, step: 2, provider: 'primary-provider',
    failure: { code: 'TIMEOUT', message: 'timed out' }, signal: new AbortController().signal,
  }
  const pass = vi.fn(async () => undefined)

  expect(await hooks.get('agent/request-error')!(failedRequest as never, pass as never)).toEqual({ kind: 'retry' })
  expect(flush).toHaveBeenCalledWith(session)
  expect(events).toEqual([{
    type: 'llm/fallback',
    data: {
      turn: 4,
      step: 2,
      primary: { provider: 'primary-provider', model: 'primary-model', maxTokens: 500 },
      fallback: { provider: 'recovery-provider', model: 'recovery-model', maxTokens: 300 },
      failureCode: 'TIMEOUT',
    },
  }])

  // Re-register from the durable event, as a restored host does after restart.
  hooks.clear()
  registerSameStepFallback(ctx, undefined)
  const retry = await hooks.get('agent/request')!({ agent, turn: 4, step: 2 } as never, async () => ({
    provider: 'primary-provider', model: 'primary-model', maxTokens: 500,
  }) as never) as { provider: string; model: string; maxTokens?: number }
  expect(retry).toMatchObject({ provider: 'recovery-provider', model: 'recovery-model', maxTokens: 300 })

  const nextStep = await hooks.get('agent/request')!({ agent, turn: 4, step: 3 } as never, async () => ({
    provider: 'recovery-provider', model: 'recovery-model', maxTokens: 300,
  }) as never) as { provider: string; model: string; maxTokens?: number }
  expect(nextStep).toMatchObject({ provider: 'primary-provider', model: 'primary-model', maxTokens: 500 })
  expect(beforeFailure).toEqual({ completedToolCalls: 1, approvalCommits: 1 })
  expect([...hooks.keys()]).toEqual(['agent/request'])
})

it('does not record recovery for an unrelated provider, unsupported failure or duplicate failed step', async () => {
  const hooks = new Map<string, (...args: never[]) => unknown>()
  const events: { type: string; data: unknown }[] = []
  const state = { turn: 1, step: 1 }
  const ctx = {
    sessionProjections: {
      register() {},
      stateOf: () => events.length ? state : null,
    },
    on(name: string, hook: (...args: never[]) => unknown) { hooks.set(name, hook); return () => {} },
  } as unknown as Context
  registerSameStepFallback(ctx, { fromProvider: 'primary-provider', provider: 'recovery-provider', model: 'recovery-model' })
  const session = {
    requestHeader: () => ({ config: { provider: 'primary-provider', model: 'primary-model' } }),
    append: (type: string, data: unknown) => events.push({ type, data }),
  }
  const agent = { session }
  const next = vi.fn(async () => undefined)
  const requestError = hooks.get('agent/request-error')!

  await requestError({ agent, turn: 1, step: 1, provider: 'other', failure: { code: 'TIMEOUT', message: '' }, signal: new AbortController().signal } as never, next as never)
  await requestError({ agent, turn: 1, step: 1, provider: 'primary-provider', failure: { code: 'AUTH', message: '' }, signal: new AbortController().signal } as never, next as never)
  expect(events).toHaveLength(0)
  expect(next).toHaveBeenCalledTimes(2)
})

it('does not request a native retry when the fallback checkpoint cannot be flushed', async () => {
  const hooks = new Map<string, (...args: never[]) => unknown>()
  const append = vi.fn()
  const ctx = {
    sessionProjections: { register() {}, stateOf: () => null },
    sessions: { flush: async () => false },
    on(name: string, hook: (...args: never[]) => unknown) { hooks.set(name, hook); return () => {} },
  } as unknown as Context
  registerSameStepFallback(ctx, { fromProvider: 'primary-provider', provider: 'recovery-provider', model: 'recovery-model' })
  const agent = { session: {
    requestHeader: () => ({ config: { provider: 'primary-provider', model: 'primary-model' } }),
    append,
  } }
  await expect(hooks.get('agent/request-error')!({
    agent, turn: 1, step: 1, provider: 'primary-provider',
    failure: { code: 'TIMEOUT', message: '' }, signal: new AbortController().signal,
  } as never, async () => undefined as never)).rejects.toThrow('llm_fallback_persistence_required')
  expect(append).toHaveBeenCalledOnce()
})
