/** Receipt-only email presentation. No network request, sending, or approval action. */
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
export interface RuntimeNotification {
  key: string
  turn: number
  time: number
  subject: string
  kind: 'completion' | 'decision' | 'approval' | undefined
  status: 'sending' | 'sent' | 'delivered' | 'failed' | 'delivery-failed' | 'unknown'
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}
function json(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined
  try { return object(JSON.parse(value)) } catch { return undefined }
}
function subject(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, 120) || 'Runtime update' : 'Runtime update'
}
/** Narrow only the recorded authoritative result, never assistant prose or arguments. */
export function notificationStatus(result: Record<string, unknown> | undefined): RuntimeNotification['status'] {
  const receipt = object(result?.receipt)
  const delivery = receipt?.deliveryStatus
  if (result?.status === 'rejected' || result?.status === 'failed' || result?.status === 'disabled') return 'failed'
  if (['bounced', 'failed', 'rejected', 'undeliverable'].includes(String(delivery))) return 'delivery-failed'
  if (result?.status === 'accepted' && result.sent === true && receipt?.ok !== false) {
    return delivery === 'delivered' ? 'delivered' : 'sent'
  }
  return 'unknown'
}
const cache = new WeakMap<SessionEventWindow, readonly RuntimeNotification[]>()
/** Rebuild from the existing native history on reload; repeated receipts update one card. */
export function runtimeNotifications(log: SessionEventWindow): readonly RuntimeNotification[] {
  const cached = cache.get(log)
  if (cached) return cached
  const calls = new Map<string, RuntimeNotification>()
  const cards = new Map<string, RuntimeNotification>()
  const completed = new Set<number>()
  for (const entry of log.entries) {
    if (entry.type !== 'event') continue
    const event = entry.event
    if (event.type === 'turn/end') { completed.add(event.data.turn); continue }
    if (event.type === 'tool/call' && event.data.name === 'hivemind_administrator_message') {
      const args = json(event.data.arguments)
      const kind = args?.kind
      calls.set(String(event.data.callId), { key: String(event.data.callId), turn: event.data.turn,
        time: event.time, subject: subject(args?.subject),
        kind: kind === 'completion' || kind === 'decision' || kind === 'approval' ? kind : undefined, status: 'sending' })
    }
    if (event.type !== 'tool/result' || !isAppendSurfaceEvent(event)) continue
    const callId = String(event.data.message.source.callId)
    const call = calls.get(callId)
    if (!call) continue
    const content = event.data.message.content.flatMap(block => block.content)
    const result = content.reduce<Record<string, unknown> | undefined>((found, block) =>
      found ?? (block.type === 'text' ? json(block.text) : undefined), undefined)
    const id = typeof result?.message_id === 'string' && result.message_id ? result.message_id : callId
    const key = `email:${id}`
    const previous = cards.get(key)
    const isError = event.data.message.content.some(block => block.isError === true)
    const status = isError ? 'unknown' : notificationStatus(result)
    const preservesTerminal = (previous?.status === 'delivered' || previous?.status === 'delivery-failed')
      && (status === 'sent' || status === 'unknown')
    cards.set(key, { ...call, ...previous, key, time: previous?.time ?? event.time,
      status: preservesTerminal ? previous.status : status })
    calls.delete(callId)
  }
  for (const call of calls.values()) cards.set(`call:${call.key}`, { ...call,
    status: completed.has(call.turn) ? 'unknown' : 'sending' })
  const notifications = [...cards.values()]
  cache.set(log, notifications)
  return notifications
}
