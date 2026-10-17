import { afterEach, expect, it, vi } from 'vitest'
import { initialHistoryMessages, PAGE_MESSAGES } from '../src/client/sessions/session.ts'

afterEach(() => vi.unstubAllGlobals())
it('bounds the initial HIVE window without shrinking older native pages', () => {
  for (const pathname of ['/hivemind/app/overview/new', '/hivemind/app/overview/session/saved', '/hivemind/app/employee/harness/session/saved']) {
    vi.stubGlobal('window', { location: { pathname } })
    expect(initialHistoryMessages()).toBe(5)
  }
  expect(PAGE_MESSAGES).toBe(50)
  vi.stubGlobal('window', { location: { pathname: '/' } })
  expect(initialHistoryMessages()).toBe(50)
})
