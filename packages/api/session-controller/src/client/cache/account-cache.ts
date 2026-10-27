/**
 * Page-wide account-scoped SWR cache shared by the session list and history caches.
 *
 * The signed-in account is resolved from bootstrap once per page load and
 * every cache read and write reuses that answer. A probe that fails for a
 * reason other than sign-out is retried by the next caller. An account change
 * inside one page load is not observed; signing in as another account loads a
 * new page, which resolves the account again and clears the previous
 * account's entries through {@link AccountCacheScope}.
 */
import { openSwrStore, resolveAccountScope, AccountCacheScope, type AccountScope } from './swr-account.ts'
import { SwrCache, type SwrChannel, type SwrStore } from './swr-cache.ts'

/** Account identity and the SWR cache bound to it. */
export interface AccountScopedCache {
  /** @returns the signed-in account, or undefined when signed out or the probe failed. */
  account(): Promise<AccountScope | undefined>
  /** @returns the SWR cache once its store is open. */
  cache(): Promise<SwrCache>
}

/**
 * Build the account-scoped cache over an opening store.
 * @param store - persistent store, or the promise that opens it.
 * @param channel - cross-tab invalidation channel, when the browser has one.
 * @param fetcher - fetch used for the bootstrap identity probe.
 * @returns the shared account and cache accessors.
 */
export function createAccountScopedCache(
  store: Promise<SwrStore>,
  channel: SwrChannel | undefined,
  fetcher: typeof fetch,
): AccountScopedCache {
  const ready = store.then((opened) => {
    const cache = new SwrCache(opened, channel)
    return { cache, scope: new AccountCacheScope(cache) }
  })
  let resolving: Promise<AccountScope | undefined> | undefined
  const account = (): Promise<AccountScope | undefined> => {
    if (resolving !== undefined) return resolving
    const attempt = resolveAccountScope(fetcher).then(async (resolved) => {
      const { scope } = await ready
      await scope.bind(resolved)
      return resolved
    })
    const pending: Promise<AccountScope | undefined> = attempt.catch(() => {
      // An unavailable bootstrap is not a sign-out; the next caller probes again.
      if (resolving === pending) resolving = undefined
      return undefined
    })
    resolving = pending
    return pending
  }
  return {
    account,
    cache: async () => (await ready).cache,
  }
}

/**
 * Build the browser's IndexedDB-backed account-scoped cache.
 * @param indexedDBFactory - IndexedDB factory; the cache is built only when one exists.
 * @param fetcher - fetch used for the bootstrap identity probe.
 * @returns the shared cache, or undefined when the browser has no IndexedDB.
 */
export function createBrowserAccountCache(
  indexedDBFactory: IDBFactory | undefined,
  fetcher: typeof fetch = fetch,
): AccountScopedCache | undefined {
  if (indexedDBFactory === undefined) return undefined
  const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('hm-swr-cache')
  return createAccountScopedCache(openSwrStore(indexedDBFactory), channel as SwrChannel | undefined, fetcher)
}
