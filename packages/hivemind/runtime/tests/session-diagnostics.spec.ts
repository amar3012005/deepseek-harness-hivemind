import { expect, it } from 'vitest'
import { sessionDiagnostics, sessionDiagnosticsTool } from '../src/session-diagnostics.ts'
const time = Date.parse('2026-10-11T00:00:00Z')
const events = [
  { type: 'tool/call', seq: 1, time: time - 1, data: { callId: 'first', name: 'artifact_inspect', turn: 1 } },
  { type: 'tool/result', seq: 2, time, data: { turn: 1, message: { source: { callId: 'first' }, content: [{ isError: true, content: 'SCHEMA_INVALID' }] } } },
  { type: 'tool/result', seq: 3, time: time + 1, data: { message: { content: [{ isError: false, content: 'success' }] } } },
  { type: 'user/message', seq: 4, time: time + 2, data: { source: { plugin: 'compact' }, text: 'Summary omitted the old error' } },
  { type: 'compaction/end', seq: 5, time: time + 3, data: { turn: 2, error: 'no text summary' } },
  { type: 'turn/end', seq: 6, time: time + 4, data: { turn: 2, reason: { kind: 'error', error: { code: 'PROVIDER_ERROR' } } } },
]
it('filters original receipts after compaction, preserving call name, exact window and pagination', () => {
  const first = sessionDiagnostics(events, time, time + 4, 0, 1)
  expect(first.failures).toEqual([{ kind: 'tool_result', tool: 'artifact_inspect', observed: 'SCHEMA_INVALID', sequence: 2, turn: 1, time: '2026-10-11T00:00:00.000Z' }])
  expect(first.has_more).toBe(true)
  expect(sessionDiagnostics(events, time, time + 4, first.next_sequence as number, 25).failures).toEqual([{ kind: 'compaction_error', observed: 'no text summary', sequence: 5, turn: 2, time: '2026-10-11T00:00:00.003Z' }])
  expect(sessionDiagnostics(events, time, time + 5, 5, 25).failures).toHaveLength(1)
})
it('requires an agent and bounded UTC window; has no cross-agent or memory selector', async () => {
  const tool = sessionDiagnosticsTool()
  expect(Object.keys(tool.parameters.properties ?? {})).toEqual(['since', 'until', 'after_sequence', 'limit'])
  await expect(tool.execute({ since: '2026-10-11T00:00:00Z', until: '2026-10-12T00:00:00Z' }, {} as never)).rejects.toThrow('agent_required')
  const execution = { agent: { session: { snapshotEvents: () => events } } } as never
  await expect(tool.execute({ since: 'yesterday', until: 'tomorrow' }, execution)).rejects.toThrow('invalid_window')
  const result = await tool.execute({ since: '2026-10-11T00:00:00Z', until: '2026-10-12T00:00:00Z' }, execution)
  expect((result as { failures: unknown[] }).failures).toHaveLength(3)
})
