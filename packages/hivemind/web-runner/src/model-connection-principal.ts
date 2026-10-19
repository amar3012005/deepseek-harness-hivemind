/** Resolve the main app's existing human session through its authoritative bootstrap. */
import type { IncomingMessage } from 'node:http'
import type { ConnectionActor } from './codex-connections.ts'
export async function modelConnectionPrincipal(
  request: IncomingMessage,
  bootstrapBase: URL,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<ConnectionActor | undefined> {
  const cookie = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('hm_cp_session='))
  if (!cookie || cookie.length > 12000) return undefined
  const response = await fetcher(new URL('/v1/bootstrap', bootstrapBase), {
    headers: { cookie, accept: 'application/json' }, cache: 'no-store', redirect: 'error', signal,
  })
  if (response.status === 401 || response.status === 403) return undefined
  if (!response.ok) throw Error('connection_identity_unavailable')
  const value = await response.json() as { authenticated?: boolean; user?: { id?: unknown }; organization?: { id?: unknown } }
  if (value.authenticated === false || typeof value.user?.id !== 'string' || typeof value.organization?.id !== 'string') return undefined
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
  if (!uuid.test(value.user.id) || !uuid.test(value.organization.id)) return undefined
  return { userId: value.user.id, orgId: value.organization.id }
}
