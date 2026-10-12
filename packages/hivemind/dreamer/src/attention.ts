import { createHmac, randomUUID } from 'node:crypto'
import type { DreamRun } from './store.ts'

/** Forward identity only; the receiving service reloads authorized, published evidence. */
export async function forwardDreamAttention(
  run: DreamRun,
  options: { enabled: boolean; base?: string | undefined; secret?: string | undefined; timeoutMs: number },
): Promise<void> {
  if (!options.enabled || run.status !== 'completed' || run.trigger_id === 'introduction' || !run.output_ids.length) return
  if (!options.base || !options.secret || options.secret.length < 32) throw new Error('dream_attention_not_configured')
  const base = new URL(options.base)
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('dream_attention_origin_required')
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', 'control-plane'].includes(base.hostname)))
    throw new Error('dream_attention_secure_origin_required')
  const now = Math.floor(Date.now() / 1000)
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    iss: 'hivemind-dreamer', aud: 'hivemind-attention-signals', sub: run.user_id,
    org_id: run.org_id, run_id: run.id, iat: now, exp: now + 30, jti: randomUUID(),
  })}`
  const token = `${unsigned}.${createHmac('sha256', options.secret).update(unsigned).digest('base64url')}`
  const response = await fetch(new URL('/v1/internal/runtime-attention/signals', base), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'dreaming', runId: run.id, orgId: run.org_id, userId: run.user_id }),
  })
  if (!response.ok) throw new Error(`dream_attention_delivery_${response.status}`)
}
