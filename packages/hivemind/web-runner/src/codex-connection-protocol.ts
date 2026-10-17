/** Private runner/worker transport. Tokens are scoped to one installed connection and action. */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface CodexBinding {
  orgId: string
  userId: string
  connectionId: string
  endpoint: string
  secret: string
}
export const bridgeActions = [
  'status',
  'models',
  'resolve-model',
  'select',
  'disconnect',
  'stream',
  'images/generate',
  'voice/start',
  'voice/socket',
  'account/start',
  'account/answer',
  'account/cancel',
] as const
export type BridgeAction = (typeof bridgeActions)[number]
export const connectionIdPattern = /^[a-z0-9][a-z0-9-]{0,79}$/u
export function bridgeToken(binding: CodexBinding, action: BridgeAction): string {
  const payload = Buffer.from(
    JSON.stringify({
      orgId: binding.orgId,
      userId: binding.userId,
      connectionId: binding.connectionId,
      action,
      expires: Date.now() + 30_000,
      nonce: randomUUID(),
    }),
  ).toString('base64url')
  return `${payload}.${createHmac('sha256', binding.secret).update(payload).digest('base64url')}`
}
export function verifyBridgeToken(token: string, binding: CodexBinding, action: BridgeAction): boolean {
  if (token.length > 2048) return false
  const [payload, signature, extra] = token.split('.')
  if (!payload || !signature || extra) return false
  const expected = createHmac('sha256', binding.secret).update(payload).digest()
  const actual = Buffer.from(signature, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) return false
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>
    return (
      value.orgId === binding.orgId &&
      value.userId === binding.userId &&
      value.connectionId === binding.connectionId &&
      value.action === action &&
      typeof value.expires === 'number' &&
      value.expires > Date.now() &&
      value.expires <= Date.now() + 30_000 &&
      typeof value.nonce === 'string'
    )
  } catch {
    return false
  }
}
export async function connectionBody(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const parts: Uint8Array[] = []
  let size = 0
  for await (const part of req) {
    const value = Buffer.from(part as Uint8Array)
    size += value.length
    if (size > limit) throw Error('connection_request_too_large')
    parts.push(value)
  }
  const value: unknown = JSON.parse(Buffer.concat(parts).toString() || '{}')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('connection_invalid_request')
  return value as Record<string, unknown>
}
export function connectionReply(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}
