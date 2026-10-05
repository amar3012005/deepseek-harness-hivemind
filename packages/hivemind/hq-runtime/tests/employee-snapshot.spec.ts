import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import { employeeTaskSnapshot, installEmployeeSnapshots } from '../src/employee-snapshot.ts'
function events(status = 'pending', reviewStatus = 'accepted', reviewer = 'runtime'): SessionEvent[] {
  return [
    { seq: 1, time: 1000, type: 'hivemind/hq-employee-assignment', data: { taskId: 'task-1', employeeId: 'employee', employeeName: 'Sofia', memberName: 'sofia', sessionId: 'employee-room', personaSha256: 'digest' } },
    { seq: 2, time: 1000, type: 'team/task', data: { task: { id: 'task-1', revision: status === 'completed' ? 3 : 2, subject: 'Assessment', description: 'Only my work', ownerId: 'employee-room', status, blockedBy: [], writeScopes: [] } } },
    { seq: 3, time: 1000, type: 'hivemind/hq-calendar-item', data: { id: 'window', taskId: 'task-1', revision: 1, kind: 'assignment', owner: 'employee', title: 'Assessment', startsAt: '2030-01-01T10:00:00Z', endsAt: '2030-01-01T11:00:00Z', resolved: false } },
    { seq: 4, time: 1000, type: 'hivemind/hq-task-contract', data: { taskId: 'task-1', dueAt: '2030-01-01T11:00:00Z', acceptanceCriteria: ['Saved report'] } },
    { seq: 5, time: 1000, type: 'hivemind/hq-task-artifacts', data: { taskId: 'task-1', artifactIds: ['saved'] } },
    { seq: 6, time: 1000, type: 'hivemind/hq-task-review', data: { taskId: 'task-1', taskRevision: 2, artifactIds: ['saved'], inputHash: 'hash', status: reviewStatus, reviewer, model: reviewer, probabilities: [] } },
  ] as unknown as SessionEvent[]
}
describe('employee-only native snapshots', () => {
  it('shows exact saved window and only selected assignment', () => {
    const result = employeeTaskSnapshot(events(), 'task-1', 'root')!
    expect(result.employeeName).toBe('Sofia')
    expect(result.calendar?.startsAt).toBe('2030-01-01T10:00:00.000Z')
    expect(result.task.status).toBe('pending')
    expect(employeeTaskSnapshot(events(), 'other', 'root')).toBeUndefined()
  })
  it('requires native completion and accepted current Runtime review for completed display', () => {
    expect(employeeTaskSnapshot(events('in_progress'), 'task-1', 'root')?.task.status).toBe('in_progress')
    expect(employeeTaskSnapshot(events('completed'), 'task-1', 'root')?.task.status).toBe('completed')
    expect(employeeTaskSnapshot(events('completed', 'needs_changes'), 'task-1', 'root')?.task.status).toBe('in_progress')
    expect(employeeTaskSnapshot(events('completed', 'accepted', 'jev'), 'task-1', 'root')?.task.status).toBe('in_progress')
  })
  it('refuses mismatched producer ownership and stale review revisions', () => {
    const input = events('completed')
    const task = input[1]!
    if (task.type === 'team/task') task.data.task = { ...task.data.task, ownerId: 'other' as never }
    expect(employeeTaskSnapshot(input, 'task-1', 'root')).toBeUndefined()
    const stale = events('completed')
    const review = stale[5]!
    if (review.type === 'hivemind/hq-task-review') Object.assign(review.data, { taskRevision: 1 })
    expect(employeeTaskSnapshot(stale, 'task-1', 'root')?.task.status).toBe('in_progress')
  })
})


it('publishes only authorized own-room snapshots quietly and deduplicates unchanged state', async () => {
  const input = events()
  const hooks = new Map<string, (...args: unknown[]) => void>()
  const received: SessionEvent[] = []
  const target = { runMaintenance: async (fn: () => Promise<void>) => fn(), session: {
    ownEvents: () => received,
    append: vi.fn((type: string, data: unknown) => received.push({ type, data } as SessionEvent)),
  } }
  const root = { id: 'root', session: { id: 'root', header: { agentPreset: 'hivemind-hq' }, snapshotEvents: () => input, ownEvents: () => input } }
  const read = vi.fn(async () => ({})), close = vi.fn(async () => {})
  const open = vi.fn(async () => ({ read, close }))
  const ctx = {
    effect: (fn: (...args: unknown[]) => void) => { fn() }, on: (name: string, fn: (...args: unknown[]) => void) => hooks.set(name, fn),
    agents: { get: () => root }, sessions: { flush: async () => true },
    sessionPersistence: { open },
    sessionController: { resolveAgent: vi.fn(async () => ({ agent: target })) },
    logger: { warn: vi.fn() },
  } as unknown as Context
  installEmployeeSnapshots(ctx)
  hooks.get('session/event')!(root.session, input[2])
  await vi.waitFor(() => { expect(target.session.append).toHaveBeenCalledOnce() })
  expect(open).toHaveBeenCalledWith('employee-room', 'read')
  expect(received[0]?.type).toBe('hivemind/employee-task-snapshot')
  hooks.get('agent/session-start')!({ agent: root })
  await vi.waitFor(() => { expect(read).toHaveBeenCalledTimes(2) })
  expect(target.session.append).toHaveBeenCalledOnce()
  expect(close).toHaveBeenCalledTimes(2)
})

it('does not publish when authenticated target read fails', async () => {
  const input = events()
  let hook: ((...args: unknown[]) => void) | undefined
  const append = vi.fn(), resolveAgent = vi.fn(), warn = vi.fn()
  const root = { id: 'root', session: { id: 'root', header: { agentPreset: 'hivemind-hq' }, snapshotEvents: () => input } }
  const ctx = {
    effect: (fn: (...args: unknown[]) => void) => { fn() }, on: (name: string, fn: (...args: unknown[]) => void) => { if (name === 'session/event') hook = fn },
    agents: { get: () => root }, sessions: { flush: async () => true },
    sessionPersistence: { open: async () => { throw new Error('not_authorized') } },
    sessionController: { resolveAgent }, logger: { warn },
  } as unknown as Context
  installEmployeeSnapshots(ctx)
  hook!(root.session, input[2])
  await vi.waitFor(() => { expect(warn).toHaveBeenCalledOnce() })
  expect(resolveAgent).not.toHaveBeenCalled()
  expect(append).not.toHaveBeenCalled()
})

it('publishes the saved assignment during active work and later completion separately without waking', async () => {
  let input = events()
  const hooks = new Map<string, (...args: unknown[]) => void>()
  const received: SessionEvent[] = []
  const target = { id: 'employee-room', status: 'running', runMaintenance: async (fn: () => Promise<void>) => fn(), session: {
    ownEvents: () => received,
    append: vi.fn((type: string, data: unknown) => received.push({ type, data } as SessionEvent)),
  } }
  const root = { id: 'root', session: { id: 'root', header: { agentPreset: 'hivemind-hq' }, snapshotEvents: () => input } }
  const read = vi.fn(async () => ({})), open = vi.fn(async () => ({ read, close: async () => {} }))
  const wake = vi.fn()
  const ctx = {
    effect: (fn: (...args: unknown[]) => void) => { fn() },
    on: (name: string, fn: (...args: unknown[]) => void) => hooks.set(name, fn),
    agents: { get: () => root }, sessions: { flush: async () => true }, sessionPersistence: { open },
    sessionController: { resolveAgent: async () => ({ agent: target }) }, logger: { warn: vi.fn() },
    schedule: { ensure: wake },
  } as unknown as Context
  installEmployeeSnapshots(ctx)
  hooks.get('session/event')!(root.session, input[2])
  await vi.waitFor(() => { expect(target.session.append).toHaveBeenCalledOnce() })
  expect(received[0]?.type === 'hivemind/employee-task-snapshot' && received[0].data.task.status).toBe('pending')
  expect(target.status).toBe('running')
  input = events('completed')
  input.push({ seq: 7, time: 2000, type: 'team/task', data: input[1]!.data } as SessionEvent)
  hooks.get('session/event')!(root.session, input.at(-1))
  await vi.waitFor(() => { expect(target.session.append).toHaveBeenCalledTimes(2) })
  const result = received[1]
  if (result?.type !== 'hivemind/employee-task-snapshot') throw new Error('snapshot_missing')
  expect(result.data.task.status).toBe('completed')
  expect(result.data.task.revision).toBe(3)
  target.status = 'idle'
  hooks.get('agent/status')!({ agent: target, status: 'idle' })
  expect(target.session.append).toHaveBeenCalledTimes(2)
  expect(wake).not.toHaveBeenCalled()
})
