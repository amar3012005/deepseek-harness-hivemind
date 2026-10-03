import { describe, expect, it } from 'vitest'
import { savedScheduleId, scheduledWork } from '../src/client/scheduled-work.ts'
describe('confirmed delegated schedule presentation', () => {
  it('retains the assigned employee separately from the timer owner', () => {
    const result = scheduledWork.update!({ state: { ids: [], seq: 1 } } as never, {
      event: { type: 'tool/result', seq: 4, data: { message: { content: [{ content: [{ type: 'text', text: JSON.stringify({
        status: 'scheduled', schedule_id: 'timer-1', employee_id: 'ravi-id',
      }) }] }] } } },
    } as never)
    expect(result).toEqual({ ids: ['timer-1'], seq: 4, employeeIds: { 'timer-1': 'ravi-id' } })
  })
  it('accepts only a confirmed native timer receipt', () => {
    expect(savedScheduleId('{"status":"scheduled","schedule_id":"timer-1"}')).toBe('timer-1')
    expect(savedScheduleId('{"status":"pending","schedule_id":"timer-1"}')).toBeUndefined()
    expect(savedScheduleId('{"status":"scheduled","starts_at":"2026-10-03"}')).toBeUndefined()
    expect(savedScheduleId('{')).toBeUndefined()
  })
})
