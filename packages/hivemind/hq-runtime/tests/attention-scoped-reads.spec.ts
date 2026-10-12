import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { nativeSignalProvenanceSql } from '../src/attention.ts'

it('reads only scoped views while retaining the activation cutoff and native provenance', () => {
  const sql = nativeSignalProvenanceSql('hivemind', '2026-10-08T04:00:17Z')
  expect(sql).toContain('e.native_source_valid')
  expect(sql).toContain("e.native_source_created_at>='2026-10-08T04:00:17.000Z'")
  expect(sql).not.toContain('memories m')
  const source = readFileSync(new URL('../src/attention.ts', import.meta.url), 'utf8')
  for (const view of ['hivemind_attention_events', 'hivemind_attention_subscriptions', 'hivemind_attention_decision_memories']) expect(source).toContain(view)
  for (const table of ['hivemind_trigger_events', 'hivemind_trigger_subscriptions', 'hyper_agent_operating_memories']) expect(source).not.toContain(table)
})

it('rejects unsafe schema identifiers before interpolating any native query', () => {
  expect(() => nativeSignalProvenanceSql('hivemind; DROP SCHEMA public', '2026-10-08')).toThrow('invalid_signal_schema')
})
