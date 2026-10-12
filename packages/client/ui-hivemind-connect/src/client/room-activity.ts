import type { SessionPendingInteraction } from '@deepseek-ai/dsh-client-ui-session/client'
/** Every native human interaction needs attention, not only tool approval. */
export function roomNeedsInput(pending: SessionPendingInteraction | undefined): boolean {
  return pending !== undefined
}
