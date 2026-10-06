// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ISessions, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  HIVE_EMPLOYEE_HARNESS_PATH,
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
  refresh: ReturnType<typeof vi.fn>
} {
  let state = initial
  const listeners = new Set<() => void>()
  const open = vi.fn((id: SessionId) => {
    state = { ...state, current: id }
    for (const listener of listeners) listener()
  })
  const create = vi.fn(({ sessionId }: { sessionId?: SessionId } = {}) => (
    Promise.resolve(sessionId ?? sid('session-created'))
  ))
  const refresh = vi.fn(async () => {})
  return {
    sessions: {
      list: {
        getSnapshot: () => state,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      },
      open,
      create,
      refresh,
    } as unknown as ISessions,
    set: (next) => { state = next; for (const listener of listeners) listener() },
    open,
    create,
    refresh,
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

function hyperagentState(current?: string): SessionListState {
  const list = state(current)
  const byId = { ...list.byId }
  for (const id of [sid('session-recent'), sid('session-older')]) {
    byId[id] = { ...byId[id]!, agentPreset: 'hivemind-hyperagents' }
  }
  return { ...list, byId }
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
    expect(parseHivemindSessionRoute(`${HIVE_EMPLOYEE_HARNESS_PATH}/session/session-a`))
      .toEqual({ kind: 'session', sessionId: 'session-a' })
  })

  it('opens the newest non-empty root and replaces the landing route', () => {
    const harness = fixture(state())
    const push = vi.spyOn(window.history, 'pushState')
    install(harness.sessions)
    expect(harness.open).toHaveBeenCalledWith('session-recent')
    expect(window.location.pathname).toBe(hivemindSessionPath(sid('session-recent')))
    expect(push).not.toHaveBeenCalled()
  })

  it('keeps the employee Harness URL when opening a linked session and selecting another', () => {
    window.history.replaceState(null, '', `${HIVE_EMPLOYEE_HARNESS_PATH}/session/session-older`)
    const harness = fixture(hyperagentState())
    install(harness.sessions)
    expect(harness.open).toHaveBeenCalledWith('session-older')
    expect(window.location.pathname).toBe(`${HIVE_EMPLOYEE_HARNESS_PATH}/session/session-older`)
    harness.set(hyperagentState('session-recent'))
    expect(window.location.pathname).toBe(`${HIVE_EMPLOYEE_HARNESS_PATH}/session/session-recent`)
  })

  it('routes an old HyperAgents session away from BRAIN to the newest Chat session', async () => {
    window.history.replaceState(null, '', `${HIVE_OVERVIEW_PATH}/session/session-older`)
    const mixed = state()
    mixed.byId[sid('session-older')] = {
      ...mixed.byId[sid('session-older')]!, agentPreset: 'hivemind-hyperagents',
    }
    const harness = fixture(mixed)
    install(harness.sessions)
    await vi.waitFor(() => { expect(harness.open).toHaveBeenCalledWith('session-recent') })
    expect(window.location.pathname).toBe(`${HIVE_OVERVIEW_PATH}/session/session-recent`)
  })

  it('does not admit a blank HyperAgents session into a BRAIN route', async () => {
    window.history.replaceState(null, '', `${HIVE_OVERVIEW_PATH}/session/session-older`)
    const mixed = state('session-older')
    mixed.byId[sid('session-older')] = {
      ...mixed.byId[sid('session-older')]!, blank: true,
      agentPreset: 'hivemind-hyperagents',
      projectionValues: { agentPreset: 'hivemind-hyperagents' },
    }
    const harness = fixture(mixed)
    install(harness.sessions)
    await vi.waitFor(() => { expect(harness.open).toHaveBeenCalledWith('session-recent') })
    expect(window.location.pathname).toBe(`${HIVE_OVERVIEW_PATH}/session/session-recent`)
  })

  it('creates exactly once from /new and canonicalizes with replaceState', async () => {
    window.history.replaceState(null, '', `${HIVE_OVERVIEW_PATH}/new`)
    const harness = fixture({ ...state(), ids: [], byId: {} })
    install(harness.sessions)
    await vi.waitFor(() => { expect(harness.open).toHaveBeenCalledWith('session-created') })
    expect(harness.create).toHaveBeenCalledTimes(1)
    expect(harness.create).toHaveBeenCalledWith({ agentPreset: 'hivemind-chat' })
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

  it('refreshes an opaque deep link and never creates a replacement session for it', async () => {
    window.history.replaceState(null, '', `${HIVE_OVERVIEW_PATH}/session/session-not-recent`)
    const harness = fixture(state())
    install(harness.sessions)
    await vi.waitFor(() => { expect(harness.refresh).toHaveBeenCalledOnce() })
    expect(harness.create).not.toHaveBeenCalled()
    expect(harness.open).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe(`${HIVE_OVERVIEW_PATH}/session/session-not-recent`)
  })

  it('preserves a missing current route without recreating the deleted id', async () => {
    window.history.replaceState(null, '', `${HIVE_OVERVIEW_PATH}/session/session-older`)
    const harness = fixture(state('session-older'))
    install(harness.sessions)
    const next = state()
    const { [sid('session-older')]: _removed, ...remaining } = next.byId
    next.byId = remaining
    next.ids = next.ids.filter(id => id !== sid('session-older'))
    harness.set(next)
    await vi.waitFor(() => { expect(harness.refresh).toHaveBeenCalled() })
    expect(harness.create).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe(`${HIVE_OVERVIEW_PATH}/session/session-older`)
  })

  it('does not promote a known subagent into the root conversation surface', () => {
    window.history.replaceState(null, '', `${HIVE_OVERVIEW_PATH}/session/session-child`)
    const harness = fixture(state())
    install(harness.sessions)
    expect(harness.open).toHaveBeenLastCalledWith('session-recent')
    expect(window.location.pathname).toBe(`${HIVE_OVERVIEW_PATH}/session/session-recent`)
  })
})

describe('dedicated Dreaming conversation route', () => {
  it('opens the native child address without creating or selecting a regular session', async () => {
    window.history.replaceState(null, '', `${HIVE_OVERVIEW_PATH}/session/session-child?dreamingParent=session-parent`)
    const f = fixture(state())
    const child = vi.fn()
    f.sessions.openSubagent = child
    f.sessions.refreshSubagents = vi.fn().mockResolvedValue(undefined)
    const dispose = setupHivemindSessionRouting(f.sessions)
    disposers.push(dispose)
    await Promise.resolve()
    expect(f.sessions.refreshSubagents).toHaveBeenCalledWith('session-parent')
    expect(child).toHaveBeenCalledWith({ parentSessionId: 'session-parent', childSessionId: 'session-child', mode: 'continuable' })
    expect(f.open).not.toHaveBeenCalled()
    expect(f.create).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe(`${HIVE_OVERVIEW_PATH}/dreaming`)
    expect(window.location.search).toBe('')
  })
  it('resolves the direct room through the authenticated tenant activity', async () => {
    window.history.replaceState(null, '', `${HIVE_OVERVIEW_PATH}/dreaming`)
    const f = fixture(state())
    f.sessions.openSubagent = vi.fn()
    f.sessions.refreshSubagents = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ activity: { session: {
      parentSessionId: 'session-parent', childSessionId: 'session-child', mode: 'continuable',
    } } }) }))
    disposers.push(setupHivemindSessionRouting(f.sessions))
    await vi.waitFor(() =>{  expect(f.sessions.openSubagent).toHaveBeenCalled() })
    expect(f.create).not.toHaveBeenCalled()
    expect(f.open).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe(`${HIVE_OVERVIEW_PATH}/dreaming`)
    f.set(state('session-recent'))
    expect(window.location.pathname).toBe(`${HIVE_OVERVIEW_PATH}/dreaming`)
    vi.unstubAllGlobals()
  })
  it('preserves the Dreaming route while the native child catalog is loading', async () => {
    window.history.replaceState(null, '', `${HIVE_OVERVIEW_PATH}/session/session-child?dreamingParent=session-parent`)
    const f = fixture(state())
    let resolve!: () => void
    f.sessions.refreshSubagents = vi.fn(() => new Promise<void>((done) => { resolve = done }))
    f.sessions.openSubagent = vi.fn()
    disposers.push(setupHivemindSessionRouting(f.sessions))
    f.set(state('session-recent'))
    expect(window.location.search).toBe('?dreamingParent=session-parent')
    expect(f.create).not.toHaveBeenCalled()
    expect(f.open).not.toHaveBeenCalled()
    resolve()
    await Promise.resolve()
    expect(f.sessions.openSubagent).toHaveBeenCalled()
  })
  it('keeps the child address on subsequent list notifications', () => {
    window.history.replaceState(null, '', `${HIVE_OVERVIEW_PATH}/session/session-child?dreamingParent=session-parent`)
    const f = fixture(state())
    f.sessions.openSubagent = vi.fn()
    f.sessions.refreshSubagents = vi.fn().mockResolvedValue(undefined)
    disposers.push(setupHivemindSessionRouting(f.sessions))
    f.set({ ...state('session-child'), currentAddress: { parentSessionId: sid('session-parent'), childSessionId: sid('session-child'), mode: 'continuable' } })
    expect(f.open).not.toHaveBeenCalled()
    expect(window.location.search).toBe('?dreamingParent=session-parent')
  })
})
