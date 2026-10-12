/** Bounded presentation reads; never a partial seed for Agent restoration. */
import type { Context } from '@deepseek-ai/cordis'
import {
  interruptedTurnClosers, isAppendSurfaceEvent,
} from '@deepseek-ai/dsh-session'
import type {
  SessionEvent, SessionHeader, SessionId, SessionLogOffset as Offset, SessionSeqCursor,
} from '@deepseek-ai/dsh-session'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type { SessionHandle, SessionPersistenceOpenOptions } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'

const READ_BLOCK = 256
const COLD_WINDOW_THRESHOLD = 2048

/** A presentation suffix, explicitly distinct from a complete SessionObservation. */
export interface ColdHistorySource extends Disposable {
  readonly source: 'window'
  readonly header: SessionHeader
  readonly inheritedEventCount: Offset
  readonly events: readonly SessionEvent[]
  readonly cursor: SessionSeqCursor
  readonly projections?: ProjectionSnapshot
}

/** Find the existing message group cut, or a complete recent-turn cut. */
export function historyWindowCut(
  events: readonly SessionEvent[], maxMessages: number, maxTurns?: number,
  turnWindow?: { minMessages: number; minTurns: number },
): number | undefined {
  if (turnWindow !== undefined) {
    let messages = 0
    let turns = 0
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]
      if (event === undefined) continue
      if (event.type === 'turn/start') {
        turns++
        if (messages >= turnWindow.minMessages && turns >= turnWindow.minTurns) return event.seq
      }
      if (!isAppendSurfaceEvent(event)
        || (event.type !== 'user/message' && event.type !== 'assistant/message')) continue
      messages++
      if (messages >= maxMessages) {
        let cut = event.seq as number
        for (const source of event.sourceEventSeqs ?? []) cut = Math.min(cut, source)
        return cut
      }
    }
    return undefined
  }
  let count = 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent
    if (maxTurns !== undefined) {
      if (event.type !== 'turn/start') continue
    } else if (!isAppendSurfaceEvent(event)
      || (event.type !== 'user/message' && event.type !== 'assistant/message')) continue
    count += 1
    if (count < (maxTurns ?? maxMessages)) continue
    let cut = event.seq as number
    for (const source of event.sourceEventSeqs ?? []) cut = Math.min(cut, source)
    // Human prompts may precede turn/start. Preserve the previous user prompt
    // and all intervening receipt/status events as part of this turn's group.
    if (maxTurns !== undefined) {
      let found = false
      let closedPreviousTurn = false
      for (let previous = index - 1; previous >= 0; previous -= 1) {
        const candidate = events[previous] as SessionEvent
        if (candidate.type === 'turn/end') {
          closedPreviousTurn = true
          break
        }
        if (candidate.type === 'user/message' && isAppendSurfaceEvent(candidate)) {
          cut = Math.min(cut, candidate.seq)
          found = true
        }
      }
      // Timer and inbox turns need no human prompt. A preceding turn/end
      // proves the whole opening group is present, even in a nonzero suffix.
      if (!found && !closedPreviousTurn && events[0]?.seq !== 0) return undefined
    }
    return cut
  }
  return undefined
}

/**
 * Read a fixed backwards presentation window using the native read handle.
 * Small turn windows deliver presentation before projection restoration;
 * other follow windows require a complete compatible checkpoint. Unknown
 * formats/backends retain ordinary replay.
 * Every body read uses the backend's existing principal scope and validation.
 */
export async function readColdHistorySource(
  ctx: Context, id: SessionId, signal: AbortSignal,
  options: {
    maxMessages: number
    maxTurns?: number
    turnWindow?: { minMessages: number; minTurns: number }
    beforeSeq?: number
    throughSeq?: number
    withProjections: boolean
  },
): Promise<ColdHistorySource | undefined> {
  if (ctx.sessions.get(id) !== undefined) return undefined
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) return undefined
  // A product backend may provide a presentation-only read handle. Native
  // full observation remains the fallback; never treat a slice as a seed.
  const reader = persistence as typeof persistence & {
    openHistoryRead?: (id: SessionId, options?: SessionPersistenceOpenOptions) => Promise<SessionHandle>
  }
  if (reader.openHistoryRead === undefined) return undefined
  const snapshot = await persistence.stat(id, { signal })
  if (snapshot === undefined) throw new SessionQueryError(`stored session ${id} not found`, 'SESSION_QUERY_SESSION_NOT_FOUND')
  const count = snapshot.eventCount
  const deferred = options.maxTurns !== undefined && options.maxTurns <= 5
  if (count === undefined || (!deferred && count < COLD_WINDOW_THRESHOLD)) return undefined
  await using handle = await reader.openHistoryRead(id, { signal })
  const header = handle.header
  // Direct-child lineage authorization stays in ordinary native observation.
  if (header.origin === 'subagent' || header.cwd === undefined) return undefined
  const cache = ctx.get('sessionProjectionCache')
  const requireProjections = options.withProjections && !deferred
  const floor = requireProjections ? cache?.coldReadFloor(header, handle.inheritedEventCount) : undefined
  if (requireProjections && (cache === undefined || floor === undefined || floor === 0)) return undefined
  if (options.throughSeq !== undefined && options.throughSeq >= count) return undefined
  const durableEnd = Math.min(count, options.throughSeq === undefined ? count : options.throughSeq + 1)
  const pageEnd = Math.min(durableEnd, options.beforeSeq ?? durableEnd)
  let start = pageEnd
  let pageEvents: SessionEvent[] = []
  let cut: number | undefined
  // Fixed length reads cannot include concurrent appends beyond the stat cut.
  while (start > 0) {
    signal.throwIfAborted()
    const next = Math.max(0, start - READ_BLOCK)
    const read = await handle.read(next, start - next, { signal })
    if (read.events.length !== start - next) return undefined
    pageEvents = [...read.events, ...pageEvents]
    start = next
    cut = historyWindowCut(pageEvents, options.maxMessages, options.maxTurns, options.turnWindow)
    if (cut !== undefined && cut >= start) break
  }
  // Source references are the same native grouping authority as ordinary
  // pagination. Fetch referenced prefix instead of dropping those events.
  if (cut !== undefined && cut < start) {
    const prefix = await handle.read(cut, start - cut, { signal })
    if (prefix.events.length !== start - cut) return undefined
    pageEvents = [...prefix.events, ...pageEvents]
    start = cut
  }
  if (ctx.sessions.get(id) !== undefined) return undefined
  let projections: ProjectionSnapshot | undefined
  const cursor: SessionSeqCursor = (durableEnd - 1) as SessionSeqCursor
  // A suffix cannot prove whether an open tail is actively being written.
  // Keep interrupted-turn balancing in the complete native observation.
  if (interruptedTurnClosers(pageEvents).length !== 0) return undefined
  if (requireProjections) {
    if (cache === undefined || floor === undefined || floor >= count) return undefined
    const suffix = await handle.read(floor, count - floor, { signal })
    if (suffix.events.length !== count - floor) return undefined
    try {
      projections = cache.coldSnapshotSuffix(header, handle.inheritedEventCount, suffix.events, floor)
    } catch {
      return undefined
    }
  }
  return {
    source: 'window', header, inheritedEventCount: handle.inheritedEventCount,
    events: pageEvents, cursor,
    ...(projections === undefined ? {} : { projections }),
    [Symbol.dispose]() {},
  }
}
