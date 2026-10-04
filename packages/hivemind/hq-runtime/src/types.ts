/** Browser-safe human HQ control contracts. */
export interface HqModeState {
  readonly revision: number
  readonly enabled: boolean
  readonly changedAt: number
}
/** Compare-and-set human switch input. */
export interface HqModeUpdate { readonly enabled: boolean; readonly expectedRevision: number; readonly clientTimeZone?: string }
/** A stale tab cannot overwrite another human action. */
export type HqModeUpdateResult = { readonly ok: true; readonly value: HqModeState }
  | { readonly ok: false; readonly code: 'hq-mode-conflict'; readonly current: HqModeState }

/** Authorized projection of native tasks and Schedule; no independent lifecycle. */
export interface HqWorkspaceTask {
  readonly id: string
  readonly revision: number
  readonly title: string
  readonly objective: string
  readonly status: string
  readonly owner: string
  readonly sessionId?: string | undefined
  readonly dependencies: readonly string[]
  readonly authority: readonly string[]
  readonly dueAt?: string | undefined
  readonly acceptanceCriteria: readonly string[]
  readonly artifactIds: readonly string[]
  readonly reviewStatus?: string | undefined
  readonly startedAt?: string | undefined
  readonly completedAt?: string | undefined
  readonly nextWakeAt?: string | undefined
}
export interface HqWorkspaceWake {
  readonly id: string
  readonly title: string
  readonly kind: string
  readonly scheduledAt: string
  readonly status: string
  readonly deliveredAt?: string | undefined
  readonly messageId?: string | undefined
  readonly taskId?: string | undefined
}
export interface HqWorkspace {
  readonly mode: HqModeState
  readonly tasks: readonly HqWorkspaceTask[]
  readonly wakes: readonly HqWorkspaceWake[]
  readonly calendar: readonly HqCalendarItem[]
}

/** Planning metadata; native Team tasks retain execution ownership. */
export interface HqCalendarItem {
  readonly id: string
  readonly revision: number
  readonly kind: 'meeting' | 'decision' | 'source_request' | 'assignment'
  readonly title: string
  readonly owner: string
  readonly startsAt: string
  readonly endsAt: string
  readonly taskId?: string | undefined
  readonly resolved: boolean
}
export interface HqCalendarUpdate {
  readonly expectedRevision: number
  readonly item: HqCalendarItem
}
export type HqCalendarUpdateResult = { readonly ok: true; readonly value: HqCalendarItem }
  | { readonly ok: false; readonly code: 'hq-calendar-conflict'; readonly current: HqCalendarItem | null }

export interface HqWakeHistory {
  readonly id: string
  readonly records: readonly { readonly scheduledAt: string; readonly deliveredAt: string; readonly messageId: string }[]
  readonly earlierRecordsUnavailable: boolean
}
/** Native employee plan, loaded only for an authorized selected assignment. */
export interface HqTaskProgress {
  readonly taskId: string
  readonly sessionId: string | null
  readonly todos: readonly { readonly content: string; readonly status: string }[]
}

/** Quiet human note; presentation is not application or fulfillment. */
export interface HqRestNote {
  readonly id: string
  readonly text: string
  readonly createdAt: string
  readonly status: 'pending' | 'presented'
  readonly presentedAt: string | null
}
export interface HqRestNoteRequest { readonly id: string; readonly text: string }
export interface HqRestNoteResult { readonly note: HqRestNote }
/** Current exact handoff identity and native wake receipt for human inspection. */
export interface HqRestState {
  readonly latest: {
    readonly handoffId: string
    readonly summary: string
    readonly requestedWakeAt: string
    readonly effectiveWakeAt: string | null
    readonly scheduleId: string | null
    readonly wakeStatus: 'active' | 'inactive' | null
    readonly ready: boolean
  } | null
  readonly notes: readonly HqRestNote[]
  readonly omittedPresentedNotes?: number
}

/** Derived authorized task display stored only in its assigned employee room. */
export interface EmployeeTaskSnapshot {
  readonly rootSessionId: string
  readonly employeeId: string
  readonly employeeName: string
  readonly employeeRole?: string
  readonly avatarUrl?: string
  readonly sourceSequence: number
  readonly task: HqWorkspaceTask
  readonly calendar: HqCalendarItem | null
}
