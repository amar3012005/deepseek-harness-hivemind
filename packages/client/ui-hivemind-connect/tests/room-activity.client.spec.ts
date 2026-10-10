import { expect, it } from 'vitest'
import { roomNeedsInput } from '../src/client/room-activity.ts'
it('shows attention for every native human interaction and clears after resolution', () => {
  for (const kind of ['approval', 'question', 'plan-review', 'memory-save-destination']) {
    expect(roomNeedsInput({ kind, key: 'request', sessionId: 'employee-room' } as never)).toBe(true)
  }
  expect(roomNeedsInput(undefined)).toBe(false)
})
