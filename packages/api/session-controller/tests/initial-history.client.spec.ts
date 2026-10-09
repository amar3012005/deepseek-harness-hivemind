import { afterEach, expect, it, vi } from 'vitest'
import { initialHistoryTurns } from '../src/client/sessions/session.ts'

afterEach(() => { vi.unstubAllGlobals() })

it('opens five recent turns on phones while retaining twenty on desktop', () => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) })
  expect(initialHistoryTurns()).toBe(5)
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
  expect(initialHistoryTurns()).toBe(20)
})
