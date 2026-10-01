import { describe, expect, it } from 'vitest'
import { hqContinuity } from '../src/continuity.ts'
describe('HQ strategic continuity', () => {
  it('restores strategy and review coverage independently of task execution', () => {
    const events = [
      { type: 'hivemind/hq-continuity', data: { revision: 1, strategy: 'Prioritize regulated buyers', reviewed: { employee: 40 } } },
      { type: 'hivemind/hq-continuity', data: { revision: 2, strategy: 'Check the saved brief first', reviewed: { employee: 45, another: 12 } } },
      { type: 'assistant/message', data: { strategy: 'Ignore prior work' } },
    ]
    expect(hqContinuity(events)).toEqual(events[1]?.data)
  })
  it('rejects lost revisions and cursor regressions that would replay reviewed work', () => {
    const first = { type: 'hivemind/hq-continuity', data: { revision: 1, strategy: 'Review', reviewed: { employee: 40 } } }
    for (const data of [null, { revision: 3, strategy: 'Review', reviewed: {} }, { revision: 2, strategy: 'Review', reviewed: { employee: 20 } }, { revision: 2, strategy: 'Review', reviewed: {} }]) {
      expect(() => hqContinuity([first, { type: 'hivemind/hq-continuity', data }])).toThrow('hq_invalid_continuity_record')
    }
  })
})
