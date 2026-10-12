// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ISessions, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  HIVE_EMPLOYEE_HARNESS_PATH,
  HIVE_OVERVIEW_PATH,
  hivemindSessionPath,
  isHivemindRoute,
  parseHivemindSessionRoute,
  setupHivemindSessionRouting,
} from '../src/client/session-route.ts'

function sid(value: string): SessionId { return value as SessionId }

function fixture(initial: SessionListState): {
  sessions: ISessions
  uiWorkspace: { openSession: ReturnType<typeof vi.fn> }
  remote: { session: { create: ReturnType<typeof vi.fn>; employeeRoom: ReturnType<typeof vi.fn> } }
  set: (state: SessionListState) => void
  open: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  employeeRoom: ReturnType<typeof vi.fn>
  failed: ReturnType<typeof vi.fn<(error: unknown) => void>>
  refresh: ReturnType<typeof vi.fn>
} {
  let state = initial
  const listeners = new Set<() => void>()
  const open = vi.fn((id: SessionId) => {
    state = { ...state, byId: Object.fromEntries(Object.entries(state.byId).map(([key, row]) => [key, {
      ...row, retainedBy: key === id ? { mainView: 1 } : {},
    }])) }
    for (const listener of listeners) listener()
  })
  const create = vi.fn(async () => ({ ok: true as const, value: { sessionId: sid('session-created') } }))
  const employeeRoom = vi.fn(async () => ({ ok: true as const, value: { sessionId: sid('session-runtime') } }))
  const refresh = vi.fn(async () => {})
  const uiWorkspace = { openSession: open }
  const remote = { session: { create, employeeRoom } }
  const failed = vi.fn()
  return {
    sessions: {
      list: {
        getSnapshot: () => state,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      },
      refresh,
    } as unknown as ISessions,
    uiWorkspace,
    remote,
    set: (next) => { state = next; for (const listener of listeners) listener() },
    open,
    create,
    employeeRoom,
    failed,
    refresh,
  }
}

function state(current?: string): SessionListState {
  const recent = sid('session-recent')
  const older = sid('session-older')
  const child = sid('session-child')
  return {
    phase: 'ready', ids: [recent, child, older],
    byId: {
      [recent]: { id: recent, displayTitle: 'Recent', running: false, blank: false, updatedAt: 3, retainedBy: current === 'session-recent' ? { mainView: 1 } : {} },
      [child]: { id: child, displayTitle: 'Child', running: false, blank: false, updatedAt: 2, origin: 'subagent', retainedBy: {} },
      [older]: { id: older, displayTitle: 'Older', running: false, blank: false, updatedAt: 1, retainedBy: current === 'session-older' ? { mainView: 1 } : {} },
    },
    projectionsBySession: {},
  }
}

function hyperagentState(current?: string): SessionListState {
  const list = state(current)
  const byId = { ...list.byId }
  for (const id of [sid('session-recent'), sid('session-older')]) {
    byId[id] = { ...byId[id]!, projectionValues: { agentPreset: 'hivemind-hyperagents' } }
  }
  return { ...list, byId }
}

beforeEach(() => { window.history.replaceState(null, '', HIVE_OVERVIEW_PATH) })
const disposers: Array<() => void> = []
afterEach(() => { while (disposers.length > 0) disposers.pop()?.() })

function install(f: ReturnType<typeof fixture>): void {
  disposers.push(setupHivemindSessionRouting(
    f.sessions, f.uiWorkspace as never, f.remote as never, window,
    (error: unknown) => { f.failed(error) },
  ))
}

describe('HIVE native session routes', () => {
  it('recognizes official agent surfaces without changing unrelated native routes', () => {
    expect(isHivemindRoute(HIVE_EMPLOYEE_HARNESS_PATH)).toBe(true)
    expect(isHivemindRoute(`${HIVE_EMPLOYEE_HARNESS_PATH}/session/session-older`)).toBe(true)
    expect(isHivemindRoute(HIVE_OVERVIEW_PATH)).toBe(true)
    expect(isHivemindRoute('/chat/session/session-older')).toBe(false)
  })

  it('activates a durable exact route even when its selection was already restored', () => {
    window.history.replaceState({}, '', `${HIVE_EMPLOYEE_HARNESS_PATH}/session/session-older`)
    const harness = fixture(hyperagentState('session-older'))
    install(harness)
    expect(harness.open).toHaveBeenCalledExactlyOnceWith(sid('session-older'))
    expect(harness.create).not.toHaveBeenCalled()
    harness.set(hyperagentState('session-older'))
    expect(harness.open).toHaveBeenCalledTimes(1)
  })

  it('does not pull HIVE sidebar navigation back into chat', () => {
    const harness = fixture(state())
    install(harness)
    window.history.pushState({ idx: 7 }, '', '/hivemind/app/connectors')
    harness.set(state('session-older'))
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(window.location.pathname).toBe('/hivemind/app/connectors')
    expect(window.history.state).toEqual({ idx: 7 })
  })

  it('preserves the shell router history state during session projection', () => {
    window.history.replaceState({ idx: 4, key: 'shell' }, '', HIVE_OVERVIEW_PATH)
    install(fixture(state()))
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
    install(harness)
    expect(harness.open).toHaveBeenCalledWith('session-recent')
    expect(window.location.pathname).toBe(hivemindSessionPath(sid('session-recent')))
    expect(push).not.toHaveBeenCalled()
  })

  it('keeps the employee Harness URL when opening a linked session and selecting another', () => {
    window.history.replaceState(null, '', `${HIVE_EMPLOYEE_HARNESS_PATH}/session/session-older`)
    const harness = fixture(hyperagentState())
    install(harness)
    expect(harness.open).toHaveBeenCalledWith('session-older')
    expect(window.location.pathname).toBe(`${HIVE_EMPLOYEE_HARNESS_PATH}/session/session-older`)
    harness.set(hyperagentState('session-recent'))
    expect(window.location.pathname).toBe(`${HIVE_EMPLOYEE_HARNESS_PATH}/session/session-recent`)
  })

  it('routes an old HyperAgents session away from BRAIN to the newest Chat session', async () => {
    window.history.replaceState(null, '', `${HIVE_OVERVIEW_PATH}/session/session-older`)
    const mixed = state()
    mixed.byId[sid('session-older')] = {
      ...mixed.byId[sid('session-older')]!, projectionValues: { agentPreset: 'hivemind-hyperagents' },
    }
    const harness = fixture(mixed)
    install(harness)
    await vi.waitFor(() => { expect(harness.open).toHaveBeenCalledWith('session-recent') })
    expect(window.location.pathname).toBe(`${HIVE_OVERVIEW_PATH}/session/session-recent`)
  })

  it('does not admit a blank HyperAgents session into a BRAIN route', async () => {
    window.history.replaceState(null, '', `${HIVE_OVERVIEW_PATH}/session/session-older`)
    const mixed = state('session-older')
    mixed.byId[sid('session-older')] = {
      ...mixed.byId[sid('session-older')]!, blank: true,
      projectionValues: { agentPreset: 'hivemind-hyperagents' },
    }
    const harness = fixture(mixed)
    install(harness)
    await vi.waitFor(() => { expect(harness.open).toHaveBeenCalledWith('session-recent') })
    expect(window.location.pathname).toBe(`${HIVE_OVERVIEW_PATH}/session/session-recent`)
  })

  it('creates exactly once from /new and canonicalizes with replaceState', async () => {
    window.history.replaceState(null, '', `${HIVE_OVERVIEW_PATH}/new`)
    const harness = fixture({ ...state(), ids: [], byId: {} })
    install(harness)
    await vi.waitFor(() => { expect(harness.open).toHaveBeenCalledWith('session-created') })
    expect(harness.create).toHaveBeenCalledTimes(1)
    expect(harness.create).toHaveBeenCalledWith({ agentPreset: 'hivemind-chat' })
    expect(window.location.pathname).toBe(hivemindSessionPath(sid('session-created')))
  })

  it('resolves the canonical Runtime room from the employee /new route', async () => {
    window.history.replaceState(null, '', `${HIVE_EMPLOYEE_HARNESS_PATH}/new`)
    const harness = fixture({ ...state(), ids: [], byId: {} })
    install(harness)
    await vi.waitFor(() => { expect(harness.open).toHaveBeenCalledWith('session-runtime') })
    expect(harness.employeeRoom).toHaveBeenCalledExactlyOnceWith({ employeeId: 'runtime' })
    expect(harness.create).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe(`${HIVE_EMPLOYEE_HARNESS_PATH}/session/session-runtime`)
  })

  it('keeps the employee route and shows failure without opening a fallback room', async () => {
    window.history.replaceState(null, '', `${HIVE_EMPLOYEE_HARNESS_PATH}/new`)
    const harness = fixture({ ...state(), ids: [], byId: {} })
    harness.employeeRoom.mockResolvedValueOnce({ ok: false, error: { code: 'auth/forbidden', message: 'Room unavailable', details: {} } } as never)
    install(harness)
    await vi.waitFor(() => { expect(harness.failed).toHaveBeenCalledOnce() })
    expect(harness.failed.mock.calls[0]?.[0]).toMatchObject({ message: 'Room unavailable' })
    expect(harness.open).not.toHaveBeenCalled()
    expect(harness.create).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe(`${HIVE_EMPLOYEE_HARNESS_PATH}/new`)
  })

  it('does not retry a failed creation on unchanged list refreshes', async () => {
    const empty = { ...state(), ids: [], byId: {} }
    const harness = fixture(empty)
    harness.create.mockResolvedValue({ ok: false, error: { code: 'session/unavailable', message: 'Unavailable', details: {} } })
    install(harness)
    await vi.waitFor(() => { expect(harness.create).toHaveBeenCalledTimes(1) })
    await Promise.resolve()
    for (let index = 0; index < 3; index++) {
      harness.set({ ...empty })
      await Promise.resolve()
      await Promise.resolve()
    }
    expect(harness.create).toHaveBeenCalledTimes(1)
    expect(harness.open).not.toHaveBeenCalled()
  })

  it('opens an exact listed root, pushes native selection, and follows popstate', () => {
    window.history.replaceState(null, '', `${HIVE_OVERVIEW_PATH}/session/session-older`)
    const harness = fixture(state('session-recent'))
    install(harness)
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
    install(harness)

    expect(harness.open).toHaveBeenLastCalledWith('session-older')
    expect(window.location.pathname).toBe(`${HIVE_OVERVIEW_PATH}/session/session-older`)
  })

  it('refreshes an opaque deep link and never creates a replacement session for it', async () => {
    window.history.replaceState(null, '', `${HIVE_OVERVIEW_PATH}/session/session-not-recent`)
    const harness = fixture(state())
    install(harness)
    await vi.waitFor(() => { expect(harness.refresh).toHaveBeenCalledOnce() })
    expect(harness.create).not.toHaveBeenCalled()
    expect(harness.open).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe(`${HIVE_OVERVIEW_PATH}/session/session-not-recent`)
  })

  it('preserves a missing current route without recreating the deleted id', async () => {
    window.history.replaceState(null, '', `${HIVE_OVERVIEW_PATH}/session/session-older`)
    const harness = fixture(state('session-older'))
    install(harness)
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
    install(harness)
    expect(harness.open).toHaveBeenLastCalledWith('session-recent')
    expect(window.location.pathname).toBe(`${HIVE_OVERVIEW_PATH}/session/session-recent`)
  })
})

describe('dedicated Dreaming conversation route', () => {
  it('opens the native child address without creating or selecting a regular session', async () => {
    window.history.replaceState(null, '', `${HIVE_OVERVIEW_PATH}/session/session-child?dreamingParent=session-parent`)
    const f = fixture(state())
    const dispose = setupHivemindSessionRouting(f.sessions, f.uiWorkspace as never, f.remote as never)
    disposers.push(dispose)
    await Promise.resolve()
    expect(f.refresh).toHaveBeenCalled()
    expect(f.open).toHaveBeenCalledWith({ parentSessionId: 'session-parent', childSessionId: 'session-child', mode: 'continuable' })
    expect(f.create).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe(`${HIVE_OVERVIEW_PATH}/dreaming`)
    expect(window.location.search).toBe('')
  })
  it('resolves the direct room through the authenticated tenant activity', async () => {
    window.history.replaceState(null, '', `${HIVE_OVERVIEW_PATH}/dreaming`)
    const f = fixture(state())
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ activity: { session: {
      parentSessionId: 'session-parent', childSessionId: 'session-child', mode: 'continuable',
    } } }) }))
    disposers.push(setupHivemindSessionRouting(f.sessions, f.uiWorkspace as never, f.remote as never))
    await vi.waitFor(() =>{  expect(f.open).toHaveBeenCalledWith({ parentSessionId: 'session-parent', childSessionId: 'session-child', mode: 'continuable' }) })
    expect(f.create).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe(`${HIVE_OVERVIEW_PATH}/dreaming`)
    f.set(state('session-recent'))
    expect(window.location.pathname).toBe(`${HIVE_OVERVIEW_PATH}/dreaming`)
    vi.unstubAllGlobals()
  })
  it('preserves the Dreaming route while the native child catalog is loading', async () => {
    window.history.replaceState(null, '', `${HIVE_OVERVIEW_PATH}/session/session-child?dreamingParent=session-parent`)
    const f = fixture(state())
    let resolve!: () => void
    f.sessions.refresh = vi.fn(() => new Promise<void>((done) => { resolve = done }))
    disposers.push(setupHivemindSessionRouting(f.sessions, f.uiWorkspace as never, f.remote as never))
    f.set(state('session-recent'))
    expect(window.location.search).toBe('?dreamingParent=session-parent')
    expect(f.create).not.toHaveBeenCalled()
    expect(f.open).not.toHaveBeenCalled()
    resolve()
    await Promise.resolve()
    expect(f.open).toHaveBeenCalledWith({ parentSessionId: 'session-parent', childSessionId: 'session-child', mode: 'continuable' })
  })
  it('keeps the child address on subsequent list notifications', () => {
    window.history.replaceState(null, '', `${HIVE_OVERVIEW_PATH}/session/session-child?dreamingParent=session-parent`)
    const f = fixture(state())
    disposers.push(setupHivemindSessionRouting(f.sessions, f.uiWorkspace as never, f.remote as never))
    f.set(state('session-child'))
    expect(f.open).not.toHaveBeenCalled()
    expect(window.location.search).toBe('?dreamingParent=session-parent')
  })
})
