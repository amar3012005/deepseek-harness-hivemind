import { describe, expect, it } from 'vitest'
import { publicHost } from '../src/authority.ts'

describe('HIVE runner public authority', () => {
  it('uses the reverse-proxy-pinned Host before a transport forwarded host', () => {
    expect(publicHost({
      host: 'dev.next.singulancelabs.com',
      'x-forwarded-host': 'harness-origin.dev.next.singulancelabs.com',
    })).toBe('dev.next.singulancelabs.com')
  })

  it('uses the first forwarded authority when Host is absent', () => {
    expect(publicHost({ 'x-forwarded-host': 'public.example, transport.example' })).toBe('public.example')
    expect(publicHost({})).toBeUndefined()
  })
})
