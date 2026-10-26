import { describe, expect, it } from 'vitest'
import { SchemaCache } from '../src/schema-cache.ts'

function clock(start = 1_000) {
  let now = start
  return { now: () => now, advance: (ms: number) => { now += ms } }
}

describe('SchemaCache', () => {
  it('returns a stored contract only within its TTL', () => {
    const time = clock()
    const cache = new SchemaCache<string>(60_000, time.now)
    cache.set('org:user', 'GMAIL_FETCH_EMAILS', 'hash-1', 'contract')
    expect(cache.get('org:user', 'GMAIL_FETCH_EMAILS')).toBe('contract')
    time.advance(59_999)
    expect(cache.get('org:user', 'GMAIL_FETCH_EMAILS')).toBe('contract')
    time.advance(1)
    expect(cache.get('org:user', 'GMAIL_FETCH_EMAILS')).toBeUndefined()
  })

  it('misses when the caller requires a different schema version', () => {
    const cache = new SchemaCache<string>(60_000, clock().now)
    cache.set('org:user', 'GMAIL_FETCH_EMAILS', 'hash-1', 'contract')
    expect(cache.get('org:user', 'GMAIL_FETCH_EMAILS', 'hash-1')).toBe('contract')
    expect(cache.get('org:user', 'GMAIL_FETCH_EMAILS', 'hash-2')).toBeUndefined()
  })

  it('isolates tenants and users that share a tool slug', () => {
    const cache = new SchemaCache<string>(60_000, clock().now)
    cache.set('org-a:user-1', 'GMAIL_FETCH_EMAILS', 'hash-1', 'a')
    expect(cache.get('org-b:user-1', 'GMAIL_FETCH_EMAILS')).toBeUndefined()
    expect(cache.get('org-a:user-2', 'GMAIL_FETCH_EMAILS')).toBeUndefined()
  })

  it('drops every entry of one tenant on invalidation and keeps other tenants', () => {
    const cache = new SchemaCache<string>(60_000, clock().now)
    cache.set('org-a:user-1', 'GMAIL_FETCH_EMAILS', 'hash-1', 'a-gmail')
    cache.set('org-a:user-1', 'SLACK_LIST_CHANNELS', 'hash-2', 'a-slack')
    cache.set('org-b:user-1', 'GMAIL_FETCH_EMAILS', 'hash-1', 'b-gmail')
    cache.invalidateTenant('org-a:user-1')
    expect(cache.get('org-a:user-1', 'GMAIL_FETCH_EMAILS')).toBeUndefined()
    expect(cache.get('org-a:user-1', 'SLACK_LIST_CHANNELS')).toBeUndefined()
    expect(cache.get('org-b:user-1', 'GMAIL_FETCH_EMAILS')).toBe('b-gmail')
  })

  it('stores nothing when the TTL is zero', () => {
    const cache = new SchemaCache<string>(0, clock().now)
    cache.set('org:user', 'GMAIL_FETCH_EMAILS', 'hash-1', 'contract')
    expect(cache.get('org:user', 'GMAIL_FETCH_EMAILS')).toBeUndefined()
  })

  it('evicts expired entries when a later write occurs', () => {
    const time = clock()
    const cache = new SchemaCache<string>(1_000, time.now)
    cache.set('org:user', 'OLD_READ', 'hash-1', 'old')
    time.advance(1_000)
    cache.set('org:user', 'NEW_READ', 'hash-2', 'new')
    expect(cache.get('org:user', 'NEW_READ')).toBe('new')
    expect(cache.get('org:user', 'OLD_READ')).toBeUndefined()
  })
})
