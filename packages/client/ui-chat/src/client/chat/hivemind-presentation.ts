/** Presentation projections only; stored attribution and model history are untouched. */
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Host-authored question receipts are model context, not another human chat message. */
export function isQuestionAnswerSubmission(source: unknown): boolean {
  return record(source) && source['kind'] === 'user' && source['questionAnswerSubmission'] === true
}

/** User-facing failure text never includes provider payloads, IDs or credentials. */
export function hivemindFailureText(code: unknown): string {
  if (code === 'AUTH') return 'The model connection needs attention. Please check your connection and try again.'
  return 'The reply couldn’t be completed. Your conversation is saved. Please try again.'
}
