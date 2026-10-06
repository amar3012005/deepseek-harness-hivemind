// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { MobileAddSheet } from '../src/client/skeleton/MobileAddSheet.tsx'
afterEach(cleanup)
it('keeps native Photo, Camera and File choices available without submitting a message', () => {
  const pick = vi.fn(); const mode = vi.fn()
  const view = render(<MobileAddSheet close={vi.fn()} pick={pick} canAttach chooseMode={mode} />)
  fireEvent.click(view.getByRole('button', { name: 'Photo' }))
  fireEvent.click(view.getByRole('button', { name: 'Camera' }))
  fireEvent.click(view.getByRole('button', { name: 'File' }))
  expect(pick.mock.calls.map(call => call[0])).toEqual(['photo', 'camera', 'file'])
  fireEvent.click(view.getByRole('button', { name: /Deep Research/ }))
  expect(mode).toHaveBeenCalledWith('research')
  expect(view.getByText('Ask for a multi-source report')).toBeTruthy()
})
it('does not offer uploads when native attachment intake is unavailable', () => {
  const view = render(<MobileAddSheet close={vi.fn()} pick={vi.fn()} canAttach={false} chooseMode={vi.fn()} />)
  expect(view.getByRole('button', { name: 'Camera' }).hasAttribute('disabled')).toBe(true)
})
it('contains focus, supports Escape and restores the prior focused control', () => {
  const origin = document.createElement('button'); document.body.append(origin); origin.focus()
  const close = vi.fn()
  const view = render(<MobileAddSheet close={close} pick={vi.fn()} canAttach chooseMode={vi.fn()} />)
  const first = view.getByRole('button', { name: /^Close$/ })
  expect(document.activeElement).toBe(first)
  fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
  expect(document.activeElement).toBe(view.getByRole('button', { name: /Connectors/ }))
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(close).toHaveBeenCalledOnce()
  view.unmount(); expect(document.activeElement).toBe(origin); origin.remove()
})
it('opens the host connector sheet only on explicit choice and closes on backdrop', async () => {
  const listener = vi.fn(); window.addEventListener('hivemind:mobile-connectors', listener)
  const close = vi.fn()
  const view = render(<MobileAddSheet close={close} pick={vi.fn()} canAttach chooseMode={vi.fn()} />)
  expect(listener).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('button', { name: /Connectors/ }))
  await new Promise<void>(resolve => queueMicrotask(resolve))
  expect(listener).toHaveBeenCalledOnce()
  fireEvent.click(view.getByRole('button', { name: 'Close add to chat' }))
  expect(close).toHaveBeenCalledTimes(2)
  window.removeEventListener('hivemind:mobile-connectors', listener)
})
