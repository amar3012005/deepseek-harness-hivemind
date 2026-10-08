const CONNECTION_MARKER = 'hivemind_connection'
const SESSION_MARKER = 'hivemind_session'

function channelName(sessionId: string): string {
  return `hivemind:connected-app:${sessionId}`
}

export interface ConnectionReturn {
  readonly status: 'success' | 'failed'
}

/** Listen for the OAuth return tab without relying on blocked cross-frame storage. */
export function listenForConnectionReturn(
  sessionId: string,
  listener: (value: ConnectionReturn) => void,
): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {}
  const channel = new BroadcastChannel(channelName(sessionId))
  channel.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (event.data === null || typeof event.data !== 'object') return
    const status = (event.data as { status?: unknown }).status
    if (status === 'success' || status === 'failed') listener({ status })
  })
  return () => { channel.close() }
}

/** Notify the original conversation after Composio returns to its session URL. */
export function setupConnectionCallbackReturn(): () => void {
  const url = new URL(window.location.href)
  if (url.searchParams.get(CONNECTION_MARKER) !== 'complete') return () => {}
  const sessionId = url.searchParams.get(SESSION_MARKER)
  const providerStatus = url.searchParams.get('status')
  const status: ConnectionReturn['status'] = providerStatus === 'success' ? 'success' : 'failed'
  const notify = () => {
    if (sessionId === null || typeof BroadcastChannel === 'undefined') return
    const channel = new BroadcastChannel(channelName(sessionId))
    channel.postMessage({ status })
    channel.close()
  }
  const strip = () => {
    for (const key of [CONNECTION_MARKER, SESSION_MARKER, 'status', 'connected_account_id', 'connectedAccountId']) {
      url.searchParams.delete(key)
    }
    window.history.replaceState(window.history.state, '', url)
  }
  if (status === 'success') {
    // The URL is only a refresh hint. The server derives the actor and checks
    // actual provider state; failed reconciliation keeps this URL retryable.
    void fetch('/api/hivemind/connections/reconcile', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: '{}', signal: AbortSignal.timeout(16000),
    }).then(async (response) => {
      const result = await response.json() as { ok?: boolean }
      if (!response.ok || result.ok !== true) throw new Error('connection_refresh_unavailable')
      notify()
      strip()
      window.setTimeout(() => { window.close() }, 100)
    }).catch(() => {
      // Keep callback markers so reloading retries authenticated verification.
      const notice = document.createElement('div')
      notice.setAttribute('role', 'status')
      notice.textContent = 'Connection verification is not ready. Reload this page to retry.'
      Object.assign(notice.style, {
        position: 'fixed', bottom: '20px', left: '20px', right: '20px', zIndex: '10000',
        padding: '16px', borderRadius: '12px', background: '#fff', color: '#222',
        boxShadow: '0 2px 16px #0002',
      })
      document.body.append(notice)
    })
  } else { notify(); strip() }
  return () => {}
}
