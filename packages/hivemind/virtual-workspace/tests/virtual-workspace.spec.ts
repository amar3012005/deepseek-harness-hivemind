import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import HivemindVirtualWorkspaceRegistry from '../src/index.ts'

describe('HIVE virtual workspace registry', () => {
  it('provides the native dependency without exposing a filesystem workspace', () => {
    const registry = new HivemindVirtualWorkspaceRegistry(new Context())
    expect(registry.list()).toEqual([])
    expect(registry.get('browser-controlled-id')).toBeUndefined()
  })
})
