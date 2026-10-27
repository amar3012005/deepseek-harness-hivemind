/** Session list through the SWR cache: cached rows show first, the server pull replaces them, and the cache is account-scoped. */

import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { SessionManager } from '../src/client/sessions/manager.ts'
import { createSessionListCache, sessionListCache, type SessionListCacheSeam } from '../src/client/cache/session-list-cache.ts'
import { createAccountScopedCache } from '../src/client/cache/account-cache.ts'
import { MemorySwrStore } from '../src/client/cache/swr-cache.ts'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { FakeApiClient, deferred, err, fakeRemote, ok } from './fake-api.client.ts'

const S1 = 'fk-l1' as SessionId
const S2 = 'fk-l2' as SessionId
const USER = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const OTHER_ORG = '33333333-3333-4333-8333-333333333333'

function summary(sessionId: SessionId) {
  return { sessionId, updatedAt: 100, running: false, blank: false }
}

function cacheSeam(cached: readonly ReturnType<typeof summary>[] | undefined): SessionListCacheSeam & { write: ReturnType<typeof vi.fn> } {
  return {
    read: vi.fn(async () => cached as never),
    write: vi.fn(async () => {}),
  }
}

describe('SessionManager list through the SWR cache', () => {
  it('shows the cached list before the server pull resolves', async () => {
    const api = new FakeApiClient()
    const gate = deferred<Awaited<ReturnType<FakeApiClient['onList']>>>()
    api.onList = () => gate.promise
    const manager = new SessionManager(fakeRemote(api), undefined, undefined, cacheSeam([summary(S1)]))
    const pulled = manager.refreshList()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(manager.getListSnapshot().items.map(item => item.sessionId)).toEqual([S1])
    gate.resolve(ok({ items: [summary(S2)] as never[] }))
    await pulled
    expect(manager.getListSnapshot().items.map(item => item.sessionId)).toEqual([S2])
  })

  it('writes the server list back to the cache after a successful pull', async () => {
    const api = new FakeApiClient()
    api.onList = () => Promise.resolve(ok({ items: [summary(S2)] as never[] }))
    const seam = cacheSeam(undefined)
    const manager = new SessionManager(fakeRemote(api), undefined, undefined, seam)
    await manager.refreshList()
    expect(seam.write).toHaveBeenCalledWith([expect.objectContaining({ sessionId: S2 })])
  })

  it('does not write when the pull fails', async () => {
    const api = new FakeApiClient()
    api.onList = () => Promise.resolve(err(new RemoteError('gateway/internal', 'offline', {})))
    const seam = cacheSeam(undefined)
    const manager = new SessionManager(fakeRemote(api), undefined, undefined, seam)
    await manager.refreshList()
    expect(seam.write).not.toHaveBeenCalled()
  })

  it('keeps the live-only behavior when no cache is supplied', async () => {
    const api = new FakeApiClient()
    api.onList = () => Promise.resolve(ok({ items: [summary(S2)] as never[] }))
    const manager = new SessionManager(fakeRemote(api))
    await manager.refreshList()
    expect(manager.getListSnapshot().items.map(item => item.sessionId)).toEqual([S2])
  })
})

describe('createSessionListCache account scope', () => {
  it('is absent without IndexedDB', () => {
    expect(createSessionListCache(undefined)).toBeUndefined()
  })

  it('reads nothing while signed out, and never serves one account\'s list to another', async () => {
    const store = new MemorySwrStore()
    const page = (identity: { user: string; org: string } | undefined) => {
      const fetcher = (async () => {
        if (identity === undefined) return new Response('{}', { status: 401 })
        const body = { authenticated: true, user: { id: identity.user }, organization: { id: identity.org } }
        return new Response(JSON.stringify(body), { status: 200 })
      }) as typeof fetch
      return sessionListCache(createAccountScopedCache(Promise.resolve(store), undefined, fetcher))
    }
    const first = page({ user: USER, org: ORG })
    await first.write([summary(S1)] as never[])
    expect(await first.read()).toEqual([summary(S1)])
    expect(await page({ user: USER, org: OTHER_ORG }).read()).toBeUndefined()
    expect(await page(undefined).read()).toBeUndefined()
  })

  it('probes bootstrap once per page for every read and write', async () => {
    const calls: string[] = []
    const fetcher = (async (input: string) => {
      calls.push(input)
      return new Response(JSON.stringify({ authenticated: true, user: { id: USER }, organization: { id: ORG } }), { status: 200 })
    }) as unknown as typeof fetch
    const cache = sessionListCache(createAccountScopedCache(Promise.resolve(new MemorySwrStore()), undefined, fetcher))
    await Promise.all([cache.read(), cache.write([summary(S1)] as never[]), cache.read()])
    await cache.read()
    expect(calls).toEqual(['/__hivemind/bootstrap'])
  })

  it('probes again after an unavailable bootstrap', async () => {
    let status = 503
    const fetcher = (async () => new Response(JSON.stringify({ authenticated: true, user: { id: USER }, organization: { id: ORG } }),
      { status })) as typeof fetch
    const cache = sessionListCache(createAccountScopedCache(Promise.resolve(new MemorySwrStore()), undefined, fetcher))
    await cache.write([summary(S1)] as never[])
    status = 200
    await cache.write([summary(S1)] as never[])
    expect(await cache.read()).toEqual([summary(S1)])
  })

  it('starts the server pull before the local copy is read', async () => {
    const api = new FakeApiClient()
    let pulled = false
    api.onList = () => { pulled = true; return Promise.resolve(ok({ items: [] as never[] })) }
    let pulledBeforeRead: boolean | undefined
    const seam: SessionListCacheSeam = { read: async () => { pulledBeforeRead = pulled; return undefined }, write: async () => {} }
    await new SessionManager(fakeRemote(api), undefined, undefined, seam).refreshList()
    expect(pulledBeforeRead).toBe(true)
  })
})
