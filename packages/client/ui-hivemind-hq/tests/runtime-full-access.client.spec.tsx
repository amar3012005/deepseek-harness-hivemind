// @vitest-environment jsdom
import { cleanup, act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RuntimeFullAccess, type RuntimeFullAccessProps } from '../src/client/RuntimeFullAccess.tsx'
afterEach(cleanup)
const sessionId = 'session-runtime' as SessionId
const subscribe = () => () => {}
const reply = (enabled: boolean, revision: number, ok = true) => ({ ok: true as const, value: { ok, current: { enabled, revision } } })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
it('loads authoritative state and changes on/off with CAS without a second popup', async () => {
  const load = vi.fn<RuntimeFullAccessProps['load']>()
    .mockResolvedValueOnce(reply(false, 7)).mockResolvedValueOnce(reply(true, 8)).mockResolvedValueOnce(reply(false, 9))
  render(<RuntimeFullAccess sessionId={sessionId} load={load} subscribe={subscribe} />)
  const control = screen.getByRole('checkbox') as HTMLInputElement
  await waitFor(() => expect(control.disabled).toBe(false))
  expect(control.checked).toBe(false)
  fireEvent.click(control)
  await waitFor(() => expect(control.checked).toBe(true))
  expect(load).toHaveBeenNthCalledWith(2, sessionId, { enabled: true, expectedRevision: 7 })
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(control)
  await waitFor(() => expect(control.checked).toBe(false))
  expect(load).toHaveBeenNthCalledWith(3, sessionId, { enabled: false, expectedRevision: 8 })
})
it('ignores an older refresh after a confirmed selection', async () => {
  const old = deferred<ReturnType<typeof reply>>()
  const load = vi.fn<RuntimeFullAccessProps['load']>()
    .mockResolvedValueOnce(reply(false, 1)).mockReturnValueOnce(old.promise).mockResolvedValueOnce(reply(true, 2))
  render(<RuntimeFullAccess sessionId={sessionId} load={load} subscribe={subscribe} />)
  const control = screen.getByRole('checkbox') as HTMLInputElement
  await waitFor(() => expect(control.disabled).toBe(false))
  act(() => { window.dispatchEvent(new Event('focus')) })
  fireEvent.click(control)
  await waitFor(() => expect(control.checked).toBe(true))
  await act(async () => { old.resolve(reply(false, 1)); await old.promise })
  expect(control.checked).toBe(true)
})
it('clears previous session state and rejects its late response', async () => {
  const old = deferred<ReturnType<typeof reply>>()
  const next = deferred<ReturnType<typeof reply>>()
  const load = vi.fn<RuntimeFullAccessProps['load']>().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
  const view = render(<RuntimeFullAccess sessionId={sessionId} load={load} subscribe={subscribe} />)
  view.rerender(<RuntimeFullAccess sessionId={'session-other' as SessionId} load={load} subscribe={subscribe} />)
  const control = screen.getByRole('checkbox') as HTMLInputElement
  expect(control.disabled).toBe(true); expect(control.checked).toBe(false)
  await act(async () => { old.resolve(reply(true, 9)); await old.promise })
  expect(control.disabled).toBe(true); expect(control.checked).toBe(false)
  await act(async () => { next.resolve(reply(false, 3)); await next.promise })
  await waitFor(() => expect(control.disabled).toBe(false))
  expect(control.checked).toBe(false)
})
it('reloads authoritative state after a failed write and offers actual retry', async () => {
  const load = vi.fn<RuntimeFullAccessProps['load']>()
    .mockResolvedValueOnce(reply(false, 1)).mockRejectedValueOnce(Error('failed write'))
    .mockResolvedValueOnce(reply(false, 2)).mockResolvedValueOnce(reply(true, 3))
  render(<RuntimeFullAccess sessionId={sessionId} load={load} subscribe={subscribe} />)
  const control = screen.getByRole('checkbox') as HTMLInputElement
  await waitFor(() => expect(control.disabled).toBe(false))
  fireEvent.click(control)
  await screen.findByRole('button', { name: 'Retry' })
  expect(control.checked).toBe(false)
  expect(load).toHaveBeenNthCalledWith(3, sessionId)
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(control.checked).toBe(true))
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
})
it('reconciles a concurrent admin conflict rather than displaying the requested value', async () => {
  const load = vi.fn<RuntimeFullAccessProps['load']>()
    .mockResolvedValueOnce(reply(false, 4)).mockResolvedValueOnce(reply(false, 5, false)).mockResolvedValueOnce(reply(false, 5))
  render(<RuntimeFullAccess sessionId={sessionId} load={load} subscribe={subscribe} />)
  const control = screen.getByRole('checkbox') as HTMLInputElement
  await waitFor(() => expect(control.disabled).toBe(false))
  fireEvent.click(control)
  await screen.findByRole('button', { name: 'Retry' })
  expect(control.checked).toBe(false)
  expect(load).toHaveBeenNthCalledWith(3, sessionId)
})
