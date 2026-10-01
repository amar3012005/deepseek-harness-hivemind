import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include'
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
  it('mounts HQ coordination inside the effective private company realm without skipped include patches', () => {
    const parse = (name: string) => load(readFileSync(new URL(`../../../preset/agent-presets/presets/${name}/agent.cordis.yml`, import.meta.url), 'utf8'), { schema: entryListSchema }) as EntryOptions[]
    const hq = parse('hivemind-hq')
    expect(hq[0].config.path).toBe('../hivemind-chat/agent.cordis.yml')
    const warnings: string[] = []
    const effective = applyEntryPatches(parse('hivemind-chat'), hq[0].config.patches, message => warnings.push(message))
    expect(warnings).toEqual([])
    const rows: EntryOptions[] = []
    const visit = (entries: EntryOptions[]) => {
      for (const entry of entries) {
        rows.push(entry)
        if (entry.group && Array.isArray(entry.config)) visit(entry.config)
      }
    }
    visit(effective)
    expect(rows.filter(row => row.id === 'hivemind-hq-runtime')).toHaveLength(1)
    expect(rows.find(row => row.id === 'persona').config.prefix).toContain('chief of staff')
    expect(rows.find(row => row.id === 'hivemind-capabilities').isolate.hivemindMemory).toBe(true)
    for (const id of ['hivemind-runtime', 'hivemind-employee-directory', 'hivemind-research', 'hivemind-progressive-browser', 'hivemind-artifact-renderer']) expect(rows.some(row => row.id === id)).toBe(true)
    const disclosure = rows.find(row => row.id === 'hivemind-playbooks').config
    expect(disclosure.progressiveToolDisclosure).toBe(true)
    expect(disclosure.coreTools).toEqual(expect.arrayContaining(['hivemind_hq_orientation', 'hivemind_hq_continuity', 'hivemind_hq_contract', 'team_task_create', 'schedule_create']))
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
