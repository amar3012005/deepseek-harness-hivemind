// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locales.ts'
import { savedConnectionRequests } from '../src/client/connected-app-state.ts'
import { connectedAppStatus } from '../src/client/ConnectedAppStatus.tsx'
import { PendingConnectionAuthorization } from '../src/client/connection-question.ts'
import { ConnectedAppDock } from '../src/client/ConnectedAppDock.tsx'
function event(status = 'connection_required', workflow = 'saved-workflow', extra = {}) {
  return { type: 'event', event: { type: 'hivemind/connected-receipt', data: { version: 1,
    tool: 'connection_authorization', workflowSessionId: workflow,
    receipt: { status, session_id: workflow, request_call_id: 'original-call', toolkit: 'slack',
      app_label: 'Slack', reason: 'Read the saved pipeline discussion.', redirect_url: 'https://connect.example/slack', ...extra } } } }
}
function windowOf(...entries: unknown[]): SessionEventWindow { return { entries } as unknown as SessionEventWindow }
afterEach(cleanup)
it('restores pending authorization without a foreground turn and clears only matching verified workflow', () => {
  expect(savedConnectionRequests(windowOf(event()))).toHaveLength(1)
  expect(savedConnectionRequests(windowOf(event(), event('ready', 'other-workflow')))).toHaveLength(1)
  expect(savedConnectionRequests(windowOf(event(), event('ready')))).toHaveLength(0)
  expect(savedConnectionRequests(windowOf(event(), event('ready', 'saved-workflow', { request_call_id: 'different' })))).toHaveLength(1)
  expect(savedConnectionRequests(windowOf(event(), event('ready', 'saved-workflow', { toolkit: 'gmail' })))).toHaveLength(1)
})
it('rejects unsafe links and mismatched workflow references', () => {
  expect(savedConnectionRequests(windowOf(event('connection_required', 'saved-workflow', { redirect_url: 'javascript:bad' })))).toEqual([])
  expect(savedConnectionRequests(windowOf(event('connection_required', 'saved-workflow', { session_id: 'different' })))).toEqual([])
})
it('shows one actual pending call and clears on result or turn end; ready receipts never imply connected', () => {
  const start = { type: 'event', event: { type: 'turn/start', data: { turn: 3 } } }
  const call = { type: 'event', event: { type: 'tool/call', data: { callId: 'call', name: 'hivemind_connected_task', arguments: JSON.stringify({ action: 'search', queries: [{ app: 'Slack' }] }) } } }
  const result = { type: 'event', event: { type: 'tool/result', data: { message: { source: { callId: 'call' } } } } }
  expect(connectedAppStatus(windowOf(start, call, event('ready')), 3)).toEqual({ app: 'Slack', toolkit: 'slack', status: 'searching' })
  expect(connectedAppStatus(windowOf(start, call, result), 3)).toBeUndefined()
  expect(connectedAppStatus(windowOf(start, call, { type: 'event', event: { type: 'turn/end', data: {} } }), 3)).toBeUndefined()
  expect(connectedAppStatus(windowOf(start, event('ready')), 3)).toBeUndefined()
})
it('reloads an actionable dock; only explicit Continue sends once and never replaces a draft', async () => {
  const resume = vi.fn(async () => {})
  const props = { sessionId: 'room', t: makeTranslate(zh, commonZh), resume,
    useEmployeeEvents: (select: (window: SessionEventWindow) => unknown) => select(windowOf(event())),
    useSessionStatus: (select: (map: Map<unknown, unknown>) => unknown) => select(new Map()),
  } as unknown as Parameters<typeof ConnectedAppDock>[0]
  const view = render(<ConnectedAppDock {...props} />)
  expect(resume).not.toHaveBeenCalled()
  expect(view.container.querySelector('[data-connected-app-request="original-call"]')).not.toBeNull()
  fireEvent.click(view.getByRole('button', { name: '我已连接 Slack — 继续' }))
  fireEvent.click(view.getByRole('button', { name: '正在验证连接…' }))
  await waitFor(() => expect(resume).toHaveBeenCalledTimes(1))
  expect(resume).toHaveBeenCalledWith('Check my Slack connection and continue the paused request.')
})

it('keeps only one human action card during active authorization and removes persisted card after verified receipt', () => {
  const active = Object.create(PendingConnectionAuthorization.prototype)
  const props = { sessionId: 'room', t: makeTranslate(zh, commonZh), resume: vi.fn(),
    useEmployeeEvents: (select: (window: SessionEventWindow) => unknown) => select(windowOf(event())),
    useSessionStatus: (select: (map: Map<unknown, unknown>) => unknown) => select(new Map([['room', { pendingInteraction: active }]])),
  } as unknown as Parameters<typeof ConnectedAppDock>[0]
  const view = render(<ConnectedAppDock {...props} />)
  expect(view.container.textContent).toBe('')
  view.rerender(<ConnectedAppDock {...props} useSessionStatus={select => select(new Map())}
    useEmployeeEvents={select => select(windowOf(event(), event('ready')))} />)
  expect(view.container.textContent).toBe('')
})

it('clears a durably cancelled exact request while retaining unrelated and renewed requests', () => {
  expect(savedConnectionRequests(windowOf(event(), event('cancelled')))).toEqual([])
  expect(savedConnectionRequests(windowOf(event(), event('cancelled', 'saved-workflow', { request_call_id: 'other' })))).toHaveLength(1)
  expect(savedConnectionRequests(windowOf(event(), event('cancelled'), event('connection_required', 'renewed-workflow', { request_call_id: 'renewed' })))[0]?.callId).toBe('renewed')
})
