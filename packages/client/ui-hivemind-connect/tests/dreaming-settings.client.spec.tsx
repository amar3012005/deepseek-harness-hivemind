// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DreamingSettings } from '../src/client/DreamingSettings.tsx'
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const state = { enabled: false, available: true, canChange: true, synced: false }
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
describe('Company Dreaming opt-in', () => {
  it('starts off and persists one explicit switch into Flashbacks', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(response(state))
      .mockResolvedValueOnce(response({ ...state, enabled: true }))
    vi.stubGlobal('fetch', request)
    render(<DreamingSettings />)
    const toggle = screen.getByRole('switch')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
    expect(JSON.parse(request.mock.calls[1]![1].body)).toEqual({ enabled: true })
    expect(screen.getByText(/company-visible Flashbacks/)).toBeTruthy()
  })
  it('members can see the setting but cannot change it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...state, canChange: false })))
    render(<DreamingSettings />)
    await screen.findByText(/Only company administrators/)
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true)
  })
  it('keeps the saved state when persistence fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response(state)).mockResolvedValueOnce(response({}, 503)))
    render(<DreamingSettings />)
    const toggle = screen.getByRole('switch')
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(toggle)
    await screen.findByRole('alert')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })
  it('can turn off even when the dispatcher becomes unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...state, enabled: true, available: false })))
    render(<DreamingSettings />)
    await screen.findByText(/not configured/)
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(false)
  })
})
