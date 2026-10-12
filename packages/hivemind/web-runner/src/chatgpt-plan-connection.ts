import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'

const actions = ['status', 'start', 'callback', 'models', 'select', 'disconnect'] as const
export function registerPlanConnection(ctx: Context, base: string,
  authorize: (req: IncomingMessage) => string | undefined,
  origin: (req: IncomingMessage) => string,
  fetchImpl: typeof fetch = fetch): void {
  for (const action of actions) ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: `/api/hivemind/chatgpt-plan/${action}`,
    handler: async (req, res) => {
      const reply = (status: number, value: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify(value))
      }
      const method = action === 'status' ? 'GET' : 'POST'
      if (req.method !== method) { reply(405, { error: 'method_not_allowed' }); return }
      const token = authorize(req)
      if (!token) { reply(401, { error: 'authentication_required' }); return }
      if (method === 'POST' && req.headers.origin !== origin(req)) {
        reply(403, { error: 'same_origin_required' }); return
      }
      try {
        let body: Record<string, unknown> = {}
        if (method === 'POST') {
          const parts: Buffer[] = []; let bytes = 0
          for await (const part of req) {
            const buffer = Buffer.from(part); bytes += buffer.length
            if (bytes > 8192) { reply(413, { error: 'request_too_large' }); return }
            parts.push(buffer)
          }
          const parsed: unknown = JSON.parse(Buffer.concat(parts).toString() || '{}')
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { reply(400, { error: 'invalid_request' }); return }
          body = parsed as Record<string, unknown>
          const allowed = action === 'callback' ? ['state', 'code'] : action === 'select' ? ['model', 'platform_fallback'] : []
          if (Object.keys(body).some(key => !allowed.includes(key))) { reply(400, { error: 'invalid_request' }); return }
        }
        const upstream = await fetchImpl(`${base}/internal/v1/harness-chat/core/chatgpt-plan/connection/${action}`, {
          method, redirect: 'error', signal: AbortSignal.timeout(20000),
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
        })
        const value: unknown = await upstream.json()
        // Core endpoints only return connection state, model IDs or authorization URL; never grants.
        reply(upstream.status, value)
      } catch { reply(503, { error: 'chatgpt_connection_unavailable' }) }
    },
  }), `hivemind: ChatGPT connection ${action}`)
}
