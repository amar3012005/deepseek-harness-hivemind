import { afterEach, expect, it, vi } from 'vitest'
import { setupEmbeddedSessionBootstrap } from '../src/client/embedded-session-bootstrap.ts'
import type { ISessions, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

afterEach(() => vi.useRealTimers())

function fixture() {
  let state = { phase: 'pending', ids: [], current: undefined } as unknown as SessionListState
  const listeners = new Set<() => void>()
  const open = vi.fn(), create = vi.fn(async () => 'created' as SessionId)
  const sessions = { list: { getSnapshot: () => state, subscribe: (fn: () => void) => {
    listeners.add(fn); return () => listeners.delete(fn)
  } }, open, create } as unknown as Pick<ISessions, 'list' | 'open' | 'create'>
  return { sessions, open, create, set(next: Partial<SessionListState>) {
    state = { ...state, ...next }; for (const fn of listeners) fn()
  } }
}

it('does not create a competing blank session while catalog or exact-route resolution is pending', async () => {
  vi.useFakeTimers()
  const f = fixture(), stop = setupEmbeddedSessionBootstrap(f.sessions)
  await vi.advanceTimersByTimeAsync(1500)
  expect(f.create).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled()
  // The route owner chooses the existing durable room as the catalog arrives.
  f.set({ phase: 'ready', current: 'owned-runtime' as SessionId, ids: ['owned-runtime' as SessionId] })
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.create).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled()
  stop()
})

it('opens an existing catalog session once ready and creates only an authoritative empty catalog', async () => {
  vi.useFakeTimers()
  const f = fixture(), stop = setupEmbeddedSessionBootstrap(f.sessions)
  await vi.advanceTimersByTimeAsync(1000)
  f.set({ phase: 'ready', ids: ['owned' as SessionId] })
  await vi.advanceTimersByTimeAsync(50)
  expect(f.open).toHaveBeenCalledExactlyOnceWith('owned'); expect(f.create).not.toHaveBeenCalled()
  stop()
  const empty = fixture(), end = setupEmbeddedSessionBootstrap(empty.sessions)
  await vi.advanceTimersByTimeAsync(1000)
  empty.set({ phase: 'ready' })
  await vi.advanceTimersByTimeAsync(50)
  expect(empty.create).toHaveBeenCalledOnce(); expect(empty.open).toHaveBeenCalledWith('created')
  end()
})

it('does not create from a failed catalog or after disposal', async () => {
  vi.useFakeTimers()
  const f = fixture(), stop = setupEmbeddedSessionBootstrap(f.sessions)
  // A failed first catalog pull retains native phase=pending; no successful baseline exists.
  f.set({ phase: 'pending' })
  await vi.advanceTimersByTimeAsync(1500)
  expect(f.create).not.toHaveBeenCalled()
  f.set({ phase: 'ready' }); stop()
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.create).not.toHaveBeenCalled()
})
