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
