/** Session history through the local copy: the cached tail draws first, the server page replaces it, and stored tails stay bounded. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { Session } from '../src/client/sessions/session.ts'
import {
  cacheableTail, sessionHistoryCache, type CachedHistoryPage, type SessionHistoryCacheSeam,
} from '../src/client/cache/session-history-cache.ts'
import { createAccountScopedCache } from '../src/client/cache/account-cache.ts'
import { MemorySwrStore } from '../src/client/cache/swr-cache.ts'
import { FakeApiClient, deferred, fakeRemote, ok } from './fake-api.client.ts'
import { historyValue, plainTurn } from './event-script.client.ts'

const SID = 'fk-h1' as SessionId
const USER = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'

afterEach(() => { vi.useRealTimers() })

function durable(events: SessionEvent[]): CachedHistoryPage['entries'] {
  return events.map(event => ({ type: 'event' as const, event }))
}

function seam(page: CachedHistoryPage | undefined): SessionHistoryCacheSeam & { write: ReturnType<typeof vi.fn> } {
  return { read: vi.fn(async () => page), write: vi.fn(async () => {}) }
}

function seqs(session: Session): number[] {
  return session.eventSource.getSnapshot().entries.map(entry => entry.event.seq)
}

describe('Session open with a local history copy', () => {
  it('draws the cached tail while the server page is pending, then the server page replaces it', async () => {
    const api = new FakeApiClient()
    const gate = deferred<ReturnType<typeof ok<ReturnType<typeof historyValue>>>>()
    api.onHistory = () => gate.promise as never
    const cached = { entries: durable(plainTurn(SessionSeq(10), 1, 'old question', 'old answer')), hasMore: true }
    const session = new Session(SID, fakeRemote(api), { historyCache: seam(cached) })
    const opening = session.open()
    await vi.waitFor(() => { expect(seqs(session)).toEqual([10, 11, 12, 13, 14, 15]) })
    expect(session.getSnapshot().openState).toBe('loading')
    gate.resolve(ok(historyValue(plainTurn(SessionSeq(20), 1, 'new question', 'new answer'), false)))
    await opening
    expect(session.getSnapshot().openState).toBe('open')
    expect(seqs(session)).toEqual([20, 21, 22, 23, 24, 25])
    expect(session.getSnapshot().hasMore).toBe(false)
  })

  it('ignores a cached tail that arrives after the server page', async () => {
    const api = new FakeApiClient()
    api.onHistory = () => Promise.resolve(ok(historyValue(plainTurn(SessionSeq(20), 1, 'q', 'a'), false)))
    const late = deferred<CachedHistoryPage | undefined>()
    const session = new Session(SID, fakeRemote(api), { historyCache: { read: () => late.promise, write: async () => {} } })
    await session.open()
    late.resolve({ entries: durable(plainTurn(SessionSeq(1), 1, 'stale', 'stale')), hasMore: false })
    await late.promise
    await Promise.resolve()
    expect(seqs(session)).toEqual([20, 21, 22, 23, 24, 25])
  })

  it('stores the settled server window once after a quiet period', async () => {
    vi.useFakeTimers()
    const api = new FakeApiClient()
    api.onHistory = () => Promise.resolve(ok(historyValue(plainTurn(SessionSeq(5), 1, 'q', 'a'), true)))
    const cache = seam(undefined)
    const session = new Session(SID, fakeRemote(api), { historyCache: cache })
    await session.open()
    expect(cache.write).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(cache.write).toHaveBeenCalledWith(SID, expect.objectContaining({ hasMore: true }))
    expect((cache.write.mock.calls[0]?.[1] as CachedHistoryPage).entries.map(entry => entry.event.seq)).toEqual([5, 6, 7, 8, 9, 10])
    cache.write.mockClear()
    await session.dispose()
    expect(cache.write).not.toHaveBeenCalled()
  })
})

describe('cacheableTail', () => {
  it('drops transient rows and starts a cut tail at a turn start', () => {
    const events = [...plainTurn(SessionSeq(1), 1, 'a', 'b'), ...plainTurn(SessionSeq(7), 2, 'c', 'd')]
    const transient = { type: 'transient' as const, event: { type: 'assistant/live-chunk', seq: 9, time: 0, data: {} } as never }
    const page = cacheableTail([...durable(events), transient], false, { maxEntries: 8, maxChars: 1_000_000 })
    expect(page?.entries.map(entry => entry.event.seq)).toEqual([7, 8, 9, 10, 11, 12])
    expect(page?.hasMore).toBe(true)
  })

  it('returns nothing for a window without durable rows', () => {
    expect(cacheableTail([], false)).toBeUndefined()
  })
})

describe('sessionHistoryCache', () => {
  const fetcher = (async () => new Response(JSON.stringify({ authenticated: true, user: { id: USER }, organization: { id: ORG } }),
    { status: 200 })) as typeof fetch

  it('reads a written tail back for the same account from a new page', async () => {
    const store = new MemorySwrStore()
    const page = { entries: durable(plainTurn(SessionSeq(1), 1, 'q', 'a')), hasMore: false }
    await sessionHistoryCache(createAccountScopedCache(Promise.resolve(store), undefined, fetcher)).write(SID, page)
    const reopened = sessionHistoryCache(createAccountScopedCache(Promise.resolve(store), undefined, fetcher))
    expect(await reopened.read(SID)).toEqual(page)
  })

  it('keeps at most sixty stored tails, removing the least recently written', async () => {
    const store = new MemorySwrStore()
    const cache = sessionHistoryCache(createAccountScopedCache(Promise.resolve(store), undefined, fetcher))
    const page = { entries: durable(plainTurn(SessionSeq(1), 1, 'q', 'a')), hasMore: false }
    for (let index = 0; index < 61; index += 1) await cache.write(`fk-${String(index)}` as SessionId, page)
    const reopened = sessionHistoryCache(createAccountScopedCache(Promise.resolve(store), undefined, fetcher))
    expect(await reopened.read('fk-0' as SessionId)).toBeUndefined()
    expect(await reopened.read('fk-60' as SessionId)).toEqual(page)
  })
})
