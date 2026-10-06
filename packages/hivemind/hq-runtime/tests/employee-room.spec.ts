import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { allowsEmployeeWork, employeeWorkPrompt, prepareEmployee, workReference } from '../src/employee-room.ts'

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
  const profile = { id: 'employee', status: 'draft', policy_rules: { native_lifecycle: { version: 1, phase: 'active', kind: 'durable' } } }
  const ctx = { get: (name: string) => name === 'hivemindEmployeeDirectory' ? { profiles: async () => ({ profiles: [profile] }) } : undefined, sessionPersistence: { open }, sessionController: { resolveAgent: async () => ({ agent: root }) }, agentTeams: { listMembers: () => [{ id: target.id, ownership: 'persistent' }], getTask: () => task } } as unknown as Context
  const ref = { rootId: root.id, taskId: 'task-1' }
  return { events, task, ctx, target, ref, open, close, profile }
}
const signal = new AbortController().signal
describe('HQ persistent employee delivery', () => {
  it('keeps detailed learning in typed private memory and returns concise artifact receipts', () => {
    const root = { id: 'chief', session: { snapshotEvents: () => [{ type: 'hivemind/hq-task-contract', data: { taskId: 'task-1', dueAt: '2026-10-03T20:00:00Z', acceptanceCriteria: ['Save brief'] } }] } } as unknown as Agent
    const ctx = { agentTeams: { getTask: () => ({ description: 'Create brief', subject: 'Brief', writeScopes: [] }) } } as unknown as Context
    const prompt = employeeWorkPrompt(ctx, root, 'task-1')
    expect(prompt).toContain('actual persistent employee identity')
    expect(prompt).toContain('task_status automatically; do not duplicate')
    expect(prompt).toContain('exact artifact_ids')
    expect(prompt).toContain('do not send a README packet')
    expect(prompt).toContain('selected method references in the saved task description')
    expect(prompt).toContain('retrieve the relevant authorized source or ask Runtime')
    expect(prompt).toContain('deadline does not make a reported blocker inactionable')
    expect(prompt).toContain('do not mark the task complete or grant new permissions')
  })
  it('resolves the exact directory from the root preset isolate realm', async () => {
    const profiles = vi.fn(async () => ({ profiles: [] }))
    const serviceFor = vi.fn(() => ({ profiles }))
    const root = { id: 'runtime-room', ctx: { get: () => undefined } } as unknown as Agent
    const ctx = { get: (name: string) => name === 'agentPresets' ? { serviceFor } : undefined } as unknown as Context
    await expect(prepareEmployee(ctx, root, 'task-1', 'employee', signal)).rejects.toThrow('hq_employee_not_authorized')
    expect(serviceFor).toHaveBeenCalledWith(root, 'hivemindEmployeeDirectory')
    expect(profiles).toHaveBeenCalledWith(signal)
  })
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
  it('denies newly closed registry authority for an existing persistent room', async () => {
    const f = fixture()
    f.profile.policy_rules.native_lifecycle.phase = 'closing'
    expect(await allowsEmployeeWork(f.ctx, f.target, f.ref, signal)).toBe(false)
    f.profile.policy_rules.native_lifecycle.phase = 'archived'
    expect(await allowsEmployeeWork(f.ctx, f.target, f.ref, signal)).toBe(false)
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

it('fails closed for malformed deadline or unsupported registry versions before scheduled work admission', async () => {
  const f = fixture()
  for (const state of [{ version: 2, phase: 'active', kind: 'durable' },
    { version: 1, phase: 'active', kind: 'temporary', expires_at: 'invalid' }]) {
    Object.assign(f.profile.policy_rules.native_lifecycle, state)
    expect(await allowsEmployeeWork(f.ctx, f.target, f.ref, signal)).toBe(false)
  }
})
