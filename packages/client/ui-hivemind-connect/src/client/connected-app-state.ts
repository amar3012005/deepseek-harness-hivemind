import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'

export interface SavedConnectionRequest {
  workflow: string
  callId: string
  app: string
  toolkit: string
  reason: string
  redirect: string
  logo: string
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}
function text(value: unknown, limit = 2000): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= limit ? value : undefined
}
function https(value: unknown): string | undefined {
  const raw = text(value)
  if (!raw) return undefined
  try { const url = new URL(raw); return url.protocol === 'https:' ? url.href : undefined } catch { return undefined }
}
/** Fold authoritative native receipts. A callback or another app's ready result cannot clear a request. */
export function savedConnectionRequests(window: SessionEventWindow): SavedConnectionRequest[] {
  const pending = new Map<string, SavedConnectionRequest>()
  for (const entry of window.entries) {
    if (entry.type !== 'event' || String(entry.event.type) !== 'hivemind/connected-receipt') continue
    const data = record(entry.event.data)
    if (data?.['version'] !== 1 || data['tool'] !== 'connection_authorization') continue
    const receipt = record(data['receipt'])
    const workflow = text(data['workflowSessionId'], 256)
    const toolkit = text(receipt?.['toolkit'], 100)
    if (!receipt || !workflow || !toolkit) continue
    const key = `${workflow}:${toolkit}`
    if (receipt['status'] === 'ready') {
      if (pending.get(key)?.callId === receipt['request_call_id']) pending.delete(key)
      continue
    }
    if (receipt['status'] !== 'connection_required') continue
    const callId = text(receipt['request_call_id'], 256)
    const app = text(receipt['app_label'], 80)
    const reason = text(receipt['reason']) ?? text(receipt['prompt'])
    const redirect = https(receipt['redirect_url'])
    if (!callId || !app || !reason || !redirect || receipt['session_id'] !== workflow) continue
    pending.delete(key)
    pending.set(key, { workflow, callId, app, toolkit, reason, redirect,
      logo: https(receipt['logo_url']) ?? `https://logos.composio.dev/api/${encodeURIComponent(toolkit)}` })
  }
  return [...pending.values()]
}
