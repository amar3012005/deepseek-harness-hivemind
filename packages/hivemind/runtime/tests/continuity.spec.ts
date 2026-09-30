import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { completedTaskMemory, pendingTaskMemories, sessionOwner, type SessionOwner } from '../src/continuity.ts'

const owner: SessionOwner = { id: 'elena', slug: 'elena', name: 'Elena', role: 'strategist' }
const sessionId = 'session-d292efdd-4b56-4053-b61c-9cd63a7cd8ff'
function history(reason = 'completed', source = 'user'): SessionEvent[] {
  const user = createUserMessage({ content: [{ type: 'text', text: 'Create a market campaign blueprint' }], source: { kind: source } as never })
  const assistant = createAssistantMessage({ content: [{ type: 'text', text: 'Blueprint: research, position, launch.' }], source: { model: 'test' } as never })
  const result = createToolResultMessage({ callId: 'call-1' as never, content: [{ type: 'text', text: 'Failed' }], isError: true })
  return [
    { seq: 0, time: 1000, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, time: 1001, type: 'user/message', data: user },
    { seq: 2, time: 1002, type: 'tool/call', data: { callId: 'call-1', name: 'research' } },
    { seq: 3, time: 1003, type: 'tool/result', data: { message: result } },
    { seq: 4, time: 1004, type: 'assistant/message', data: { turn: 1, message: assistant, interrupted: false } },
    { seq: 5, time: 1005, type: 'turn/end', data: { turn: 1, reason: { kind: reason } } },
  ] as unknown as SessionEvent[]
}

describe('persistent employee task memory', () => {
  it('keeps the first owner across later selections and reassignment events', () => {
    const events = [
      { type: 'hivemind/session-owner', data: owner },
      { type: 'hivemind/employee-selection', data: { id: 'ravi' } },
      { type: 'hivemind/session-owner', data: { ...owner, slug: 'ravi' } },
    ] as SessionEvent[]
    expect(sessionOwner(events)).toEqual(owner)
  })
  it('records request, answer, author, timestamps and failed tool evidence without claiming external success', () => {
    const packet = completedTaskMemory(sessionId, owner, history(), 1)!
    expect(packet.agent_slug).toBe('elena')
    expect(packet.summary).toContain('market campaign blueprint')
    expect(packet.summary).toContain('Blueprint: research')
    expect(packet.summary).toContain('external actions require their own successful tool receipts')
    expect(packet.context.toolReceipts).toEqual([{ name: 'research', callId: 'call-1', resultSeq: 3, isError: true }])
    expect(packet.context.requestedAt).toBe('1970-01-01T00:00:01.001Z')
    expect(packet.context.completedAt).toBe('1970-01-01T00:00:01.005Z')
    expect(completedTaskMemory(sessionId, owner, history(), 1)).toEqual(packet)
  })
  it('accepts scheduled requests but skips injected messages and aborted turns', () => {
    expect(completedTaskMemory(sessionId, owner, history('completed', 'schedule'), 1)).toBeDefined()
    expect(completedTaskMemory(sessionId, owner, history('completed', 'plugin'), 1)).toBeUndefined()
    expect(completedTaskMemory(sessionId, owner, history('aborted'), 1)).toBeUndefined()
  })
  it('retries durable pending records and suppresses successfully saved replay', () => {
    const packet = completedTaskMemory(sessionId, owner, history(), 1)!
    const events = [{ type: 'hivemind/task-memory-pending', data: packet }] as SessionEvent[]
    expect(pendingTaskMemories(events)).toEqual([packet])
    events.push({ type: 'hivemind/task-memory-recorded', data: { idempotencyKey: packet.idempotency_key, memoryId: 'id', turn: 1 } } as SessionEvent)
    expect(pendingTaskMemories(events)).toEqual([])
  })
})
