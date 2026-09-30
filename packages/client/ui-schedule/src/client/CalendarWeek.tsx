/** Calendar projection of committed native Schedule times; never calculates future recurrence. */
import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { Button, IconChevronLeftOutline14, IconChevronRightOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ScheduleCatalogEntry, ScheduleId } from '@deepseek-ai/dsh-schedule/client'
import { taskName } from './schedule-format.ts'
import css from './CalendarWeek.module.css'

/** Local day identity for a UTC instant under an explicit display zone. */
export function calendarDate(instant: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant)
  const part = (type: string): string => {
    const value = parts.find(item => item.type === type)?.value
    if (value === undefined) throw new Error(`calendar_date_part_missing: ${type}`)
    return value
  }
  return `${part('year')}-${part('month')}-${part('day')}`
}

/** Calendar-date arithmetic independent of elapsed hours or DST. */
function shiftDate(day: string, step: number): string {
  const value = new Date(`${day}T12:00:00Z`)
  value.setUTCDate(value.getUTCDate() + step)
  return value.toISOString().slice(0, 10)
}

/** One displayed day and its committed enabled reminders. */
export interface CalendarDay { readonly date: string; readonly records: readonly ScheduleCatalogEntry[] }

/**
 * Project the week containing an anchor onto seven local calendar dates.
 * @param records - current native catalog; inactive records have no upcoming wake.
 * @param anchor - ISO local date selecting a Monday-first week.
 * @param timeZone - explicit browser display zone; never changes saved rule interpretation.
 * @returns seven days with enabled records sorted by their committed instant.
 */
export function calendarWeek(records: readonly ScheduleCatalogEntry[], anchor: string, timeZone: string): readonly CalendarDay[] {
  const weekday = new Date(`${anchor}T12:00:00Z`).getUTCDay()
  const monday = shiftDate(anchor, -((weekday + 6) % 7))
  const ordered = records.filter(record => record.status === 'active').toSorted((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt))
  return Array.from({ length: 7 }, (_, index) => {
    const date = shiftDate(monday, index)
    return { date, records: ordered.filter(record => calendarDate(Date.parse(record.scheduledAt), timeZone) === date) }
  })
}

/** Inputs reuse the task manager's catalog, selection and locale. */
export interface CalendarWeekProps extends PropsLocale<'schedule.manager'> {
  readonly records: readonly ScheduleCatalogEntry[]
  readonly now: number
  readonly timeZone: string
  readonly selectedId: ScheduleId | null
  readonly onSelect: (id: ScheduleId, button: HTMLButtonElement) => void
}

/**
 * Render a navigable week with native task selection.
 * @param props - authoritative filtered records and task manager callbacks.
 * @returns the calendar without creating tasks or issuing model requests.
 */
export function CalendarWeek(props: CalendarWeekProps) {
  const { records, now, timeZone, selectedId, onSelect, t } = props
  const today = calendarDate(now, timeZone)
  const [anchor, setAnchor] = useState(today)
  const days = useMemo(() => calendarWeek(records, anchor, timeZone), [records, anchor, timeZone])
  const formatDay = new Intl.DateTimeFormat(t('time.locale'), { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
  const formatTime = new Intl.DateTimeFormat(t('time.locale'), { hour: '2-digit', minute: '2-digit', timeZone })
  return <section className={css.calendar} aria-label={t('calendar.label')}>
    <div className={css.toolbar}>
      <Button size="sm" aria-label={t('calendar.previous')} icon={<IconChevronLeftOutline14 />} onClick={() => setAnchor(shiftDate(anchor, -7))} />
      <span aria-live="polite">{days[0]?.date} — {days[6]?.date}</span>
      <Button size="sm" aria-label={t('calendar.next')} icon={<IconChevronRightOutline14 />} onClick={() => setAnchor(shiftDate(anchor, 7))} />
      <Button size="sm" variant="outline" onClick={() => setAnchor(today)}>{t('calendar.today')}</Button>
    </div>
    <p className={css.note}>{t('calendar.note')} <span>{timeZone}</span></p>
    <div className={css.days}>
      {days.map(day => <section className={css.day} key={day.date} aria-label={day.date}>
        <h2 className={clsx(css.heading, day.date === today && css.today)}><time dateTime={day.date}>{formatDay.format(new Date(`${day.date}T12:00:00Z`))}</time></h2>
        {day.records.length === 0 && <p className={css.empty}>{t('calendar.empty')}</p>}
        {day.records.map(record => <Button key={record.id} className={clsx(css.task, selectedId === record.id && css.selected)}
          aria-label={taskName(record)} aria-expanded={selectedId === record.id}
          onClick={event => onSelect(record.id, event.currentTarget)}>
          <time dateTime={record.scheduledAt}>{formatTime.format(Date.parse(record.scheduledAt))}</time>
          <span>{taskName(record)}</span>
        </Button>)}
      </section>)}
    </div>
  </section>
}
