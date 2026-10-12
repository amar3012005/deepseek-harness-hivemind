/** Timezone evidence from an authenticated HQ browser control, not user speech. */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'hivemind-browser-zone': { kind: 'hivemind-browser-zone'; timeZone: string }
  }
}
export function createBrowserTimeZoneConfirmation(timeZone: string) {
  if (timeZone !== 'UTC' && !/^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/.test(timeZone)) throw new TypeError('browser time zone must be UTC or IANA Area/Location')
  const canonical = new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone
  return createUserMessage({ source: { kind: 'hivemind-browser-zone', timeZone: canonical },
    content: [{ type: 'text', text: `Browser time zone confirmed by human control: ${canonical}.` }] })
}
