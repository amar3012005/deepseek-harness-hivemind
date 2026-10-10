import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { LlmFailure } from '@deepseek-ai/dsh-llm/types'
import type { RetryId } from './brand.ts'

export type { RetryId }

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Required non-surface route checkpoint for one failed model step. */
    'llm/fallback': LlmFallbackEventData
    /** Durable, non-surface record of one provider-routed retry scheduled after a failed request attempt. */
    'llm/retry': LlmRetryEventData
    /** Durable transition written after a retry wait succeeds and before the next request attempt starts. */
    'llm/retry-started': LlmRetryStartedEventData
  }
}

/** Durable payload recorded before one provider-routed model-request retry wait. */
export type LlmRetryEventData =
  | {
    retryId: RetryId
    turn: number
    step: number
    provider: string
    mode: 'normal'
    policyKey: string
    retry: number
    maxRetries: number
    delayMs: number
    failure: LlmFailure
  }

  | {
    retryId: RetryId
    turn: number
    step: number
    provider: string
    mode: 'always'
    policyKey: string
    retry: number
    delayMs: number
    failure: LlmFailure
  }

/** Durable transition recorded after one retry delay completes. */
export interface LlmRetryStartedEventData {
  retryId: RetryId
  turn: number
  step: number
  retry: number
}

/** Durable primary selection and independently authorized route for one model step. */
export interface LlmFallbackEventData {
  turn: number
  step: number
  primary: LlmCallConfig
  fallback: LlmCallConfig
  failureCode: string
}
