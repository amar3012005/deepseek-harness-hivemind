import { describe, expect, it } from 'vitest'
import { transportIsLoopback } from '../src/client/transport-authority.ts'
describe('packaged remote Host authority', () => {
  it('never elevates packaged localhost or absent location', () => {
    expect(transportIsLoopback({ remoteHost: true }, { hostname: 'localhost' })).toBe(false)
    expect(transportIsLoopback({ remoteHost: true }, undefined)).toBe(false)
    expect(transportIsLoopback({ remoteHost: true, ownsHost: true }, { hostname: 'localhost' })).toBe(false)
  })
  it('preserves owned worker and normal hosted browser semantics', () => {
    expect(transportIsLoopback({ ownsHost: true }, { hostname: 'example.com' })).toBe(true)
    expect(transportIsLoopback(undefined, { hostname: 'localhost' })).toBe(true)
    expect(transportIsLoopback(undefined, { hostname: 'next.singulancelabs.com' })).toBe(false)
  })
})
