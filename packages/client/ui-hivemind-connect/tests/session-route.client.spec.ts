// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ISessions, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  HIVE_OVERVIEW_PATH,
  hivemindSessionPath,
  parseHivemindSessionRoute,
  setupHivemindSessionRouting,
} from '../src/client/session-route.ts'

function sid(value: string): SessionId { return value as SessionId }

function fixture(initial: SessionListState): {
  sessions: ISessions
  set: (state: SessionListState) => void
  open: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
} {
  let state = initial
  const listeners = new Set<() => void>()
  const open = vi.fn((id: SessionId) => {
    state = { ...state, current: id }
    for (const listener of listeners) listener()
  })
  const create = vi.fn(async () => sid('session-created'))
  return {
    sessions: {
      list: {
        getSnapshot: () => state,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      },
      open,
      create,
    } as unknown as ISessions,
    set: (next) => { state = next; for (const listener of listeners) listener() },
    open,
    create,
  }
}

function state(current?: string): SessionListState {
  const recent = sid('session-recent')
  const older = sid('session-older')
  const child = sid('session-child')
  return {
    phase: 'ready', ids: [recent, child, older], current: current === undefined ? undefined : sid(current),
    byId: {
      [recent]: { id: recent, displayTitle: 'Recent', running: false, blank: false, updatedAt: 3 },
      [child]: { id: child, displayTitle: 'Child', running: false, blank: false, updatedAt: 2, origin: 'subagent' },
      [older]: { id: older, displayTitle: 'Older', running: false, blank: false, updatedAt: 1 },
    },
    subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  }
}

beforeEach(() => { window.history.replaceState(null, '', HIVE_OVERVIEW_PATH) })
const disposers: Array<() => void> = []
afterEach(() => { while (disposers.length > 0) disposers.pop()?.() })

function install(sessions: ISessions): void {
  disposers.push(setupHivemindSessionRouting(sessions))
}

describe('HIVE native session routes', () => {
  it('does not pull HIVE sidebar navigation back into chat', () => {
    const harness = fixture(state())
    install(harness.sessions)
    window.history.pushState({ idx: 7 }, '', '/hivemind/app/connectors')
    harness.set(state('session-older'))
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(window.location.pathname).toBe('/hivemind/app/connectors')
    expect(window.history.state).toEqual({ idx: 7 })
  })

  it('preserves the shell router history state during session projection', () => {
    window.history.replaceState({ idx: 4, key: 'shell' }, '', HIVE_OVERVIEW_PATH)
    install(fixture(state()).sessions)
    expect(window.history.state).toEqual({ idx: 4, key: 'shell' })
  })
  it('parses only canonical opaque session paths', () => {
    expect(parseHivemindSessionRoute(HIVE_OVERVIEW_PATH)).toEqual({ kind: 'overview' })
    expect(parseHivemindSessionRoute(`${HIVE_OVERVIEW_PATH}/new`)).toEqual({ kind: 'new' })
    expect(parseHivemindSessionRoute(`${HIVE_OVERVIEW_PATH}/session/session-a`))
      .toEqual({ kind: 'session', sessionId: 'session-a' })
    expect(parseHivemindSessionRoute(`${HIVE_OVERVIEW_PATH}/session/session-a/overview/overview`))
      .toEqual({ kind: 'session', sessionId: 'session-a' })
    expect(parseHivemindSessionRoute(`${HIVE_OVERVIEW_PATH}/session/a/b`)).toEqual({ kind: 'invalid' })
  })

  it('opens the newest non-empty root and replaces the landing route', () => {
    const harness = fixture(state())
    const push = vi.spyOn(window.history, 'pushState')
    install(harness.sessions)
    expect(harness.open).toHaveBeenCalledWith('session-recent')
    expect(window.location.pathname).toBe(hivemindSessionPath(sid('session-recent')))
    expect(push).not.toHaveBeenCalled()
  })

  it('creates exactly once from /new and canonicalizes with replaceState', async () => {
    window.history.replaceState(null, '', `${HIVE_OVERVIEW_PATH}/new`)
    const harness = fixture({ ...state(), ids: [], byId: {} })
    install(harness.sessions)
    await vi.waitFor(() => { expect(harness.open).toHaveBeenCalledWith('session-created') })
    expect(harness.create).toHaveBeenCalledTimes(1)
    expect(window.location.pathname).toBe(hivemindSessionPath(sid('session-created')))
  })

  it('opens an exact listed root, pushes native selection, and follows popstate', () => {
    window.history.replaceState(null, '', `${HIVE_OVERVIEW_PATH}/session/session-older`)
    const harness = fixture(state('session-recent'))
    install(harness.sessions)
    expect(harness.open).toHaveBeenLastCalledWith('session-older')

    harness.set({ ...state('session-recent') })
    expect(window.location.pathname).toBe(`${HIVE_OVERVIEW_PATH}/session/session-recent`)

    window.history.replaceState(null, '', `${HIVE_OVERVIEW_PATH}/session/session-older`)
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(harness.open).toHaveBeenLastCalledWith('session-older')
  })

  it('repairs repeated Overview suffixes without losing the selected session', () => {
    window.history.replaceState(null, '', `${HIVE_OVERVIEW_PATH}/session/session-older/overview/overview`)
    const harness = fixture(state('session-recent'))
    install(harness.sessions)

    expect(harness.open).toHaveBeenLastCalledWith('session-older')
    expect(window.location.pathname).toBe(`${HIVE_OVERVIEW_PATH}/session/session-older`)
  })

  it('opens an opaque deep link absent from the bounded recent list', () => {
    window.history.replaceState(null, '', `${HIVE_OVERVIEW_PATH}/session/session-not-recent`)
    const harness = fixture(state())
    install(harness.sessions)
    expect(harness.open).toHaveBeenLastCalledWith('session-not-recent')
    expect(window.location.pathname).toBe(`${HIVE_OVERVIEW_PATH}/session/session-not-recent`)
  })

  it('does not promote a known subagent into the root conversation surface', () => {
    window.history.replaceState(null, '', `${HIVE_OVERVIEW_PATH}/session/session-child`)
    const harness = fixture(state())
    install(harness.sessions)
    expect(harness.open).toHaveBeenLastCalledWith('session-recent')
    expect(window.location.pathname).toBe(`${HIVE_OVERVIEW_PATH}/session/session-recent`)
  })
})
