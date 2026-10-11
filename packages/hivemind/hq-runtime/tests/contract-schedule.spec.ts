import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { HqCalendarItem } from '../src/types.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.ts'

it('dispatches authorized ready work during unfinished awakening without a future timer and preserves actual waits', async () => {
  const future = (minutes: number) => new Date(Date.now() + minutes * 60000).toISOString()
  const events = [
    { type: 'hivemind/hq-mode', data: { enabled: true, revision: 1, changedAt: Date.now() } },
    { type: 'hivemind/hq-awakening-start', data: { version: 1, turn: 1, startedAt: new Date().toISOString() } },
    { type: 'hivemind/hq-task-contract', data: { taskId: 'task-1', dueAt: future(120), acceptanceCriteria: ['Saved evidence brief'] } },
    { type: 'hivemind/hq-employee-assignment', data: { taskId: 'task-1', employeeId: 'employee', memberName: 'analyst', sessionId: 'employee-room', personaSha256: 'saved-persona' } },
  ] as SessionEvent[]
  const root = { id: 'root', session: { snapshotEvents: () => events, ownEvents: () => events } }
  const employee = { id: 'employee-room', status: 'idle' }
  const task = { id: 'task-1', subject: 'Urgent evidence brief', description: 'Inspect the supplied customer problem.', status: 'pending', ready: true, revision: 1, writeScopes: [] }
  const profile = { id: 'employee', slug: 'analyst', name: 'Analyst', persona: 'Inspect evidence and report uncertainty.' }
  const directory = { profiles: async () => ({ profiles: [profile] }) }
  const tools = new Map<string, ToolDefinition>()
  const updateTask = vi.fn(async () => {})
  const deliverAgentMessage = vi.fn(async () => ({ messageId: 'native-assignment', targetSessionId: employee.id }))
  const close = vi.fn(async () => {})
  const ctx = {
    effect: (effect: () => unknown) => effect(), on: () => () => {},
    get: (name: string) => name === 'hivemindEmployeeDirectory' ? directory : undefined,
    tools: { register: (tool: ToolDefinition) => { tools.set(tool.name, tool); return () => {} } },
    agentTeams: { guardTaskUpdates: () => () => {}, membership: () => ({ role: 'lead', root }),
      getTask: () => task, listMembers: () => [{ id: employee.id, name: 'analyst', ownership: 'persistent' }], updateTask },
    agents: { get: () => employee },
    sessionPersistence: { open: async () => ({ read: async () => ({ events }), close }) },
    sessionController: { resolveAgent: async () => ({ agent: root }),
      resolvePersistentEmployeeRoom: async () => employee, deliverAgentMessage },
  } as unknown as Context
  apply(ctx)
  const tool = tools.get('hivemind_hq_contract')!
  const args = { action: 'assign', task_id: task.id, employee_id: profile.id }
  const signal = new AbortController().signal
  const execution = { agent: root, signal } as never
  await expect(tool.execute(args, execution)).resolves.toMatchObject({ task_id: task.id, message_id: 'native-assignment', member: { session_id: employee.id } })
  expect(updateTask).toHaveBeenCalledWith(root, { taskId: task.id, expectedRevision: 1, action: 'reassign', owner: 'analyst' })
  expect(deliverAgentMessage).toHaveBeenCalledWith(root, expect.objectContaining({ target: profile.id, taskId: task.id, kind: 'question' }), signal)
  expect(close).toHaveBeenCalledOnce()
  task.ready = false
  await expect(tool.execute(args, execution)).rejects.toThrow('hq_task_dependencies_unfinished')
  task.ready = true
  events.push({ type: 'hivemind/hq-calendar-item', data: { id: 'later-start', revision: 1, kind: 'assignment', title: task.subject,
    owner: profile.id, taskId: task.id, startsAt: future(15), endsAt: future(30), resolved: false } } as SessionEvent)
  await expect(tool.execute(args, execution)).rejects.toThrow('hq_task_planned_start_not_due')
  events.pop()
  events.push({ type: 'hivemind/hq-mode', data: { enabled: false, revision: 2, changedAt: Date.now() } } as SessionEvent)
  await expect(tool.execute(args, execution)).rejects.toThrow('hq_assignment_not_ready')
  expect(deliverAgentMessage).toHaveBeenCalledOnce()
  expect(updateTask).toHaveBeenCalledOnce()
})

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
  await expect(tool.execute({ ...args, starts_at: future(-1) }, execution)).rejects.toThrow('hq_schedule_start_must_be_future')
  await expect(tool.execute({ ...args, starts_at: future(121), ends_at: future(124) }, execution))
    .rejects.toThrow('hq_schedule_deadline_must_follow_start')
  await expect(tool.execute({ ...args, ends_at: args.starts_at }, execution)).rejects.toThrow('hq_schedule_end_must_follow_start')
  await expect(tool.execute({ ...args, starts_at: '2026-10-05T09:00:00' }, execution)).rejects.toThrow()
  expect(plan).toHaveBeenCalledTimes(2)
})
