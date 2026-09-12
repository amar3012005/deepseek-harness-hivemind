import type { ISessions, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export const HIVE_OVERVIEW_PATH = '/hivemind/app/overview'
const LEGACY_HIVE_OVERVIEW_PATH = '/hivemind/app/v1/overview'
const SESSION_PATH_PREFIX = `${HIVE_OVERVIEW_PATH}/session/`

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
  if (pathname === `${HIVE_OVERVIEW_PATH}/new`) return { kind: 'new' }
  if (!pathname.startsWith(SESSION_PATH_PREFIX)) return { kind: 'invalid' }
  const [encoded, ...suffix] = pathname.slice(SESSION_PATH_PREFIX.length).split('/')
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

export function hivemindSessionPath(sessionId: SessionId): string {
  return `${SESSION_PATH_PREFIX}${encodeURIComponent(sessionId)}`
}

function rootSession(state: SessionListState, sessionId: SessionId | undefined): SessionId | undefined {
  if (sessionId === undefined) return undefined
  const summary = state.byId[sessionId]
  return summary !== undefined && summary.origin !== 'subagent' ? sessionId : undefined
}

function newestRoot(state: SessionListState): SessionId | undefined {
  return state.ids.find(id => state.byId[id]?.origin !== 'subagent' && state.byId[id]?.blank === false)
    ?? state.ids.find(id => state.byId[id]?.origin !== 'subagent')
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
  let generation = 0
  let initialized = false
  let observedCurrent: SessionId | undefined

  const replace = (path: string): void => {
    if (browser.location.pathname !== path) browser.history.replaceState(browser.history.state, '', path)
  }

  const selectOrCreate = (state: SessionListState, forceCreate: boolean): void => {
    if (creating) return
    const attempt = ++generation
    const selected = forceCreate ? undefined : newestRoot(state)
    if (selected !== undefined) {
      applyingRoute = true
      initialized = true
      observedCurrent = selected
      sessions.open(selected)
      replace(hivemindSessionPath(selected))
      applyingRoute = false
      return
    }
    creating = true
    void sessions.create().then((sessionId) => {
      if (disposed || attempt !== generation) return
      applyingRoute = true
      initialized = true
      observedCurrent = sessionId
      sessions.open(sessionId)
      replace(hivemindSessionPath(sessionId))
      applyingRoute = false
    }).catch(() => {
      if (!disposed && attempt === generation) replace(HIVE_OVERVIEW_PATH)
    }).finally(() => { creating = false })
  }

  const applyLocation = (): void => {
    if (!browser.location.pathname.startsWith(HIVE_OVERVIEW_PATH)
      && browser.location.pathname !== LEGACY_HIVE_OVERVIEW_PATH) return
    const state = sessions.list.getSnapshot()
    if (state.phase !== 'ready') return
    const route = parseHivemindSessionRoute(browser.location.pathname)
    if (route.kind === 'session') {
      const knownSubagent = state.byId[route.sessionId]?.origin === 'subagent'
      if (!knownSubagent) {
        applyingRoute = true
        initialized = true
        observedCurrent = route.sessionId
        if (state.current !== route.sessionId) sessions.open(route.sessionId)
        replace(hivemindSessionPath(route.sessionId))
        applyingRoute = false
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
    if (!browser.location.pathname.startsWith(HIVE_OVERVIEW_PATH)
      && browser.location.pathname !== LEGACY_HIVE_OVERVIEW_PATH) return
    const state = sessions.list.getSnapshot()
    if (applyingRoute) return
    if (!initialized) {
      applyLocation()
      return
    }
    const current = rootSession(state, state.current)
    if (current === undefined || current === observedCurrent) return
    observedCurrent = current
    const path = hivemindSessionPath(current)
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
