/** Voice control uses the existing authenticated shell transport when installed. */
import type { ClientTransportHooks } from '@deepseek-ai/dsh-client-connection/client'

/** Keep packaged local-origin calls on the shell's authorized remote HTTP carrier. */
export function voiceFetch(path: string, init?: RequestInit): Promise<Response> {
  const transport = (globalThis as typeof globalThis & { __DSH_TRANSPORT__?: ClientTransportHooks }).__DSH_TRANSPORT__
  return transport?.fetch ? transport.fetch(new URL(path, globalThis.location?.href ?? 'http://localhost'), init ?? {}) : fetch(path, init)
}
