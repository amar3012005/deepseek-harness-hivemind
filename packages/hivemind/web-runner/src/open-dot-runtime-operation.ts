/** Purpose-bound Core relay receiver; native assignment/session resolution belongs to the injected service. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const OPEN_DOT_RUNTIME_OPERATION_PATH = '/internal/hivemind/open-dot/runtime/employee-operation'
export type OpenDotApprovedArgs = { message_key: string; recipient: string; kind: 'question' | 'reply' | 'update'; text: string; artifact_ids: string[]; summary?: string; reply_to?: string } | { blocker_key: string; question: string; summary?: string }
export interface OpenDotRuntimeOperationInput {
  principal: { organizationId: string; userId: string }
  employeeId: string; dotId: string; dispatchMessageId: string
  operation: 'message' | 'blocker'; approvedargs: OpenDotApprovedArgs
}
export interface OpenDotRuntimeOperationReceipt { accepted: true; receipt_id: string; delivery_state: string }
export interface OpenDotRuntimeOperationService {
  /** Must authorize the persisted assignment and use its actual native session; honor cancellation before durable acceptance. */
  execute(input: OpenDotRuntimeOperationInput, signal: AbortSignal): Promise<OpenDotRuntimeOperationReceipt>
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const common = ['organization_id', 'user_id', 'employee_id', 'dot_id', 'dispatch_message_id', 'operation']
class Rejection extends Error { constructor(public status: number, public code: string) { super(code) } }
function reject(status = 400, code = 'invalid_open_dot_employee_operation'): never { throw new Rejection(status, code) }
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(k => !keys.includes(k))) reject()
}
function text(value: unknown, max: number): string { if (typeof value !== 'string' || !value.trim() || value.length > max) reject(); return value.trim() }
function parse(raw: string): unknown { try { return JSON.parse(raw) } catch { return reject() } }
function decode(part: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(part) || Buffer.from(part, 'base64url').toString('base64url') !== part) reject(401, 'invalid_open_dot_runtime_authorization')
  return parse(Buffer.from(part, 'base64url').toString('utf8'))
}
function equal(a: Buffer, b: Buffer) { return a.length === b.length && timingSafeEqual(a, b) }
export function verifyOpenDotRuntimeOperation(raw: string, authorization: string, secret: string, now = Date.now()): OpenDotRuntimeOperationInput {
  if (Buffer.byteLength(secret) < 32) reject(503, 'open_dot_runtime_bridge_unavailable')
  const token = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization)?.[1]
  if (!token || token.length > 8192) reject(401, 'invalid_open_dot_runtime_authorization')
  const [h, p, sig] = token.split('.')
  if (Buffer.from(sig, 'base64url').toString('base64url') !== sig) reject(401, 'invalid_open_dot_runtime_authorization')
  if (!equal(createHmac('sha256', secret).update(`${h}.${p}`).digest(), Buffer.from(sig, 'base64url'))) reject(401, 'invalid_open_dot_runtime_authorization')
  const header = decode(h), claims = decode(p)
  exact(header, ['alg', 'typ']); if (header.alg !== 'HS256' || header.typ !== 'JWT') reject(401)
  exact(claims, ['iss','aud','sub','org_id','profile','variation','jti','body_sha256','iat','exp','employee_id','dot_id','dispatch_message_id','operation'])
  const at = Math.floor(now / 1000)
  if (claims.iss !== 'hivemind-control-plane' || claims.aud !== 'hivemind-open-dot-runtime-bridge' || claims.profile !== 'hivemind-chat' || claims.variation !== 'harness' || !UUID.test(String(claims.jti)) || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || Number(claims.exp) <= Number(claims.iat) || Number(claims.exp) - Number(claims.iat) > 30 || Number(claims.iat) > at + 5 || Number(claims.exp) < at - 5 || claims.body_sha256 !== createHash('sha256').update(raw).digest('hex')) reject(401, 'invalid_open_dot_runtime_authorization')
  const body = parse(raw)
  exact(body, [...common, ...(claims.operation === 'message' ? ['message_key','recipient','kind','text','summary','reply_to','artifact_ids'] : ['blocker_key','question','summary'])])
  for (const k of ['organization_id','user_id','employee_id','dispatch_message_id']) if (typeof body[k] !== 'string' || !UUID.test(body[k])) reject()
  if (typeof body.dot_id !== 'string' || body.dot_id.length > 180 || !/^dot_[a-zA-Z0-9_-]+$/.test(body.dot_id)) reject()
  if (claims.sub !== body.user_id || claims.org_id !== body.organization_id || ['employee_id','dot_id','dispatch_message_id','operation'].some(k => claims[k] !== body[k])) reject(403, 'open_dot_runtime_principal_mismatch')
  let args: OpenDotApprovedArgs
  if (body.operation === 'message') {
    if (!['question','reply','update'].includes(String(body.kind))) reject()
    const ids = body.artifact_ids ?? []
    if (!Array.isArray(ids) || ids.length > 8 || ids.some(id => typeof id !== 'string' || !/^file_[a-f0-9]{16,64}$/.test(id))) reject()
    args = { message_key: text(body.message_key,120), recipient: text(body.recipient,180), kind: body.kind as 'question'|'reply'|'update', text: text(body.text,12000), artifact_ids: [...ids] }
    if (body.reply_to !== undefined) args.reply_to = text(body.reply_to,180)
  } else if (body.operation === 'blocker') args = { blocker_key: text(body.blocker_key,120), question: text(body.question,4000) }
  else reject()
  if (body.summary !== undefined) args.summary = text(body.summary,1000)
  return { principal: { organizationId: body.organization_id as string, userId: body.user_id as string }, employeeId: body.employee_id as string, dotId: body.dot_id, dispatchMessageId: body.dispatch_message_id as string, operation: body.operation, approvedargs: args }
}
export function createOpenDotRuntimeOperationHandler(service: OpenDotRuntimeOperationService, options: { secret?: string; now?: () => number } = {}) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const controller = new AbortController()
    const abort = () => controller.abort()
    const close = () => { if (!res.writableEnded) abort() }
    req.once('aborted', abort); res.once('close', close)
    const respond = (status: number, value: unknown) => { if (res.destroyed || res.writableEnded) return; res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
    try {
      if (req.url !== OPEN_DOT_RUNTIME_OPERATION_PATH) reject(404, 'not_found')
      if (req.method !== 'POST') reject(405, 'method_not_allowed')
      for (const key of ['authorization','content-type']) if (req.rawHeaders.filter((v,i) => i % 2 === 0 && v.toLowerCase() === key).length !== 1) reject(400)
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(String(req.headers['content-type']))) reject(415, 'unsupported_media_type')
      if (req.headers['content-encoding'] || Number(req.headers['content-length'] || 0) > 65536) reject(413, 'request_too_large')
      const chunks: Buffer[] = []; let size = 0
      for await (const part of req) { const bytes = Buffer.from(part); size += bytes.length; if (size > 65536) reject(413, 'request_too_large'); chunks.push(bytes) }
      if (controller.signal.aborted || req.aborted) reject(499, 'request_cancelled')
      const input = verifyOpenDotRuntimeOperation(Buffer.concat(chunks).toString('utf8'), String(req.headers.authorization || ''), options.secret ?? process.env.HIVE_HARNESS_RUNNER_SERVICE_SECRET ?? '', options.now?.())
      const receipt = await service.execute(input, controller.signal)
      // A persisted receipt remains authoritative even when cancellation races with acceptance.
      exact(receipt, ['accepted','receipt_id','delivery_state'])
      if (receipt.accepted !== true || typeof receipt.receipt_id !== 'string' || !receipt.receipt_id.trim() || receipt.receipt_id.length > 180 || typeof receipt.delivery_state !== 'string' || !/^[a-z][a-z0-9_-]{0,79}$/.test(receipt.delivery_state)) reject(502, 'open_dot_runtime_invalid_receipt')
      respond(200, receipt)
    } catch (error) {
      respond(error instanceof Rejection ? error.status : controller.signal.aborted ? 499 : 503, { error: error instanceof Rejection ? error.code : controller.signal.aborted ? 'request_cancelled' : 'open_dot_runtime_unavailable' })
    } finally { req.off('aborted', abort); res.off('close', close) }
  }
}
