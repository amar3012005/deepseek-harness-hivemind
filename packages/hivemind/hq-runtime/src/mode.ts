/** Human-controlled HQ autonomy state in the existing tenant session log. */
import type { LedgerEvent } from './ledger.ts'
import type { HqModeState } from './types.ts'
export type { HqModeState } from './types.ts'

/**
 * Reconstruct the human switch without trusting model text or remembered state.
 * @param events - authoritative native session event stream.
 * @returns latest mode, or the paused revision-zero default.
 */
export function hqMode(events: readonly LedgerEvent[]): HqModeState {
  let mode: HqModeState = { revision: 0, enabled: false, changedAt: 0 }
  let seen = false
  for (const event of events) {
    if (event.type !== 'hivemind/hq-mode') continue
    if (typeof event.data !== 'object' || event.data === null) throw new Error('hq_invalid_mode_record')
    const next = event.data as Partial<HqModeState>
    // Older fresh-start rooms persisted a paused revision-zero seed.
    // Accept that seed once; never treat it as permission to enable autonomy.
    const legacySeed = !seen && next.revision === 0 && next.enabled === false
    if ((!legacySeed && next.revision !== mode.revision + 1) || typeof next.enabled !== 'boolean'
      || typeof next.changedAt !== 'number' || !Number.isSafeInteger(next.changedAt) || next.changedAt < 0) throw new Error('hq_invalid_mode_record')
    mode = next as HqModeState
    seen = true
  }
  return mode
}
