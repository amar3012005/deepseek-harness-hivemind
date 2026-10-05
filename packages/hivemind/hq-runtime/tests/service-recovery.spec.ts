import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { installServiceRecovery, serviceInterrupted } from '../src/service-recovery.ts'
function saved(reason: unknown = { kind: 'interrupted' }): SessionEvent[] {
  return [{ type: 'turn/start', seq: 1, time: 0, data: { turn: 4 } },
    { type: 'turn/end', seq: 2, time: 0, data: { turn: 4, reason } }] as SessionEvent[]
}
describe('service interruption eligibility', () => {
  it('allows only native crash repair or service disposal', () => {
    expect(serviceInterrupted(saved(), 4)).toBe(true)
    expect(serviceInterrupted(saved({ kind: 'aborted', reason: { kind: 'disposed' } }), 4)).toBe(true)
    for (const reason of [{ kind: 'completed' }, { kind: 'blocked' }, { kind: 'error', error: { message: 'network' } },
      { kind: 'aborted', reason: { kind: 'user' } }, { kind: 'aborted', reason: { kind: 'hook', reason: 'approval' } }]) {
      expect(serviceInterrupted(saved(reason), 4)).toBe(false)
    }
  })
  it('does not reopen a later turn or committed rest', () => {
    expect(serviceInterrupted([...saved(), { type: 'turn/start', seq: 3, time: 0, data: { turn: 5 } }], 4)).toBe(false)
    expect(serviceInterrupted([...saved(), { type: 'hivemind/hq-rest-confirmed', seq: 3, time: 0, data: {} } as SessionEvent], 4)).toBe(false)
  })
  it('holds pending or cancelled human approval, preserving a granted approval', () => {
    const asked = { type: 'approval/asked', seq: 3, time: 0, data: { id: 'approval' } } as SessionEvent
    const decided = (outcome: string) => ({ type: 'approval/decided', seq: 4, time: 0, data: { id: 'approval', outcome } } as SessionEvent)
    expect(serviceInterrupted([...saved(), asked], 4)).toBe(false)
    expect(serviceInterrupted([...saved(), asked, decided('cancelled')], 4)).toBe(false)
    expect(serviceInterrupted([...saved(), asked, decided('allowed-once')], 4)).toBe(true)
  })
})
function harness() {
  let events = [{ type: 'hivemind/hq-mode', seq: 0, time: 0, data: { revision: 1, enabled: true, changedAt: 0 } },
    ...saved()] as SessionEvent[]
  const agent = { id: 'root', status: 'idle', inbox: { nextStep: [], nextTurn: [] },
    session: { id: 'root', header: { agentPreset: 'hivemind-chat' },
      ownEvents: () => events, snapshotEvents: () => events } }
  events.unshift({ type: 'agent-preset/selected', seq: 0, time: 0, data: { agentPreset: 'hivemind-hq' } } as SessionEvent)
  const hooks = new Map<string, (...args: unknown[]) => unknown>()
  type Request = { title: string; after_seconds: number; prompt: string }
  type Task = { sessionId: string; record: Request & { id: string; scheduledAt: string } }
  let guard: (agent: unknown, task: Task) => Promise<boolean>
  let record: Task
  const ensure = vi.fn(async (sessionId: string, key: string, request: Request) => {
    const { createHash } = await import('node:crypto')
    record = { sessionId, record: { id: `schedule-${createHash('sha256').update(`${sessionId}\0${key}`).digest('hex')}`,
      scheduledAt: '2030-01-01T00:00:00Z', ...request } }
    return record.record
  })
  const remove = vi.fn(async () => ({ deleted: true })), read = vi.fn(async () => ({}))
  const ctx = { effect: (fn: () => unknown) => fn(), on: (name: string, fn: (...args: unknown[]) => unknown) => hooks.set(name, fn),
    schedule: { guardDelivery: (fn: typeof guard) => { guard = fn }, ensure, delete: remove },
    sessions: { flush: async () => true }, agentTeams: { tryMembership: () => ({ root: agent }) },
    sessionPersistence: { open: async () => ({ read, close: async () => {} }) },
    sessionController: { resolveAgent: async () => ({ agent }) }, logger: { warn: vi.fn() } } as unknown as Context
  installServiceRecovery(ctx)
  const arm = () => hooks.get('agent/pre-step')!({ agent, turn: 4 }, async () => ({ kind: 'enter', messages: [] }))
  return { agent, ensure, remove, read, hooks, arm, guard: () => guard!(agent, record),
    record: () => record, events: () => events, setEvents: (value: SessionEvent[]) => { events = value } }
}
it('arms exactly one tenant-scoped native receipt and never delivers while work runs', async () => {
  const h = harness()
  await h.arm(); await h.arm()
  expect(h.ensure).toHaveBeenCalledOnce()
  expect(h.ensure.mock.calls[0]?.[2].prompt).toContain('TOOL_OUTCOME_UNKNOWN')
  h.agent.status = 'running'
  expect(await h.guard()).toBe(false)
  h.agent.status = 'idle'
  expect(await h.guard()).toBe(true)
  expect(h.read).toHaveBeenCalledOnce()
})
it('excludes paused or newly resumed autonomy and pending native input', async () => {
  const h = harness(); await h.arm()
  h.agent.inbox.nextTurn.push({} as never)
  expect(await h.guard()).toBe(false)
  h.agent.inbox.nextTurn.length = 0
  h.setEvents([...h.events(), { type: 'hivemind/hq-mode', seq: 3, time: 0, data: { revision: 2, enabled: false, changedAt: 0 } }])
  expect(await h.guard()).toBe(false)
  h.setEvents([...h.events(), { type: 'hivemind/hq-mode', seq: 4, time: 0, data: { revision: 3, enabled: true, changedAt: 0 } }])
  expect(await h.guard()).toBe(false)
})
it('cleans normal stops but retains service-disposal receipt for background native dispatch', async () => {
  const h = harness(); await h.arm()
  h.hooks.get('agent/turn-ended')!({ agent: h.agent, turn: 4, reason: { kind: 'aborted', reason: { kind: 'disposed' } } })
  expect(h.remove).not.toHaveBeenCalled()
  h.hooks.get('agent/turn-ended')!({ agent: h.agent, turn: 4, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  expect(h.remove).toHaveBeenCalledOnce()
})

it('acknowledges a durable native delivery key without requesting another continuation', async () => {
  const h = harness(); await h.arm()
  const { createHash } = await import('node:crypto')
  const record = h.record().record
  const deliveryKey = createHash('sha256').update(`${record.id}:${record.scheduledAt}`).digest('hex')
  h.agent.status = 'running'
  h.setEvents([...h.events(), { seq: 3, time: 0, type: 'agent/inbox/spliced', data: {
    inserted: [{ source: { kind: 'schedule', deliveryKey } }],
  } } as SessionEvent])
  expect(await h.guard()).toBe(true)
  expect(h.ensure).toHaveBeenCalledOnce()
  expect(h.read).not.toHaveBeenCalled()
})
