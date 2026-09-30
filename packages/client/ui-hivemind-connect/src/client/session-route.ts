import type { ISessions, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export const HIVE_OVERVIEW_PATH = '/hivemind/app/overview'
export const HIVE_EMPLOYEE_HARNESS_PATH = '/hivemind/app/employee/harness'
const LEGACY_HIVE_OVERVIEW_PATH = '/hivemind/app/v1/overview'
const SESSION_PATH_PREFIX = `${HIVE_OVERVIEW_PATH}/session/`
const EMPLOYEE_SESSION_PATH_PREFIX = `${HIVE_EMPLOYEE_HARNESS_PATH}/session/`

function routeBase(pathname: string): string {
  return pathname.startsWith(EMPLOYEE_SESSION_PATH_PREFIX) || pathname === `${HIVE_EMPLOYEE_HARNESS_PATH}/new`
    ? HIVE_EMPLOYEE_HARNESS_PATH : HIVE_OVERVIEW_PATH
}

function isHivemindRoute(pathname: string): boolean {
  return pathname.startsWith(HIVE_OVERVIEW_PATH)
    || pathname.startsWith(EMPLOYEE_SESSION_PATH_PREFIX)
    || pathname === `${HIVE_EMPLOYEE_HARNESS_PATH}/new`
    || pathname === LEGACY_HIVE_OVERVIEW_PATH
}

type Route =
  | { readonly kind: 'overview' }
  | { readonly kind: 'new' }
  | { readonly kind: 'session'; readonly sessionId: SessionId }
  | { readonly kind: 'invalid' }

interface BrowserRoute {
  readonly location: Pick<Location, 'pathname'>
  readonly history: Pick<History, 'pushState' | 'replaceState' | 'state'>
  addEventListener(type: 'popstate', listener: () => void): void
  removeEventListener(type: 'popstate', listener: () => void): void
}

/** Parse only the public HIVE route grammar. Session ids remain opaque. */
export function parseHivemindSessionRoute(pathname: string): Route {
  if (pathname === HIVE_OVERVIEW_PATH || pathname === LEGACY_HIVE_OVERVIEW_PATH) return { kind: 'overview' }
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
  const preset = sessionId === state.current
    ? summary.projectionValues?.agentPreset ?? summary.agentPreset
    : summary.agentPreset ?? summary.projectionValues?.agentPreset
  // A newly opened OS blank begins with the Chat creation header until its
  // selection event lands. A saved HyperAgents selection must still win.
  if (summary.blank && base === HIVE_EMPLOYEE_HARNESS_PATH && sessionId === state.current
    && preset === 'hivemind-chat' && summary.projectionValues?.agentPreset == null) return true
  if (summary.blank && preset == null) return true
  const hyperagent = preset === 'hivemind-hyperagents' || preset === 'hivemind-hq'
    || preset === 'hyperagents' || preset === 'hyperagents-compressed'
  return base === HIVE_EMPLOYEE_HARNESS_PATH ? hyperagent : !hyperagent
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
  browser: BrowserRoute = window,
): () => void {
  let disposed = false
  let applyingRoute = false
  let creating = false
  let resolving = false
  let generation = 0
  let initialized = false
  let observedCurrent: SessionId | undefined
  let creatingOsSession: SessionId | undefined
  let currentBase = routeBase(browser.location.pathname)
  const sessionPath = (id: SessionId): string => hivemindSessionPath(id, currentBase)
  const rootForRoute = (state: SessionListState, id: SessionId | undefined): SessionId | undefined => {
    if (id === undefined) return undefined
    // The OS preset is selected just after the native blank Session is made.
    // Keep that one newly created id on its OS URL during the short gap.
    if (id === creatingOsSession) {
      const summary = state.byId[id]
      const preset = summary?.projectionValues?.agentPreset ?? summary?.agentPreset
      if (summary?.blank !== true || preset === 'hivemind-hyperagents' || preset === 'hivemind-hq'
        || preset === 'hyperagents' || preset === 'hyperagents-compressed') creatingOsSession = undefined
      else if (currentBase === HIVE_EMPLOYEE_HARNESS_PATH && summary.origin !== 'subagent') return id
    }
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
      sessions.open(selected)
      replace(sessionPath(selected))
      applyingRoute = false
      return
    }
    creating = true
    const creatingBase = currentBase
    void sessions.create().then((sessionId) => {
      if (disposed || attempt !== generation) return
      if (creatingBase === HIVE_EMPLOYEE_HARNESS_PATH) creatingOsSession = sessionId
      applyingRoute = true
      initialized = true
      observedCurrent = sessionId
      sessions.open(sessionId)
      replace(sessionPath(sessionId))
      applyingRoute = false
    }).catch(() => {
      if (!disposed && attempt === generation) replace(HIVE_OVERVIEW_PATH)
    }).finally(() => { creating = false })
  }

  const selectExact = (state: SessionListState, sessionId: SessionId): void => {
    if (creating || resolving) return
    if (rootForRoute(state, sessionId) !== undefined) {
      applyingRoute = true
      initialized = true
      observedCurrent = sessionId
      if (state.current !== sessionId) sessions.open(sessionId)
      replace(sessionPath(sessionId))
      applyingRoute = false
      return
    }
    // A route identifies an existing durable Session; it is never permission
    // to create a new one. Refresh once to cover a boot/list race, then fall
    // back to the newest real root if the host still does not project it.
    const attempt = ++generation
    resolving = true
    void sessions.refresh().then(() => {
      if (disposed || attempt !== generation) return
      const refreshed = sessions.list.getSnapshot()
      if (rootForRoute(refreshed, sessionId) !== undefined) {
        applyingRoute = true
        initialized = true
        observedCurrent = sessionId
        if (refreshed.current !== sessionId) sessions.open(sessionId)
        replace(sessionPath(sessionId))
        applyingRoute = false
        return
      }
      replace(HIVE_OVERVIEW_PATH)
      selectOrCreate(refreshed, false)
    }).catch(() => {
      if (!disposed && attempt === generation) replace(HIVE_OVERVIEW_PATH)
    }).finally(() => { resolving = false })
  }

  const applyLocation = (): void => {
    if (!isHivemindRoute(browser.location.pathname)) return
    currentBase = routeBase(browser.location.pathname)
    const state = sessions.list.getSnapshot()
    if (state.phase !== 'ready') return
    const route = parseHivemindSessionRoute(browser.location.pathname)
    if (route.kind === 'session') {
      const knownSubagent = state.byId[route.sessionId]?.origin === 'subagent'
      if (!knownSubagent) {
        selectExact(state, route.sessionId)
        return
      }
      // A known child is never promoted to the root conversation surface.
      replace(HIVE_OVERVIEW_PATH)
      selectOrCreate(state, false)
      return
    }
    if (route.kind === 'new') {
      selectOrCreate(state, true)
      return
    }
    if (route.kind === 'invalid') replace(HIVE_OVERVIEW_PATH)
    selectOrCreate(state, false)
  }

  const onList = (): void => {
    if (!isHivemindRoute(browser.location.pathname)) return
    currentBase = routeBase(browser.location.pathname)
    const state = sessions.list.getSnapshot()
    if (applyingRoute) return
    if (!initialized) {
      applyLocation()
      return
    }
    const current = rootForRoute(state, state.current)
    if (current === undefined) {
      const route = parseHivemindSessionRoute(browser.location.pathname)
      if (route.kind === 'session' && rootForRoute(state, route.sessionId) === undefined && !resolving) {
        initialized = false
        observedCurrent = undefined
        replace(HIVE_OVERVIEW_PATH)
        selectOrCreate(state, false)
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
