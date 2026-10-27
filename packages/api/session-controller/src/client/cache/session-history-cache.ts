/**
 * Session history cache: the last durable history page of each Session, keyed
 * by account and Session id, so a reopened room draws from the local copy
 * before the server tail page arrives. The server page always replaces the
 * cached window; the cache never answers a page request on its own.
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionEventLikeEntry, SessionLiveEventEntry } from '../contract/events.ts'
import type { AccountScopedCache } from './account-cache.ts'
import { swrKey } from './swr-cache.ts'

/** One cached durable history tail. */
export interface CachedHistoryPage {
  /** Durable entries in ascending `seq` order. */
  readonly entries: readonly SessionLiveEventEntry[]
  /** Whether older history exists before the first entry. */
  readonly hasMore: boolean
}

/** Cache seam a Session reads on open and writes after its window changes. */
export interface SessionHistoryCacheSeam {
  /**
   * @param sessionId - Session whose tail page to read.
   * @returns the cached tail for the signed-in account, or undefined when none is available.
   */
  read(sessionId: SessionId): Promise<CachedHistoryPage | undefined>
  /**
   * @param sessionId - Session whose window changed.
   * @param page - durable tail selected by {@link cacheableTail}.
   */
  write(sessionId: SessionId, page: CachedHistoryPage): Promise<void>
}

/** Bounds on one cached history tail. */
export interface HistoryCacheLimits {
  /** Maximum durable entries kept per Session. */
  readonly maxEntries: number
  /** Maximum serialized UTF-16 length of the kept entries. */
  readonly maxChars: number
}

/** Default bounds: roughly one visible page of turns, without large tool outputs filling storage. */
export const HISTORY_CACHE_LIMITS: HistoryCacheLimits = { maxEntries: 400, maxChars: 750_000 }

/** Recently read or written tails kept in memory for this page. */
const MEMORY_SESSIONS = 24
/** Sessions whose tails stay in persistent storage per account; the least recently written are removed. */
const STORED_SESSIONS = 60

/**
 * Select the durable tail of a window for caching. Transient live chunks are
 * dropped. When the bounds cut the window, the kept tail starts at a turn
 * start so the cached page never opens mid-turn, and `hasMore` becomes true.
 * @param entries - current window in ascending `seq` order.
 * @param hasMore - whether the window has older history.
 * @param limits - entry and size bounds.
 * @returns the cacheable tail, or undefined when no durable entry fits.
 */
export function cacheableTail(
  entries: readonly SessionEventLikeEntry[],
  hasMore: boolean,
  limits: HistoryCacheLimits = HISTORY_CACHE_LIMITS,
): CachedHistoryPage | undefined {
  const durable = entries.filter((entry): entry is SessionLiveEventEntry => entry.type === 'event')
  let start = Math.max(0, durable.length - limits.maxEntries)
  let chars = 0
  for (let index = durable.length - 1; index >= start; index -= 1) {
    chars += JSON.stringify(durable[index]).length
    if (chars > limits.maxChars) { start = index + 1; break }
  }
  if (start > 0) {
    const turn = durable.findIndex((entry, index) => index >= start && entry.event.type === 'turn/start')
    start = turn === -1 ? start : turn
  }
  const kept = durable.slice(start)
  if (kept.length === 0) return undefined
  return { entries: kept, hasMore: hasMore || start > 0 }
}

/**
 * Build the history cache over a shared account-scoped cache.
 * @param shared - page-wide account-scoped cache.
 * @returns the history cache.
 */
export function sessionHistoryCache(shared: AccountScopedCache): SessionHistoryCacheSeam {
  const memory = new Map<SessionId, CachedHistoryPage>()
  let writes: Promise<void> = Promise.resolve()
  const remember = (sessionId: SessionId, page: CachedHistoryPage): void => {
    memory.delete(sessionId)
    memory.set(sessionId, page)
    for (const oldest of memory.keys()) {
      if (memory.size <= MEMORY_SESSIONS) break
      memory.delete(oldest)
    }
  }
  return {
    async read(sessionId) {
      const account = await shared.account()
      if (account === undefined) return undefined
      const held = memory.get(sessionId)
      if (held !== undefined) return held
      const cache = await shared.cache()
      const stored = await cache.hydrate<CachedHistoryPage>(swrKey(account.tenant, account.user, 'history', sessionId))
      if (stored === undefined || !Array.isArray(stored.entries)) return undefined
      remember(sessionId, stored)
      return stored
    },
    write(sessionId, page) {
      // Writes are serialized so the stored recency index is never written from two stale reads.
      const run = writes.then(async () => {
        const account = await shared.account()
        if (account === undefined) return
        remember(sessionId, page)
        const cache = await shared.cache()
        await cache.write(swrKey(account.tenant, account.user, 'history', sessionId), page)
        const indexKey = swrKey(account.tenant, account.user, 'history-index', '')
        const stored = await cache.hydrate<readonly SessionId[]>(indexKey)
        const recent = [sessionId, ...(Array.isArray(stored) ? stored : []).filter(id => id !== sessionId)]
        for (const evicted of recent.slice(STORED_SESSIONS)) {
          memory.delete(evicted)
          await cache.remove(swrKey(account.tenant, account.user, 'history', evicted))
        }
        await cache.write(indexKey, recent.slice(0, STORED_SESSIONS))
      })
      writes = run.catch(() => {
        // A refused write (quota, blocked storage) leaves the previous copy; the server page stays authoritative.
      })
      return run
    },
  }
}
