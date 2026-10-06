import { describe, it, expect } from 'vitest'
import { privateMemoryFailure } from '../src/private-memory-errors.ts'
describe('private memory error reporting', () => {
  it('returns specific bounded recovery without provider text', () => {
    expect(privateMemoryFailure({ error: 'invalid_runtime_memory_evidence', details: 'untrusted body' }))
      .toEqual({ code: 'invalid_runtime_memory_evidence', message: expect.stringContaining('Evidence is optional') })
  })
  it('does not expose unknown body contents or inherited properties', () => {
    for (const error of ['secret value', 'constructor', '__proto__', 'invalid_fake_provider_body'])
      expect(privateMemoryFailure({ error })).toBeUndefined()
    expect(privateMemoryFailure(null)).toBeUndefined()
  })
})
