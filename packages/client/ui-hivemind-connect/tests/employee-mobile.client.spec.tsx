// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { BrainConnections } from '../src/client/BrainConnections.tsx'
vi.mock('../src/client/SessionCredits.tsx', () => ({ SessionCredits: () => null }))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/') })
const props = (preset: string) => ({ sessionId: 'test', showDetails: vi.fn(),
  useSessions: (select: (value: unknown) => unknown) => select({ byId: { test: { agentPreset: preset } }, jobsBySession: {} }),
})
it.each([375, 390, 768])('keeps employee Environment closed at %spx until explicitly opened', (width) => {
  window.history.replaceState({}, '', '/hivemind/app/employee/harness/session/test')
  vi.stubGlobal('matchMedia', () => ({ matches: width <= 900, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ accounts: [] }) })))
  const view = render(<BrainConnections {...props('hivemind-hq') as unknown as Parameters<typeof BrainConnections>[0]} />)
  const toggle = view.getByRole('button', { name: 'HIVEMIND environment' })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(toggle.textContent).toContain('Runtime')
  expect(view.queryByRole('dialog')).toBeNull()
  fireEvent.click(toggle)
  expect(view.getByRole('dialog').getAttribute('aria-modal')).toBe('true')
  expect(document.activeElement).toBe(view.getByRole('button', { name: 'Hide' }))
  fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
  expect(document.activeElement).not.toBe(toggle)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(view.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(toggle)
  fireEvent.click(toggle)
  fireEvent.click(view.getByRole('button', { name: 'Close environment' }))
  expect(view.queryByRole('dialog')).toBeNull()
})
it.each([375, 390, 768])('keeps native Brain Environment dismissible at %spx', (width) => {
  window.history.replaceState({}, '', '/hivemind/app/overview/session/test')
  vi.stubGlobal('matchMedia', () => ({ matches: width <= 900, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ accounts: [] }) })))
  const view = render(<BrainConnections {...props('hivemind-chat') as unknown as Parameters<typeof BrainConnections>[0]} />)
  expect(view.getByRole('button', { name: 'HIVEMIND environment' }).getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(view.getByRole('button', { name: 'HIVEMIND environment' }))
  expect(view.getByRole('dialog').getAttribute('aria-modal')).toBe('true')
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(view.queryByRole('dialog')).toBeNull()
})

it('preserves desktop Brain Environment defaults', () => {
  window.history.replaceState({}, '', '/hivemind/app/overview/session/test')
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ accounts: [] }) })))
  const view = render(<BrainConnections {...props('hivemind-chat') as unknown as Parameters<typeof BrainConnections>[0]} />)
  expect(view.getByRole('button', { name: 'HIVEMIND environment' }).getAttribute('aria-expanded')).toBe('true')
  expect(view.queryByRole('dialog')).toBeNull()
})
