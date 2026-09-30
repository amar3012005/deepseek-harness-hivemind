// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { HqControlAction } from '../src/client/HqControlAction.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
const mode = { revision: 1, enabled: true, changedAt: 1 }
const base = { sessionId: 'hq' as SessionId, t: makeTranslate(en) }

it('uses committed revisions and reconciles a conflicting human switch', async () => {
  const load = vi.fn().mockResolvedValue({ ok: true, value: mode })
  const current = { revision: 2, enabled: false, changedAt: 2 }
  const setMode = vi.fn().mockResolvedValue({ ok: true, value: { ok: false, code: 'hq-mode-conflict', current } })
  render(<HqControlAction {...base} load={load} setMode={setMode} />)
  await waitFor(() => expect(screen.getByRole('button', { name: en.pause }).hasAttribute('disabled')).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: en.pause }))
  await screen.findByText(en.conflict)
  expect(setMode).toHaveBeenCalledWith('hq', { enabled: false, expectedRevision: 1 })
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
