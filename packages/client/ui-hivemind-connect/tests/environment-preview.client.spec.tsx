// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { isEnvironmentPreviewOpen } from '../src/client/environment-preview.ts'
import { BrainConnections } from '../src/client/BrainConnections.tsx'

vi.mock('../src/client/SessionCredits.tsx', () => ({ SessionCredits: () => null }))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.body.innerHTML = ''; window.history.replaceState({}, '', '/') })

it('collapses apps with native Preview, hides the wide panel, and retains explicit reopening', async () => {
  window.history.replaceState({}, '', '/hivemind/app/employee/harness/session/test')
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ accounts: [] }) })))
  const panel = document.createElement('div')
  panel.dataset.sidebarRightPanel = 'push'
  let width = 250
  panel.getBoundingClientRect = () => ({ width } as DOMRect)
  document.body.append(panel)
  const props = {
    sessionId: 'test', showDetails: vi.fn(), isPreviewOpen: () => panel.hasAttribute('data-sidebar-right-open'),
    useSessions: (select: (value: unknown) => unknown) => select({ byId: { test: { agentPreset: 'hivemind-hq' } }, jobsBySession: {} }),
  }
  const view = render(<BrainConnections {...props as unknown as Parameters<typeof BrainConnections>[0]} />)
  expect(view.getByRole('button', { name: /Connected apps/ }).getAttribute('aria-expanded')).toBe('true')
  expect(view.getByRole('button', { name: 'HIVEMIND environment' }).textContent).not.toContain('Runtime')
  await act(async () => { panel.dataset.sidebarRightOpen = ''; fireEvent(window, new Event('resize')) })
  expect(view.getByRole('button', { name: /Connected apps/ }).getAttribute('aria-expanded')).toBe('false')
  await act(async () => { width = window.innerWidth * 0.46; fireEvent(window, new Event('resize')) })
  expect(view.queryByRole('region', { name: 'HIVEMIND connected apps' })).toBeNull()
  fireEvent.click(view.getByRole('button', { name: 'HIVEMIND environment' }))
  expect(view.getByRole('region', { name: 'HIVEMIND connected apps' })).toBeTruthy()
  expect(view.getByRole('button', { name: 'HIVEMIND environment' }).textContent).not.toContain('Runtime')
  fireEvent.click(view.getByRole('button', { name: 'Hide' }))
  expect(view.getByRole('button', { name: 'HIVEMIND environment' }).textContent).toContain('Runtime')
  await act(async () => { panel.removeAttribute('data-sidebar-right-open'); fireEvent(window, new Event('resize')) })
  expect(view.queryByRole('region', { name: 'HIVEMIND connected apps' })).toBeNull()
})

it('binds a Preview mounted after the Environment effect and follows its edge', async () => {
  window.history.replaceState({}, '', '/hivemind/app/employee/harness/session/test')
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ accounts: [] }) })))
  const props = {
    sessionId: 'test', showDetails: vi.fn(), isPreviewOpen: () => true,
    useSessions: (select: (value: unknown) => unknown) => select({ byId: { test: { agentPreset: 'hivemind-hq' } }, jobsBySession: {} }),
  }
  const view = render(<BrainConnections {...props as unknown as Parameters<typeof BrainConnections>[0]} />)
  const panel = document.createElement('div')
  panel.dataset.sidebarRightPanel = 'push'; panel.dataset.sidebarRightOpen = ''
  let width = window.innerWidth * 0.3
  panel.getBoundingClientRect = () => ({ width, left: window.innerWidth - width } as DOMRect)
  await act(async () => { document.body.append(panel) })
  expect(view.getByRole('button', { name: /Connected apps/ }).getAttribute('aria-expanded')).toBe('false')
  expect(Number.parseFloat(view.getByRole('region', { name: 'HIVEMIND connected apps' }).style.right)).toBeCloseTo(width + 8)
  await act(async () => { width = window.innerWidth * 0.45 - 0.01; fireEvent(window, new Event('resize')) })
  expect(view.queryByRole('region', { name: 'HIVEMIND connected apps' })).toBeNull()
  expect(view.getByRole('button', { name: 'HIVEMIND environment' }).textContent).toContain('Runtime')
  fireEvent.click(view.getByRole('button', { name: 'HIVEMIND environment' }))
  expect(view.getByRole('region', { name: 'HIVEMIND connected apps' })).toBeTruthy()
  await act(async () => { panel.remove() })
  expect(view.getByRole('button', { name: /Connected apps/ }).getAttribute('aria-expanded')).toBe('true')
})

it.each(['hivemind-artifact-preview', 'text', 'hivemind-workbench-preview'])('uses the actual native %s caller for layout', async (kind) => {
  window.history.replaceState({}, '', '/hivemind/app/employee/harness/session/test')
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ accounts: [] }) })))
  const panel = document.createElement('div')
  panel.dataset.sidebarRightPanel = 'push'; panel.dataset.sidebarRightOpen = ''
  let width = window.innerWidth * 0.3
  panel.getBoundingClientRect = () => ({ width, left: window.innerWidth - width } as DOMRect)
  document.body.append(panel)
  const sidebar = { isExpanded: () => true, active: () => ({ kind }) }
  const props = {
    sessionId: 'test', showDetails: vi.fn(), isPreviewOpen: () => isEnvironmentPreviewOpen(sidebar),
    useSessions: (select: (value: unknown) => unknown) => select({ byId: { test: { agentPreset: 'hivemind-hq' } }, jobsBySession: {} }),
  }
  const view = render(<BrainConnections {...props as unknown as Parameters<typeof BrainConnections>[0]} />)
  expect(view.getByRole('button', { name: /Connected apps/ }).getAttribute('aria-expanded')).toBe('false')
  await act(async () => { width = window.innerWidth * 0.45 - 0.01; fireEvent(window, new Event('resize')) })
  expect(view.queryByRole('region', { name: 'HIVEMIND connected apps' })).toBeNull()
  expect(view.getByRole('button', { name: 'HIVEMIND environment' }).textContent).toContain('Runtime')
  fireEvent.click(view.getByRole('button', { name: 'HIVEMIND environment' }))
  expect(view.getByRole('region', { name: 'HIVEMIND connected apps' })).toBeTruthy()
})
it('preserves non-Preview employee detail behavior and closed state', () => {
  expect(isEnvironmentPreviewOpen({ isExpanded: () => true, active: () => ({ kind: 'hivemind-employee' }) })).toBe(false)
  expect(isEnvironmentPreviewOpen({ isExpanded: () => false, active: () => ({ kind: 'hivemind-artifact-preview' }) })).toBe(false)
})

it.each([0.9, 1])('keeps Environment before the native Preview boundary at zoom %s', async (scale) => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ accounts: [] }) })))
  const panel = document.createElement('div')
  panel.dataset.sidebarRightPanel = 'push'; panel.dataset.sidebarRightOpen = ''
  const layoutWidth = window.innerWidth * 0.3
  Object.defineProperty(panel, 'offsetWidth', { value: layoutWidth })
  let left = window.innerWidth - layoutWidth * scale
  panel.getBoundingClientRect = () => ({ width: layoutWidth * scale, left } as DOMRect)
  document.body.append(panel)
  const props = {
    sessionId: 'test', showDetails: vi.fn(), isPreviewOpen: () => true,
    useSessions: (select: (value: unknown) => unknown) => select({ byId: { test: { agentPreset: 'hivemind-hq' } }, jobsBySession: {} }),
  }
  const view = render(<BrainConnections {...props as unknown as Parameters<typeof BrainConnections>[0]} />)
  const environment = view.getByRole('region', { name: 'HIVEMIND connected apps' })
  expect(Number.parseFloat(environment.style.right)).toBeCloseTo(layoutWidth + 8)
  // A native slide changes position without changing the observed width.
  await act(async () => { left -= 20; fireEvent(panel, new Event('transitionend')) })
  expect(Number.parseFloat(environment.style.right)).toBeCloseTo(layoutWidth + 20 / scale + 8)
  expect(Number.parseFloat(environment.style.maxWidth)).toBeCloseTo(left / scale - 16)
})
