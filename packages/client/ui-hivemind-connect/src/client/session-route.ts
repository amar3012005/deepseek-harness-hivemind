import type { ISessions, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export const HIVE_OVERVIEW_PATH = '/hivemind/app/overview'
export const HIVE_EMPLOYEE_HARNESS_PATH = '/hivemind/app/employee/harness'
const LEGACY_HIVE_OVERVIEW_PATH = '/hivemind/app/v1/overview'
const SESSION_PATH_PREFIX = `${HIVE_OVERVIEW_PATH}/session/`
const EMPLOYEE_SESSION_PATH_PREFIX = `${HIVE_EMPLOYEE_HARNESS_PATH}/session/`

function routeBase(pathname: string): string {
  return pathname.startsWith(EMPLOYEE_SESSION_PATH_PREFIX) || (pathname === HIVE_EMPLOYEE_HARNESS_PATH || pathname === `${HIVE_EMPLOYEE_HARNESS_PATH}/new`)
    ? HIVE_EMPLOYEE_HARNESS_PATH : HIVE_OVERVIEW_PATH
}

export function isHivemindRoute(pathname: string): boolean {
  return pathname.startsWith(HIVE_OVERVIEW_PATH)
    || pathname.startsWith(EMPLOYEE_SESSION_PATH_PREFIX)
    || pathname === HIVE_EMPLOYEE_HARNESS_PATH
    || pathname === `${HIVE_EMPLOYEE_HARNESS_PATH}/new`
    || pathname === LEGACY_HIVE_OVERVIEW_PATH
}

type Route =
  | { readonly kind: 'overview' }
  | { readonly kind: 'new' }
  | { readonly kind: 'session'; readonly sessionId: SessionId }
  | { readonly kind: 'invalid' }

interface BrowserRoute {
  readonly location: Pick<Location, 'pathname'> & { readonly search?: string }
  readonly history: Pick<History, 'pushState' | 'replaceState' | 'state'>
  addEventListener(type: 'popstate', listener: () => void): void
  removeEventListener(type: 'popstate', listener: () => void): void
}

/** Parse only the public HIVE route grammar. Session ids remain opaque. */
export function parseHivemindSessionRoute(pathname: string): Route {
  if (pathname === HIVE_OVERVIEW_PATH || pathname === HIVE_EMPLOYEE_HARNESS_PATH || pathname === LEGACY_HIVE_OVERVIEW_PATH) return { kind: 'overview' }
  if (pathname === `${HIVE_OVERVIEW_PATH}/new` || pathname === `${HIVE_EMPLOYEE_HARNESS_PATH}/new`) return { kind: 'new' }
  const prefix = pathname.startsWith(EMPLOYEE_SESSION_PATH_PREFIX) ? EMPLOYEE_SESSION_PATH_PREFIX : SESSION_PATH_PREFIX
  if (!pathname.startsWith(prefix)) return { kind: 'invalid' }
  const [encoded, ...suffix] = pathname.slice(prefix.length).split('/')
  if (encoded === undefined || encoded === '' || encoded.length > 512
    || (suffix.length > 0 && suffix.some(segment => segment !== 'overview'))) return { kind: 'invalid' }
  try {
    const value = decodeURIComponent(encoded)
    if (value === '' || value.includes('/') || value.length > 256) return { kind: 'invalid' }
    return { kind: 'session', sessionId: value as SessionId }
  } catch {
    return { kind: 'invalid' }
  }
}

export function hivemindSessionPath(sessionId: SessionId, base = HIVE_OVERVIEW_PATH): string {
  return `${base}/session/${encodeURIComponent(sessionId)}`
}

function matchesMode(state: SessionListState, sessionId: SessionId, base: string): boolean {
  const summary = state.byId[sessionId]
  if (summary === undefined) return false
  const preset = summary.projectionValues?.agentPreset ?? state.projectionsBySession[sessionId]?.values.agentPreset
  // A newly opened OS blank begins with the Chat creation header until its
  // selection event lands. A saved HyperAgents selection must still win.
  if (summary.blank && base === HIVE_EMPLOYEE_HARNESS_PATH && isMainView(state, sessionId)
    && preset === 'hivemind-chat' && summary.projectionValues?.agentPreset == null) return true
  if (summary.blank && preset == null) return true
  const hyperagent = preset === 'hivemind-hyperagents' || preset === 'hivemind-hq'
    || preset === 'hyperagents' || preset === 'hyperagents-compressed'
  return base === HIVE_EMPLOYEE_HARNESS_PATH ? hyperagent : !hyperagent
}

function isMainView(state: SessionListState, sessionId: SessionId | undefined): boolean {
  return sessionId !== undefined && (state.byId[sessionId]?.retainedBy.mainView ?? 0) > 0
}

function mainViewSession(state: SessionListState): SessionId | undefined {
  return Object.values(state.byId).find(row => (row.retainedBy.mainView ?? 0) > 0)?.id
}

function rootSession(state: SessionListState, sessionId: SessionId | undefined, base: string): SessionId | undefined {
  if (sessionId === undefined) return undefined
  const summary = state.byId[sessionId]
  return summary !== undefined && summary.origin !== 'subagent' && matchesMode(state, sessionId, base)
    ? sessionId : undefined
}

function newestRoot(state: SessionListState, base: string): SessionId | undefined {
  return state.ids.find(id => state.byId[id]?.origin !== 'subagent'
    && state.byId[id]?.blank === false && matchesMode(state, id, base))
    ?? state.ids.find(id => state.byId[id]?.origin !== 'subagent' && matchesMode(state, id, base))
}

/**
 * Bind native Session selection to the public HIVE URL. The Session Controller
 * remains the only session owner and authorization boundary. The recent list
 * is intentionally bounded, so an opaque deep-linked id must still be opened
 * through the controller even when it is not present in that projection.
 */
export function setupHivemindSessionRouting(
  sessions: ISessions,
  uiWorkspace: UiWorkspace,
  remote: ClientRemote,
  browser: BrowserRoute = window,
  onEmployeeRoomFailure: (error: unknown) => void = () => undefined,
): () => void {
  let disposed = false
  let applyingRoute = false
  let creating = false
  let resolving = false
  let resolvingDream = false
  let generation = 0
  let initialized = false
  let observedCurrent: SessionId | undefined
  let currentBase = routeBase(browser.location.pathname)
  const sessionPath = (id: SessionId): string => hivemindSessionPath(id, currentBase)
  const rootForRoute = (state: SessionListState, id: SessionId | undefined): SessionId | undefined => {
    if (id === undefined) return undefined
    return rootSession(state, id, currentBase)
  }

  const replace = (path: string): void => {
    if (browser.location.pathname !== path) browser.history.replaceState(browser.history.state, '', path)
  }

  const selectOrCreate = (state: SessionListState, forceCreate: boolean): void => {
    if (creating) return
    const attempt = ++generation
    const selected = forceCreate ? undefined : newestRoot(state, currentBase)
    if (selected !== undefined) {
      applyingRoute = true
      initialized = true
      observedCurrent = selected
      uiWorkspace.openSession(selected)
      replace(sessionPath(selected))
      applyingRoute = false
      return
    }
    creating = true
    const creatingBase = currentBase
    const target = creatingBase === HIVE_EMPLOYEE_HARNESS_PATH
      ? remote.session.employeeRoom({ employeeId: 'runtime' }).then((result) => {
        if (!result.ok) throw new Error(result.error.message)
        return result.value.sessionId
      })
      : remote.session.create({ agentPreset: 'hivemind-chat' }).then((result) => {
        if (!result.ok) throw new Error(result.error.message)
        return result.value.sessionId
      })
    void target.then(async (sessionId) => {
      await sessions.refresh()
      if (disposed || attempt !== generation) return
      applyingRoute = true
      initialized = true
      observedCurrent = sessionId
      uiWorkspace.openSession(sessionId)
      replace(sessionPath(sessionId))
      applyingRoute = false
    }).catch((error: unknown) => {
      if (!disposed && attempt === generation) {
        // A list refresh is not a request to retry a failed creation. Keep this
        // route initialized until explicit navigation starts a new attempt.
        // This also contains uncertain transport failures: creating another
        // Session could duplicate a request already accepted by the Host.
        initialized = true
        if (creatingBase === HIVE_EMPLOYEE_HARNESS_PATH) onEmployeeRoomFailure(error)
        else replace(currentBase)
      }
    }).finally(() => { creating = false })
  }

  const selectExact = (state: SessionListState, sessionId: SessionId): void => {
    if (creating || resolving) return
    if (rootForRoute(state, sessionId) !== undefined) {
      applyingRoute = true
      initialized = true
      observedCurrent = sessionId
      uiWorkspace.openSession(sessionId)
      replace(sessionPath(sessionId))
      applyingRoute = false
      return
    }
    // A route identifies an existing durable Session; it is never permission
    // to create a new one. Refresh once to cover a boot/list race, then
    // retain the exact address if the host still does not project it. A
    // bounded list or interrupted refresh is not evidence of deletion.
    const attempt = ++generation
    resolving = true
    void sessions.refresh().then(() => {
      if (disposed || attempt !== generation) return
      const refreshed = sessions.list.getSnapshot()
      if (rootForRoute(refreshed, sessionId) !== undefined) {
        applyingRoute = true
        initialized = true
        observedCurrent = sessionId
        uiWorkspace.openSession(sessionId)
        replace(sessionPath(sessionId))
        applyingRoute = false
        return
      }
      if (refreshed.byId[sessionId] !== undefined) {
        // A known session in another product surface retains mode routing.
        replace(currentBase)
        selectOrCreate(refreshed, false)
        return
      }
      initialized = true
      observedCurrent = sessionId
    }).catch(() => {
      // Preserve the durable address through transport loss. The native list
      // reconnect supplies the next authoritative snapshot.
    }).finally(() => { resolving = false })
  }

  let directDream: { parentSessionId: SessionId; childSessionId: SessionId; mode: 'continuable' } | undefined
  const dreamPath = `${HIVE_OVERVIEW_PATH}/dreaming`
  const dreamingAddress = () => {
    if (browser.location.pathname === dreamPath) return directDream
    const parent = new URLSearchParams(browser.location.search ?? '').get('dreamingParent')
    const route = parseHivemindSessionRoute(browser.location.pathname)
    if (route.kind !== 'session' || parent === null || !/^session-[a-z0-9-]+$/u.test(parent)) return undefined
    return { parentSessionId: parent as SessionId, childSessionId: route.sessionId, mode: 'continuable' as const }
  }
  const applyLocation = (): void => {
    if (!isHivemindRoute(browser.location.pathname)) return
    currentBase = routeBase(browser.location.pathname)
    const state = sessions.list.getSnapshot()
    if (state.phase !== 'ready') return
    const route = parseHivemindSessionRoute(browser.location.pathname)
    if (browser.location.pathname === dreamPath && directDream === undefined) {
      initialized = true
      if (resolvingDream) return
      resolvingDream = true
      const attempt = ++generation
      void fetch('/hivemind/dreamer/settings?view=activity', { credentials: 'include' }).then(async (response) => {
        if (!response.ok) throw new Error('dreaming_unavailable')
        const value = await response.json() as { activity?: { session?: typeof directDream } }
        const address = value.activity?.session
        if (!address || (address as { mode: string }).mode !== 'continuable' || !/^session-[a-z0-9-]+$/u.test(address.parentSessionId)
          || !/^session-[a-z0-9-]+$/u.test(address.childSessionId)) throw new Error('dreaming_address_invalid')
        if (!disposed && attempt === generation) directDream = address
      }).catch(() => { /* Keep the independent room; never create a root here. */ }).finally(() => {
        resolvingDream = false
        if (!disposed && attempt === generation && directDream) applyLocation()
      })
      return
    }
    const dreaming = dreamingAddress()
    if (dreaming !== undefined) {
      initialized = true
      observedCurrent = dreaming.childSessionId
      if (resolvingDream) return
      resolvingDream = true
      const attempt = ++generation
      void sessions.refresh().then(() => {
        if (disposed || attempt !== generation) return
        uiWorkspace.openSession(dreaming)
        directDream = dreaming
        replace(dreamPath)
      }).catch(() => {
        // Keep the dedicated address; never create a root on discovery failure.
      }).finally(() => { resolvingDream = false })
      return
    }
    if (route.kind === 'session') {
      const knownSubagent = state.byId[route.sessionId]?.origin === 'subagent'
      if (!knownSubagent) {
        selectExact(state, route.sessionId)
        return
      }
      // A known child is never promoted to the root conversation surface.
      replace(currentBase)
      selectOrCreate(state, false)
      return
    }
    if (route.kind === 'new') {
      selectOrCreate(state, true)
      return
    }
    if (route.kind === 'invalid') replace(currentBase)
    selectOrCreate(state, false)
  }

  const onList = (): void => {
    if (!isHivemindRoute(browser.location.pathname)) return
    currentBase = routeBase(browser.location.pathname)
    const state = sessions.list.getSnapshot()
    if (applyingRoute || resolvingDream) return
    if (!initialized) {
      applyLocation()
      return
    }
    if (browser.location.pathname === dreamPath) return
    const currentSession = mainViewSession(state)
    const active = currentSession === undefined ? undefined : state.byId[currentSession]
    if (currentSession !== undefined && active && !active.blank && active.origin !== 'subagent') {
      const preset = active.projectionValues?.agentPreset ?? state.projectionsBySession[currentSession]?.values.agentPreset
      const nextBase = ['hivemind-hyperagents', 'hivemind-hq', 'hyperagents', 'hyperagents-compressed'].includes(preset ?? '')
        ? HIVE_EMPLOYEE_HARNESS_PATH : HIVE_OVERVIEW_PATH
      if (nextBase !== currentBase) {
        currentBase = nextBase
        observedCurrent = currentSession
        replace(sessionPath(currentSession))
        window.dispatchEvent(new PopStateEvent('popstate'))
        return
      }
    }
    const current = rootForRoute(state, currentSession)
    if (current === undefined) {
      const route = parseHivemindSessionRoute(browser.location.pathname)
      if (route.kind === 'session' && rootForRoute(state, route.sessionId) === undefined && !resolving) {
        initialized = false
        observedCurrent = undefined
        applyLocation()
      }
      return
    }
    if (current === observedCurrent) return
    observedCurrent = current
    const path = sessionPath(current)
    if (browser.location.pathname !== path) browser.history.pushState(browser.history.state, '', path)
  }

  const onPopState = (): void => {
    initialized = false
    observedCurrent = undefined
    generation += 1
    applyLocation()
  }

  const unsubscribe = sessions.list.subscribe(onList)
  browser.addEventListener('popstate', onPopState)
  onList()
  return () => {
    disposed = true
    generation += 1
    unsubscribe()
    browser.removeEventListener('popstate', onPopState)
  }
}
