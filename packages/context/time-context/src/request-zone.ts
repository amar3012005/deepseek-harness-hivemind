/** Browser-zone derivation and model-facing policy text for one open request turn. */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { assertNever } from '@deepseek-ai/dsh-util-values'

const IANA_TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/

/** Browser-zone facts derived from human browser inputs in one open turn. */
export type BrowserTimeZoneContext =
  | { readonly kind: 'resolved'; readonly timeZone: string }
  | { readonly kind: 'mixed'; readonly timeZones: readonly string[] }
  | { readonly kind: 'missing' }

/** Read and validate a Host-canonicalized browser zone from a user-rpc message or trusted human-control confirmation. */
function browserTimeZone(message: UserMessage): string | undefined {
  const source = message.source
  const controlZone = source.kind === 'plugin' && source.plugin === 'time-context/browser-zone'
    ? message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('').match(/^Browser time zone confirmed by human control: (.+)\.$/)?.[1]
    : undefined
  const value = controlZone ?? (source.kind === 'user'
    && 'rpcId' in source
    && typeof source.rpcId === 'string'
    && 'clientTimeZone' in source
    && typeof source.clientTimeZone === 'string'
    ? source.clientTimeZone
    : undefined)
  if (value === undefined) return undefined
  if (value !== 'UTC' && !IANA_TIME_ZONE.test(value)) {
    throw new TypeError(
      `browser time zone must be canonical UTC or IANA Area/Location: ${JSON.stringify(value)}`,
    )
  }
  let canonical: string
  try {
    canonical = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone
  } catch (error: unknown) {
    throw new TypeError(`browser time zone is unsupported: ${JSON.stringify(value)}`, { cause: error })
  }
  if (canonical !== value) {
    throw new TypeError(`browser time zone must be canonical: ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Derive the unique, mixed, or missing browser zone for one open turn.
 * @param messages - Entered and proposed user messages belonging to the turn.
 * @returns Sorted, duplicate-free browser-zone facts.
 * @throws TypeError when a user-rpc source carries an invalid or noncanonical zone.
 */
export function deriveBrowserTimeZoneContext(
  messages: readonly UserMessage[],
): BrowserTimeZoneContext {
  const timeZones = [...new Set(messages.flatMap((message) => {
    const timeZone = browserTimeZone(message)
    return timeZone === undefined ? [] : [timeZone]
  }))].sort()
  const [timeZone, ...remaining] = timeZones
  if (timeZone === undefined) return { kind: 'missing' }
  if (remaining.length === 0) return { kind: 'resolved', timeZone }
  return { kind: 'mixed', timeZones }
}

/**
 * Render the model instruction for one browser-zone context.
 * @param context - Browser-zone facts for the open turn.
 * @returns One durable policy line.
 */
export function renderBrowserTimeZoneContext(context: BrowserTimeZoneContext): string {
  switch (context.kind) {
    case 'resolved':
      return `Browser time zone for this request: ${context.timeZone}. `
        + 'Interpret otherwise-unqualified dates and times in this zone.'
    case 'mixed':
      return `Browser time zone for this request: mixed ${JSON.stringify(context.timeZones)}. `
        + 'Ask the user to clarify otherwise-unqualified dates and times.'
    case 'missing':
      return 'Browser time zone for this request: unavailable. '
        + 'Ask the user to clarify otherwise-unqualified dates and times.'
    /* v8 ignore next 2 -- the closed BrowserTimeZoneContext union is exhausted above. */
    default:
      return assertNever(context, 'BrowserTimeZoneContext')
  }
}

/** Create quiet durable clock context for an authenticated human browser control.
 * Callers own authorization; this records timezone evidence, not a new user task.
 * @param timeZone - Browser-provided UTC or supported IANA zone; aliases are canonicalized.
 * @returns Validated context for native Agent.inject before a scheduled wake.
 */
export function createBrowserTimeZoneConfirmation(timeZone: string): UserMessage {
  if (timeZone !== 'UTC' && !IANA_TIME_ZONE.test(timeZone)) throw new TypeError('browser time zone must be UTC or IANA Area/Location')
  const canonical = new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone
  return createUserMessage({
    source: { kind: 'plugin', plugin: 'time-context/browser-zone', form: 'recall' },
    content: [{ type: 'text', text: `Browser time zone confirmed by human control: ${canonical}.` }],
  })
}
