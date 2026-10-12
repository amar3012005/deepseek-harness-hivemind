/**
 * Client-safe terminal reasons shared by Host subagent providers and browser consumers.
 *
 * @module @deepseek-ai/dsh-subagent/stop-reason
 */

/** Why a subagent run ended. Backends may merge in additional variants. */
export interface SubagentStopReasonMap {
  /** The child finished its turn normally. */
  completed: 'completed'
  /** Cancelled through the request signal or disposal. */
  aborted: 'aborted'
  /** Model or transport failure. */
  error: 'error'
  /** The child hit its token ceiling before finishing. */
  'max-tokens': 'max-tokens'
  /** The child declined the task. */
  refusal: 'refusal'
}

/** The union over {@link SubagentStopReasonMap}. */
export type SubagentStopReason = SubagentStopReasonMap[keyof SubagentStopReasonMap]
