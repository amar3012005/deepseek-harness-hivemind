/** Pure bounded projections for the plugin-owned connected-event attention seam. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { LedgerEvent } from './ledger.ts'
import { hqMode } from './mode.ts'

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max: number): string => typeof value === 'string' ? value.slice(0, max) : ''
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
/** Existing runner service key, purpose-separated claims; never accept the key itself as a bearer.
 * @param authorization - signed HTTP bearer value.
 * @param secret - existing runner service signing key.
 * @param now - verification clock in milliseconds.
 * @returns exact bound request scope, or undefined for rejected authorization.
 */
export function attentionAuthorization(authorization: string | undefined, secret: string | undefined, now = Date.now()) {
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32 || !authorization?.startsWith('Bearer ')) return undefined
  try {
    const parts = authorization.slice(7).split('.')
    if (parts.length !== 3) return undefined
    const [headerPart, claimsPart, supplied] = parts as [string, string, string]
    const expected = createHmac('sha256', secret).update(`${headerPart}.${claimsPart}`).digest('base64url')
    const a = Buffer.from(supplied), b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined
    const header: unknown = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'))
    const claims: unknown = JSON.parse(Buffer.from(claimsPart, 'base64url').toString('utf8'))
    if (!object(header) || !object(claims) || header.alg !== 'HS256' || header.typ !== 'JWT'
      || claims.iss !== 'hivemind-control-plane' || claims.aud !== 'hivemind-runtime-attention'
      || typeof claims.sub !== 'string' || !uuid.test(claims.sub)
      || typeof claims.org_id !== 'string' || !uuid.test(claims.org_id)
      || typeof claims.jti !== 'string' || !uuid.test(claims.jti)
      || typeof claims.event_id !== 'string' || !claims.event_id || claims.event_id.length > 300
      || !['context', 'deliver'].includes(String(claims.operation))
      || typeof claims.iat !== 'number' || !Number.isInteger(claims.iat)
      || typeof claims.exp !== 'number' || !Number.isInteger(claims.exp)
      || claims.iat > Math.floor(now / 1000) + 5 || claims.exp <= Math.floor(now / 1000)
      || claims.exp <= claims.iat || claims.exp - claims.iat > 30) return undefined
    return { orgId: claims.org_id, userId: claims.sub, eventId: claims.event_id, operation: claims.operation }
  } catch { return undefined }
}
export function attentionSnapshot(events: readonly LedgerEvent[], sessionId: string, consentRevision: number) {
  const tasks = new Map<string, unknown>()
  let goal: unknown, handoff: unknown
  for (const event of events) {
    if (!object(event.data)) continue
    if (event.type === 'team/task' && object(event.data.task) && typeof event.data.task.id === 'string') {
      const task = event.data.task
      if (typeof task.id !== 'string') continue
      tasks.set(task.id, { id: task.id, revision: task.revision, status: task.status,
        subject: text(task.subject, 200), description: text(task.description, 400), owner: text(task.owner, 160) })
    }
    if (event.type === 'goal/change') {
      const source = event.data.goal
      goal = event.data.operation === 'clear' || !object(source) ? undefined
        : { id: source.id, revision: source.revision, phase: source.phase, objective: text(source.objective, 1000) }
    }
    if (event.type === 'hivemind/hq-rest-intent') handoff = { id: event.data.id,
      nextSteps: Array.isArray(event.data.nextSteps) ? event.data.nextSteps.slice(0, 8).map(v => text(v, 300)) : [],
      blockers: Array.isArray(event.data.blockers) ? event.data.blockers.slice(0, 8).map(v => text(v, 300)) : [],
      summary: text(event.data.summary, 1000) }
  }
  const mode = hqMode(events)
  const value = { sessionId, consentRevision, enabled: mode.enabled, modeRevision: mode.revision, modeChangedAt: mode.changedAt,
    goals: goal === undefined ? [] : [goal], tasks: [...tasks.values()].slice(-20),
    pendingDecisions: handoff === undefined ? [] : [handoff] }
  return { ...value, revision: createHash('sha256').update(JSON.stringify(value)).digest('hex') }
}
/** Source identity survives admission/claim/replay; a delivery receipt is not required for retry safety. */
export function attentionAdmitted(events: readonly LedgerEvent[], eventId: string): boolean {
  for (const event of events) {
    if (!object(event.data)) continue
    const messages = event.type === 'user/message' ? [event.data]
      : event.type === 'agent/inbox/spliced' && Array.isArray(event.data.inserted) ? event.data.inserted
        : event.type === 'agent/inbox/claimed' && object(event.data.message) ? [event.data.message] : []
    if (messages.some(message => object(message) && object(message.source)
      && message.source.kind === 'hivemind-runtime-event' && message.source.eventId === eventId)) return true
  }
  return false
}
/** Never forward an entire provider envelope, credentials or arbitrary nested payload. */
export function attentionEvidence(value: unknown) {
  const data = object(value) ? value : {}
  const display = object(data._hivemind) ? data._hivemind : {}
  const preview = object(data.preview) ? data.preview : {}
  const body = [data.preview, data.message_text, data.text, data.body, preview.body]
    .find(value => typeof value === 'string' && value.trim())
  return { title: text(display.title || data.subject || data.title, 200), preview: text(body, 1500) }
}
