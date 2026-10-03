import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { allowsEmployeeWork, workReference } from '../src/employee-room.ts'

function fixture() {
  const events = [
    { type: 'hivemind/hq-mode', data: { enabled: true, revision: 1, changedAt: Date.now() } },
    { type: 'hivemind/hq-employee-assignment', data: { taskId: 'task-1', employeeId: 'employee', memberName: 'employee', sessionId: 'employee-room', personaSha256: 'digest' } },
  ] as SessionEvent[]
  const root = { id: 'runtime-room', session: { snapshotEvents: () => events } } as unknown as Agent
  const target = { id: 'employee-room' } as Agent
  const task = { id: 'task-1', status: 'pending', ready: true }
  const close = vi.fn(async () => {})
  const open = vi.fn(async () => ({ read: async () => ({ events }), close }))
  const ctx = { sessionPersistence: { open }, sessionController: { resolveAgent: async () => ({ agent: root }) }, agentTeams: { listMembers: () => [{ id: target.id, ownership: 'persistent' }], getTask: () => task } } as unknown as Context
  const ref = { rootId: root.id, taskId: 'task-1' }
  return { events, task, ctx, target, ref, open, close }
}
const signal = new AbortController().signal
describe('HQ persistent employee delivery', () => {
  it('recognizes the native JSON reminder framing and rejects malformed references', () => {
    const prompt = 'HQ_EMPLOYEE_ASSIGNMENT={"rootId":"runtime","taskId":"task-1","itemId":"planning","revision":2}\nPerform saved work.'
    expect(workReference(`reminder_prompt_json: ${JSON.stringify(prompt)}`)).toEqual({ rootId: 'runtime', taskId: 'task-1', itemId: 'planning', revision: 2 })
    expect(workReference('Hello')).toBeUndefined()
    expect(() => workReference('HQ_EMPLOYEE_ASSIGNMENT={"rootId":1}')).toThrow('reference_invalid')
  })
  it('authorizes the exact saved assignee after scoped persistence verification', async () => {
    const f = fixture()
    expect(await allowsEmployeeWork(f.ctx, f.target, f.ref, signal)).toBe(true)
    expect(f.open).toHaveBeenCalledWith('runtime-room', 'read', { signal })
    expect(f.close).toHaveBeenCalledTimes(1)
    await expect(allowsEmployeeWork(f.ctx, { id: 'other-room' } as Agent, f.ref, signal)).rejects.toThrow('target_not_authorized')
    f.open.mockRejectedValueOnce(new Error('tenant denied'))
    await expect(allowsEmployeeWork(f.ctx, f.target, f.ref, signal)).rejects.toThrow('tenant denied')
  })
  it('retains paused, dependency-blocked, terminal and future work before model admission', async () => {
    const f = fixture()
    f.task.ready = false
    expect(await allowsEmployeeWork(f.ctx, f.target, f.ref, signal)).toBe(false)
    f.task.ready = true
    f.task.status = 'completed'
    expect(await allowsEmployeeWork(f.ctx, f.target, f.ref, signal)).toBe(false)
    f.task.status = 'pending'
    f.events.push({ type: 'hivemind/hq-mode', data: { enabled: false, revision: 2, changedAt: Date.now() } } as SessionEvent)
    expect(await allowsEmployeeWork(f.ctx, f.target, f.ref, signal)).toBe(false)
    f.events.pop()
    f.events.push({ type: 'hivemind/hq-calendar-item', data: { id: 'plan', taskId: 'task-1', revision: 1, kind: 'assignment', title: 'Work', owner: 'employee', startsAt: new Date(Date.now() + 60_000).toISOString(), endsAt: new Date(Date.now() + 120_000).toISOString(), resolved: false } } as SessionEvent)
    expect(await allowsEmployeeWork(f.ctx, f.target, f.ref, signal)).toBe(false)
    expect(await allowsEmployeeWork(f.ctx, f.target, { ...f.ref, itemId: 'plan', revision: 0 }, signal)).toBe(false)
  })
})
