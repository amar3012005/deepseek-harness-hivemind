/** Tenant-scoped App Runtime transport through the existing Core gateway. */
import { createHmac, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-hivemind-execution-scope'

/** Deployment-owned transport configuration; never supplied by a model. */
export interface TransportConfig {
  serviceApiBase: string
  serviceSecretEnv: string
  requestTimeoutMs: number
  maxResponseBytes: number
}

/** Validate the configured gateway origin before registering any tools.
 * @param value - Deployment-configured gateway origin.
 * @returns The trusted origin URL.
 */
export function trustedOrigin(value: string): URL {
  const url = new URL(value)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  const compose = ['control-plane', 'hivemind-control-plane'].includes(url.hostname)
  if (!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !local && !compose)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('app-builder: serviceApiBase must be an HTTPS origin or trusted local gateway')
  }
  return url
}

/** Execute one scoped request without redirecting credentials or retrying writes.
 * @param ctx - Authenticated execution scope owner.
 * @param config - Deployment-owned transport settings.
 * @param path - Tool-owned relative App Runtime route.
 * @param method - HTTP operation.
 * @param body - Validated JSON request, or undefined for reads.
 * @param signal - Native tool cancellation signal.
 * @returns Parsed JSON response for canonical tool-output validation.
 */
export async function request(
  ctx: Context,
  config: TransportConfig,
  path: string,
  method: string,
  body: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const principal = ctx.hivemindExecutionScope.require()
  if (principal.projectId !== undefined) throw new Error('app-builder: organization-level access is required; project-scoped sessions cannot access CRM applications')
  const secret = process.env[config.serviceSecretEnv]
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error('app-builder: scoped service credential is unavailable')
  const origin = trustedOrigin(config.serviceApiBase)
  const target = new URL(`/internal/v1/harness-chat/core/api/app-runtime/apps${path}`, origin)
  if (target.origin !== origin.origin) throw new Error('app-builder: request escaped trusted origin')
  const now = Math.floor(Date.now() / 1000)
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ iss: 'hivemind-harness-runner', aud: 'hivemind-control-plane-harness-proxy', sub: principal.userId, org_id: principal.orgId, profile: principal.profile, iat: now, exp: now + 30, jti: randomUUID() })}`
  const token = `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), config.requestTimeoutMs)
  let settledResponse = false
  try {
    const response = await fetch(target, { method, redirect: 'manual', signal: AbortSignal.any([signal, deadline.signal]),
      headers: { accept: 'application/json', authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const reader = response.body?.getReader()
    if (!reader) throw new Error('app-builder: empty server response')
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        length += chunk.value.byteLength
        if (length > config.maxResponseBytes) throw new Error('app-builder: response exceeds configured byte limit')
        chunks.push(chunk.value)
      }
    } finally { await reader.cancel(); reader.releaseLock() }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (!response.ok) {
      settledResponse = true
      const envelope = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
      const failure = typeof envelope.error === 'object' && envelope.error !== null && !Array.isArray(envelope.error) ? envelope.error as Record<string, unknown> : {}
      const code = typeof failure.code === 'string' && /^[a-z_]{1,64}$/i.test(failure.code) ? failure.code : `HTTP_${response.status}`
      const safeCodes = ['invalid_app_spec', 'invalid_record_data', 'version_conflict', 'idempotency_conflict', 'migration_required', 'not_found', 'invalid_request', 'invalid_operation_id', 'invalid_version', 'invalid_identifier', 'invalid_arguments', 'invalid_reference', 'read_only_field']
      const message = safeCodes.includes(code.toLowerCase()) && typeof failure.message === 'string' ? failure.message.slice(0, 1000) : 'Request was not accepted; check application authorization and gateway integration'
      const details = typeof failure.details === 'object' && failure.details !== null ? failure.details as Record<string, unknown> : {}
      const path = typeof details.path === 'string' ? ` (${details.path.slice(0, 256)})` : ''
      throw new Error(`app-builder: ${code}: ${message}${path}`)
    }
    settledResponse = true
    return parsed
  } catch (error: unknown) {
    if (method !== 'GET' && !settledResponse) {
      throw new Error('app-builder: write outcome is unknown; reconcile or retry the identical payload with the same operation_id, never a new operation_id', { cause: error })
    }
    throw error
  } finally { clearTimeout(timer) }
}
