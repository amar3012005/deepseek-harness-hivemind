/** Product-owned tenant authentication layered over native Connection admission. */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { OperatorPeer, type ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { HivemindPrincipal } from '@deepseek-ai/dsh-hivemind-execution-scope'
import type { ConnectionRpcHandlerResult } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { nativeSessionBinding } from './native-consent.ts'

const COOKIE = '__Host-hive-tenant'
const MAX_COOKIE_BYTES = 4096
const DEFAULT_TTL_SECONDS = 60 * 60 * 24
const TENANT_PRESETS = new Set(['hivemind-chat', 'hivemind-hyperagents', 'hivemind-hq'])

interface TenantGatewayAdmissionRequest {
  readonly kind: 'invoke' | 'stream' | 'event'
  readonly endpoint: string
  readonly payload: unknown
  readonly signal: AbortSignal
  readonly peer: PeerScope | undefined
}
type TenantGatewayAdmission = (request: TenantGatewayAdmissionRequest, next: () => Promise<unknown>) => Promise<unknown>

export interface TenantTransportOptions {
  readonly secret: string
  readonly maxAgeSeconds?: number
  readonly membershipActive: (principal: HivemindPrincipal, signal: AbortSignal) => Promise<boolean>
  readonly referencedSessionIds: (payload: unknown) => Set<string>
  /** Product authority check for one durable session under the current principal. */
  readonly referencedSessionAuthorized: (principal: HivemindPrincipal, sessionId: string, signal: AbortSignal) => Promise<boolean>
  /** Fresh tenant directory/lifecycle check before resolving a canonical employee room. */
  readonly employeeRoomAuthorized: (principal: HivemindPrincipal, employeeId: string, signal: AbortSignal) => Promise<boolean>
  /** Resolve the native preset default exactly as Session creation would. */
  readonly resolveAgentPreset: (requested?: string) => Promise<string>
}

type RemoteValidation = 'active' | 'filtered' | 'revoked' | 'cancelled'

export interface HivemindTenantTransport {
  /** Resolve a valid product cookie from a request; no forwarded authority is trusted. */
  principal(request: ConnectionTrustRequest): HivemindPrincipal | undefined
  /** Resolve and revalidate active organization membership for product route handlers. */
  authenticate(request: ConnectionTrustRequest, signal: AbortSignal): Promise<HivemindPrincipal | undefined>
  /** Create a host-only tenant cookie for a verified ticket-exchange principal. */
  issueCookie(principal: HivemindPrincipal, authority: string): string
  /** Authenticate/revalidate and scope one decoded Typert RPC through its dispatch. */
  runAuthenticatedRpc<T extends ConnectionRpcHandlerResult>(
    request: Request,
    endpoint: string,
    payload: unknown,
    next: () => Promise<T>,
  ): Promise<T>
  /** Revalidate tenant membership/session ownership around one Remote invocation or stream item. */
  runAuthenticatedRemote<T>(request: TenantGatewayAdmissionRequest, next: () => Promise<T>): Promise<T | unknown>
}

declare module '@deepseek-ai/cordis' {
  interface Context { hivemindTenantTransport: HivemindTenantTransport }
}

function requestHeader(request: ConnectionTrustRequest, name: string): string | undefined {
  const headers = request.headers
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name] ?? headers[name.toLowerCase()]
  return typeof value === 'string' ? value : undefined
}

function canonicalAuthority(value: string | undefined): string | undefined {
  if (value === undefined || value.length > 255 || value.trim() !== value || /[,\s/@?#]/u.test(value)) return undefined
  try {
    const parsed = new URL(`https://${value}`)
    return parsed.host === value.toLowerCase() && parsed.username === '' && parsed.password === ''
      ? parsed.host : undefined
  } catch { return undefined }
}

function encode(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString('base64url') }
function sign(body: string, secret: string): string { return createHmac('sha256', secret).update(body).digest('base64url') }

function cookieValue(header: string | undefined): string | undefined {
  if (header === undefined || header.length > MAX_COOKIE_BYTES) return undefined
  const found: string[] = []
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0 || part.slice(0, separator).trim() !== COOKIE) continue
    found.push(part.slice(separator + 1).trim())
  }
  return found.length === 1 ? found[0] : undefined
}

function hasTenantCookie(header: string | undefined): boolean {
  if (header === undefined) return false
  return header.split(';').some(part => (part.split('=', 1)[0] ?? '').trim() === COOKIE)
}

function decodePrincipal(token: string | undefined, authority: string | undefined, secret: string): HivemindPrincipal | undefined {
  if (token === undefined || token.length > MAX_COOKIE_BYTES || authority === undefined) return undefined
  const [body, signature, extra] = token.split('.')
  if (!body || !signature || extra !== undefined) return undefined
  const expected = Buffer.from(sign(body, secret), 'base64url')
  const actual = Buffer.from(signature, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined
  try {
    const value: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const claims = value as Record<string, unknown>
    if (claims.v !== 1 || claims.authority !== authority || typeof claims.exp !== 'number'
      || !Number.isSafeInteger(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)
      || typeof claims.userId !== 'string' || !claims.userId || claims.userId.length > 128
      || typeof claims.orgId !== 'string' || !claims.orgId || claims.orgId.length > 128
      || typeof claims.variation !== 'string' || !claims.variation || claims.variation.length > 128
      || claims.profile !== 'hivemind-chat'
      || (claims.projectId !== undefined && (typeof claims.projectId !== 'string' || !claims.projectId || claims.projectId.length > 128))) return undefined
    const nativeSessionHash = nativeSessionBinding(claims.nativeSessionHash)
    return Object.freeze({
      orgId: claims.orgId,
      userId: claims.userId,
      profile: 'hivemind-chat',
      variation: claims.variation,
      ...(claims.projectId === undefined ? {} : { projectId: claims.projectId }),
      ...(nativeSessionHash === undefined ? {} : { nativeSessionHash }),
    })
  } catch { return undefined }
}

function failure(code: string, message: string): ConnectionRpcHandlerResult {
  return { ok: false, error: { code, message, details: {} } }
}

/** Install the product cookie provider and decoded RPC admission layer. */
export async function installTenantTransport(ctx: Context, options: TenantTransportOptions): Promise<void> {
  if (Buffer.byteLength(options.secret, 'utf8') < 32) throw new Error('tenant transport secret must be at least 32 bytes')
  const maxAge = options.maxAgeSeconds ?? DEFAULT_TTL_SECONDS
  if (!Number.isSafeInteger(maxAge) || maxAge < 60 || maxAge > 86400) throw new Error('tenant transport max age is invalid')
  const peers = new Map<string, { readonly peer: OperatorPeer; readonly owner: HivemindPrincipal }>()
  const ownerByPeer = new WeakMap<PeerScope, HivemindPrincipal>()
  const key = (principal: HivemindPrincipal) => JSON.stringify([principal.orgId, principal.userId, principal.profile,
    principal.variation, principal.projectId ?? null, principal.nativeSessionHash ?? null])
  const peerFor = (principal: HivemindPrincipal): PeerScope => {
    const id = key(principal)
    let entry = peers.get(id)
    if (entry === undefined) {
      const peer = new OperatorPeer(ctx.connection.operator.ctx)
      entry = { peer, owner: principal }
      peers.set(id, entry)
      ownerByPeer.set(peer, principal)
    }
    return entry.peer
  }
  const revokePeer = async (peer: PeerScope): Promise<void> => {
    for (const [id, entry] of peers) if (entry.peer === peer) {
      peers.delete(id)
      await peer.dispose()
      return
    }
  }
  const principal = (request: ConnectionTrustRequest): HivemindPrincipal | undefined => {
    const cookie = cookieValue(requestHeader(request, 'cookie'))
    if (cookie === undefined) return undefined
    return decodePrincipal(cookie, canonicalAuthority(requestHeader(request, 'host')), options.secret)
  }
  const transport: HivemindTenantTransport = {
    principal,
    async authenticate(request, signal) {
      const owner = principal(request)
      return owner !== undefined && await options.membershipActive(owner, signal) ? owner : undefined
    },
    issueCookie(owner, authority) {
      const host = canonicalAuthority(authority)
      if (host === undefined) throw new Error('tenant cookie authority is invalid')
      const exp = Math.floor(Date.now() / 1000) + maxAge
      const body = encode({ v: 1, authority: host, exp, orgId: owner.orgId, userId: owner.userId,
        profile: owner.profile, variation: owner.variation, ...(owner.projectId === undefined ? {} : { projectId: owner.projectId }),
        ...(nativeSessionBinding(owner.nativeSessionHash) === undefined ? {} : { nativeSessionHash: owner.nativeSessionHash }) })
      return `${COOKIE}=${body}.${sign(body, options.secret)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`
    },
    async runAuthenticatedRpc<T extends ConnectionRpcHandlerResult>(
      request: Request, endpoint: string, payload: unknown, next: () => Promise<T>,
    ): Promise<T> {
      const owner = principal({ headers: request.headers })
      if (owner === undefined) {
        // Native browser-authenticated operator requests retain their native scope.
        if (hasTenantCookie(request.headers.get('cookie') ?? undefined)) return failure('auth/unauthorized', 'tenant authentication is invalid') as T
        return next()
      }
      const signal = request.signal
      if (!await options.membershipActive(owner, signal)) return failure('auth/unauthorized', 'tenant membership is inactive') as T
      const args = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)['args'] : undefined
      // Typert names the single Session request parameter on the wire.
      // Keep legacy flat arguments readable for older clients, while the
      // current request object owns identity when present.
      const methodArgs = (endpoint === 'session/create' || endpoint === 'session/employeeRoom')
        && typeof args === 'object' && args !== null && !Array.isArray(args)
        && Object.hasOwn(args, 'request')
        ? (args as Record<string, unknown>)['request'] : args
      const requestedPreset = typeof methodArgs === 'object' && methodArgs !== null && !Array.isArray(methodArgs)
        ? (methodArgs as Record<string, unknown>)['agentPreset'] : undefined
      if (endpoint === 'session/create' || endpoint === 'agentPresets/select') {
        if (requestedPreset !== undefined && (typeof requestedPreset !== 'string' || !TENANT_PRESETS.has(requestedPreset))) {
          return failure('auth/forbidden', 'agent preset is unavailable for this product profile') as T
        }
        if (endpoint === 'agentPresets/select' && typeof requestedPreset !== 'string') {
          return failure('auth/forbidden', 'agent preset selection is required') as T
        }
        if (endpoint === 'session/create') {
          try {
            const effective = await ctx.hivemindExecutionScope.run(owner, () => options.resolveAgentPreset(typeof requestedPreset === 'string' ? requestedPreset : undefined))
            if (!TENANT_PRESETS.has(effective)) return failure('auth/forbidden', 'agent preset is unavailable for this product profile') as T
          } catch {
            return failure('auth/forbidden', 'agent preset is unavailable for this product profile') as T
          }
        }
      }
      if (endpoint === 'session/employeeRoom') {
        const employeeArgs = typeof args === 'object' && args !== null && !Array.isArray(args) && Object.hasOwn(args, 'request')
          ? (args as Record<string, unknown>)['request'] : args
        const employeeId = typeof employeeArgs === 'object' && employeeArgs !== null && !Array.isArray(employeeArgs)
          ? (employeeArgs as Record<string, unknown>)['employeeId'] : undefined
        if (typeof employeeId !== 'string' || employeeId.length > 128
          || !await options.employeeRoomAuthorized(owner, employeeId, signal)) {
          return failure('auth/forbidden', 'employee room is unavailable for this organization') as T
        }
      }
      const scoped = <TResult>(action: () => TResult): TResult => ctx.hivemindExecutionScope.run(owner, action)
      const sessionIds = options.referencedSessionIds(payload)
      if (endpoint === 'session/create' && sessionIds.size > 0) return failure('session/not-found', 'referenced session is unavailable') as T
      if (sessionIds.size > 128) return failure('auth/forbidden', 'too many referenced sessions') as T
      for (const id of sessionIds) {
        if (id.length > 256) return failure('auth/forbidden', 'invalid referenced session') as T
        const snapshot = await scoped(() => ctx.sessionPersistence.stat(SessionId(id), { signal }))
        if (snapshot === undefined) return failure('session/not-found', 'referenced session is unavailable') as T
      }
      return scoped(next)
    },
    async runAuthenticatedRemote<T>(request: TenantGatewayAdmissionRequest, next: () => Promise<T>): Promise<T | unknown> {
      const owner = request.peer === undefined ? undefined : ownerByPeer.get(request.peer)
      // The native operator/in-process path remains under its existing identity.
      if (owner === undefined) return next()
      const scoped = <TResult>(action: () => TResult): TResult => ctx.hivemindExecutionScope.run(owner, action)
      if (request.kind === 'invoke' && request.endpoint === 'session/employeeRoom') {
        const args = typeof request.payload === 'object' && request.payload !== null && !Array.isArray(request.payload)
          ? (request.payload as Record<string, unknown>)['args'] : undefined
        const employeeArgs = typeof args === 'object' && args !== null && !Array.isArray(args) && Object.hasOwn(args, 'request')
          ? (args as Record<string, unknown>)['request'] : args
        const employeeId = typeof employeeArgs === 'object' && employeeArgs !== null && !Array.isArray(employeeArgs)
          ? (employeeArgs as Record<string, unknown>)['employeeId'] : undefined
        if (typeof employeeId !== 'string' || employeeId.length > 128
          || !await scoped(() => options.employeeRoomAuthorized(owner, employeeId, request.signal))) {
          throw new Error('tenant employee room authorization was denied')
        }
      }
      const sessionIds = options.referencedSessionIds(request.payload)
      let validationDenial: string | undefined
      const revokeWithDiagnostic = async (phase: string): Promise<void> => {
        if (process.env.HIVEMIND_TENANT_AUTH_DIAGNOSTICS === 'true') {
          ctx.logger.warn('hivemind-tenant-transport: peer revocation', JSON.stringify({
            phase,
            kind: request.kind,
            endpoint: request.endpoint,
            signalAborted: request.signal.aborted,
            denial: validationDenial ?? 'unknown',
          }))
        }
        await revokePeer(request.peer as PeerScope)
      }
      let validation: Promise<RemoteValidation> | undefined
      const validate = (): Promise<RemoteValidation> => validation ??= (async () => {
        validationDenial = undefined
        if (request.signal.aborted) { validationDenial = 'request-aborted'; return 'cancelled' }
        try {
          const membershipActive = await options.membershipActive(owner, request.signal)
          if (request.signal.aborted) { validationDenial = 'request-aborted-after-membership'; return 'cancelled' }
          if (!membershipActive) { validationDenial = 'membership-inactive'; return 'revoked' }
          if (sessionIds.size > 128) { validationDenial = 'too-many-session-references'; return request.kind === 'event' ? 'filtered' : 'revoked' }
          if (request.kind === 'event' && sessionIds.size === 0) { validationDenial = 'event-without-session-reference'; return 'filtered' }
          for (const id of sessionIds) {
            if (!id || id.length > 256) { validationDenial = 'invalid-session-reference'; return request.kind === 'event' ? 'filtered' : 'revoked' }
            const authorized = await options.referencedSessionAuthorized(owner, id, request.signal)
            if (request.signal.aborted) { validationDenial = 'request-aborted-after-session-check'; return 'cancelled' }
            if (!authorized) { validationDenial = 'session-unauthorized'; return request.kind === 'event' ? 'filtered' : 'revoked' }
          }
          return 'active'
        } catch (error) {
          if (request.signal.aborted) { validationDenial = 'request-aborted-after-validation-error'; return 'cancelled' }
          validationDenial = error instanceof Error ? `validation-exception:${error.constructor.name}` : 'validation-exception:unknown'
          return 'revoked'
        }
      })().finally(() => { validation = undefined })
      const initialValidation = await validate()
      if (initialValidation !== 'active') {
        if (initialValidation === 'filtered') return false
        if (initialValidation === 'revoked') await revokeWithDiagnostic('before-dispatch')
        if (request.kind === 'event') return false
        throw new Error(initialValidation === 'cancelled'
          ? 'tenant Remote request was cancelled'
          : 'tenant Remote authorization is no longer active')
      }
      const result = await scoped(next)
      if (request.kind !== 'stream' || typeof result !== 'object' || result === null
        || !(Symbol.asyncIterator in result)) return result
      const source = (result as AsyncIterable<unknown>)[Symbol.asyncIterator]()
      let closed = false
      function cleanup(): void {
        if (closed) return
        closed = true
        clearInterval(revalidationTimer)
        request.signal.removeEventListener('abort', cleanup)
      }
      const revalidationTimer: NodeJS.Timeout = setInterval(() => {
        void validate().then(async (status) => {
          if (status === 'cancelled') cleanup()
          else if (status === 'revoked') {
            cleanup()
            await revokeWithDiagnostic('revalidation-timer')
          }
        })
      }, 15_000)
      revalidationTimer.unref?.()
      request.signal.addEventListener('abort', cleanup, { once: true })
      const guarded: AsyncIterable<unknown> = {
        [Symbol.asyncIterator]() {
          return {
            async next(value?: unknown) {
              if (closed) {
                if (request.signal.aborted) return { done: true, value: undefined }
                throw new Error('tenant Remote authorization was revoked')
              }
              const before = await validate()
              if (before === 'cancelled') {
                cleanup()
                await source.return?.()
                return { done: true, value: undefined }
              }
              if (before === 'revoked') {
                cleanup()
                await revokeWithDiagnostic('stream-next-before-item')
                await source.return?.()
                throw new Error('tenant Remote authorization was revoked')
              }
              try {
                const item = await scoped(() => source.next(value))
                if (request.signal.aborted) {
                  cleanup()
                  await source.return?.()
                  return { done: true, value: undefined }
                }
                if (item.done) cleanup()
                else {
                  const after = await validate()
                  if (after === 'cancelled') {
                    cleanup()
                    await source.return?.()
                    return { done: true, value: undefined }
                  }
                  if (after === 'revoked') {
                    cleanup()
                    await revokeWithDiagnostic('stream-next-after-item')
                    await source.return?.()
                    throw new Error('tenant Remote authorization was revoked')
                  }
                }
                return item
              } catch (error) {
                cleanup()
                if (request.signal.aborted) return { done: true, value: undefined }
                throw error
              }
            },
            async return(value?: unknown) {
              cleanup()
              return source.return === undefined ? { done: true, value } : source.return(value)
            },
            async throw(error?: unknown) {
              cleanup()
              if (source.throw !== undefined) return source.throw(error)
              await source.return?.()
              throw error
            },
          }
        },
      }
      return guarded
    },
  }
  ctx.provide('hivemindTenantTransport', transport)
  const disposePeerAuth = ctx.connection.registerPeerAuthenticator((request) => {
    const header = requestHeader(request, 'cookie')
    if (!hasTenantCookie(header)) return undefined
    const owner = principal(request)
    if (owner === undefined) throw new Error('tenant authentication is invalid')
    return peerFor(owner)
  })
  const disposeRpc = ctx.connection.rpc.registerAdmission(async (request, next) =>
    transport.runAuthenticatedRpc(request.request, request.endpoint, request.payload, next))
  const gatewayWithAdmission = ctx.typertGateway as typeof ctx.typertGateway & {
    registerAdmission(admission: TenantGatewayAdmission): () => Promise<void>
  }
  const disposeGateway = gatewayWithAdmission.registerAdmission((request, next) =>
    transport.runAuthenticatedRemote(request, next))
  ctx.effect(() => async () => {
    await disposeGateway()
    await disposeRpc()
    await disposePeerAuth()
    await Promise.all([...peers.values()].map(({ peer }) => peer.dispose()))
    peers.clear()
  }, 'hivemind tenant transport')
}
