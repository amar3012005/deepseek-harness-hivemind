// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ChatgptPlanConnection } from '../src/client/ChatgptPlanConnection.tsx'
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it('shows the bottom connection control and honest disabled hosted state', async () => {
  window.history.replaceState(null, '', '/hivemind/app/overview')
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ available: false, connected: false, models: [], selected_model: null, platform_fallback: false }))))
  render(<ChatgptPlanConnection />)
  fireEvent.click(screen.getByRole('button', { name: 'Connect to your ChatGPT' }))
  await waitFor(() => expect(screen.getByText('ChatGPT connection is not enabled on this server yet.')).toBeTruthy())
  expect((screen.getByRole('button', { name: 'Continue with ChatGPT' }) as HTMLButtonElement).disabled).toBe(true)
})
it('does not put the Brain connection control in Runtime or employee rooms', () => {
  window.history.replaceState(null, '', '/hivemind/app/employee/harness/runtime')
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  const { container } = render(<ChatgptPlanConnection />)
  expect(container.textContent).toBe(''); expect(fetcher).not.toHaveBeenCalled()
})
it('removes callback code from the page and submits it without tokens', async () => {
  window.history.replaceState(null, '', '/hivemind/app/overview?code=fixture-code&state=fixture-state')
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ available: true, connected: true, models: ['fixture-gpt'], selected_model: 'fixture-gpt', platform_fallback: false })))
  vi.stubGlobal('fetch', fetcher); render(<ChatgptPlanConnection />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Your ChatGPT is connected' })).toBeTruthy())
  expect(window.location.search).toBe('')
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/hivemind/chatgpt-plan/callback')
  expect(JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ code: 'fixture-code', state: 'fixture-state' })
})
