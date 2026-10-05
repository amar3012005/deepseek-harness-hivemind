import { describe, expect, it } from 'vitest'
import { principalMembershipActive } from '../src/principal-membership.ts'

describe('authoritative principal membership', () => {
  it('allows only a bounded explicit active response, without caching', async () => {
    let calls = 0
    const fetcher = (async (_url, options) => {
      calls++
      expect(options?.redirect).toBe('error')
      return new Response(JSON.stringify(calls === 1 ? { active: true } : { error: 'denied' }), { status: calls === 1 ? 200 : 403 })
    }) as typeof fetch
    expect(await principalMembershipActive('http://core.test', 'fixture', new AbortController().signal, fetcher)).toBe(true)
    expect(await principalMembershipActive('http://core.test', 'fixture', new AbortController().signal, fetcher)).toBe(false)
    expect(calls).toBe(2)
  })
  it('fails closed on unavailable, invalid, oversized and aborted responses', async () => {
    for (const body of ['{}', '{"active":true,"extra":1}', 'x'.repeat(257)]) {
      expect(await principalMembershipActive('http://core.test', 'fixture', new AbortController().signal, (async () => new Response(body)) as typeof fetch)).toBe(false)
    }
    expect(await principalMembershipActive('http://core.test', 'fixture', new AbortController().signal, (async () => { throw Error('unavailable') }) as typeof fetch)).toBe(false)
    const controller = new AbortController(); controller.abort()
    expect(await principalMembershipActive('http://core.test', 'fixture', controller.signal, (async () => new Response('{"active":true}')) as typeof fetch)).toBe(false)
  })
})
