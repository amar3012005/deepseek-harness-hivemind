// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ChatgptPlanConnection } from '../src/client/ChatgptPlanConnection.tsx'
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it('shows the bottom connection control as coming soon without calling an unavailable hosted endpoint', async () => {
  window.history.replaceState(null, '', '/hivemind/app/overview')
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  render(<ChatgptPlanConnection />)
  fireEvent.click(screen.getByRole('button', { name: 'Connect to your ChatGPT' }))
  await waitFor(() => expect(screen.getByText('Coming soon')).toBeTruthy())
  expect(screen.queryByRole('button', { name: 'Continue with ChatGPT' })).toBeNull()
  expect(fetcher).not.toHaveBeenCalled()
})
it('does not put the Brain connection control in Runtime or employee rooms', () => {
  window.history.replaceState(null, '', '/hivemind/app/employee/harness/runtime')
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  const { container } = render(<ChatgptPlanConnection />)
  expect(container.textContent).toBe(''); expect(fetcher).not.toHaveBeenCalled()
})
it('strips stale callback parameters without transmitting them to an unavailable provider', async () => {
  window.history.replaceState(null, '', '/hivemind/app/overview?code=fixture-code&state=fixture-state')
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  render(<ChatgptPlanConnection />)
  await waitFor(() => expect(window.location.search).toBe(''))
  expect(window.location.search).toBe('')
  expect(fetcher).not.toHaveBeenCalled()
  expect(document.body.textContent).not.toContain('fixture-code')
  expect(document.body.textContent).not.toContain('fixture-state')
})
