// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { resolvedShowSystemPrompts } from '../src/client/apply.ts'

const globals = globalThis as {
  __HIVEMIND_EMBED_CONFIG__?: { version?: unknown }
}

afterEach(() => {
  delete globals.__HIVEMIND_EMBED_CONFIG__
})

describe('HIVE browser presentation', () => {
  it('hides transcript system-prompt cards only in the native HIVE shell', () => {
    expect(resolvedShowSystemPrompts({ showSystemPrompts: true })).toBe(true)

    globals.__HIVEMIND_EMBED_CONFIG__ = { version: 1 }
    expect(resolvedShowSystemPrompts({ showSystemPrompts: true })).toBe(false)
  })
})
