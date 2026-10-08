import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { forwardDreamAttention } from '../src/attention.ts'
import type { DreamRun } from '../src/store.ts'

const run = { id: 'run', org_id: 'org', user_id: 'user', status: 'completed', trigger_id: 'scheduled', output_ids: ['output'] } as DreamRun
const options = { enabled: true, base: 'https://control.example', secret: 's'.repeat(32), timeoutMs: 1000 }
afterEach(() => vi.unstubAllGlobals())
describe('Dreamer attention delivery', () => {
  it('sends only authoritative identity with a bounded owner-bound signature', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    await forwardDreamAttention(run, options)
    const [url, request] = fetchMock.mock.calls[0]
    expect(url.href).toBe('https://control.example/v1/internal/runtime-attention/signals')
    expect(JSON.parse(request.body)).toEqual({ source: 'dreaming', runId: 'run', orgId: 'org', userId: 'user' })
    const [header, payload, signature] = request.headers.authorization.slice(7).split('.')
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
    expect(claims).toMatchObject({ iss: 'hivemind-dreamer', aud: 'hivemind-attention-signals', sub: 'user', org_id: 'org', run_id: 'run' })
    expect(claims.exp - claims.iat).toBe(30)
    expect(signature).toBe(createHmac('sha256', options.secret).update(`${header}.${payload}`).digest('base64url'))
    expect(request.redirect).toBe('error')
  })
  it('does not forward disabled, incomplete, introductory or empty runs', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await forwardDreamAttention(run, { ...options, enabled: false })
    for (const patch of [{ status: 'running' }, { trigger_id: 'introduction' }, { output_ids: [] }])
      await forwardDreamAttention({ ...run, ...patch }, options)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('rejects unsafe configuration before contacting a receiver', async () => {
    for (const patch of [{ secret: 'short' }, { base: 'http://external.example' }, { base: 'https://control.example/path' }])
      await expect(forwardDreamAttention(run, { ...options, ...patch })).rejects.toThrow()
  })
  it('leaves failures retryable by the existing completion callback queue', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
    await expect(forwardDreamAttention(run, options)).rejects.toThrow('dream_attention_delivery_503')
  })
})
