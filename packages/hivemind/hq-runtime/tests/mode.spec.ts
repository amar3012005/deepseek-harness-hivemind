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
  it('recovers the paused legacy fresh-start seed and preserves revision checks', () => {
    const seed = { type: 'hivemind/hq-mode', data: { revision: 0, enabled: false, changedAt: 10 } }
    expect(hqMode([seed]).enabled).toBe(false)
    expect(hqMode([seed, { type: 'hivemind/hq-mode', data: { revision: 1, enabled: true, changedAt: 11 } }]).enabled).toBe(true)
    expect(() => hqMode([seed, seed])).toThrow('hq_invalid_mode_record')
    expect(() => hqMode([{ ...seed, data: { ...seed.data, enabled: true } }])).toThrow('hq_invalid_mode_record')
  })
  it('fails closed on malformed or noncontiguous persisted control records', () => {
    for (const data of [null, { revision: 2, enabled: true, changedAt: 10 }, { revision: 1, enabled: 'true', changedAt: 10 }]) {
      expect(() => hqMode([{ type: 'hivemind/hq-mode', data }])).toThrow('hq_invalid_mode_record')
    }
  })
})
