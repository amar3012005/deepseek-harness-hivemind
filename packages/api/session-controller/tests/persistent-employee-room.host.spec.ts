import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionController } from '../src/index.ts'
import { PersistentEmployeeRoomResolver } from '../src/persistent-employee-room.ts'

const profile = { id: 'employee-7', name: 'Ravi', role: 'Analyst' }

function fixture(options: { events?: { type: string; data: unknown }[]; resolveId?: string; flushResult?: boolean } = {}) {
  const events = options.events ?? []
  const session = {
    id: 'session-canonical' as SessionId,
    header: { id: 'session-canonical' as SessionId, parentSession: undefined, origin: undefined },
    snapshotEvents: () => events,
    append: vi.fn((type: string, data: unknown) => { events.push({ type, data }) }),
  }
  const agent = { id: session.id, session } as unknown as Agent
  const employeeRoomId = vi.fn(async () => (options.resolveId ?? session.id) as SessionId)
  const create = vi.fn(async () => ({ sessionId: session.id, agentPreset: 'hivemind-hyperagents' }))
  const flush = vi.fn(async () => options.flushResult ?? true)
  const ctx = {
    sessionPersistence: { employeeRoomId },
    agents: { get: (id: SessionId) => id === session.id ? agent : undefined },
    sessions: { flush },
  } as unknown as Context
  const commands = { create } as never
  const agents = { presetForSession: () => 'hivemind-hyperagents' } as never
  return { resolver: new PersistentEmployeeRoomResolver(ctx, commands, agents), events, agent, employeeRoomId, create, flush }
}

describe('PersistentEmployeeRoomResolver', () => {
  it('reuses the canonical same-tenant room and checkpoints selection once', async () => {
    const h = fixture()
    const first = await h.resolver.resolve(profile.id, profile, new AbortController().signal)
    const second = await h.resolver.resolve(profile.id, profile, new AbortController().signal)
    expect(first).toBe(h.agent)
    expect(second).toBe(h.agent)
    expect(h.employeeRoomId).toHaveBeenCalledTimes(2)
    expect(h.create).toHaveBeenCalledTimes(2)
    expect(h.events.filter(event => event.type === 'hivemind/employee-selection')).toHaveLength(1)
    expect(h.flush).toHaveBeenCalledTimes(1)
  })

  it('rejects profile mismatch and provider-denied foreign tenant identity before admission', async () => {
    const h = fixture()
    await expect(h.resolver.resolve('another-employee', profile, new AbortController().signal))
      .rejects.toThrow('agent_message_target_identity_conflict')
    expect(h.employeeRoomId).not.toHaveBeenCalled()
    const denied = fixture()
    denied.employeeRoomId.mockRejectedValueOnce(new Error('session-not-found'))
    await expect(denied.resolver.resolve(profile.id, profile, new AbortController().signal)).rejects.toThrow('session-not-found')
    expect(denied.create).not.toHaveBeenCalled()
  })

  it('rejects a canonical room already owned by a different employee', async () => {
    const h = fixture({ events: [{ type: 'hivemind/session-owner', data: { id: 'employee-foreign' } }] })
    await expect(h.resolver.resolve(profile.id, profile, new AbortController().signal))
      .rejects.toThrow('agent_message_target_identity_conflict')
    expect(h.flush).not.toHaveBeenCalled()
  })

  it('does not report a newly selected room as durable when the native flush returns false', async () => {
    const h = fixture({ flushResult: false })
    await expect(h.resolver.resolve(profile.id, profile, new AbortController().signal))
      .rejects.toThrow('persistent_employee_room_selection_persistence_required')
    expect(h.flush).toHaveBeenCalledOnce()
  })

  it('restores the same persistent identity without duplicating selection after restart', async () => {
    const savedSelection = { type: 'hivemind/employee-selection', data: profile }
    const h = fixture({ events: [savedSelection] })
    const restarted = new PersistentEmployeeRoomResolver(
      {
        sessionPersistence: { employeeRoomId: h.employeeRoomId },
        agents: { get: (id: SessionId) => id === h.agent.id ? h.agent : undefined },
        sessions: { flush: h.flush },
      } as unknown as Context,
      { create: h.create } as never,
      { presetForSession: () => 'hivemind-hyperagents' } as never,
    )
    const restored = await restarted.resolve(profile.id, profile, new AbortController().signal)
    expect(restored.id).toBe(h.agent.id)
    expect(h.events.filter(event => event.type === 'hivemind/employee-selection')).toHaveLength(1)
    expect(h.flush).not.toHaveBeenCalled()
  })
})

// A mounted controller must receive the durable identity provider used by rooms.
it('declares the native persistence dependency required for employee room admission', () => {
  expect(SessionController.inject).toContain('sessionPersistence')
})
