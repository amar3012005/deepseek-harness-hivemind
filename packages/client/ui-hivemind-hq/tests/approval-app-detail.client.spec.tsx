// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ApprovalActionLabel, ApprovalAppDetail } from '../src/client/ApprovalAppDetail.tsx'
import { approvalCall } from '../src/client/app-approval.ts'
import { en } from '../src/client/locales.ts'
afterEach(cleanup)

const t = ((key: keyof typeof en, values?: Record<string, string>) =>
  Object.entries(values ?? {}).reduce((text, [name, value]) => text.replace(`{${name}}`, value), en[key])) as never
const gmail = JSON.stringify({ action: 'execute', session_id: 's1', tool_slug: 'GMAIL_SEND_EMAIL',
  arguments: { recipient_email: 'support@example.com', subject: 'Approval check', body: 'test', is_html: false, include_signature: false, user_id: 'me' } })
function props(argsRaw: string, callId = 'call-1') {
  const snapshot = { nodes: { values: () => [{ kind: 'tool-call', data: { root: { callId, argsRaw } } }] } }
  const useChat = (selector: (value: typeof snapshot) => unknown) => selector(snapshot)
  return { callId, useChat, t } as unknown as Parameters<typeof ApprovalAppDetail>[0]
}

describe('approvalCall', () => {
  it('reads a connected-app execute as the app and labelled fields without internal flags', () => {
    expect(approvalCall(gmail)).toEqual({ kind: 'app', toolkit: 'gmail', app: 'Gmail', fields: [
      { labelKey: 'approval.field.to', label: 'Recipient email', value: 'support@example.com' },
      { labelKey: 'approval.field.subject', label: 'Subject', value: 'Approval check' },
      { labelKey: 'approval.field.message', label: 'Body', value: 'test' }], action: 'send-email' })
  })
  it('keeps shell commands and ignores unreadable or unrelated arguments', () => {
    expect(approvalCall('{"command":"pnpm test"}')).toEqual({ kind: 'command', command: 'pnpm test' })
    expect(approvalCall('{')).toBeUndefined()
    expect(approvalCall('{"action":"search"}')).toBeUndefined()
    expect(approvalCall(undefined)).toBeUndefined()
  })
})

describe('ApprovalAppDetail', () => {
  it('renders the app, its logo and plain fields, never the slug or JSON', () => {
    const view = render(<ApprovalAppDetail {...props(gmail)} />)
    expect(screen.getByText('Gmail')).toBeTruthy()
    expect(screen.getByText('To')).toBeTruthy()
    expect(screen.getByText('support@example.com')).toBeTruthy()
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe('https://logos.composio.dev/api/gmail')
    expect(view.container.textContent).not.toMatch(/GMAIL_SEND_EMAIL|[{}]|is_html|user_id/)
  })
  it('falls back to the command for shell approvals', () => {
    expect(render(<ApprovalAppDetail {...props('{"command":"rm -rf build"}')} />).container.textContent).toBe('rm -rf build')
  })
})

describe('ApprovalActionLabel', () => {
  const label = (argsRaw: string, decision: 'allowed-once' | 'rejected') => render(<ApprovalActionLabel
    {...props(argsRaw) as unknown as Parameters<typeof ApprovalActionLabel>[0]} decision={decision} fallback={decision === 'rejected' ? 'Reject' : 'Allow once'} />).container.textContent
  it('names an email send and a draft by what happens', () => {
    expect(label(gmail, 'allowed-once')).toBe('Send email')
    cleanup()
    expect(label(gmail, 'rejected')).toBe('Discard')
    cleanup()
    expect(label(gmail.replace('GMAIL_SEND_EMAIL', 'GMAIL_CREATE_EMAIL_DRAFT'), 'allowed-once')).toBe('Save draft')
  })
  it('keeps the default copy for other apps, commands and unreadable arguments', () => {
    expect(label(gmail.replace('GMAIL_SEND_EMAIL', 'GOOGLECALENDAR_CREATE_EVENT'), 'allowed-once')).toBe('Allow once')
    cleanup()
    expect(label('{"command":"pnpm test"}', 'rejected')).toBe('Reject')
    cleanup()
    expect(label('{', 'allowed-once')).toBe('Allow once')
  })
})
