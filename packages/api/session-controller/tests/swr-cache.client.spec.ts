// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  MemorySwrStore, SwrCache, accountPrefix, mergeHistoryBySeq, swrKey,
  type SwrChannel, type SwrMessage,
} from '../src/client/cache/swr-cache.ts'

/** Two BroadcastChannel-like endpoints where each tab's posts reach the other tab. */
function pairedChannels(): [SwrChannel, SwrChannel] {
  const endpoint = (): SwrChannel => ({
    postMessage: () => {},
    onmessage: null,
    close: () => {},
  })
  const a = endpoint()
  const b = endpoint()
  a.postMessage = (message: SwrMessage) => { b.onmessage?.({ data: message }) }
  b.postMessage = (message: SwrMessage) => { a.onmessage?.({ data: message }) }
  return [a, b]
}

describe('swrKey', () => {
  it('builds hm:<tenant>:<user>:<kind>:<id>', () => {
    expect(swrKey('t1', 'u1', 'history', 'room-9')).toBe('hm:t1:u1:history:room-9')
  })

  it('rejects a segment that contains the separator, so keys cannot collide across accounts', () => {
    expect(() => swrKey('t1:x', 'u1', 'rooms', '')).toThrow(/no ':'/)
    expect(() => swrKey('t1', '', 'rooms', '')).toThrow(/non-empty/)
  })
})

describe('SwrCache tenant isolation', () => {
  it('never returns another tenant or user value for the same kind and id', async () => {
    const cache = new SwrCache(new MemorySwrStore(), undefined)
    await cache.write(swrKey('tenantA', 'u1', 'room', 'r1'), { owner: 'A' })
    const other = cache.load(swrKey('tenantB', 'u1', 'room', 'r1'), async () => ({ owner: 'B' }))
    expect(other.cached).toBeUndefined()
    expect(await other.fresh).toEqual({ owner: 'B' })
    const sameTenantOtherUser = cache.load(swrKey('tenantA', 'u2', 'room', 'r1'), async () => ({ owner: 'u2' }))
    expect(sameTenantOtherUser.cached).toBeUndefined()
  })

  it('clears only the signed-out account', async () => {
    const store = new MemorySwrStore()
    const cache = new SwrCache(store, undefined)
    await cache.write(swrKey('t1', 'u1', 'rooms', ''), ['u1'])
    await cache.write(swrKey('t1', 'u2', 'rooms', ''), ['u2'])
    await cache.clearAccount('t1', 'u1')
    expect(cache.load(swrKey('t1', 'u1', 'rooms', ''), async () => []).cached).toBeUndefined()
    expect(await store.get(swrKey('t1', 'u1', 'rooms', ''))).toBeUndefined()
    expect((await store.get(swrKey('t1', 'u2', 'rooms', '')))?.value).toEqual(['u2'])
    expect(accountPrefix('t1', 'u1')).toBe('hm:t1:u1:')
  })
})

describe('SwrCache stale-while-revalidate', () => {
  it('returns the stored value immediately and replaces it with the fresh value', async () => {
    const cache = new SwrCache(new MemorySwrStore(), undefined)
    const key = swrKey('t1', 'u1', 'room', 'r1')
    await cache.write(key, 'stored')
    const load = cache.load(key, async () => 'fresh')
    expect(load.cached).toBe('stored')
    expect(await load.fresh).toBe('fresh')
    expect(cache.load(key, async () => 'unused').cached).toBe('fresh')
  })

  it('shares one in-flight fetch between concurrent loads of the same key', async () => {
    const cache = new SwrCache(new MemorySwrStore(), undefined)
    const fetcher = vi.fn(async () => 'value')
    const key = swrKey('t1', 'u1', 'rooms', '')
    const first = cache.load(key, fetcher)
    const second = cache.load(key, fetcher)
    expect(await first.fresh).toBe('value')
    expect(await second.fresh).toBe('value')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('hydrates memory from the persistent store on a cold start', async () => {
    const store = new MemorySwrStore()
    const key = swrKey('t1', 'u1', 'room', 'r1')
    await new SwrCache(store, undefined).write(key, 'persisted')
    const coldTab = new SwrCache(store, undefined)
    expect(coldTab.load(key, async () => 'x').cached).toBeUndefined()
    expect(await coldTab.hydrate(key)).toBe('persisted')
    expect(coldTab.load(key, async () => 'x').cached).toBe('persisted')
  })

  it('does not cache a failed fetch', async () => {
    const cache = new SwrCache(new MemorySwrStore(), undefined)
    const key = swrKey('t1', 'u1', 'room', 'r1')
    await expect(cache.load(key, async () => { throw new Error('offline') }).fresh).rejects.toThrow('offline')
    expect(cache.load(key, async () => 'x').cached).toBeUndefined()
  })
})

describe('SwrCache cross-tab sync', () => {
  it('drops a sibling tab memory copy when another tab writes the key', async () => {
    const store = new MemorySwrStore()
    const [channelA, channelB] = pairedChannels()
    const tabA = new SwrCache(store, channelA)
    const tabB = new SwrCache(store, channelB)
    const key = swrKey('t1', 'u1', 'room', 'r1')
    await tabB.write(key, 'old')
    await tabA.hydrate(key)
    expect(tabA.load(key, async () => 'x').cached).toBe('old')
    await tabB.write(key, 'new')
    expect(tabA.load(key, async () => 'x').cached).toBeUndefined()
  })

  it('clears a sibling tab account on sign-out', async () => {
    const store = new MemorySwrStore()
    const [channelA, channelB] = pairedChannels()
    const tabA = new SwrCache(store, channelA)
    const tabB = new SwrCache(store, channelB)
    const key = swrKey('t1', 'u1', 'rooms', '')
    await tabA.write(key, ['rooms'])
    await tabB.hydrate(key)
    await tabA.clearAccount('t1', 'u1')
    expect(tabB.load(key, async () => []).cached).toBeUndefined()
  })
})

describe('mergeHistoryBySeq', () => {
  it('keeps one entry per seq, ascending, with the live entry winning', () => {
    const cached = [{ seq: 1, text: 'cached 1' }, { seq: 2, text: 'cached 2' }]
    const live = [{ seq: 2, text: 'live 2' }, { seq: 3, text: 'live 3' }, { seq: 3, text: 'live 3 again' }]
    expect(mergeHistoryBySeq(cached, live)).toEqual([
      { seq: 1, text: 'cached 1' },
      { seq: 2, text: 'live 2' },
      { seq: 3, text: 'live 3 again' },
    ])
  })

  it('returns no duplicates when a live event replays a cached seq', () => {
    const cached = [{ seq: 5 }, { seq: 6 }]
    expect(mergeHistoryBySeq(cached, [{ seq: 6 }]).map(event => event.seq)).toEqual([5, 6])
  })
})
