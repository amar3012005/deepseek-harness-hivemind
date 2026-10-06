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
): number | undefined {
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
      for (let previous = index - 1; previous >= 0; previous -= 1) {
        const candidate = events[previous] as SessionEvent
        if (candidate.type === 'turn/end') break
        if (candidate.type === 'user/message' && isAppendSurfaceEvent(candidate)) {
          cut = Math.min(cut, candidate.seq)
          found = true
        }
      }
      if (!found && events[0]?.seq !== 0) return undefined
    }
    return cut
  }
  return undefined
}

/**
 * Read a fixed backwards presentation window using the native read handle.
 * Cold follow requires a complete compatible checkpoint; older pages need
 * only header authorization. Unknown formats/backends retain ordinary replay.
 * Every body read uses the backend's existing principal scope and validation.
 */
export async function readColdHistorySource(
  ctx: Context, id: SessionId, signal: AbortSignal,
  options: { maxMessages: number; maxTurns?: number; beforeSeq?: number; throughSeq?: number; withProjections: boolean },
): Promise<ColdHistorySource | undefined> {
  if (ctx.sessions.get(id) !== undefined) return undefined
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) return undefined
  const snapshot = await persistence.stat(id, { signal })
  if (snapshot === undefined) throw new SessionQueryError(`stored session ${id} not found`, 'SESSION_QUERY_SESSION_NOT_FOUND')
  const count = snapshot.eventCount
  if (count === undefined || count < COLD_WINDOW_THRESHOLD) return undefined
  await using handle = await persistence.openHistoryRead(id, { signal })
  const header = handle.header
  // Direct-child lineage authorization stays in ordinary native observation.
  if (header.origin === 'subagent' || header.cwd === undefined) return undefined
  const cache = ctx.get('sessionProjectionCache')
  const floor = options.withProjections
    ? cache?.coldReadFloor(header, handle.inheritedEventCount) : undefined
  if (options.withProjections && (cache === undefined || floor === undefined || floor === 0)) return undefined
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
    cut = historyWindowCut(pageEvents, options.maxMessages, options.maxTurns)
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
  let cursor: SessionSeqCursor = (durableEnd - 1) as SessionSeqCursor
  if (options.withProjections) {
    if (cache === undefined) return undefined
    const projectionStart = floor as Offset
    if (projectionStart >= count) return undefined
    const suffix = await handle.read(projectionStart, count - projectionStart, { signal })
    if (suffix.events.length !== count - projectionStart) return undefined
    // The visible tail contains the final turn's start, unlike a checkpoint
    // suffix. It therefore produces exactly the native interruption closers.
    const closers = interruptedTurnClosers(pageEvents)
    // An open durable turn may still have an external writer. Keep native
    // full observation/recovery as the authority instead of advancing a
    // presentation cursor with locally invented events across that race.
    if (closers.length !== 0) return undefined
    try {
      projections = cache.coldSnapshotSuffix(header, handle.inheritedEventCount,
        [...suffix.events, ...closers], projectionStart)
    } catch {
      return undefined
    }
    pageEvents.push(...closers)
    cursor = (count + closers.length - 1) as SessionSeqCursor
  }
  return {
    source: 'window', header, inheritedEventCount: handle.inheritedEventCount,
    events: pageEvents, cursor,
    ...(projections === undefined ? {} : { projections }),
    [Symbol.dispose]() {},
  }
}
