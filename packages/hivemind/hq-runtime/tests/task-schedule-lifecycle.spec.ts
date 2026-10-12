import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { taskDeadlineScheduleId, projectCalendarTaskStatus } from '../src/task-schedule-lifecycle.ts'
it('targets the exact native ensure deadline identity without another task or session', () => {
  const expected = `schedule-${createHash('sha256').update('root\0hq-task-deadline-task-1').digest('hex')}`
  expect(taskDeadlineScheduleId('root', 'task-1')).toBe(expected)
  expect(taskDeadlineScheduleId('other', 'task-1')).not.toBe(expected)
  expect(taskDeadlineScheduleId('root', 'task-2')).not.toBe(expected)
})
it('projects terminal Team status without mutating calendar acceptance history', () => {
  const items = [{ id: 'assignment', kind: 'assignment', taskId: 'task-1', resolved: false },
    { id: 'other', kind: 'assignment', taskId: 'task-2', resolved: false },
    { id: 'meeting', kind: 'meeting', resolved: false }] as never
  for (const status of ['completed', 'deleted']) {
    expect(projectCalendarTaskStatus(items, new Map([['task-1', status]])).map(item => item.resolved)).toEqual([true, false, false])
  }
  expect(projectCalendarTaskStatus(items, new Map([['task-1', 'in_progress']]))[0]?.resolved).toBe(false)
  expect(items).toEqual([{ id: 'assignment', kind: 'assignment', taskId: 'task-1', resolved: false },
    { id: 'other', kind: 'assignment', taskId: 'task-2', resolved: false }, { id: 'meeting', kind: 'meeting', resolved: false }])
})

it('cancels exact active deadline once and preserves delivered or unrelated timers on retry', async () => {
  const { HqControl } = await import('../src/control.ts')
  let task = { id: 'task-1', revision: 1, status: 'pending', blockedBy: [] }
  const deadline = taskDeadlineScheduleId('root', 'task-1')
  const timers = [
    { id: deadline, sessionId: 'root', status: 'active' },
    { id: taskDeadlineScheduleId('root', 'task-2'), sessionId: 'root', status: 'active' },
    { id: taskDeadlineScheduleId('other', 'task-1'), sessionId: 'other', status: 'active' },
  ]
  const removed: string[] = []
  const root = { id: 'root', session: { snapshotEvents: () => [{ type: 'team/task', data: { task } }] } }
  const receiver = { root: () => root, ctx: {
    agentTeams: { getTask: () => task, listTasks: () => task.status === 'pending' ? [task] : [],
      updateTask: async () => { task = { ...task, status: 'deleted', revision: 2 } } },
    schedule: { catalog: async () => timers,
      delete: async ({ id }: { id: string }) => { removed.push(id); const timer = timers.find(item => item.id === id); if (timer) timer.status = 'inactive' } },
  } }
  const cancel = (revision: number) => HqControl.prototype.cancelScheduledTask.call(receiver as never, root as never,
    { taskId: 'task-1', expectedRevision: revision })
  expect(await cancel(1)).toEqual({ cancelled: true })
  expect(await cancel(1)).toEqual({ cancelled: true })
  expect(removed).toEqual([deadline])
  expect(timers.slice(1).map(item => item.status)).toEqual(['active', 'active'])
})
