// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isExternalEmployeeHarness, setupExternalEmployeeSidebar } from '../src/client/external-sidebar.ts'

afterEach(() => {
  document.querySelector('[data-os-harness-rooms]')?.remove()
  document.querySelector('a[href="/hivemind/app/connectors"]')?.remove()
  delete document.documentElement.dataset.dshEmbedded
  window.history.replaceState({}, '', '/')
  vi.restoreAllMocks()
})

describe('outer-owned employee sidebar', () => {
  it('uses the native external-sidebar input for Brain when its outer navigation exists', () => {
    window.history.replaceState({}, '', '/hivemind/app/overview/new')
    const outer = document.createElement('a')
    outer.href = '/hivemind/app/connectors'
    document.body.append(outer)
    const setExternalSidebar = vi.fn()
    const dispose = setupExternalEmployeeSidebar({ setExternalSidebar })
    expect(setExternalSidebar).toHaveBeenLastCalledWith(true)
    dispose()
    expect(setExternalSidebar).toHaveBeenLastCalledWith(false)
  })
  it('requires both the employee Harness route and the outer Rooms host marker', () => {
    const outer = document.createElement('div')
    outer.setAttribute('data-os-harness-rooms', '')
    document.body.append(outer)

    expect(isExternalEmployeeHarness('/hivemind/app/employee/harness/session/s-1', document)).toBe(true)
    expect(isExternalEmployeeHarness('/hivemind/app/employee/harness/session/s-1', document.body)).toBe(true)
    expect(isExternalEmployeeHarness('/hivemind/app/overview', document)).toBe(false)
  })

  it('enables only while the product host exists and restores its marker on leave and disposal', async () => {
    window.history.replaceState({}, '', '/hivemind/app/employee/harness/session/s-1')
    document.documentElement.dataset.dshEmbedded = 'preexisting'
    const setExternalSidebar = vi.fn()
    const dispose = setupExternalEmployeeSidebar({ setExternalSidebar })
    const outer = document.createElement('div')
    outer.setAttribute('data-os-harness-rooms', '')
    document.body.append(outer)

    await vi.waitFor(() => expect(setExternalSidebar).toHaveBeenLastCalledWith(true))
    expect(document.documentElement.dataset.dshEmbedded).toBe('true')

    outer.remove()
    await vi.waitFor(() => expect(setExternalSidebar).toHaveBeenLastCalledWith(false))
    expect(document.documentElement.dataset.dshEmbedded).toBe('preexisting')

    dispose()
    expect(setExternalSidebar).toHaveBeenLastCalledWith(false)
    expect(document.documentElement.dataset.dshEmbedded).toBe('preexisting')
  })

  it('cleans up the layout state and marker if disposed while active', async () => {
    window.history.replaceState({}, '', '/hivemind/app/employee/harness')
    const outer = document.createElement('div')
    outer.setAttribute('data-os-harness-rooms', '')
    document.body.append(outer)
    const setExternalSidebar = vi.fn()
    const dispose = setupExternalEmployeeSidebar({ setExternalSidebar })
    expect(setExternalSidebar).toHaveBeenLastCalledWith(true)
    dispose()
    expect(setExternalSidebar).toHaveBeenLastCalledWith(false)
    expect(document.documentElement.dataset.dshEmbedded).toBeUndefined()
  })
})
