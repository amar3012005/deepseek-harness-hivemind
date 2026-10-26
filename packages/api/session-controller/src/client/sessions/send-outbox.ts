/**
 * Send outbox: messages typed before the Session subscription is ready.
 *
 * Each message receives one `rpcId` at enqueue time. Retries reuse that id, and
 * a message leaves the outbox only when the responder acknowledges its id. A
 * reconnect therefore resends an unacknowledged message with the same id, and
 * never sends an acknowledged message again.
 */

/** One queued message. `rpcId` is minted once and reused by every retry. */
export interface OutboxEntry<T> {
  readonly rpcId: string
  readonly payload: T
}

/** Send one entry on the wire. Resolves when the entry is handed to the transport. */
export type OutboxSend<T> = (entry: OutboxEntry<T>) => Promise<void>

interface QueuedEntry<T> {
  readonly rpcId: string
  readonly payload: T
  /** Connection generation that last handed this entry to the transport. */
  sentIn: number | undefined
}

/**
 * Exactly-once outbox keyed by `rpcId`.
 *
 * An entry is handed to the transport at most once per connection generation.
 * A new generation, which a reconnect starts through {@link SendOutbox.beginConnection},
 * resends every unacknowledged entry with its original `rpcId`. The responder deduplicates
 * by `rpcId`, so a resend cannot create a second message.
 * @typeParam T - payload type sent for each message.
 */
export class SendOutbox<T> {
  private readonly entries: QueuedEntry<T>[] = []
  private readonly listeners = new Set<() => void>()
  private generation = 0
  private flushing = false

  /**
   * @param mint - returns a new `rpcId`; called once per enqueued message.
   */
  constructor(private readonly mint: () => string) {}

  /**
   * Queue a message. The caller's `rpcId` is used when given, so an optimistic echo
   * already keyed by it keeps one identity; otherwise a new id is minted.
   * @param payload - message payload.
   * @param rpcId - identity minted by the caller, if one exists.
   * @returns the queued entry, including its `rpcId`.
   */
  enqueue(payload: T, rpcId?: string): OutboxEntry<T> {
    const entry: QueuedEntry<T> = { rpcId: rpcId ?? this.mint(), payload, sentIn: undefined }
    this.entries.push(entry)
    this.notify()
    return { rpcId: entry.rpcId, payload: entry.payload }
  }

  /**
   * Start a connection generation. Entries not yet acknowledged become eligible for the next flush.
   */
  beginConnection(): void {
    this.generation += 1
  }

  /**
   * Snapshot of unacknowledged messages, in enqueue order.
   * @returns the queued entries.
   */
  snapshot(): readonly OutboxEntry<T>[] {
    return this.entries.map(entry => ({ rpcId: entry.rpcId, payload: entry.payload }))
  }

  /**
   * Subscribe to queue changes, for the optimistic bubbles.
   * @param listener - called after enqueue and acknowledgement.
   * @returns disposer removing the listener.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Record the responder's acknowledgement. The entry leaves the outbox and is never sent again.
   * @param rpcId - id echoed by the responder.
   * @returns true when an unacknowledged entry matched.
   */
  acknowledge(rpcId: string): boolean {
    const index = this.entries.findIndex(entry => entry.rpcId === rpcId)
    if (index === -1) return false
    this.entries.splice(index, 1)
    this.notify()
    return true
  }

  /**
   * Hand each entry not yet sent in the current generation to the transport, in enqueue order.
   * A failed send clears that entry's mark, so the next flush retries it with the same `rpcId`.
   * Overlapping flushes return at once.
   * @param send - transport send for one entry.
   */
  async flush(send: OutboxSend<T>): Promise<void> {
    if (this.flushing) return
    this.flushing = true
    try {
      for (const entry of [...this.entries]) {
        if (entry.sentIn === this.generation) continue
        if (!this.entries.includes(entry)) continue
        entry.sentIn = this.generation
        try {
          await send({ rpcId: entry.rpcId, payload: entry.payload })
        } catch {
          entry.sentIn = undefined
          return
        }
      }
    } finally {
      this.flushing = false
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
