interface EmbedConfig { version: 1; parentOrigins: string[] }
interface EmbedEnvelope { version: 1; type: string; request_id: string; ticket?: string }
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

declare global {
  interface Window { __HIVEMIND_EMBED_CONFIG__?: EmbedConfig }
}

function postEmbed(parent: WindowProxy, origin: string, type: string, requestId: string): void {
  parent.postMessage({ version: 1, type, request_id: requestId }, origin)
}

/** Mount the origin-bound, one-shot parent bootstrap protocol. */
export function setupEmbedMessaging(): () => void {
  const config = window.__HIVEMIND_EMBED_CONFIG__
  const parent = window.parent
  if (config?.version !== 1 || parent === window) return () => undefined
  const origins = new Set(config.parentOrigins.map(value => new URL(value).origin))
  const readyRequestId = randomUUID()
  for (const origin of origins) postEmbed(parent, origin, 'hivemind:harness-ready.v1', readyRequestId)
  let accepted = false
  const receive = (event: MessageEvent<unknown>): void => {
    if (accepted || event.source !== parent || !origins.has(event.origin)
      || typeof event.data !== 'object' || event.data === null) return
    const envelope = event.data as Partial<EmbedEnvelope>
    if (envelope.version !== 1 || envelope.type !== 'hivemind:harness-bootstrap.v1'
      || typeof envelope.request_id !== 'string' || envelope.request_id.length === 0
      || typeof envelope.ticket !== 'string' || envelope.ticket.length === 0) return
    accepted = true
    void fetch('/api/hivemind/embed/exchange', {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: envelope.ticket, request_id: envelope.request_id }),
    }).then((response) => {
      if (!response.ok) throw new Error('ticket exchange failed')
      postEmbed(parent, event.origin, 'hivemind:harness-connected.v1', envelope.request_id as string)
    }).catch(() => {
      postEmbed(parent, event.origin, 'hivemind:harness-auth-error.v1', envelope.request_id as string)
    })
  }
  const disconnect = (): void => {
    for (const origin of origins) postEmbed(parent, origin, 'hivemind:harness-disconnected.v1', readyRequestId)
  }
  window.addEventListener('message', receive)
  window.addEventListener('pagehide', disconnect, { once: true })
  return () => {
    window.removeEventListener('message', receive)
    window.removeEventListener('pagehide', disconnect)
  }
}
