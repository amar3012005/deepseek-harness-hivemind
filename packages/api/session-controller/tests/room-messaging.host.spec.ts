import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { RoomMessaging, roomMessageId } from '../src/room-messaging.ts'

function fixture() {
  const agents = new Map<string, Agent>()
  function agent(id: string, preset = 'hivemind-hyperagents') {
    const events: SessionEvent[] = []
    const inbox: { nextTurn: unknown[]; nextStep: unknown[] } = { nextTurn: [], nextStep: [] }
    const append = (type: string, data: unknown) => { events.push({ type, data } as SessionEvent) }
    const value = {
      id,
      session: { header: { id, agentPreset: preset }, ownEvents: () => events, snapshotEvents: () => events, append },
      inbox, steer: vi.fn(message => inbox.nextTurn.push(message)),
    } as unknown as Agent
    agents.set(id, value)
    return value
  }
  const caller = agent('hq', 'hivemind-hq')
  const ravi = agent('ravi')
  const ctx = { agents: { get: (id: string) => agents.get(id) }, sessions: { flush: vi.fn(() => Promise.resolve()) } } as unknown as Context
  const open = vi.fn((key: string) => Promise.resolve(key === 'runtime' ? caller : ravi))
  const messaging = new RoomMessaging(ctx, open)
  const request = { key: 'test-1', target: 'employee-ravi', targetProfile: { id: 'employee-ravi', name: 'Ravi', role: 'Research' }, kind: 'question' as const, text: 'What is the requested title?' }
  return { ctx, caller, ravi, messaging, request }
}
const signal = new AbortController().signal

describe('Persistent agent room messaging', () => {
  it('admits a question once and pins the trusted recipient selection', async () => {
    const { caller, ravi, messaging, request } = fixture()
    const receipt = await messaging.send(caller, request, signal)
    expect(receipt.status).toBe('accepted')
    await messaging.send(caller, request, signal)
    expect(ravi.steer).toHaveBeenCalledTimes(1)
    expect(ravi.session.snapshotEvents().filter(e => e.type === 'hivemind/room-message-received')).toHaveLength(1)
    expect(ravi.session.snapshotEvents().find(e => e.type === 'hivemind/employee-selection')?.data).toEqual(request.targetProfile)
  })
  it('records a quiet notice without starting or queuing a model turn', async () => {
    const { caller, ravi, messaging, request } = fixture()
    await messaging.send(caller, { ...request, kind: 'update', text: 'Artifact generated; task remains open.' }, signal)
    expect(ravi.steer).not.toHaveBeenCalled()
    expect(ravi.inbox.nextTurn).toHaveLength(0)
    const notice = ravi.session.snapshotEvents().find(e => e.type === 'user/message')
    expect(notice?.type === 'user/message' && notice.data.source).toMatchObject({ kind: 'hivemind-agent-message', form: 'notice' })
  })
  it('rejects conflicting reuse, self delivery, and replies without received references', async () => {
    const { caller, messaging, request } = fixture()
    await messaging.send(caller, request, signal)
    await expect(messaging.send(caller, { ...request, text: 'different' }, signal)).rejects.toThrow('key_conflict')
    await expect(messaging.send(caller, { ...request, key: 'self', target: 'runtime' }, signal)).rejects.toThrow('self_target')
    await expect(messaging.send(caller, { ...request, key: 'reply', kind: 'reply' }, signal)).rejects.toThrow('reply_reference')
  })
  it('correlates a reply to its original room and rejects runaway exchanges', async () => {
    const { caller, ravi, messaging, request } = fixture()
    const sent = await messaging.send(caller, request, signal)
    await messaging.send(ravi, { key: 'reply-1', target: 'runtime', kind: 'reply', text: 'Runtime Cordis integration check', replyTo: sent.messageId }, signal)
    expect(caller.steer).toHaveBeenCalledTimes(1)
    const incoming = ravi.session.snapshotEvents().find(e => e.type === 'hivemind/room-message-received')
    if (incoming?.type !== 'hivemind/room-message-received') throw new Error('missing receipt')
    incoming.data.hops = 8
    await expect(messaging.send(ravi, { key: 'reply-2', target: 'runtime', kind: 'reply', text: 'again', replyTo: sent.messageId }, signal)).rejects.toThrow('exchange_limit')
  })
  it('does not repeat admission when receiver flush failed after its inbox accepted', async () => {
    const { ctx, caller, ravi, messaging, request } = fixture()
    vi.mocked(ctx.sessions.flush).mockImplementationOnce(() => Promise.resolve()).mockRejectedValueOnce(new Error('flush failed'))
    await expect(messaging.send(caller, request, signal)).rejects.toThrow('flush failed')
    await messaging.send(caller, request, signal)
    expect(ravi.steer).toHaveBeenCalledTimes(1)
  })
  it('keeps Brain and delegated child controls on their native paths', async () => {
    const { caller, messaging, request } = fixture()
    Object.assign(caller.session.header, { agentPreset: 'hivemind-chat' })
    await expect(messaging.send(caller, request, signal)).rejects.toThrow('employee_mode_required')
    Object.assign(caller.session.header, { agentPreset: 'hivemind-hyperagents' })
    Object.assign(caller.session.header, { parentSession: 'parent' })
    await expect(messaging.send(caller, request, signal)).rejects.toThrow('use_native_team_mailbox')
    expect(() => roomMessageId('room', '../other')).toThrow('key_invalid')
  })
})
