import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { admittedEmployeeWork } from '../src/employee-work-origin.ts'

function agent(events: unknown[]): Agent {
  return { session: { ownEvents: () => events as SessionEvent[] } } as unknown as Agent
}
const start = { seq: 1, type: 'turn/start', data: { turn: 7 } }
const origin = { seq: 2, type: 'hivemind/employee-work-origin', data: { turn: 7, rootId: 'chief', taskId: 'task-1' } }

describe('admitted employee assignment origin', () => {
  it('uses the exact host-attested assignment inside its open turn', () => {
    expect(admittedEmployeeWork(agent([start, origin]))).toEqual(origin.data)
  })
  it('preserves delegation across an intervening direct human clarification', () => {
    expect(admittedEmployeeWork(agent([start, origin,
      { seq: 3, type: 'user/message', data: { source: { kind: 'user' }, content: [] } },
    ]))).toEqual(origin.data)
  })
  it('does not infer delegation from an old assignment in a new human turn', () => {
    expect(admittedEmployeeWork(agent([start, origin,
      { seq: 3, type: 'turn/end', data: { turn: 7 } },
      { seq: 4, type: 'turn/start', data: { turn: 8 } },
      { seq: 5, type: 'user/message', data: { source: { kind: 'user' } } },
    ]))).toBeUndefined()
  })
  it('does not expose origin after the owning turn ended', () => {
    expect(admittedEmployeeWork(agent([start, origin,
      { seq: 3, type: 'turn/end', data: { turn: 7 } },
    ]))).toBeUndefined()
  })
  it('requires a matching turn and a receipt after its start', () => {
    expect(admittedEmployeeWork(agent([origin, { ...start, seq: 3 }]))).toBeUndefined()
    expect(admittedEmployeeWork(agent([start, { ...origin, data: { ...origin.data, turn: 6 } }]))).toBeUndefined()
  })
  it('does not guess a task from sender identity or display snapshots', () => {
    expect(admittedEmployeeWork(agent([start,
      { seq: 2, type: 'hivemind/employee-task-snapshot', data: { task: { id: 'task-1' } } },
      { seq: 3, type: 'user/message', data: { source: { kind: 'hivemind-agent-message', senderId: 'chief' } } },
    ]))).toBeUndefined()
  })
})
