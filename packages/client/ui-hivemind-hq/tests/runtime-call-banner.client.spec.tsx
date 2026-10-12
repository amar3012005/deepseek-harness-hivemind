// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, act } from '@testing-library/react'
import { RuntimeCallBanner } from '../src/client/RuntimeCallBanner.tsx'
import { en } from '../src/client/locales.ts'
afterEach(cleanup)
const sessionId = 'runtime-room' as never
const t = (key: keyof typeof en) => en[key]
describe('Runtime Start Call invitation', () => {
  it('starts the existing room action with acknowledgement rather than submitting a chat message', () => {
    const received: Event[] = []
    const start = (event: Event) => { received.push(event); event.preventDefault() }
    window.addEventListener('hivemind:start-room-call', start)
    try {
      const view = render(<RuntimeCallBanner sessionId={sessionId} t={t} />)
      fireEvent.click(view.getByRole('button', { name: 'Start Call' }))
      expect(received).toHaveLength(1)
      expect((received[0] as CustomEvent).detail).toEqual({ sessionId })
      expect(view.queryByRole('alert')).toBeNull()
    } finally { window.removeEventListener('hivemind:start-room-call', start) }
  })
  it('shows unavailable action and factual connection errors, disables connecting/live calls', () => {
    const view = render(<RuntimeCallBanner sessionId={sessionId} t={t} />)
    fireEvent.click(view.getByRole('button', { name: 'Start Call' }))
    expect(view.getByRole('alert').textContent).toBe(en['call.unavailable'])
    act(() => { window.dispatchEvent(new CustomEvent('hivemind:room-call-status', { detail: { sessionId, state: 'connecting', error: false, busy: false } })) })
    expect((view.getByRole('button', { name: 'Connecting…' }) as HTMLButtonElement).disabled).toBe(true)
    act(() => { window.dispatchEvent(new CustomEvent('hivemind:room-call-status', { detail: { sessionId, state: 'idle', error: true, busy: false } })) })
    expect(view.getByRole('alert').textContent).toBe(en['call.failed'])
    expect((view.getByRole('button', { name: 'Start Call' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
