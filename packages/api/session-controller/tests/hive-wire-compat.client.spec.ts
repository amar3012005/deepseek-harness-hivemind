import { describe, expect, it } from 'vitest'
import { adaptHiveWireEvent } from '../src/client/hive-wire-compat.ts'
import { assertSessionWireEvent } from '../src/client/session-wire-event.ts'

describe('frozen HIVE journal browser compatibility', () => {
  it('preserves the recorded system prompt and event identity without changing the source', () => {
    const source = { type: 'request/header', seq: 4, time: 10, data: {
      turn: 1, step: 1, reason: 'initial', header: { system: 'Tenant-scoped instructions', tools: [], adapterDefaults: {} },
    } }
    const before = JSON.stringify(source)
    const projected = adaptHiveWireEvent(source)
    expect(() => assertSessionWireEvent(projected)).not.toThrow()
    expect(projected).toMatchObject({ seq: 4, time: 10, data: { header: { hiveLegacySystem: 'Tenant-scoped instructions' } } })
    expect(JSON.stringify(source)).toBe(before)
    expect(() => assertSessionWireEvent(source)).toThrow(/header.system/)
  })
  it('preserves replacement sequence endpoints and provenance', () => {
    const source = { type: 'user/message', seq: 12, time: 20, data: {},
      surfaceOp: { op: 'replace', start: 4, end: 8 }, sourceEventSeqs: [4, 8] }
    expect(adaptHiveWireEvent(source)).toEqual({ ...source, surfaceOp: { op: 'replace', startSeq: 4, endSeq: 8 } })
  })
  it('rejects malformed legacy prompts instead of hiding them', () => {
    expect(() => adaptHiveWireEvent({ type: 'request/header', data: { header: { system: {} } } })).toThrow()
  })
})
