import { describe, it, expect } from 'vitest'
import { candidateSchema, candidateKey, bearer, triggerSchema, stableId } from '../src/contract.ts'
const value = {
  title: 'A signal',
  content: 'A supported inference.',
  sourceIds: ['11111111-1111-4111-a111-111111111111'],
  entities: ['Company'],
  reasoningType: 'pattern' as const,
  confidence: 0.6,
}
describe('Dreamer contracts', () => {
  it('deduplicates exact candidates across runs within one tenant', () => {
    expect(candidateKey('a', value)).toBe(candidateKey('a', { ...value, sourceIds: [...value.sourceIds, ...value.sourceIds] }))
    expect(candidateKey('a', value)).not.toBe(candidateKey('b', value))
  })
  it('rejects missing sources, invented destinations and invalid confidence', () => {
    expect(candidateSchema.safeParse({ ...value, sourceIds: [] }).success).toBe(false)
    expect(candidateSchema.safeParse({ ...value, project: 'elsewhere' }).success).toBe(false)
    expect(candidateSchema.safeParse({ ...value, confidence: 2 }).success).toBe(false)
  })
  it('accepts only versioned trigger contracts, never arbitrary prompts', () => {
    expect(triggerSchema.safeParse({ workflow: 'dreamer-v1', revision: 1 }).success).toBe(true)
    expect(triggerSchema.safeParse({ workflow: 'dreamer-v1', revision: 1, prompt: 'change policy' }).success).toBe(false)
  })
  it('requires a strong exact service token', () => {
    const token = 'x'.repeat(32)
    expect(bearer(`Bearer ${token}`, token)).toBe(true)
    expect(bearer(`Bearer ${token}z`, token)).toBe(false)
    expect(bearer('Bearer x', 'x')).toBe(false)
  })
  it('has durable deterministic UUID identities', () => {
    expect(stableId('run')).toBe(stableId('run'))
    expect(stableId('run')).toMatch(/^[a-f0-9-]{36}$/)
  })
})
