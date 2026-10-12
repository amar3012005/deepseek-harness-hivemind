import { expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { historyWindowCut } from '../src/cold-history.ts'

function log(): SessionEvent[] {
  const events: SessionEvent[] = []
  for (let turn = 1; turn <= 1000; turn++) {
    const seq = events.length
    events.push({ type: 'user/message', seq: SessionSeq(seq), time: seq,
      surfaceOp: 'append', data: createUserMessage({ content: [{ type: 'text', text: `Turn ${turn}` }], source: { kind: 'user' } }) },
    { type: 'turn/start', seq: SessionSeq(seq + 1), time: seq + 1, data: { turn } },
    { type: 'turn/end', seq: SessionSeq(seq + 2), time: seq + 2, data: { turn, reason: { kind: 'completed' } } })
  }
  return events
}

it('uses native minimum-message and minimum-turn semantics on a nonzero suffix', () => {
  const suffix = log().slice(-256)
  expect(historyWindowCut(suffix, 50, undefined, { minMessages: 2, minTurns: 2 })).toBe(2992)
})

it('honors the maximum-message cap before the requested minimum turns', () => {
  expect(historyWindowCut(log().slice(-256), 1, undefined, { minMessages: 2, minTurns: 20 })).toBe(2997)
})

it('requests additional history when the current block cannot establish the native cut', () => {
  expect(historyWindowCut(log().slice(-3), 50, undefined, { minMessages: 2, minTurns: 2 })).toBeUndefined()
})
