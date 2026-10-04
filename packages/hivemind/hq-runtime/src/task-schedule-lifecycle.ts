/** Native Schedule ensure identities and read-only Team terminal projection. */
import { createHash } from 'node:crypto'
import type { HqCalendarItem } from './types.ts'

/** Matches Schedule.ensure's session-scoped identity; never creates a timer. */
export function taskDeadlineScheduleId(sessionId: string, taskId: string): string {
  return `schedule-${createHash('sha256').update(`${sessionId}\0hq-task-deadline-${taskId}`).digest('hex')}`
}

export function projectCalendarTaskStatus(items: readonly HqCalendarItem[], statuses: ReadonlyMap<string, string>): HqCalendarItem[] {
  return items.map(item => item.kind === 'assignment' && item.taskId !== undefined
    && ['completed', 'deleted'].includes(statuses.get(item.taskId) ?? '') ? { ...item, resolved: true } : item)
}
