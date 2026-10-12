// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { HqControlAction } from '../src/client/HqControlAction.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
const mode = { revision: 1, enabled: true, changedAt: 1 }
const base = { sessionId: 'hq' as SessionId, t: makeTranslate(en),
  restState: vi.fn().mockResolvedValue({ ok: true, value: { latest: null, notes: [] } }),
  leaveRestNote: vi.fn(),
}

it('uses committed revisions and reconciles a conflicting human switch', async () => {
  const load = vi.fn().mockResolvedValue({ ok: true, value: mode })
  const current = { revision: 2, enabled: false, changedAt: 2 }
  const setMode = vi.fn().mockResolvedValue({ ok: true, value: { ok: false, code: 'hq-mode-conflict', current } })
  render(<HqControlAction {...base} load={load} setMode={setMode} />)
  await waitFor(() => expect(screen.getByRole('button', { name: en.pause }).hasAttribute('disabled')).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: en.pause }))
  await screen.findByText(en.conflict)
  expect(setMode).toHaveBeenCalledWith('hq', { enabled: false, expectedRevision: 1, clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
  expect(screen.getByRole('button', { name: en.enable }).hasAttribute('disabled')).toBe(false)
})

it('does not retry or claim success after an uncertain write', async () => {
  const load = vi.fn().mockResolvedValue({ ok: true, value: mode })
  const setMode = vi.fn().mockRejectedValue(new Error('transport lost'))
  render(<HqControlAction {...base} load={load} setMode={setMode} />)
  await waitFor(() => expect(screen.getByRole('button', { name: en.pause }).hasAttribute('disabled')).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: en.pause }))
  await screen.findByText(en.unavailable)
  expect(screen.getByRole('button', { name: en.enable }).hasAttribute('disabled')).toBe(true)
  expect(setMode).toHaveBeenCalledTimes(1)
  load.mockResolvedValue({ ok: true, value: { ...mode, revision: 2, enabled: false } })
  fireEvent.click(screen.getByRole('button', { name: en.refresh }))
  await waitFor(() => expect(screen.getByRole('button', { name: en.enable }).hasAttribute('disabled')).toBe(false))
  expect(setMode).toHaveBeenCalledTimes(1)
})


it('shows Wake up only for the first paused revision and preserves human control', async () => {
  const load = vi.fn().mockResolvedValue({ ok: true, value: { revision: 0, enabled: false, changedAt: 0 } })
  const setMode = vi.fn().mockResolvedValue({ ok: true, value: { ok: true, value: mode } })
  render(<HqControlAction {...base} load={load} setMode={setMode} />)
  const wake = await screen.findByRole('button', { name: en.wake })
  await waitFor(() => expect(wake.hasAttribute('disabled')).toBe(false))
  expect(screen.getByText(en.paused)).toBeTruthy()
  expect(setMode).not.toHaveBeenCalled()
  fireEvent.click(wake)
  await screen.findByRole('button', { name: en.pause })
  expect(setMode).toHaveBeenCalledWith('hq', { enabled: true, expectedRevision: 0, clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
})

it('saves a quiet instruction without mode changes and preserves text and identity on uncertain retry', async () => {
  const load = vi.fn().mockResolvedValue({ ok: true, value: { ...mode, enabled: false } })
  const setMode = vi.fn()
  const leaveRestNote = vi.fn().mockRejectedValueOnce(new Error('lost response'))
    .mockImplementationOnce(async (_id, request) => ({ ok: true, value: { note: { ...request, createdAt: '2026-10-02T18:00:00Z', status: 'pending', presentedAt: null } } }))
  render(<HqControlAction {...base} load={load} setMode={setMode} leaveRestNote={leaveRestNote} />)
  fireEvent.click(screen.getByRole('button', { name: en.leaveInstruction }))
  const input = screen.getByRole('textbox', { name: en.instruction }) as HTMLTextAreaElement
  fireEvent.change(input, { target: { value: 'Read current task receipts only.' } })
  fireEvent.click(screen.getByRole('button', { name: en.saveInstruction }))
  await screen.findByText(en.noteUnavailable)
  expect(input.value).toBe('Read current task receipts only.')
  fireEvent.click(screen.getByRole('button', { name: en.saveInstruction }))
  await screen.findByText(en.noteSaved)
  expect(leaveRestNote.mock.calls[1]).toEqual(leaveRestNote.mock.calls[0])
  expect(input.value).toBe('')
  expect(setMode).not.toHaveBeenCalled()
})

it('labels inactive rest wakes without claiming an upcoming wake', async () => {
  const restState = vi.fn().mockResolvedValue({ ok: true, value: { latest: {
    handoffId: 'rest-1', summary: 'Checkpoint', requestedWakeAt: '2026-10-02T18:00:00Z',
    effectiveWakeAt: '2026-10-02T18:00:00Z', scheduleId: 'wake-1', wakeStatus: 'inactive', ready: true,
  }, notes: [] } })
  render(<HqControlAction {...base} restState={restState} load={vi.fn().mockResolvedValue({ ok: true, value: mode })} setMode={vi.fn()} />)
  await screen.findByText(new RegExp(en.wakeInactive))
  expect(screen.queryByText(new RegExp(en.nextWake))).toBeNull()
})

it('refreshes displayed autonomy on the native state notification without granting authority', async () => {
  let notify: (() => void) | undefined
  const load = vi.fn().mockResolvedValue({ ok: true, value: { ...mode, enabled: false } })
  const setMode = vi.fn()
  render(<HqControlAction {...base} load={load} setMode={setMode}
    subscribeState={(_id, listener) => { notify = listener; return () => {} }} />)
  await screen.findByText(en.paused)
  load.mockResolvedValue({ ok: true, value: { ...mode, revision: 2, enabled: true } })
  notify?.()
  await screen.findByText(en.active)
  expect(setMode).not.toHaveBeenCalled()
})

it('shows a simple reset failure without exposing backend details', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  const startFresh = vi.fn().mockResolvedValue({ ok: false, error: { message: 'raw database diagnostic' } })
  render(<HqControlAction {...base} load={vi.fn().mockResolvedValue({ ok: true, value: mode })}
    setMode={vi.fn()} startFresh={startFresh} />)
  fireEvent.click(await screen.findByRole('button', { name: en.startFresh }))
  await screen.findByText(en.freshFailed)
  expect(screen.queryByText('raw database diagnostic')).toBeNull()
  expect(startFresh).toHaveBeenCalledOnce()
  vi.restoreAllMocks()
})
