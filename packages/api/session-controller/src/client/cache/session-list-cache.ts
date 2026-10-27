/**
 * Session list cache: the tenant- and user-keyed SWR entry for the session list.
 *
 * The list is read only after the account is resolved from bootstrap, so a
 * signed-out browser or an unknown identity never reads or writes the cache.
 */
import type { SessionSummary } from '../../types.ts'
import { createBrowserAccountCache, type AccountScopedCache } from './account-cache.ts'
import { swrKey, type SwrMessage } from './swr-cache.ts'

/** Cache seam the manager reads and writes. */
export interface SessionListCacheSeam {
  /** @returns the cached list for the signed-in account, or undefined when none is available. */
  read(): Promise<readonly SessionSummary[] | undefined>
  /** @param items - list returned by the server for the signed-in account. */
  write(items: readonly SessionSummary[]): Promise<void>
}

/**
 * Build the session list cache over a shared account-scoped cache.
 * @param shared - page-wide account-scoped cache.
 * @returns the list cache.
 */
export function sessionListCache(shared: AccountScopedCache): SessionListCacheSeam {
  return {
    async read() {
      const account = await shared.account()
      if (account === undefined) return undefined
      const cache = await shared.cache()
      return cache.hydrate<readonly SessionSummary[]>(swrKey(account.tenant, account.user, 'sessions', 'list'))
    },
    async write(items) {
      const account = await shared.account()
      if (account === undefined) return
      const cache = await shared.cache()
      await cache.write(swrKey(account.tenant, account.user, 'sessions', 'list'), items)
    },
  }
}

/**
 * Build the IndexedDB-backed session list cache for this browser.
 * @param indexedDBFactory - IndexedDB factory; the cache is built only when one exists.
 * @param fetcher - fetch used for the bootstrap identity probe.
 * @returns the list cache, or undefined when the browser has no IndexedDB.
 */
export function createSessionListCache(
  indexedDBFactory: IDBFactory | undefined,
  fetcher: typeof fetch = fetch,
): SessionListCacheSeam | undefined {
  const shared = createBrowserAccountCache(indexedDBFactory, fetcher)
  return shared === undefined ? undefined : sessionListCache(shared)
}

export type { SwrMessage }
