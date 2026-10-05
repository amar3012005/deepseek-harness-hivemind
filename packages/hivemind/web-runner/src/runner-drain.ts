/** Read-only release preflight over the existing process-wide native agent registry. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { timingSafeEqual } from 'node:crypto'

export function registerRunnerDrainStatus(ctx: Context, secret: string): void {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/internal/hivemind/runner-drain-status', handler: async (req, res) => {
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', 'no-store')
    const supplied = req.headers.authorization
    const expected = Buffer.from(`Bearer ${secret}`)
    const actual = Buffer.from(typeof supplied === 'string' ? supplied : '')
    if (Buffer.byteLength(secret) < 32 || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      res.statusCode = 401; res.end('{"error":"unauthorized"}'); return
    }
    if (req.method !== 'GET') {
      res.statusCode = 405; res.setHeader('allow', 'GET'); res.end('{"error":"method_not_allowed"}'); return
    }
    try {
      // list() includes direct rooms and owned agents, unlike roots().
      const active = ctx.agents.list().filter(agent => agent.status === 'running').length
      res.statusCode = 200; res.end(JSON.stringify({ active_turns: active }))
    } catch {
      res.statusCode = 503; res.end('{"error":"agent_registry_unavailable"}')
    }
  } }), 'hivemind-web-runner: authenticated runner release status')
}
