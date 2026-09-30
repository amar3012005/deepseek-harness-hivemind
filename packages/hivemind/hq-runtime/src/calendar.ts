/** Pure validation and replay of human planning metadata. */
import { parseAtInput } from '@deepseek-ai/dsh-schedule'
import type { HqCalendarItem } from './types.ts'
import type { LedgerEvent } from './ledger.ts'
export function validateCalendarItem(item: HqCalendarItem): HqCalendarItem {
  if (
    !/^[a-zA-Z0-9_-]{1,100}$/.test(item.id) ||
    !Number.isSafeInteger(item.revision) ||
    item.revision < 1 ||
    !['meeting', 'decision', 'source_request', 'assignment'].includes(item.kind) ||
    !item.title.trim() ||
    item.title.length > 200 ||
    !item.owner.trim() ||
    item.owner.length > 100 ||
    typeof item.resolved !== 'boolean'
  )
    throw new Error('hq_invalid_calendar_item')
  const start = parseAtInput(item.startsAt),
    end = parseAtInput(item.endsAt)
  if (end <= start || end - start > 7 * 86400000) throw new Error('hq_invalid_calendar_window')
  if (item.kind === 'assignment' && !/^task-[1-9]\d*$/.test(item.taskId ?? ''))
    throw new Error('hq_calendar_task_required')
  if (item.kind !== 'assignment' && item.taskId !== undefined)
    throw new Error('hq_calendar_human_task_link_invalid')
  if (item.kind === 'assignment' && item.resolved)
    throw new Error('hq_calendar_cannot_complete_task')
  return {
    ...item,
    title: item.title.trim(),
    owner: item.owner.trim(),
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(end).toISOString(),
  }
}
export function calendarItems(events: readonly LedgerEvent[]): HqCalendarItem[] {
  const items = new Map<string, HqCalendarItem>()
  for (const event of events)
    if (event.type === 'hivemind/hq-calendar-item') {
      const item = validateCalendarItem(event.data as HqCalendarItem)
      if (item.revision !== (items.get(item.id)?.revision ?? 0) + 1)
        throw new Error('hq_calendar_revision_gap')
      items.set(item.id, item)
    }
  return [...items.values()]
}
