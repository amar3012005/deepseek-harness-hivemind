import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { contractListPage } from '../src/contract-list.ts'
import { apply } from '../src/index.ts'

const bounds = { listPageSize: 8, listResultMaxBytes: 16000 }
function source() {
  const tasks = Array.from({ length: 40 }, (_, i) => ({ id: `task-${i}`, revision: 2, subject: '检验'.repeat(500), status: 'in_progress' }))
  const events = Array.from({ length: 100 }, (_, seq): SessionEvent => ({ seq: SessionSeq(seq), time: seq, type: 'hivemind/hq-task-review', data: {
    taskId: 'task-24', taskRevision: seq === 99 ? 2 : 1, status: seq === 99 ? 'accepted' : 'needs_changes', artifactIds: ['original-artifact'], inputHash: 'saved-input', model: 'runtime', probabilities: [],
  } }))
  events.push({ seq: SessionSeq(100), time: 100, type: 'hivemind/hq-task-artifacts', data: { taskId: 'task-24', artifactIds: ['original-artifact'], producerReceipts: [] } })
  return { events, tasks, profiles: Array.from({ length: 18 }, (_, i) => ({ id: `employee-${i}`, name: '名字'.repeat(500) })),
    contracts: tasks.map(task => ({ taskId: task.id, dueAt: '2030-01-01T12:00:00Z', acceptanceCriteria: Array(20).fill('验收'.repeat(500)) })),
    calendar: [], runtimeDispatches: [],
  }
}

it('pages a long board within the complete UTF-8 budget, preserves every task and selects current acceptance', () => {
  const state = source()
  const original = JSON.stringify(state)
  const seen: string[] = []
  let cursor: string | undefined
  do {
    const page = contractListPage(state, { ...(cursor ? { cursor } : {}), limit: 25 }, bounds) as {
      tasks: { task_id: string }[]
      next_cursor: string | null
    }
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(bounds.listResultMaxBytes)
    seen.push(...page.tasks.map(task => task.task_id))
    cursor = page.next_cursor ?? undefined
  } while (cursor)
  expect(seen).toEqual(state.tasks.map(task => task.id))
  const detail = contractListPage(state, { task_id: 'task-24' }, bounds)
  expect(detail).toMatchObject({ employees: [], reviews: [{ task_id: 'task-24', task_revision: 2, status: 'accepted' }],
    artifact_receipts: [{ task_id: 'task-24', artifact_ids: ['original-artifact'], artifact_count: 1 }] })
  expect(JSON.stringify(state)).toBe(original)
})

it('rejects changed roster/task cursors and invalid bounds without treating missing tasks as empty evidence', () => {
  const state = source()
  const page = contractListPage(state, {}, bounds) as { next_cursor: string }
  state.events.push({ seq: SessionSeq(101), time: 101, type: 'tool/result', surfaceOp: 'append', data: { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('unrelated-read'), content: [], isError: false }) } })
  expect(() => contractListPage(state, { cursor: page.next_cursor }, bounds)).not.toThrow()
  state.profiles.push({ id: 'new-employee', name: 'New employee' })
  expect(() => contractListPage(state, { cursor: page.next_cursor }, bounds)).toThrow('cursor_changed')
  for (const limit of [0, 26, 1.5, NaN]) expect(() => contractListPage(state, { limit }, bounds)).toThrow('limit')
  expect(() => contractListPage(state, { task_id: 'foreign-task' }, bounds)).toThrow('task_not_found')
  expect(() => contractListPage(state, {}, { ...bounds, listResultMaxBytes: 1 })).toThrow('result_budget')
})

it('runs ordinary contract listing concurrently without room opening, reconciliation or external polling', async () => {
  const state = source()
  const root = { id: 'root', session: { snapshotEvents: () => state.events, ownEvents: () => state.events } }
  const definitions = new Map<string, ToolDefinition>()
  const resolveRoom = vi.fn(() => { throw Error('unexpected room mutation') })
  const ctx = { effect: (f: () => unknown) => f(), on: () => () => {},
    tools: { register: (tool: ToolDefinition) => { definitions.set(tool.name, tool); return () => {} } },
    agentTeams: { guardTaskUpdates: () => () => {}, membership: () => ({ root, role: 'lead' }),
      listTasks: () => state.tasks, listMembers: () => { throw Error('unexpected reconciliation') } },
    hivemindEmployeeDirectory: { profiles: async () => ({ profiles: state.profiles }) },
    sessionController: { resolvePersistentEmployeeRoom: resolveRoom },
  } as unknown as Context
  apply(ctx)
  const tool = definitions.get('hivemind_hq_contract')!
  expect(tool.isConcurrencySafe?.({ action: 'list' })).toBe(true)
  expect(tool.isConcurrencySafe?.({ action: 'list', refresh_dispatches: true })).toBe(false)
  for (const action of ['inspect', 'assign', 'attach', 'decide', 'schedule']) expect(tool.isConcurrencySafe?.({ action })).toBe(false)
  const execution = { agent: root, signal: new AbortController().signal } as never
  const results = await Promise.all([tool.execute({ action: 'list' }, execution), tool.execute({ action: 'list', task_id: 'task-24' }, execution)])
  expect(results[1]).toMatchObject({ tasks: [{ task_id: 'task-24' }] })
  expect(resolveRoom).not.toHaveBeenCalled()
})
