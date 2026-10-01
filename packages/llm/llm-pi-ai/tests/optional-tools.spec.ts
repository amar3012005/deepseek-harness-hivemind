import { describe, expect, it } from 'vitest'
import { preserveOptionalToolArguments } from '../src/adapter.ts'

describe('subscription tool arguments', () => {
  it('preserves optional schemas without mutating the request or native tools', () => {
    const parameters = { type: 'object', required: ['query'], properties: { query: { type: 'string' }, filename: { type: 'string' } } }
    const native = { type: 'web_search' }
    const original = { tools: [{ type: 'function', name: 'recall', parameters, strict: null }, native] }
    expect(preserveOptionalToolArguments(original)).toEqual({ tools: [{ type: 'function', name: 'recall', parameters, strict: false }, native] })
    expect(original.tools[0]).toHaveProperty('strict', null)
    expect(parameters.required).toEqual(['query'])
  })

  it('leaves requests without tools intact', () => {
    expect(preserveOptionalToolArguments(undefined)).toBeUndefined()
    const request = { input: [] }
    expect(preserveOptionalToolArguments(request)).toBe(request)
  })
})
