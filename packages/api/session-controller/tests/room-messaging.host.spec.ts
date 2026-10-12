import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { RoomMessaging, roomMessageId, requestsAssignmentReview, type ExternalEmployeeRoomProvider } from '../src/room-messaging.ts'

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
  return { ctx, caller, ravi, messaging, request, open }
}
function externalFixture(deliver: ExternalEmployeeRoomProvider['deliver'] = async () => ({ receiptId: 'dot-job-42', status: 'accepted' })) {
  const base = fixture()
  const events: SessionEvent[] = []
  const proxy = {
    id: 'session-opaque-9f31',
    session: { header: { id: 'session-opaque-9f31', agentPreset: 'hivemind-hyperagents' }, ownEvents: () => events, snapshotEvents: () => events, append: (type: string, data: unknown) => events.push({ type, data } as SessionEvent) },
    inbox: { nextTurn: [], nextStep: [] }, steer: vi.fn(),
  } as unknown as Agent
  const agents = (base.ctx as unknown as { agents: { get: (id: string) => Agent | undefined } }).agents
  const originalGet = agents.get.bind(agents)
  vi.spyOn(agents, 'get').mockImplementation(id => id === proxy.id ? proxy : originalGet(id))
  const principal = { orgId: 'org-1', userId: 'user-1', profile: 'hivemind-chat' as const, variation: 'test', authenticatedActor: { orgId: 'org-1', userId: 'user-1', name: 'Admin', role: 'admin' } }
  Object.assign(base.ctx, { hivemindExecutionScope: { require: () => principal } })
  const provider: ExternalEmployeeRoomProvider = {
    resolve: async employeeId => {
      if (employeeId !== 'employee-dot') throw new Error('canonical_directory_employee_not_found')
      return { agent: proxy, driverless: true }
    },
    deliver,
  }
  const messaging = new RoomMessaging(base.ctx, base.open, provider)
  const input = { key: 'external-1', target: 'employee-dot', targetProfile: { id: 'employee-dot', name: 'Ravi', role: 'Research', executionBackend: 'open-dot' as const, dotId: 'dot-canonical-7' }, kind: 'question' as const, text: 'Prepare the requested report.' }
  return { ...base, proxy, provider, messaging, input, principal }
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
  it('routes a marked external employee through durable provider acceptance without steering a DSH turn', async () => {
    let resolveAcceptance!: () => void
    const acceptance = new Promise<void>(resolve => { resolveAcceptance = resolve })
    const delivered = vi.fn(async (_input: Parameters<ExternalEmployeeRoomProvider['deliver']>[0]) => { await acceptance; return { receiptId: 'dot-job-42', status: 'accepted' as const } })
    const { caller, open, proxy, messaging, input, principal } = externalFixture(delivered)
    const sending = messaging.send(caller, input, signal)
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledOnce())
    expect(proxy.steer).not.toHaveBeenCalled()
    expect(proxy.session.snapshotEvents().some(event => event.type === 'hivemind/room-message-received')).toBe(false)
    expect(open).not.toHaveBeenCalled()
    resolveAcceptance()
    await sending
    expect(proxy.session.snapshotEvents().find(event => event.type === 'hivemind/room-message-received')?.data).toMatchObject({ targetId: proxy.id })
    expect(proxy.session.snapshotEvents().find(event => event.type === 'hivemind/external-delivery-accepted')?.data).toMatchObject({ receiptId: 'dot-job-42', employeeId: 'employee-dot' })
    expect(delivered.mock.calls[0]?.[0]).toMatchObject({ callerSessionId: caller.id, principal, authenticatedActor: principal.authenticatedActor })
  })
  it('retains durable backend acceptance when canceled after queue acceptance and recovers without duplicate delivery', async () => {
    const delivered = vi.fn(async () => ({ receiptId: 'dot-job-42', status: 'accepted' as const }))
    const { ctx, caller, proxy, messaging, input } = externalFixture(delivered)
    const controller = new AbortController()
    vi.mocked(ctx.sessions.flush).mockImplementation(async session => {
      const events = (session as unknown as { snapshotEvents?: () => SessionEvent[] }).snapshotEvents?.() ?? []
      const headerId = (session as unknown as { header?: { id?: string } }).header?.id
      if (headerId === proxy.id && events.some(event => event.type === 'hivemind/external-delivery-accepted')) controller.abort()
      return true
    })
    await expect(messaging.send(caller, input, controller.signal)).rejects.toThrow()
    expect(proxy.session.snapshotEvents().find(event => event.type === 'hivemind/external-delivery-accepted')?.data).toMatchObject({ receiptId: 'dot-job-42' })
    expect(proxy.session.snapshotEvents().some(event => event.type === 'hivemind/room-message-received')).toBe(false)
    expect(delivered).toHaveBeenCalledOnce()
    vi.mocked(ctx.sessions.flush).mockResolvedValue(true)
    await messaging.send(caller, input, signal)
    expect(delivered).toHaveBeenCalledOnce()
    expect(proxy.session.snapshotEvents().filter(event => event.type === 'hivemind/room-message-received')).toHaveLength(1)
  })
  it('rejects malformed backend receipts before writing acceptance or delivery receipts', async () => {
    const malformed = vi.fn(async () => ({ receiptId: 'dot-job-bad', status: 'done' } as unknown as { receiptId: string; status: 'accepted' | 'recorded' }))
    const { caller, proxy, messaging, input } = externalFixture(malformed)
    await expect(messaging.send(caller, input, signal)).rejects.toThrow('external_receipt_invalid')
    expect(proxy.session.snapshotEvents().some(event => event.type === 'hivemind/external-delivery-accepted')).toBe(false)
    expect(proxy.session.snapshotEvents().some(event => event.type === 'hivemind/room-message-received')).toBe(false)
  })
  it('does not bind a proxy room when cancellation arrives during external resolution', async () => {
    const { open, proxy, provider, messaging, input } = externalFixture()
    const controller = new AbortController()
    vi.spyOn(provider, 'resolve').mockImplementation(async () => {
      controller.abort()
      return { agent: proxy, driverless: true }
    })
    await expect(messaging.resolveRoom(input.target, input.targetProfile, controller.signal)).rejects.toThrow()
    expect(proxy.session.snapshotEvents().some(event => event.type === 'hivemind/external-employee-room')).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
  it('fails closed for an explicitly external profile when no provider is registered', async () => {
    const { messaging, open, request } = fixture()
    await expect(messaging.resolveRoom(request.target, { ...request.targetProfile, executionBackend: 'open-dot', dotId: 'dot-canonical' }, signal)).rejects.toThrow('external_provider_required')
    expect(open).not.toHaveBeenCalled()
  })
  it('fails closed when the trusted HIVE principal is unavailable', async () => {
    const { ctx, messaging, open, request } = fixture()
    Object.assign(ctx, { hivemindExecutionScope: undefined })
    const profile = { ...request.targetProfile, executionBackend: 'open-dot' as const, dotId: 'dot-canonical' }
    const provider: ExternalEmployeeRoomProvider = {
      resolve: async () => { throw new Error('must not resolve without principal') },
      deliver: async () => ({ receiptId: 'unused', status: 'accepted' }),
    }
    const withProvider = new RoomMessaging(ctx, open, provider)
    await expect(withProvider.resolveRoom(request.target, profile, signal)).rejects.toThrow('external_principal_required')
    expect(open).not.toHaveBeenCalled()
  })
  it('rejects an authored actor that conflicts with the scoped principal', async () => {
    const { ctx, caller, proxy, messaging, input } = externalFixture()
    const wrongActor = { orgId: 'other-org', userId: 'other-user', name: 'Other', role: 'member' }
    ;(ctx as unknown as { serial: (...args: unknown[]) => Promise<unknown> }).serial = async () => wrongActor
    await expect(messaging.send(caller, input, signal)).rejects.toThrow('external_actor_conflict')
    expect(caller.session.snapshotEvents().some(event => event.type === 'hivemind/room-message-queued')).toBe(false)
    expect(proxy.session.snapshotEvents().some(event => event.type === 'hivemind/external-delivery-accepted')).toBe(false)
  })
  it('admits a question once and pins the trusted recipient selection', async () => {
    const { caller, ravi, messaging, request } = fixture()
    const receipt = await messaging.send(caller, request, signal)
    expect(receipt.status).toBe('accepted')
    expect(caller.session.snapshotEvents().find(e => e.type === 'hivemind/room-message-queued')?.data).toMatchObject({ delivery: { key: request.key, target: request.target } })
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

it('saves the same brief summary and complete detailed instructions in outbox, inbox and recovery', async () => {
  const { caller, ravi, messaging, request } = fixture()
  const detailed = { ...request, summary: 'Review today’s work and send me your findings.', text: 'Review today’s work.\n' + 'Keep every evidence receipt and explain each blocker.\n'.repeat(20) }
  await messaging.send(caller, detailed, signal)
  const queued = caller.session.snapshotEvents().find(event => event.type === 'hivemind/room-message-queued')
  const received = ravi.session.snapshotEvents().find(event => event.type === 'hivemind/room-message-received')
  expect(queued?.data).toMatchObject({ summary: detailed.summary, text: detailed.text })
  expect(received?.data).toMatchObject({ summary: detailed.summary, text: detailed.text })
  const admitted = ravi.inbox.nextTurn[0] as { content: { type: string; text: string }[] }
  expect(JSON.parse(admitted.content[0]!.text)).toMatchObject({ summary: detailed.summary, text: detailed.text })
  await messaging.send(caller, detailed, signal)
  expect(ravi.steer).toHaveBeenCalledTimes(1)
  await expect(messaging.send(caller, { ...detailed, summary: 'Changed summary' }, signal)).rejects.toThrow('key_conflict')
})
it.each(['', 'many\nlines', 'x'.repeat(241)])('rejects invalid visible summary before room delivery (%s)', async (summary) => {
  const { caller, ravi, messaging, request } = fixture()
  await expect(messaging.send(caller, { ...request, summary }, signal)).rejects.toThrow('summary_invalid')
  expect(ravi.steer).not.toHaveBeenCalled()
  expect(caller.session.snapshotEvents()).toHaveLength(0)
})


it('preserves the original authenticated sender when a later turn retries a queued packet', async () => {
  const { ctx, caller, ravi, messaging, request } = fixture()
  const original = { name: 'Original admin', userId: 'admin-1', orgId: 'org', role: 'owner' }
  const current = { name: 'Later admin', userId: 'admin-2', orgId: 'org', role: 'admin' }
  Object.assign(ctx, { serial: vi.fn().mockResolvedValueOnce(original).mockResolvedValue(current) })
  vi.mocked(ctx.sessions.flush).mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('receiver unavailable'))
  await expect(messaging.send(caller, request, signal)).rejects.toThrow('receiver unavailable')
  await messaging.send(caller, request, signal)
  expect(ravi.steer).toHaveBeenCalledTimes(1)
  expect(Reflect.get(ravi.inbox.nextTurn[0] as object, 'source')).toMatchObject({ authenticatedActor: original })
  expect(ctx.serial).toHaveBeenCalledTimes(1)
})
