// @vitest-environment jsdom
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import css from '../src/client/RuntimeNotificationBanner.module.css'
import { afterEach, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import { RuntimeNotificationBanner } from '../src/client/RuntimeNotificationBanner.tsx'
import { notificationStatus, runtimeNotifications } from '../src/client/runtime-notification.ts'
afterEach(cleanup)
const now = Date.parse('2026-10-08T10:00:00Z')
const call = (id = 'call-1', turn = 1, kind = 'completion') => ({ type: 'tool/call', time: now,
  data: { callId: id, name: 'hivemind_administrator_message', arguments: JSON.stringify({ subject: 'Your launch brief is ready', kind }), turn } })
const result = (value: unknown, id = 'call-1', isError = false) => ({ type: 'tool/result', surfaceOp: 'append', time: now + 1000,
  data: { message: { source: { callId: id }, content: [{ isError, content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] }] } } })
const accepted = { message_id: 'private-message-id', status: 'accepted', sent: true,
  receipt: { ok: true, provider: 'cloudflare', messageId: 'private-provider-id', deliveryStatus: 'queued' } }
const window = (...events: unknown[]) => ({ entries: events.map((event, seq) => ({ type: 'event', event: { ...event as object, seq } })) }) as SessionEventWindow
const source = (log: SessionEventWindow) => ({ subscribe: () => () => {}, getSnapshot: () => log })
it('accepted or queued is sent, not delivered or read', () => {
  const view = render(<RuntimeNotificationBanner turn={1} events={source(window(call(), result(accepted)))} />)
  expect(view.getByText('Email sent')).toBeTruthy()
  expect(view.getByText('Your launch brief is ready')).toBeTruthy()
  expect(view.getByText(/Reading is not confirmed/)).toBeTruthy()
  expect(view.queryByText('Delivery confirmed')).toBeNull()
  expect(view.container.textContent).not.toContain('private-message-id')
  expect(view.container.textContent).not.toContain('private-provider-id')
  expect(view.queryByRole('button')).toBeNull()
  expect(view.queryByRole('link')).toBeNull()
  const visualDir = process.env.RUNTIME_NOTIFICATION_VISUAL_DIR
  if (visualDir) {
    mkdirSync(visualDir, { recursive: true })
    let styles = readFileSync('packages/client/ui-hivemind-hq/src/client/RuntimeNotificationBanner.module.css', 'utf8')
    for (const name of ['list', 'banner', 'mark', 'copy', 'heading', 'subject', 'detail']) styles = styles.replaceAll(`.${name}`, `.${css[name]}`)
    writeFileSync(`${visualDir}/banner.html`, `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Runtime notification component preview</title><style>body{font-family:Arial,sans-serif;color:#262626;background:#fff;padding:24px;margin:0}.preview{max-width:680px;margin:auto}@media(max-width:520px){body{padding:12px}}${styles}</style><main class="preview"><p style="font-size:12px;color:#888">Component preview • saved notification receipt</p>${view.container.innerHTML}</main>`)
  }
})
it('delivery confirmation needs an authoritative delivered receipt', () => {
  expect(notificationStatus({ ...accepted, receipt: { ok: true, deliveryStatus: 'delivered' } })).toBe('delivered')
  expect(notificationStatus({ ...accepted, sent: false, receipt: { deliveryStatus: 'delivered' } })).toBe('unknown')
  expect(notificationStatus({ status: 'unknown', receipt: { deliveryStatus: 'delivered' } })).toBe('unknown')
  expect(notificationStatus({ status: 'rejected', receipt: { deliveryStatus: 'delivered' } })).toBe('failed')
})
it('rebuilds the same card on reload and merges replay receipts across turns', () => {
  const log = window(call(), result(accepted), call('call-2', 2), result({ ...accepted, replayed: true }, 'call-2'))
  expect(runtimeNotifications(log)).toHaveLength(1)
  expect(runtimeNotifications(log)[0]?.turn).toBe(1)
  expect(runtimeNotifications(JSON.parse(JSON.stringify(log)) as SessionEventWindow)).toEqual(runtimeNotifications(log))
  const later = window(call(), result(accepted), call('call-2', 2), result({ ...accepted, receipt: { ok: true, deliveryStatus: 'delivered' } }, 'call-2'))
  expect(runtimeNotifications(later)).toHaveLength(1)
  expect(runtimeNotifications(later)[0]?.status).toBe('delivered')
})
it('shows safe unconfirmed state on malformed or error result, without printing provider errors', () => {
  for (const value of ['{broken', undefined, { error: 'secret-provider-diagnostic' }]) {
    const log = window(call(), result(value))
    expect(runtimeNotifications(log)[0]?.status).toBe('unknown')
  }
  expect(runtimeNotifications(window(call(), result(accepted, 'call-1', true)))[0]?.status).toBe('unknown')
  expect(notificationStatus({ status: 'disabled' })).toBe('failed')
  expect(notificationStatus({ ...accepted, receipt: { deliveryStatus: 'bounced' } })).toBe('delivery-failed')
})
it('pending is not sent; a finished interrupted turn becomes unconfirmed', () => {
  expect(runtimeNotifications(window(call()))[0]?.status).toBe('sending')
  expect(runtimeNotifications(window(call(), { type: 'turn/end', data: { turn: 1 } }))[0]?.status).toBe('unknown')
})
it('unrelated tools and replacement copies cannot create notifications', () => {
  expect(runtimeNotifications(window({ ...call(), data: { ...call().data, name: 'schedule_create' } }, result(accepted)))).toEqual([])
  expect(runtimeNotifications(window(result(accepted)))).toEqual([])
  expect(runtimeNotifications(window(call(), { ...result(accepted), surfaceOp: 'replace' }))[0]?.status).toBe('sending')
})
it('approval email never grants approval and wrong turns render nothing', () => {
  const events = source(window(call('call-1', 1, 'approval'), result(accepted)))
  const view = render(<RuntimeNotificationBanner turn={1} events={events} />)
  expect(view.getByText(/Approval still requires your explicit decision/)).toBeTruthy()
  view.rerender(<RuntimeNotificationBanner turn={2} events={events} />)
  expect(view.container.textContent).toBe('')
})
it('escapes subjects and suppresses invalid timestamps', () => {
  const head = call()
  const log = window({ ...head, data: { ...head.data, arguments: JSON.stringify({ subject: '<img src=x onerror=alert(1)>' }) } },
    { ...result(accepted), time: NaN })
  const view = render(<RuntimeNotificationBanner turn={1} events={source(log)} />)
  expect(view.getByText('<img src=x onerror=alert(1)>')).toBeTruthy()
  expect(view.container.querySelector('img')).toBeNull()
  expect(view.container.querySelector('time')).toBeNull()
})
