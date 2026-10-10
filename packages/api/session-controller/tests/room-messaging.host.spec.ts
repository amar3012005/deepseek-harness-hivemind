import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { RoomMessaging, roomMessageId, requestsAssignmentReview } from '../src/room-messaging.ts'

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
  const ctx = {
    serial: async () => undefined,
    agents: { get: (id: string) => agents.get(id) },
    sessions: { flush: vi.fn(() => Promise.resolve(true)) },
  } as unknown as Context
  const open = vi.fn((key: string) => Promise.resolve(key === 'runtime' ? caller : ravi))
  const messaging = new RoomMessaging(ctx, open)
  const request = { key: 'test-1', target: 'employee-ravi', targetProfile: { id: 'employee-ravi', name: 'Ravi', role: 'Research' }, kind: 'question' as const, text: 'What is the requested title?' }
  return { ctx, caller, ravi, messaging, request }
}
const signal = new AbortController().signal

describe('Persistent agent room messaging', () => {
  it('transfers only an exact saved generated file to Runtime without starting a turn', async () => {
    const { caller, ravi, messaging } = fixture()
    const file = { type: 'file', id: 'stored-file', name: 'brief.pdf' }
    ravi.session.append('hivemind/generation-created', { artifactId: 'saved-artifact', file } as never)
    const request = { key: 'artifact', target: 'runtime', kind: 'update' as const, text: 'Chief, here is the brief.', taskId: 'task-3', artifactIds: ['invented-artifact'] }
    await expect(messaging.send(ravi, request, signal)).rejects.toThrow('artifact_ids must reference a saved file or PDF in the sender room')
    expect(caller.session.snapshotEvents()).toHaveLength(0)
    await messaging.send(ravi, { ...request, artifactIds: ['saved-artifact'] }, signal)
    const notice = caller.session.snapshotEvents().find(e => e.type === 'user/message')
    expect(notice?.type === 'user/message' && notice.data.content).toContainEqual({ type: 'file', attachment: file })
    const received = caller.session.snapshotEvents().find(e => e.type === 'hivemind/room-message-received')
    expect(received?.data).toMatchObject({ artifacts: [{ artifactId: 'saved-artifact', file, producerSessionId: 'ravi', producerName: 'Employee' }] })
    expect(caller.steer).not.toHaveBeenCalled()
  })
  it('prepares a directory-bound persistent room without inbox insertion and rejects identity conflicts', async () => {
    const { messaging, ravi, request } = fixture()
    expect(await messaging.resolveRoom(request.target, request.targetProfile, signal)).toBe(ravi)
    expect(ravi.steer).not.toHaveBeenCalled()
    expect(ravi.inbox.nextTurn).toHaveLength(0)
    ravi.session.append('hivemind/session-owner', { id: 'other' } as never)
    await expect(messaging.resolveRoom(request.target, request.targetProfile, signal)).rejects.toThrow('identity_conflict')
    await expect(messaging.resolveRoom('different', request.targetProfile, signal)).rejects.toThrow('identity_conflict')
  })
  it('admits a question once and pins the trusted recipient selection', async () => {
    const { caller, ravi, messaging, request } = fixture()
    const receipt = await messaging.send(caller, request, signal)
    expect(receipt.status).toBe('accepted')
    await messaging.send(caller, request, signal)
    expect(ravi.steer).toHaveBeenCalledTimes(1)
    expect(ravi.session.snapshotEvents().filter(e => e.type === 'hivemind/room-message-received')).toHaveLength(1)
    expect(ravi.session.snapshotEvents().find(e => e.type === 'hivemind/employee-selection')?.data).toEqual(request.targetProfile)
  })
  it('deduplicates JSONB reordered receipts after restart', async () => {
    const { caller, ravi, messaging, request } = fixture()
    await messaging.send(caller, request, signal)
    for (const event of caller.session.snapshotEvents()) {
      if (event.type === 'hivemind/room-message-queued') {
        event.data = Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(event.data))).reverse()) as unknown as typeof event.data
      }
    }
    await messaging.send(caller, request, signal)
    expect(ravi.steer).toHaveBeenCalledTimes(1)
    await expect(messaging.send(caller, { ...request, text: 'different' }, signal)).rejects.toThrow('key_conflict')
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
    vi.mocked(ctx.sessions.flush).mockImplementationOnce(() => Promise.resolve(true)).mockRejectedValueOnce(new Error('flush failed'))
    await expect(messaging.send(caller, request, signal)).rejects.toThrow('flush failed')
    await messaging.send(caller, request, signal)
    expect(ravi.steer).toHaveBeenCalledTimes(1)
  })
  it('does not confirm a false checkpoint and repairs the same accepted inbox on retry', async () => {
    const { ctx, caller, ravi, messaging, request } = fixture()
    vi.mocked(ctx.sessions.flush).mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    await expect(messaging.send(caller, request, signal)).rejects.toThrow('persistence_required')
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

it('wakes Runtime once for a verified assigned artifact and keeps paused submissions quiet', async () => {
  const { caller, ravi, messaging } = fixture()
  caller.session.append('hivemind/hq-mode', { enabled: true } as never)
  caller.session.append('hivemind/hq-employee-assignment', { taskId: 'task-3', sessionId: 'ravi' } as never)
  caller.session.append('team/task', { task: { id: 'task-3', status: 'in_progress' } } as never)
  ravi.session.append('hivemind/generation-created', { artifactId: 'saved', file: { type: 'file', id: 'file', name: 'brief.html' } } as never)
  const request = { key: 'submission', target: 'runtime', kind: 'update' as const, text: 'Ready for review.', taskId: 'task-3', artifactIds: ['saved'] }
  expect((await messaging.send(ravi, request, signal)).status).toBe('accepted')
  await messaging.send(ravi, request, signal)
  expect(caller.steer).toHaveBeenCalledTimes(1)
  caller.session.append('hivemind/hq-mode', { enabled: false } as never)
  expect((await messaging.send(ravi, { ...request, key: 'paused' }, signal)).status).toBe('recorded')
  expect(caller.steer).toHaveBeenCalledTimes(1)
})

it.each([
  ['wrong producer', 'other', 'in_progress', 1],
  ['no saved artifact', 'ravi', 'in_progress', 0],
  ['already completed', 'ravi', 'completed', 1],
  ['deleted assignment', 'ravi', 'deleted', 1],
])('keeps %s quiet', (_label, producer, status, count) => {
  const events = [{ type: 'hivemind/hq-mode', data: { enabled: true } }, { type: 'hivemind/hq-employee-assignment', data: { taskId: 'task', sessionId: producer } }, { type: 'team/task', data: { task: { id: 'task', status } } }]
  expect(requestsAssignmentReview(events, 'ravi' as never, 'task', count)).toBe(false)
})

it('wakes active Runtime once for a new employee notification without an artifact', async () => {
  const { caller, ravi, messaging } = fixture()
  caller.session.append('hivemind/hq-mode', { enabled: true } as never)
  const notice = { key: 'needs-help', target: 'runtime', kind: 'update' as const, text: 'I need a clarification before proceeding.' }
  expect((await messaging.send(ravi, notice, signal)).status).toBe('accepted')
  await messaging.send(ravi, notice, signal)
  expect(caller.steer).toHaveBeenCalledTimes(1)
  caller.session.append('hivemind/hq-mode', { enabled: false } as never)
  expect((await messaging.send(ravi, { ...notice, key: 'paused-notice' }, signal)).status).toBe('recorded')
  expect(caller.steer).toHaveBeenCalledTimes(1)
})

it('persists detailed Nightly replies inside the supported correlated message string',async()=>{
  const { caller,ravi,messaging,request }=fixture();const occurrence='2026-10-10T00:00:00.000Z'
  const question=await messaging.send(caller,{ ...request,key:'nightly-request',text:'NIGHTLY_REVIEW_REQUEST='+JSON.stringify({ occurrence,agent_index:1 }) },signal)
  const findings=[{ tool:'hivemind_app_get',expected:'A valid app reference.',observed:'Identifier rejected.',recovery:'Discovery retried.',prevention:'Validate before use.' }]
  const text='NIGHTLY_REVIEW_REPLY='+JSON.stringify({ occurrence,findings })
  await messaging.send(ravi,{ key:'nightly-reply',target:'runtime',kind:'reply',replyTo:question.messageId,text },signal)
  const received=caller.session.snapshotEvents().find(e=>e.type==='hivemind/room-message-received')
  expect(received?.type==='hivemind/room-message-received'&&received.data).toMatchObject({ kind:'reply',senderId:ravi.id,targetId:caller.id,replyTo:question.messageId,text })
})
