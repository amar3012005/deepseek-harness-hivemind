import { describe, expect, it } from 'vitest'
import { savedScheduleId } from '../src/client/scheduled-work.ts'
describe('confirmed delegated schedule presentation', () => {
  it('accepts only a confirmed native timer receipt', () => {
    expect(savedScheduleId('{"status":"scheduled","schedule_id":"timer-1"}')).toBe('timer-1')
    expect(savedScheduleId('{"status":"pending","schedule_id":"timer-1"}')).toBeUndefined()
    expect(savedScheduleId('{"status":"scheduled","starts_at":"2026-10-03"}')).toBeUndefined()
    expect(savedScheduleId('{')).toBeUndefined()
  })
})
