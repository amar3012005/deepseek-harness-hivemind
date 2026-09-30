import { describe, expect, it } from 'vitest'
import { hqMode } from '../src/mode.ts'
describe('durable human HQ mode', () => {
  it('starts paused and replays committed human changes', () => {
    expect(hqMode([])).toEqual({ revision: 0, enabled: false, changedAt: 0 })
    expect(hqMode([
      { type: 'hivemind/hq-mode', data: { revision: 1, enabled: true, changedAt: 10 } },
      { type: 'hivemind/hq-mode', data: { revision: 2, enabled: false, changedAt: 11 } },
    ])).toEqual({ revision: 2, enabled: false, changedAt: 11 })
  })
  it('does not interpret model text or other events as authority', () => {
    expect(hqMode([{ type: 'assistant/message', data: { enabled: true } }]).enabled).toBe(false)
  })
  it('fails closed on malformed or noncontiguous persisted control records', () => {
    for (const data of [null, { revision: 2, enabled: true, changedAt: 10 }, { revision: 1, enabled: 'true', changedAt: 10 }]) {
      expect(() => hqMode([{ type: 'hivemind/hq-mode', data }])).toThrow('hq_invalid_mode_record')
    }
  })
})
