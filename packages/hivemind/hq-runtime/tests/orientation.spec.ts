import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { hqBaseline, hqStrategyRevision } from '../src/orientation.ts'

describe('HQ company baseline', () => {
  it('restores versioned understanding without fabricating evidence or company-memory writes', () => {
    const one = { revision: 1, observedAt: 1, summary: 'Verified company profile; social presence unknown.', evidenceSequences: [12] }
    const two = { ...one, revision: 2, observedAt: 2, summary: 'Profile and assessment received.', evidenceSequences: [12, 40] }
    expect(hqBaseline([{ type: 'hivemind/hq-baseline', data: one }, { type: 'hivemind/hq-baseline', data: two }])).toEqual(two)
    expect(hqBaseline([])).toBeUndefined()
    expect(() => hqBaseline([{ type: 'hivemind/hq-baseline', data: { ...one, evidenceSequences: [] } }])).toThrow('hq_invalid_baseline_record')
    expect(() => hqBaseline([{ type: 'hivemind/hq-baseline', data: { ...one, revision: 2 } }])).toThrow('hq_invalid_baseline_record')
  })
  it('does not invalidate owner review merely because activity was acknowledged', () => {
    expect(hqStrategyRevision([{ type: 'hivemind/hq-continuity', data: { revision: 1, strategy: 'Investigate' } }, { type: 'hivemind/hq-continuity', data: { revision: 2, strategy: 'Investigate' } }])).toBe(1)
  })
  it('retains the native company-memory isolation realm and progressive awakening instructions', () => {
    const chat = readFileSync(new URL('../../../preset/agent-presets/presets/hivemind-chat/agent.cordis.yml', import.meta.url), 'utf8')
    expect(chat).toContain('hivemindMemory: true')
    const hq = readFileSync(new URL('../../../preset/agent-presets/presets/hivemind-hq/agent.cordis.yml', import.meta.url), 'utf8')
    expect(hq).toContain('hivemind_hq_orientation inspect')
    expect(hq).toContain('hivemind_hq_review_strategy')
    expect(hq).toContain('not a mandatory day-one sequence')
  })
})
