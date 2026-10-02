/** Durable ownership, quota accounting and bounded tenant media admission. */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'

/** Authenticated media coordinates; never accepted from model arguments. */
export interface MediaOwner { orgId: string; userId: string; sessionId: string }
/** Deployment-owned media queue policy. */
export interface MediaAdmissionConfig {
  path: string
  globalConcurrency: number
  tenantConcurrency: number
  maxQueued: number
  dailyUserLimit: number
}
interface Waiter {
  owner: MediaOwner
  operation: string
  signal: AbortSignal
  resolve(release: () => void): void
  reject(error: Error): void
  abort(): void
}
/** One runner's queue with persistent ownership and usage receipts. */
export class MediaAdmission {
  private readonly db: DatabaseSync
  private readonly waiting: Waiter[] = []
  private readonly tenants = new Map<string, number>()
  private running = 0
  private closed = false
  private dbClosed = false
  private readonly active = new Set<string>()
  constructor(private readonly config: MediaAdmissionConfig) {
    mkdirSync(dirname(config.path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(config.path)
    chmodSync(config.path, 0o600)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS media_operations (operation TEXT PRIMARY KEY, org TEXT NOT NULL, user TEXT NOT NULL, session TEXT NOT NULL, day TEXT NOT NULL, status TEXT NOT NULL)')
  }
  /** Verify stored ownership and charge each durable operation once. */
  reserve(owner: MediaOwner, operation: string): void {
    if (this.closed) throw new Error('Media runner is stopping')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const old = this.db.prepare('SELECT org,user,session FROM media_operations WHERE operation=?').get(operation)
      if (old) {
        if (old.org !== owner.orgId || old.user !== owner.userId || old.session !== owner.sessionId) throw new Error('Media operation ownership mismatch')
      } else {
        const day = new Date().toISOString().slice(0, 10)
        const usage = this.db.prepare('SELECT count(*) AS n FROM media_operations WHERE org=? AND user=? AND day=?').get(owner.orgId, owner.userId, day)
        if (Number(usage?.n) >= this.config.dailyUserLimit) throw new Error('Media daily allowance reached; try again after the next UTC day')
        this.db.prepare('INSERT INTO media_operations VALUES (?,?,?,?,?,?)').run(operation, owner.orgId, owner.userId, owner.sessionId, day, 'queued')
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  /** Wait for bounded global and organization slots; cancellation removes queued work. */
  acquire(owner: MediaOwner, operation: string, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    if (this.closed) return Promise.reject(new Error('Media runner is stopping'))
    if (!this.status(owner, operation)) return Promise.reject(new Error('Media operation has no durable reservation'))
    if (this.active.has(operation) || this.waiting.some(w => w.operation === operation)) return Promise.reject(new Error('Media operation is already admitted'))
    if (this.waiting.length >= this.config.maxQueued) return Promise.reject(new Error('Media queue is full; try again later'))
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { owner, operation, signal, resolve, reject, abort: () => {
        const i = this.waiting.indexOf(waiter)
        if (i >= 0) this.waiting.splice(i, 1)
        reject(new Error('Queued media operation cancelled'))
      } }
      signal.addEventListener('abort', waiter.abort, { once: true })
      this.waiting.push(waiter); this.drain()
    })
  }
  private drain(): void {
    if (this.closed) return
    while (this.running < this.config.globalConcurrency) {
      const index = this.waiting.findIndex(w => (this.tenants.get(w.owner.orgId) ?? 0) < this.config.tenantConcurrency)
      if (index < 0) return
      const w = this.waiting.splice(index, 1)[0]
      if (!w) return
      w.signal.removeEventListener('abort', w.abort)
      this.active.add(w.operation)
      this.running++; this.tenants.set(w.owner.orgId, (this.tenants.get(w.owner.orgId) ?? 0) + 1)
      this.db.prepare('UPDATE media_operations SET status=? WHERE operation=?').run('running', w.operation)
      let released = false
      w.resolve(() => {
        if (released) return
        released = true; this.active.delete(w.operation); this.running--
        this.tenants.set(w.owner.orgId, (this.tenants.get(w.owner.orgId) ?? 1) - 1)
        this.drain(); this.closeDatabaseIfIdle()
      })
    }
  }
  /** Persist terminal accounting without changing operation ownership. */
  finish(operation: string, status: string): void { if (this.dbClosed) return; this.db.prepare('UPDATE media_operations SET status=? WHERE operation=?').run(status, operation) }
  /** Reject undispatched queue entries when the plugin unloads. */
  close(): void {
    this.closed = true
    for (const w of this.waiting.splice(0)) { w.signal.removeEventListener('abort', w.abort); w.reject(new Error('Media runner stopped; saved intent can be reconciled')) }
    this.closeDatabaseIfIdle()
  }
  private closeDatabaseIfIdle(): void {
    if (this.closed && this.running === 0 && !this.dbClosed) { this.dbClosed = true; this.db.close() }
  }
  /** Read durable dispatch state for safe restart reconciliation. */
  status(owner: MediaOwner, operation: string): string | undefined {
    const row = this.db.prepare('SELECT org,user,session,status FROM media_operations WHERE operation=?').get(operation)
    if (row && (row.org !== owner.orgId || row.user !== owner.userId || row.session !== owner.sessionId)) throw new Error('Media operation ownership mismatch')
    return row?.status as string | undefined
  }
}

const sharedAdmissions = new Map<string, { policy: string; queue: MediaAdmission; references: number }>()
/** Share admission across per-session preset mounts in the single production runner. */
export function acquireMediaAdmission(config: MediaAdmissionConfig): { queue: MediaAdmission; release(): void } {
  const policy = JSON.stringify(config)
  let entry = sharedAdmissions.get(config.path)
  if (entry && entry.policy !== policy) throw new Error('Media queue policy differs between session mounts')
  if (!entry) { entry = { policy, queue: new MediaAdmission(config), references: 0 }; sharedAdmissions.set(config.path, entry) }
  entry.references++
  const owned = entry
  let released = false
  return { queue: owned.queue, release: () => {
    if (released) return
    released = true
    if (--owned.references === 0) { sharedAdmissions.delete(config.path); owned.queue.close() }
  } }
}
