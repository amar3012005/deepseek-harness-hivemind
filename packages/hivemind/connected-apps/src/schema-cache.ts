/**
 * Authoritative provider schema cache keyed by tenant, user, toolkit, tool slug and schema version.
 *
 * Entries expire after `ttlMs` and are dropped wholesale for a tenant when a connection changes,
 * because a connection change can alter which tools the provider exposes or authorizes.
 */
export class SchemaCache<T> {
  private readonly entries = new Map<string, { value: T; version: string; storedAt: number }>()

  /**
   * @param ttlMs - maximum entry age in milliseconds; entries older than this are misses.
   * @param now - clock in milliseconds, injectable for tests.
   */
  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Return a fresh cached value for the exact tool, or undefined on miss, expiry or version mismatch.
   * @param tenant - `orgId:userId` identity of the authenticated caller.
   * @param slug - exact provider tool slug.
   * @param version - provider schema hash the caller requires; omitted accepts any stored version.
   * @returns the cached value, or undefined.
   */
  get(tenant: string, slug: string, version?: string): T | undefined {
    const key = cacheKey(tenant, slug)
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    if (this.now() - entry.storedAt >= this.ttlMs) {
      this.entries.delete(key)
      return undefined
    }
    if (version !== undefined && entry.version !== version) return undefined
    return entry.value
  }

  /**
   * Store an authoritative schema and evict entries that have already expired.
   * @param tenant - `orgId:userId` identity of the authenticated caller.
   * @param slug - exact provider tool slug.
   * @param version - provider schema hash identifying the contract revision.
   * @param value - the authoritative contract.
   */
  set(tenant: string, slug: string, version: string, value: T): void {
    if (this.ttlMs <= 0) return
    const now = this.now()
    for (const [key, entry] of this.entries) {
      if (now - entry.storedAt >= this.ttlMs) this.entries.delete(key)
    }
    this.entries.set(cacheKey(tenant, slug), { value, version, storedAt: now })
  }

  /**
   * Drop every cached schema for one tenant, used after any connection state change.
   * @param tenant - `orgId:userId` identity whose connections changed.
   */
  invalidateTenant(tenant: string): void {
    const prefix = `${tenant}\u0000`
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key)
    }
  }
}

/**
 * Tenant-scoped key for one provider tool. The toolkit is the slug prefix before the
 * first underscore, lowercased, so the key carries the tool's toolkit without a second lookup.
 * @param tenant - `orgId:userId` identity.
 * @param slug - exact provider tool slug.
 * @returns the composite map key.
 */
function cacheKey(tenant: string, slug: string): string {
  const toolkit = (slug.split('_')[0] ?? slug).toLowerCase()
  return `${tenant}\u0000${toolkit}\u0000${slug}`
}
