import { expect, it } from 'vitest'
import { calendarItems, validateCalendarItem } from '../src/calendar.ts'
const item = { id: 'meeting-1', revision: 1, kind: 'meeting' as const, title: 'Owner review', owner: 'Amar', startsAt: '2026-10-01T10:00:00+02:00', endsAt: '2026-10-01T11:00:00+02:00', resolved: false }
it('replays planning revisions with canonical instants and rejects stale history', () => {
  const first = validateCalendarItem(item)
  expect(first.startsAt).toBe('2026-10-01T08:00:00.000Z')
  expect(calendarItems([{ type: 'hivemind/hq-calendar-item', data: first }, { type: 'hivemind/hq-calendar-item', data: { ...first, revision: 2, resolved: true } }])[0]?.resolved).toBe(true)
  expect(() => calendarItems([{ type: 'hivemind/hq-calendar-item', data: { ...first, revision: 2 } }])).toThrow('hq_calendar_revision_gap')
})
it('does not let planning complete native execution or accept ambiguous time', () => {
  expect(() => validateCalendarItem({ ...item, kind: 'assignment', taskId: 'task-1', resolved: true })).toThrow('hq_calendar_cannot_complete_task')
  expect(() => validateCalendarItem({ ...item, startsAt: '2026-10-01T10:00:00' })).toThrow()
  expect(() => validateCalendarItem({ ...item, endsAt: item.startsAt })).toThrow('hq_invalid_calendar_window')
})
