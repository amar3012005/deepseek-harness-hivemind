import type { SessionPendingInteraction } from '@deepseek-ai/dsh-client-ui-session/client'
/** Every native human interaction needs attention, not only tool approval. */
export function roomNeedsInput(pending: SessionPendingInteraction | undefined): boolean {
  return pending !== undefined
}

/** Native pending interactions are human decisions; background work is not. */
export function roomWaitingForResponse(pending: SessionPendingInteraction | undefined): boolean {
  return roomNeedsInput(pending)
}

/** A provider-connected call is live; ringing, generation and failures are not. */
export function roomCallActive(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const status = value as { state?: unknown; error?: unknown; busy?: unknown }
  return status.state === 'live' && status.error !== true && status.busy !== true
}
