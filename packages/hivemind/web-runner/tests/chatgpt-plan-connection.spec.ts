import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { registerPlanConnection } from '../src/chatgpt-plan-connection.ts'
it('requires same-origin writes, rejects caller owner fields, and forwards only authenticated service identity', async () => {
  const handlers = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()
  type Route = { path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }
  const ctx = { effect: (f: () => void) => f(), webServer: {
    register: ({ path, handler }: Route) => handlers.set(path, handler),
  } } as unknown as Context
  const upstream = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify({ available: false, connected: false })))
  registerPlanConnection(ctx, 'https://fixture-core', () => 'fixture-service-jwt', () => 'https://fixture-brain', upstream)
  async function invoke(action: string, method: string, origin: string | undefined, body = '{}') {
    const req = Readable.from([body]) as unknown as IncomingMessage
    Object.assign(req, { method, headers: { origin } })
    let status = 0; let value = ''
    const res = { writeHead: (code: number) => { status = code }, end: (text: string) => { value = text } } as unknown as ServerResponse
    await handlers.get(`/api/hivemind/chatgpt-plan/${action}`)!(req, res)
    return { status, value: JSON.parse(value) }
  }
  expect((await invoke('start', 'POST', 'https://other-origin')).status).toBe(403)
  expect((await invoke('start', 'POST', 'https://fixture-brain', '{"user_id":"other"}')).status).toBe(400)
  expect(upstream).not.toHaveBeenCalled()
  expect((await invoke('status', 'GET', undefined)).status).toBe(200)
  expect(upstream.mock.calls[0]?.[0]).toBe('https://fixture-core/internal/v1/harness-chat/core/chatgpt-plan/connection/status')
})
