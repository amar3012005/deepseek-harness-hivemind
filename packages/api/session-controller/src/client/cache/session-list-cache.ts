/**
 * Session list cache: the tenant- and user-keyed SWR entry for the session list.
 *
 * The list is read only after the account is resolved from bootstrap, so a
 * signed-out browser or an unknown identity never reads or writes the cache.
 */
import type { SessionSummary } from '../../types.ts'
import { openSwrStore, resolveAccountScope, AccountCacheScope } from './swr-account.ts'
import { SwrCache, swrKey, type SwrChannel, type SwrMessage } from './swr-cache.ts'

/** Cache seam the manager reads and writes. */
export interface SessionListCacheSeam {
  /** @returns the cached list for the signed-in account, or undefined when none is available. */
  read(): Promise<readonly SessionSummary[] | undefined>
  /** @param items - list returned by the server for the signed-in account. */
  write(items: readonly SessionSummary[]): Promise<void>
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
  if (indexedDBFactory === undefined) return undefined
  const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('hm-swr-cache')
  const ready = openSwrStore(indexedDBFactory).then((store) => {
    const cache = new SwrCache(store, channel as SwrChannel | undefined)
    return { cache, scope: new AccountCacheScope(cache) }
  })
  return {
    async read() {
      const account = await resolveAccountScope(fetcher).catch(() => undefined)
      const { cache, scope } = await ready
      await scope.bind(account)
      if (account === undefined) return undefined
      const value = await cache.hydrate<readonly SessionSummary[]>(swrKey(account.tenant, account.user, 'sessions', 'list'))
      return value
    },
    async write(items) {
      const account = await resolveAccountScope(fetcher).catch(() => undefined)
      if (account === undefined) return
      const { cache } = await ready
      await cache.write(swrKey(account.tenant, account.user, 'sessions', 'list'), items)
    },
  }
}

export type { SwrMessage }
