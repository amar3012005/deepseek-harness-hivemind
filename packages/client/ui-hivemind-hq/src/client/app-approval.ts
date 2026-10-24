/** Reads a correlated approval call as a connected-app action or a shell command; never shows slugs or raw JSON. */

const APP_NAMES: Readonly<Record<string, string>> = {
  gmail: 'Gmail', googlecalendar: 'Google Calendar', googledrive: 'Google Drive', googledocs: 'Google Docs',
  googlesheets: 'Google Sheets', linkedin: 'LinkedIn', hubspot: 'HubSpot', github: 'GitHub', slack: 'Slack', notion: 'Notion',
}
/** Argument names with a localized label; others show their own name in words. */
export const APPROVAL_FIELD_KEYS = {
  recipient_email: 'approval.field.to', to: 'approval.field.to', cc: 'approval.field.cc', bcc: 'approval.field.bcc',
  extra_recipients: 'approval.field.alsoTo', subject: 'approval.field.subject', body: 'approval.field.message',
  message: 'approval.field.message', text: 'approval.field.message', title: 'approval.field.title', summary: 'approval.field.title',
  description: 'approval.field.description', start_datetime: 'approval.field.starts', end_datetime: 'approval.field.ends',
  attendees: 'approval.field.attendees', channel: 'approval.field.channel', name: 'approval.field.name', content: 'approval.field.content',
} as const
export type ApprovalFieldKey = typeof APPROVAL_FIELD_KEYS[keyof typeof APPROVAL_FIELD_KEYS]
const HIDDEN = new Set(['user_id', 'is_html', 'include_signature', 'thread_id', 'message_id', 'from_email'])

/** One readable argument: a localized label key or the argument name in words, and its value as text. */
export interface ApprovalField { readonly labelKey?: ApprovalFieldKey; readonly label: string; readonly value: string }
/** What the approval card shows for its correlated call. */
export type ApprovalCall =
  | { readonly kind: 'app'; readonly toolkit: string; readonly app: string; readonly fields: readonly ApprovalField[]; readonly action?: ApprovalAction }
  | { readonly kind: 'command'; readonly command: string }

/** Connected-app actions whose decision buttons name what happens. */
export type ApprovalAction = 'send-email' | 'save-draft'
const ACTIONS: ReadonlyArray<readonly [RegExp, ApprovalAction]> = [
  [/^GMAIL_(?:SEND_EMAIL|SEND_DRAFT|REPLY_TO_THREAD)$/u, 'send-email'],
  [/^GMAIL_CREATE_EMAIL_DRAFT$/u, 'save-draft'],
]

const text = (value: unknown): string => Array.isArray(value)
  ? value.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join(', ')
  : typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)

/**
 * Read the raw arguments of the call an approval is for.
 * @param argsRaw - Tool call arguments as streamed JSON text.
 * @returns A connected-app action with its fields, a shell command, or undefined when neither applies.
 */
export function approvalCall(argsRaw: string | undefined): ApprovalCall | undefined {
  if (argsRaw === undefined) return undefined
  let args: Record<string, unknown>
  try {
    const parsed = JSON.parse(argsRaw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    args = parsed as Record<string, unknown>
  } catch {
    // Arguments still streaming or malformed: the card shows its headline only.
    return undefined
  }
  if (typeof args['command'] === 'string') return { kind: 'command', command: args['command'] }
  const slug = args['tool_slug']
  if (args['action'] !== 'execute' || typeof slug !== 'string' || !slug.includes('_')) return undefined
  const toolkit = (slug.split('_')[0] ?? '').toLowerCase()
  const values = typeof args['arguments'] === 'object' && args['arguments'] !== null && !Array.isArray(args['arguments'])
    ? args['arguments'] as Record<string, unknown> : {}
  const fields = Object.entries(values).flatMap(([key, value]): ApprovalField[] => {
    if (HIDDEN.has(key) || value === null || value === undefined || value === '') return []
    const labelKey = (APPROVAL_FIELD_KEYS as Record<string, ApprovalFieldKey | undefined>)[key]
    const label = key.replace(/_/g, ' ').replace(/^./, first => first.toUpperCase())
    return [{ ...(labelKey ? { labelKey } : {}), label, value: text(value).replace(/\s+/g, ' ').slice(0, 400) }]
  }).slice(0, 12)
  const action = ACTIONS.find(([pattern]) => pattern.test(slug.toUpperCase()))?.[1]
  return { kind: 'app', toolkit, app: APP_NAMES[toolkit] ?? toolkit.charAt(0).toUpperCase() + toolkit.slice(1), fields, ...(action ? { action } : {}) }
}
