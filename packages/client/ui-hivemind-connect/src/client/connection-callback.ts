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
  if (sessionId !== null && typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(channelName(sessionId))
    channel.postMessage({ status })
    channel.close()
  }
  for (const key of [CONNECTION_MARKER, SESSION_MARKER, 'status', 'connected_account_id', 'connectedAccountId']) {
    url.searchParams.delete(key)
  }
  window.history.replaceState(window.history.state, '', url)
  if (status === 'success') window.setTimeout(() => { window.close() }, 100)
  return () => {}
}
