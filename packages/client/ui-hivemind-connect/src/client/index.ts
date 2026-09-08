import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { HivemindConnect, type HivemindConnectInjected } from './HivemindConnect.tsx'
import { en, zh, type HivemindConnectKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'hivemind-connect': HivemindConnectKey }
}

const NS = 'hivemind-connect'

/** Browser dependencies for the shell-overlay connection control. */
export const inject = ['slots', 'locale']

export interface ConnectionStatus {
  status: 'connected' | 'connecting' | 'disconnected' | 'unavailable'
  userEmail?: string
}

async function call(path: string, init?: RequestInit): Promise<ConnectionStatus> {
  const response = await fetch(path, { credentials: 'same-origin', ...init })
  if (!response.ok) throw new Error('HIVE-MIND connection request failed')
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null || !('status' in body)) throw new Error('invalid HIVE-MIND connection response')
  const status = body.status
  if (status !== 'connected' && status !== 'connecting' && status !== 'disconnected') throw new Error('invalid HIVE-MIND connection status')
  const email = 'user_email' in body && typeof body.user_email === 'string' && body.user_email.trim() !== ''
    ? body.user_email.trim()
    : undefined
  return { status, ...email === undefined ? {} : { userEmail: email } }
}

/** Register the localized HIVE-MIND connection control above sidebar Settings. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-hivemind-connect: dictionaries')
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'hivemind-connect',
    order: 100,
    locale: NS,
    inject: (): HivemindConnectInjected => ({
      readStatus: () => call('/hivemind/connect/status'),
      start: () => call('/hivemind/connect/start', { method: 'POST' }),
      disconnect: () => call('/hivemind/connect', { method: 'DELETE' }),
    }),
  }, HivemindConnect))
}
