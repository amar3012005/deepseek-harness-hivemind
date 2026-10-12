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
const connectorState = { available: true, enabled: false, accounts: [] }
const request = (
  settings: typeof state,
  save?: (body: { enabled: boolean }) => Response,
) => vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  if (url.endsWith('/dreamer/settings')) {
    if (init?.method === 'PUT') return save?.(JSON.parse(String(init.body)) as { enabled: boolean }) ?? response(settings)
    return response(settings)
  }
  return response({ ...connectorState, available: settings.available })
})
describe('Company Dreaming opt-in', () => {
  it('starts off and persists one explicit switch into Flashbacks', async () => {
    const fetcher = request(state, body => response({ ...state, enabled: body.enabled }))
    vi.stubGlobal('fetch', fetcher)
    render(<DreamingSettings />)
    const toggle = screen.getByRole('switch', { name: 'Enable company dreaming' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
    const save = fetcher.mock.calls.find(([url, init]) => String(url).endsWith('/dreamer/settings') && init?.method === 'PUT')
    expect(JSON.parse(String(save?.[1]?.body))).toEqual({ enabled: true })
    expect(screen.getByText(/company-visible Flashbacks/)).toBeTruthy()
  })
  it('members can see the setting but cannot change it', async () => {
    vi.stubGlobal('fetch', request({ ...state, canChange: false }))
    render(<DreamingSettings />)
    await screen.findByText(/Only company administrators/)
    expect((screen.getByRole('switch', { name: 'Enable company dreaming' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('keeps the saved state when persistence fails', async () => {
    vi.stubGlobal('fetch', request(state, () => response({}, 503)))
    render(<DreamingSettings />)
    const toggle = screen.getByRole('switch', { name: 'Enable company dreaming' })
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(toggle)
    await screen.findByRole('alert')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })
  it('can turn off even when the dispatcher becomes unavailable', async () => {
    vi.stubGlobal('fetch', request({ ...state, enabled: true, available: false }))
    render(<DreamingSettings />)
    await screen.findByText(/not configured/)
    expect((screen.getByRole('switch', { name: 'Enable company dreaming' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
