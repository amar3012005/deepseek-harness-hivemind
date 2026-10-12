// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ScheduleCatalogEntry, ScheduleId } from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { CalendarWeek, calendarDate, calendarWeek } from '../src/client/CalendarWeek.tsx'
import { en } from '../src/client/task-manager-locales.ts'

const recurring: ScheduleCatalogEntry = {
  id: 'company-wake' as ScheduleId, sessionId: 'hq-session' as SessionId,
  kind: 'every', title: 'Review the company plan', prompt: 'Review existing assignments',
  everySeconds: 3600, status: 'active', scheduledAt: '2026-10-24T23:30:00Z',
}
afterEach(cleanup)
describe('native Schedule calendar projection', () => {
  it('uses the display zone at the UTC date boundary without changing stored times', () => {
    expect(calendarDate(Date.parse(recurring.scheduledAt), 'Europe/Berlin')).toBe('2026-10-25')
    expect(calendarDate(Date.parse(recurring.scheduledAt), 'America/New_York')).toBe('2026-10-24')
    const days = calendarWeek([recurring], '2026-10-25', 'Europe/Berlin')
    expect(days.map(day => day.date)).toEqual(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'])
    expect(days[6]?.records).toEqual([recurring])
    expect(recurring.scheduledAt).toBe('2026-10-24T23:30:00Z')
  })
  it('shows only committed active occurrences and orders repeated DST-hour instants', () => {
    const earlier = { ...recurring, id: 'earlier' as ScheduleId, scheduledAt: '2026-10-25T00:30:00Z' }
    const later = { ...recurring, id: 'later' as ScheduleId, scheduledAt: '2026-10-25T01:30:00Z' }
    const disabled = { ...recurring, id: 'disabled' as ScheduleId, status: 'inactive' as const }
    const days = calendarWeek([later, disabled, earlier], '2026-10-25', 'Europe/Berlin')
    expect(days.flatMap(day => day.records.map(record => record.id))).toEqual(['earlier', 'later'])
  })
  it('opens native task details and reflects catalog edits without a model call', () => {
    const onSelect = vi.fn()
    const props = { records: [recurring], now: Date.parse('2026-10-25T08:00:00Z'), timeZone: 'Europe/Berlin', selectedId: null, t: makeTranslate(en), onSelect }
    const view = render(<CalendarWeek {...props} />)
    const button = screen.getByRole('button', { name: recurring.title })
    fireEvent.click(button)
    expect(onSelect).toHaveBeenCalledWith(recurring.id, button)
    expect(within(screen.getByRole('region', { name: '2026-10-25' })).getAllByRole('button')).toHaveLength(1)
    view.rerender(<CalendarWeek {...props} records={[{ ...recurring, scheduledAt: '2026-11-01T12:00:00Z' }]} />)
    expect(screen.queryByRole('button', { name: recurring.title })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en['calendar.next'] }))
    expect(within(screen.getByRole('region', { name: '2026-11-01' })).getByRole('button', { name: recurring.title })).toBeTruthy()
  })
})
