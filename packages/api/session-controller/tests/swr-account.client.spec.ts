// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { AccountCacheScope, openSwrStore, resolveAccountScope } from '../src/client/cache/swr-account.ts'
import { MemorySwrStore, SwrCache, swrKey } from '../src/client/cache/swr-cache.ts'

const USER = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const OTHER_ORG = '33333333-3333-4333-8333-333333333333'

function bootstrap(body: unknown, status = 200): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('resolveAccountScope', () => {
  it('maps the organization to the tenant and the user id to the user', async () => {
    const scope = await resolveAccountScope(bootstrap({ authenticated: true, user: { id: USER }, organization: { id: ORG } }))
    expect(scope).toEqual({ tenant: ORG, user: USER })
  })

  it('returns undefined when the session is signed out', async () => {
    expect(await resolveAccountScope(bootstrap({}, 401))).toBeUndefined()
    expect(await resolveAccountScope(bootstrap({ authenticated: false }))).toBeUndefined()
  })

  it('reads the Worker JSON route first and skips an HTML app-shell reply for /v1/bootstrap', async () => {
    const calls: string[] = []
    const fetcher = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return String(input) === '/v1/bootstrap'
        ? new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } })
        : new Response(JSON.stringify({ authenticated: true, user: { id: USER }, organization: { id: ORG } }),
          { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    expect(await resolveAccountScope(fetcher)).toEqual({ tenant: ORG, user: USER })
    expect(calls).toEqual(['/__hivemind/bootstrap'])
    const htmlOnly = (async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch
    expect(await resolveAccountScope(htmlOnly)).toBeUndefined()
  })

  it('rejects non-UUID identities instead of keying the cache by them', async () => {
    expect(await resolveAccountScope(bootstrap({ user: { id: 'not-a-uuid' }, organization: { id: ORG } }))).toBeUndefined()
  })

  it('throws on a bootstrap failure other than sign-out, so the previous account is not cleared', async () => {
    await expect(resolveAccountScope(bootstrap({}, 503))).rejects.toThrow(/503/)
  })
})

describe('openSwrStore fallback', () => {
  it('uses memory when there is no IndexedDB factory', async () => {
    expect(await openSwrStore(undefined)).toBeInstanceOf(MemorySwrStore)
  })

  it('uses memory when opening the database throws synchronously', async () => {
    const throwing = { open: () => { throw new Error('blocked') } } as unknown as IDBFactory
    expect(await openSwrStore(throwing)).toBeInstanceOf(MemorySwrStore)
  })

  it('uses memory when the open request fails asynchronously', async () => {
    const failing = {
      open: () => {
        const request: { onerror?: () => void; error: null } = { error: null }
        queueMicrotask(() => request.onerror?.())
        return request
      },
    } as unknown as IDBFactory
    expect(await openSwrStore(failing)).toBeInstanceOf(MemorySwrStore)
  })
})

describe('AccountCacheScope', () => {
  it('clears the previous account when the account changes', async () => {
    const store = new MemorySwrStore()
    const cache = new SwrCache(store, undefined)
    const scope = new AccountCacheScope(cache)
    await scope.bind({ tenant: ORG, user: USER })
    await cache.write(swrKey(ORG, USER, 'rooms', ''), ['old account'])
    await scope.bind({ tenant: OTHER_ORG, user: USER })
    expect(await store.get(swrKey(ORG, USER, 'rooms', ''))).toBeUndefined()
  })

  it('clears the account on sign-out', async () => {
    const store = new MemorySwrStore()
    const cache = new SwrCache(store, undefined)
    const scope = new AccountCacheScope(cache)
    await scope.bind({ tenant: ORG, user: USER })
    await cache.write(swrKey(ORG, USER, 'rooms', ''), ['signed in'])
    await scope.bind(undefined)
    expect(await store.get(swrKey(ORG, USER, 'rooms', ''))).toBeUndefined()
  })

  it('keeps the cache when the same account rebinds', async () => {
    const store = new MemorySwrStore()
    const cache = new SwrCache(store, undefined)
    const clear = vi.spyOn(cache, 'clearAccount')
    const scope = new AccountCacheScope(cache)
    await scope.bind({ tenant: ORG, user: USER })
    await scope.bind({ tenant: ORG, user: USER })
    expect(clear).not.toHaveBeenCalled()
  })
})

describe('page-wide account probe', () => {
  it('sends one bootstrap request for every browser cache of the page, and retries after a failure', async () => {
    const { createBrowserAccountCache, forgetPageAccountProbe } = await import('../src/client/cache/account-cache.ts')
    forgetPageAccountProbe()
    const body = { authenticated: true, user: { id: USER }, organization: { id: ORG } }
    const json = { status: 200, headers: { 'content-type': 'application/json' } }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), json))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const factory = { open: () => { throw new Error('no indexedDB') } } as unknown as IDBFactory
      const first = createBrowserAccountCache(factory)!, second = createBrowserAccountCache(factory)!
      expect(await Promise.all([first.account(), second.account(), first.account()])).toEqual(Array(3).fill({ tenant: ORG, user: USER }))
      expect(fetchMock).toHaveBeenCalledTimes(1)

      forgetPageAccountProbe()
      fetchMock.mockRejectedValueOnce(new Error('offline'))
      const third = createBrowserAccountCache(factory)!
      expect(await third.account()).toBeUndefined()
      expect(await third.account()).toEqual({ tenant: ORG, user: USER })
    } finally {
      forgetPageAccountProbe()
      vi.unstubAllGlobals()
    }
  })
})
