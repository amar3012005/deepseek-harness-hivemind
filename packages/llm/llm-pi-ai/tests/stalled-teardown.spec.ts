import { expect, it, vi } from 'vitest'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'

const observed = vi.hoisted(() => ({ signal: undefined as AbortSignal | undefined }))
vi.mock('@earendil-works/pi-ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-ai')>()
  return { ...actual, createModels: (...args: Parameters<typeof actual.createModels>) => {
    const models = actual.createModels(...args)
    return new Proxy(models, { get(target, property) {
      if (property === 'streamSimple') return (_model: unknown, _context: unknown, options: { signal: AbortSignal }) => {
        observed.signal = options.signal
        return { [Symbol.asyncIterator]() { return this },
          next: () => new Promise<IteratorResult<never>>(() => {}),
          return: () => Promise.resolve({ done: true, value: undefined }),
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  } }
})

it('settles native idle timeout even when the SDK ignores abort and generator teardown queues behind its read', async () => {
  const adapter = new PiAiAdapter({ profiles: () => resolveProfiles({ deepseek: { streamIdleTimeoutMs: 20 } }),
    resolveApiKey: async () => 'fixture-key', auth: memoryAuth() })
  const iterator = adapter.stream({ provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })[Symbol.asyncIterator]()
  const outcome = await Promise.race([
    iterator.next().then(() => 'unexpected-success', (error: { code?: string }) => error.code),
    new Promise(resolve => setTimeout(() => resolve('stuck-teardown'), 200)),
  ])
  expect(outcome).toBe('TIMEOUT')
  expect(observed.signal?.aborted).toBe(true)
})

it('preserves explicit caller cancellation when the SDK also ignores that signal', async () => {
  const adapter = new PiAiAdapter({ profiles: () => resolveProfiles({ deepseek: { streamIdleTimeoutMs: 20 } }),
    resolveApiKey: async () => 'fixture-key', auth: memoryAuth() })
  const caller = new AbortController()
  const iterator = adapter.stream({ provider: 'deepseek', model: 'deepseek-v4-flash', messages: [], signal: caller.signal })[Symbol.asyncIterator]()
  const outcome = iterator.next().then(() => 'unexpected-success', (error: { code?: string }) => error.code)
  caller.abort('owner stopped')
  await expect(outcome).resolves.toBe('ABORTED')
})
