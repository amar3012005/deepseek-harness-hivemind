import { expect, it, vi } from 'vitest'
import { modelConnectionPrincipal } from '../src/model-connection-principal.ts'
const orgId = '11111111-1111-4111-8111-111111111111', userId = '22222222-2222-4222-8222-222222222222'
it('uses only authoritative bootstrap identity and the human session cookie', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ authenticated: true, user: { id: userId }, organization: { id: orgId } }))
  const result = await modelConnectionPrincipal({ headers: { cookie: 'other=private; hm_cp_session=fixture', 'x-user-id': 'foreign' } } as never, new URL('https://control.example'), new AbortController().signal, fetcher)
  expect(result).toEqual({ orgId, userId })
  expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({ cookie: 'hm_cp_session=fixture', accept: 'application/json' })
  expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://control.example/v1/bootstrap')
})
it('rejects anonymous, expired and incomplete sessions', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 401 }))
  const args = [new URL('https://control.example'), new AbortController().signal, fetcher] as const
  expect(await modelConnectionPrincipal({ headers: {} } as never, ...args)).toBeUndefined()
  expect(fetcher).not.toHaveBeenCalled()
  expect(await modelConnectionPrincipal({ headers: { cookie: 'hm_cp_session=expired' } } as never, ...args)).toBeUndefined()
  fetcher.mockImplementation(async () => Response.json({ user: { id: userId }, organization: { id: 'foreign' } }))
  expect(await modelConnectionPrincipal({ headers: { cookie: 'hm_cp_session=fixture' } } as never, ...args)).toBeUndefined()
})
