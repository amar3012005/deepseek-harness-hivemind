import { expect, it, vi } from 'vitest'
import { fetchEmployeeCatalog } from '../src/index.ts'

it('recovers one transient catalog failure without changing identity or admission', async () => {
  const request = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(Response.json({ profiles: [] }))
  expect((await fetchEmployeeCatalog(new URL('https://catalog.example'), { authorization: 'same-server-witness' }, request)).status).toBe(200)
  expect(request).toHaveBeenCalledTimes(2)
  expect(request.mock.calls[0]?.[1]).toEqual(request.mock.calls[1]?.[1])
})
it.each([401, 403, 500])('preserves catalog status %s without retry', async (status) => {
  const request = vi.fn().mockResolvedValue(new Response('', { status }))
  expect((await fetchEmployeeCatalog(new URL('https://catalog.example'), {}, request)).status).toBe(status)
  expect(request).toHaveBeenCalledTimes(1)
})
it('ends after the second transient failure', async () => {
  const request = vi.fn().mockRejectedValue(new Error('unavailable'))
  await expect(fetchEmployeeCatalog(new URL('https://catalog.example'), {}, request)).rejects.toThrow('unavailable')
  expect(request).toHaveBeenCalledTimes(2)
})
