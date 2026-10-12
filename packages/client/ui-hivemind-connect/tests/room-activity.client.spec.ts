import { expect, it } from 'vitest'
import { roomNeedsInput } from '../src/client/room-activity.ts'
it('shows attention for every native human interaction and clears after resolution', () => {
  for (const kind of ['approval', 'question', 'plan-review', 'memory-save-destination']) {
    expect(roomNeedsInput({ kind, key: 'request', sessionId: 'employee-room' } as never)).toBe(true)
  }
  expect(roomNeedsInput(undefined)).toBe(false)
})

it('waits for pending questions and approvals, never for mere running work', async () => {
  const { roomWaitingForResponse } = await import('../src/client/room-activity.ts')
  expect(roomWaitingForResponse({ kind: 'approval', key: 'saved', sessionId: 'room' } as never)).toBe(true)
  expect(roomWaitingForResponse({ kind: 'question', key: 'saved', sessionId: 'room' } as never)).toBe(true)
  expect(roomWaitingForResponse(undefined)).toBe(false)
})
it('reports only a connected provider call and clears after end or failure', async () => {
  const { roomCallActive } = await import('../src/client/room-activity.ts')
  expect(roomCallActive({ state: 'live', error: false, busy: false })).toBe(true)
  for (const status of [{ state: 'connecting' }, { state: 'idle' }, { state: 'live', error: true }, { state: 'live', busy: true }, null])
    expect(roomCallActive(status)).toBe(false)
})
