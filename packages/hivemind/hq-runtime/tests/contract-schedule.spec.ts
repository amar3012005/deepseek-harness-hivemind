import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { HqCalendarItem } from '../src/types.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.ts'

it('updates changed pending assignment times through the native calendar revision and preserves exact retries', async () => {
  const future = (minutes: number) => new Date(Date.now() + minutes * 60000).toISOString()
  let item: HqCalendarItem = { id: 'initial-task-1', revision: 1, kind: 'assignment', title: 'Evidence assessment', owner: 'employee', taskId: 'task-1', startsAt: future(60), endsAt: future(90), resolved: false }
  const history = [item]
  const task = { id: 'task-1', subject: 'Evidence assessment', status: 'pending' }
  const events = () => [
    { type: 'hivemind/hq-task-contract', data: { taskId: task.id, dueAt: future(120), acceptanceCriteria: ['Saved assessment'] } },
    ...history.map(value => ({ type: 'hivemind/hq-calendar-item', data: value })),
  ]
  const root = { id: 'root', session: { snapshotEvents: events, ownEvents: events } }
  const tools = new Map<string, ToolDefinition>()
  const plan = vi.fn(async (_root: unknown, request: { item: HqCalendarItem; expectedRevision: number }) => {
    if (request.item.revision > item.revision) history.push(request.item)
    item = request.item
    return { ok: true, value: item }
  })
  const ctx = { effect: (f: () => unknown) => f(), on: () => () => {},
    tools: { register: (tool: ToolDefinition) => { tools.set(tool.name, tool); return () => {} } },
    agentTeams: { guardTaskUpdates: () => () => {}, membership: () => ({ role: 'lead', root }), getTask: () => task, listMembers: () => [] },
    hivemindEmployeeDirectory: { profiles: async () => ({ profiles: [{ id: 'employee' }] }) },
    hivemindHq: { plan, workspace: async () => ({ wakes: [{ taskId: task.id, id: 'native-wake', status: 'active', scheduledAt: item.startsAt }] }) },
  } as unknown as Context
  apply(ctx)
  const tool = tools.get('hivemind_hq_contract')!
  const args = { action: 'schedule', task_id: task.id, employee_id: 'employee', starts_at: future(2), ends_at: future(5) }
  const execution = { agent: root, signal: new AbortController().signal } as never
  const updated = await tool.execute(args, execution)
  expect(updated).toMatchObject({ starts_at: args.starts_at, ends_at: args.ends_at })
  expect(plan.mock.calls[0]?.[1]).toMatchObject({ expectedRevision: 1, item: { id: 'initial-task-1', revision: 2 } })
  await tool.execute(args, execution)
  expect(plan.mock.calls[1]?.[1]).toMatchObject({ expectedRevision: 1, item: { revision: 2 } })
})
