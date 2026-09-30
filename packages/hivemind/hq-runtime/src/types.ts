/** Browser-safe human HQ control contracts. */
export interface HqModeState {
  readonly revision: number
  readonly enabled: boolean
  readonly changedAt: number
}
/** Compare-and-set human switch input. */
export interface HqModeUpdate { readonly enabled: boolean; readonly expectedRevision: number }
/** A stale tab cannot overwrite another human action. */
export type HqModeUpdateResult = { readonly ok: true; readonly value: HqModeState }
  | { readonly ok: false; readonly code: 'hq-mode-conflict'; readonly current: HqModeState }
