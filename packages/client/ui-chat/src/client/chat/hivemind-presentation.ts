/** Presentation projections only; stored attribution and model history are untouched. */
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function questionAnswerPresentation(content: readonly unknown[], source: unknown): string | undefined {
  if (!record(source) || source['kind'] !== 'user' || source['questionAnswerSubmission'] !== true) return undefined
  const actor = source['authenticatedActor']
  const name = record(actor) && typeof actor['name'] === 'string' && actor['name'].trim()
    ? actor['name'].trim() : undefined
  const heading = name ? `${name} answered` : 'Answer saved'
  // The server persists the authored answer array after its provenance paragraph.
  // Never render that paragraph, even if an older or incomplete record cannot be parsed.
  const block = content.length === 1 && record(content[0]) ? content[0] : undefined
  if (block?.['type'] !== 'text' || typeof block['text'] !== 'string') return heading
  try {
    const answers: unknown = JSON.parse(block['text'].slice(block['text'].indexOf('\n') + 1))
    if (!Array.isArray(answers) || answers.length === 0) return heading
    const lines = answers.map((answer: unknown) => {
      if (!record(answer) || typeof answer['question'] !== 'string'
        || !Array.isArray(answer['selected']) || !answer['selected'].every(value => typeof value === 'string')
        || (answer['custom'] !== undefined && typeof answer['custom'] !== 'string')) throw Error('unreadable answer')
      return `${answer['question']}\n${[...answer['selected'], answer['custom']].filter(Boolean).join(', ')}`
    })
    return `${heading}\n\n${lines.join('\n\n')}`
  } catch { return heading }
}

/** User-facing failure text never includes provider payloads, IDs or credentials. */
export function hivemindFailureText(code: unknown): string {
  if (code === 'AUTH') return 'The model connection needs attention. Please check your connection and try again.'
  return 'The reply couldn’t be completed. Your conversation is saved. Please try again.'
}
