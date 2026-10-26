/**
 * Account identity for the SWR cache, and the persistent store choice.
 *
 * The identity comes from the authoritative bootstrap response: the user id is
 * the account user and the organization id is the tenant. An account change or
 * sign-out clears the previous account's cache entries.
 */
import { SwrCache, MemorySwrStore, type SwrEntry, type SwrStore } from './swr-cache.ts'

/** Tenant and user that own a cache partition. */
export interface AccountScope {
  readonly tenant: string
  readonly user: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/**
 * Resolve the signed-in account from `/v1/bootstrap`.
 * @param fetcher - fetch implementation with session cookies.
 * @returns the account scope, or undefined when the session is signed out.
 * @throws Error when the bootstrap request fails for a reason other than sign-out.
 */
export async function resolveAccountScope(fetcher: typeof fetch = fetch): Promise<AccountScope | undefined> {
  const response = await fetcher('/v1/bootstrap', { credentials: 'include', cache: 'no-store', headers: { accept: 'application/json' } })
  if (response.status === 401 || response.status === 403) return undefined
  if (!response.ok) throw new Error(`account bootstrap unavailable (${response.status})`)
  const body = await response.json() as { authenticated?: unknown; user?: { id?: unknown }; organization?: { id?: unknown } }
  if (body.authenticated === false) return undefined
  const user = body.user?.id
  const tenant = body.organization?.id
  if (typeof user !== 'string' || typeof tenant !== 'string' || !UUID.test(user) || !UUID.test(tenant)) return undefined
  return { tenant, user }
}

/**
 * Open the IndexedDB-backed SWR store, or fall back to memory.
 * The fallback covers a missing factory and any synchronous or asynchronous open failure.
 * @param factory - IndexedDB factory, or undefined when the browser has none.
 * @returns the persistent store when it opens, otherwise a memory store.
 */
export async function openSwrStore(factory: IDBFactory | undefined): Promise<SwrStore> {
  if (factory === undefined) return new MemorySwrStore()
  try {
    return await openIndexedDbStore(factory)
  } catch {
    // The browser refused IndexedDB (private mode, quota, blocked storage); the memory store keeps the cache working for this tab.
    return new MemorySwrStore()
  }
}

/**
 * Store entries in one IndexedDB object store, keyed by cache key.
 * @param factory - IndexedDB factory.
 * @returns the store once the database is open.
 */
function openIndexedDbStore(factory: IDBFactory): Promise<SwrStore> {
  return new Promise<SwrStore>((resolve, reject) => {
    const request = factory.open('hm-swr-cache', 1)
    request.onupgradeneeded = () => { request.result.createObjectStore('entries') }
    request.onerror = () => { reject(request.error ?? new Error('indexedDB open failed')) }
    request.onsuccess = () => { resolve(new IndexedDbSwrStore(request.result)) }
  })
}

/** SwrStore over a single IndexedDB object store. */
class IndexedDbSwrStore implements SwrStore {
  constructor(private readonly db: IDBDatabase) {}

  get(key: string): Promise<SwrEntry<unknown> | undefined> {
    return this.run<SwrEntry<unknown> | undefined>('readonly', store => store.get(key))
  }

  async set(key: string, entry: SwrEntry<unknown>): Promise<void> {
    await this.run('readwrite', store => store.put(entry, key))
  }

  async deleteWhere(prefix: string): Promise<void> {
    const keys = await this.run<IDBValidKey[]>('readonly', store => store.getAllKeys())
    const doomed = keys.filter((key): key is string => typeof key === 'string' && key.startsWith(prefix))
    if (doomed.length === 0) return
    await this.run('readwrite', (store) => {
      for (const key of doomed) store.delete(key)
      return store.transaction
    })
  }

  private run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T> | IDBTransaction): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const transaction = this.db.transaction('entries', mode)
      const store = transaction.objectStore('entries')
      const result = action(store)
      transaction.onerror = () => { reject(transaction.error ?? new Error('indexedDB transaction failed')) }
      if ('onsuccess' in result) {
        result.onsuccess = () => { resolve(result.result) }
      } else {
        transaction.oncomplete = () => { resolve(undefined as T) }
      }
    })
  }
}

/**
 * Keep the cache bound to the signed-in account. The previous account's entries are cleared when the account changes or signs out.
 */
export class AccountCacheScope {
  private current: AccountScope | undefined

  constructor(private readonly cache: SwrCache) {}

  /**
   * Bind the cache to the account resolved from bootstrap.
   * @param next - resolved account, or undefined when signed out.
   */
  async bind(next: AccountScope | undefined): Promise<void> {
    const previous = this.current
    this.current = next
    if (previous === undefined) return
    if (next !== undefined && next.tenant === previous.tenant && next.user === previous.user) return
    await this.cache.clearAccount(previous.tenant, previous.user)
  }
}
