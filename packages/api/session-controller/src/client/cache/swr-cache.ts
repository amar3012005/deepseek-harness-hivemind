/**
 * Browser-wide stale-while-revalidate cache for Runtime room data.
 *
 * Keys are `hm:<tenant>:<user>:<kind>:<id>`. Tenant, user, and kind must not
 * contain `:`, so a tenant or user prefix never matches another account's keys.
 * The cache returns a stored value immediately and revalidates in the
 * background. Concurrent loads for one key share a single fetch. Writes and
 * sign-out clears reach other tabs through a BroadcastChannel.
 */

/** A stored value and the time it was written, in milliseconds since the epoch. */
export interface SwrEntry<T> {
  readonly value: T
  readonly storedAt: number
}

/** Persistence backend for cache entries. IndexedDB and in-memory stores implement it. */
export interface SwrStore {
  get(key: string): Promise<SwrEntry<unknown> | undefined>
  set(key: string, entry: SwrEntry<unknown>): Promise<void>
  deleteWhere(prefix: string): Promise<void>
}

/** Cross-tab message carrying a write or a clear. */
export type SwrMessage =
  | { readonly type: 'set'; readonly key: string }
  | { readonly type: 'clear'; readonly prefix: string }

/** Minimal BroadcastChannel surface used for cross-tab invalidation. */
export interface SwrChannel {
  postMessage(message: SwrMessage): void
  onmessage: ((event: { readonly data: unknown }) => void) | null
  close(): void
}

/** Result of one cached load: the stored value (if any) and the revalidated value. */
export interface SwrLoad<T> {
  /** Stored value available before revalidation, or undefined on a cold key. */
  readonly cached: T | undefined
  /** Settles with the fetched value, or rejects when the fetch fails. */
  readonly fresh: Promise<T>
}

/**
 * Build a cache key for one account's data.
 * @param tenant - tenant that owns the data; must not contain `:`.
 * @param user - user that owns the data; must not contain `:`.
 * @param kind - data kind such as `rooms`, `room` or `history`; must not contain `:`.
 * @param id - identifier within the kind; may be empty for list kinds.
 * @returns the `hm:<tenant>:<user>:<kind>:<id>` key.
 * @throws Error when a segment contains `:`.
 */
export function swrKey(tenant: string, user: string, kind: string, id: string): string {
  for (const [name, value] of [['tenant', tenant], ['user', user], ['kind', kind]] as const) {
    if (value === '' || value.includes(':')) throw new Error(`swr cache: ${name} must be non-empty and contain no ':'`)
  }
  return `hm:${tenant}:${user}:${kind}:${id}`
}

/**
 * Prefix that matches every key of one account.
 * @param tenant - tenant identifier.
 * @param user - user identifier.
 * @returns the `hm:<tenant>:<user>:` prefix.
 */
export function accountPrefix(tenant: string, user: string): string {
  return `hm:${tenant}:${user}:`
}

/** Shared in-flight loads and the backing store for one browser context. */
export class SwrCache {
  private readonly inFlight = new Map<string, Promise<unknown>>()
  private readonly memory = new Map<string, SwrEntry<unknown>>()

  constructor(
    private readonly store: SwrStore,
    private readonly channel: SwrChannel | undefined,
    private readonly now: () => number = Date.now,
  ) {
    if (channel !== undefined) {
      channel.onmessage = (event) => { this.receive(event.data) }
    }
  }

  /**
   * Load a key: return the stored value now and revalidate in the background.
   * @param key - key from {@link swrKey}.
   * @param fetcher - produces the fresh value.
   * @returns the cached value and the fresh value promise.
   */
  load<T>(key: string, fetcher: () => Promise<T>): SwrLoad<T> {
    const cached = this.memory.get(key)?.value as T | undefined
    return { cached, fresh: this.revalidate(key, fetcher) }
  }

  /**
   * Read a key from the persistent store into memory, for cold starts.
   * @param key - key from {@link swrKey}.
   * @returns the stored value, or undefined when the store has none.
   */
  async hydrate<T>(key: string): Promise<T | undefined> {
    const entry = await this.store.get(key)
    if (entry === undefined) return undefined
    this.memory.set(key, entry)
    return entry.value as T
  }

  /**
   * Store a fresh value, then notify other tabs.
   * @param key - key from {@link swrKey}.
   * @param value - value to store.
   */
  async write(key: string, value: unknown): Promise<void> {
    const entry: SwrEntry<unknown> = { value, storedAt: this.now() }
    this.memory.set(key, entry)
    await this.store.set(key, entry)
    this.channel?.postMessage({ type: 'set', key })
  }

  /**
   * Remove every entry of one account, in this tab and in the store, and tell other tabs.
   * @param tenant - tenant identifier.
   * @param user - user identifier.
   */
  async clearAccount(tenant: string, user: string): Promise<void> {
    const prefix = accountPrefix(tenant, user)
    this.dropMemory(prefix)
    await this.store.deleteWhere(prefix)
    this.channel?.postMessage({ type: 'clear', prefix })
  }

  private revalidate<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const running = this.inFlight.get(key)
    if (running !== undefined) return running as Promise<T>
    const request = fetcher()
      .then(async (value) => {
        await this.write(key, value)
        return value
      })
      .finally(() => { this.inFlight.delete(key) })
    this.inFlight.set(key, request)
    return request
  }

  private receive(data: unknown): void {
    if (typeof data !== 'object' || data === null) return
    const message = data as { type?: unknown; key?: unknown; prefix?: unknown }
    if (message.type === 'set' && typeof message.key === 'string') {
      // Another tab wrote this key; the next load reads the store, so drop the stale copy.
      this.memory.delete(message.key)
    } else if (message.type === 'clear' && typeof message.prefix === 'string') {
      this.dropMemory(message.prefix)
    }
  }

  private dropMemory(prefix: string): void {
    for (const key of this.memory.keys()) {
      if (key.startsWith(prefix)) this.memory.delete(key)
    }
  }
}

/**
 * Merge a cached history window with live durable events by `seq`.
 * Each `seq` appears once. The live entry wins for a shared `seq`, and the output is ascending by `seq`.
 * @param cached - history window from the cache.
 * @param live - events received from the stream since the cache was written.
 * @returns the merged window.
 */
export function mergeHistoryBySeq<T extends { readonly seq: number }>(
  cached: readonly T[],
  live: readonly T[],
): T[] {
  const bySeq = new Map<number, T>()
  for (const event of cached) bySeq.set(event.seq, event)
  for (const event of live) bySeq.set(event.seq, event)
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq)
}

/** In-memory store for tests and for browsers without IndexedDB. */
export class MemorySwrStore implements SwrStore {
  private readonly entries = new Map<string, SwrEntry<unknown>>()

  get(key: string): Promise<SwrEntry<unknown> | undefined> {
    return Promise.resolve(this.entries.get(key))
  }

  set(key: string, entry: SwrEntry<unknown>): Promise<void> {
    this.entries.set(key, entry)
    return Promise.resolve()
  }

  deleteWhere(prefix: string): Promise<void> {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key)
    }
    return Promise.resolve()
  }
}
