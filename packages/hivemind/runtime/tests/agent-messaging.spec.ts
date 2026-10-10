import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { authorizedRecipient, messageDirectory, installAgentMessaging, explicitEmployeeMessageKind, reconcileRoomMessages } from '../src/agent-messaging.ts'

it('resolves authenticated unique slugs without accepting missing or ambiguous recipients', () => {
  const row = { id: 'employee-id', slug: 'ravi-patel' }
  expect(authorizedRecipient([row], 'employee-id')).toBe(row)
  expect(authorizedRecipient([row], 'ravi-patel')).toBe(row)
  expect(authorizedRecipient([row], 'unlisted')).toBeUndefined()
  expect(() => authorizedRecipient([row, { id: 'other', slug: 'ravi-patel' }], 'ravi-patel')).toThrow('ambiguous_use_exact_employee_id')
})

it('resolves a unique authenticated employee name without another model lookup', () => {
  const row = { id: 'employee-id', slug: 'canonical-slug', name: 'monny' }
  expect(authorizedRecipient([row], 'monny')).toBe(row)
  expect(authorizedRecipient([row], 'Monny')).toBe(row)
  expect(authorizedRecipient([row], 'outside-employee')).toBeUndefined()
  expect(() => authorizedRecipient([row, { id: 'other', slug: 'other', name: 'MONNY' }], 'monny')).toThrow('ambiguous_use_exact_employee_id')
  expect(authorizedRecipient([row, { id: 'other', slug: 'other', name: 'MONNY' }], 'employee-id')).toBe(row)
})

it('keeps delegated children on native Team messaging without hiding room messaging globally', async () => {
  let preStep: (input: { agent: Agent; signal: AbortSignal }, next: () => Promise<void>) => Promise<void>
  const scope = {
    effect: (effect: () => unknown) => effect(),
    on: (name: string, callback: typeof preStep) => { if (name === 'agent/pre-step') preStep = callback; return () => {} },
    tools: { register: vi.fn() },
  }
  installAgentMessaging({ inject: (_names: string[], callback: (value: unknown) => void) => callback(scope) } as unknown as Context)
  const restrict = vi.fn(() => () => {})
  const child = { session: { header: { parentSession: 'lead' } }, ctx: { effect: (effect: () => unknown) => effect(), tools: { restrict } } } as unknown as Agent
  const next = vi.fn(async () => {})
  const signal = new AbortController().signal
  await preStep!({ agent: child, signal }, next)
  await preStep!({ agent: child, signal }, next)
  expect(restrict).toHaveBeenCalledExactlyOnceWith({ deny: ['hivemind_agent_message'] })
  expect(next).toHaveBeenCalledTimes(2)
})

it('reports a terminal failed employee turn quietly with stable identity and no provider secrets', async () => {
  const callbacks = new Map<string, (...args: unknown[]) => unknown>()
  const events: { type: string; seq: number; data: unknown }[] = [
    { type: 'hivemind/session-owner', seq: 0, data: { id: 'employee', name: 'Ravi', slug: 'ravi' } },
    { type: 'user/message', seq: 1, data: { source: { kind: 'hivemind-agent-message' }, content: [{ type: 'text', text: JSON.stringify({ text: 'HQ_EMPLOYEE_ASSIGNMENT={"taskId":"task-1"}' }) }] } },
    { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'error', error: { code: 'POLICY', message: 'SECRET provider prompt' } } } },
  ]
  const deliverAgentMessage = vi.fn(async (_agent: unknown, packet: { key: string; text: string }) => {
    const { createHash } = await import('node:crypto')
    events.push({ type: 'hivemind/room-message-delivered', seq: 3, data: { id: `agent-message-${createHash('sha256').update(JSON.stringify(['employee-room', packet.key])).digest('hex')}` } })
    return {}
  })
  const scope = {
    effect: (f: () => unknown) => f(),
    on: (name: string, f: (...args: unknown[]) => unknown) => { callbacks.set(name, f); return () => {} }, tools: { register: vi.fn() }, sessionController: { deliverAgentMessage }, hivemindEmployeeDirectory: { profiles: async () => ({ profiles: [{ id: 'employee' }] }) } }
  installAgentMessaging({ inject: (_names: unknown, callback: (scope: unknown) => unknown) => callback(scope) } as unknown as Context)
  const agent = { id: 'employee-room', session: { header: { agentPreset: 'hivemind-hyperagents' }, snapshotEvents: () => events } }
  await callbacks.get('agent/turn-ended')!({ agent })
  await callbacks.get('agent/turn-ended')!({ agent })
  expect(deliverAgentMessage).toHaveBeenCalledTimes(1)
  expect(deliverAgentMessage.mock.calls[0]?.[1]).toMatchObject({ key: 'response-2', target: 'runtime', kind: 'update', taskId: 'task-1' })
  expect(JSON.stringify(deliverAgentMessage.mock.calls)).not.toContain('SECRET')
  expect(deliverAgentMessage.mock.calls[0]?.[1].text).toContain('provider policy rejection')
})

it.each([false, true])('sends one terminal report with receipts, respecting an explicit Runtime reply (%s)', async (manual) => {
  const { createHash } = await import('node:crypto')
  const id = (key: string) => `agent-message-${createHash('sha256').update(JSON.stringify(['employee-room', key])).digest('hex')}`
  const events = [
    { type: 'hivemind/session-owner', seq: 0, data: { id: 'employee', name: 'Ravi', slug: 'ravi' } },
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 2, data: { source: { kind: 'schedule' }, content: [{ type: 'text', text: 'HQ_EMPLOYEE_ASSIGNMENT={"taskId":"task-1"}' }] } },
    { type: 'hivemind/generation-created', seq: 3, data: { artifactId: 'saved', file: { attachmentId: 'file' } } },
    ...(manual ? [
      { type: 'tool/call', seq: 4, data: { name: 'hivemind_agent_message', arguments: JSON.stringify({ recipient: 'runtime', kind: 'update', message_key: 'manual' }) } },
      { type: 'hivemind/room-message-delivered', seq: 5, data: { id: id('manual') } },
    ] : []),
    { type: 'assistant/message', seq: 6, data: { turn: 1, interrupted: false, message: { content: [{ type: 'text', text: 'Chief, the brief is ready.' }] } } },
  ] as { type: string; seq: number; time?: number; data: unknown }[]
  const callbacks = new Map<string, (...args: unknown[]) => unknown>()
  const deliverAgentMessage = vi.fn(async (_agent: unknown, packet: { key: string }) => {
    events.push({ type: 'hivemind/room-message-delivered', seq: 9, data: { id: id(packet.key) } })
    return {}
  })
  const scope = {
    effect: (f: () => unknown) => f(),
    on: (name: string, f: (...args: unknown[]) => unknown) => { callbacks.set(name, f); return () => {} },
    tools: { register: vi.fn() }, sessionController: { deliverAgentMessage },
    hivemindEmployeeDirectory: { profiles: async () => ({ profiles: [{ id: 'employee' }] }) },
  }
  installAgentMessaging({ inject: (_names: unknown, callback: (scope: unknown) => unknown) => callback(scope) } as unknown as Context)
  const agent = { id: 'employee-room', session: { header: { agentPreset: 'hivemind-hyperagents' }, snapshotEvents: () => events } }
  await callbacks.get('agent/pre-step')!({ agent, signal: new AbortController().signal }, async () => {})
  expect(deliverAgentMessage).not.toHaveBeenCalled()
  events.push({ type: 'turn/end', seq: 7, time: 7, data: { turn: 1, reason: { kind: 'completed' } } })
  await callbacks.get('agent/turn-ended')!({ agent })
  await callbacks.get('agent/turn-ended')!({ agent })
  expect(deliverAgentMessage).toHaveBeenCalledTimes(manual ? 0 : 1)
  if (!manual) expect(deliverAgentMessage.mock.calls[0]?.[1]).toMatchObject({ artifactIds: ['saved'] })
})

it.each([['completed', false], ['error', false], ['completed', true], ['error', true]])('reports terminal turns only for durable Chief requests (%s, %s)', async (kind, chief) => {
  const events = [
    { type: 'hivemind/session-owner', seq: 0, data: { id: 'employee', name: 'Sofia', slug: 'sofia' } },
    { type: 'user/message', seq: 1, data: { source: { kind: 'schedule' }, content: [{ type: 'text', text: 'HQ_EMPLOYEE_ASSIGNMENT={"taskId":"old-task"}' }] } },
    { type: 'turn/end', seq: 2, data: { turn: 0, reason: { kind: 'completed' } } },
    ...(chief ? [{ type: 'hivemind/room-message-received', seq: 3, data: { id: 'chief-question', senderEmployee: 'runtime', kind: 'question' } }] : []),
    ...(!chief ? [{ type: 'turn/start', seq: 5, time: 5, data: { turn: 1 } }] : []),
    { type: 'user/message', seq: chief ? 4 : 6, time: 6, data: { source: chief ? { kind: 'hivemind-agent-message', messageId: 'chief-question' } : { kind: 'user' }, content: [{ type: 'text', text: chief ? JSON.stringify({ text: 'What is your view?' }) : 'hello' }] } },
    ...(chief ? [{ type: 'turn/start', seq: 5, time: 5, data: { turn: 1 } }] : []),
    { type: 'user/message', seq: 7, data: { source: { kind: 'plugin', plugin: 'time-context' }, content: [{ type: 'text', text: 'clock context' }] } },
    { type: 'assistant/message', seq: 8, data: { turn: 1, interrupted: false, message: { content: [{ type: 'text', text: 'Hello!' }] } } },
    { type: 'turn/end', seq: 9, time: 9, data: { turn: 1, reason: kind === 'error' ? { kind, error: { code: 'SERVER' } } : { kind } } },
  ]
  const callbacks = new Map<string, (...args: unknown[]) => unknown>()
  const deliverAgentMessage = vi.fn()
  const scope = {
    effect: (f: () => unknown) => f(),
    on: (name: string, f: (...args: unknown[]) => unknown) => { callbacks.set(name, f); return () => {} },
    tools: { register: vi.fn() }, sessionController: { deliverAgentMessage },
    hivemindEmployeeDirectory: { profiles: async () => ({ profiles: [{ id: 'employee' }] }) },
  }
  installAgentMessaging({ inject: (_names: unknown, callback: (scope: unknown) => unknown) => callback(scope) } as unknown as Context)
  const agent = { id: 'employee-room', session: { header: { agentPreset: 'hivemind-hyperagents' }, snapshotEvents: () => events } }
  await callbacks.get('agent/turn-ended')!({ agent })
  if (!chief) await callbacks.get('agent/pre-step')!({ agent, signal: new AbortController().signal }, async () => {})
  expect(deliverAgentMessage).toHaveBeenCalledTimes(chief ? 1 : 0)
})

it('admits explicit Runtime updates to employees as response requests without changing other directions or receipts', () => {
  expect(explicitEmployeeMessageKind('hivemind-hq', true, 'update')).toBe('question')
  expect(explicitEmployeeMessageKind('hivemind-hq', true, 'update', 'question')).toBe('question')
  expect(explicitEmployeeMessageKind('hivemind-hq', true, 'update', 'update')).toBe('update')
  expect(explicitEmployeeMessageKind('hivemind-hyperagents', true, 'update')).toBe('update')
  expect(explicitEmployeeMessageKind('hivemind-hyperagents', false, 'update')).toBe('update')
  expect(explicitEmployeeMessageKind('hivemind-hq', true, 'reply')).toBe('reply')
  expect(explicitEmployeeMessageKind('hivemind-hq', true, 'update', undefined, false)).toBe('update')
  expect(explicitEmployeeMessageKind('hivemind-hq', true, 'update', 'question', false)).toBe('question')
})


it('normalizes a registered Chief update before delivery and rejects a paused recipient', async () => {
  const deliverAgentMessage = vi.fn(async () => ({ ok: true }))
  const profile = { id: 'employee', slug: 'sofia', name: 'Sofia', status: 'active' }
  const register = vi.fn()
  const scope = {
    effect: (effect: () => unknown) => effect(), on: vi.fn(() => () => {}),
    tools: { register }, sessionController: { deliverAgentMessage },
    hivemindEmployeeDirectory: { profiles: async () => ({ profiles: [profile] }) },
  }
  installAgentMessaging({ inject: (_names: unknown, callback: (value: unknown) => void) => callback(scope) } as unknown as Context)
  const tool = register.mock.calls[0]![0] as { execute: (args: unknown, execution: unknown) => Promise<unknown> }
  const agent = { id: 'chief', session: { header: { agentPreset: 'hivemind-hq' },
    snapshotEvents: () => [], ownEvents: () => [] } }
  const args = { recipient: 'sofia', kind: 'update', message_key: 'correction', message: 'Please revise the saved brief.\nRetain the exact sources and fix the unresolved conclusion.', summary: 'Please revise the brief.' }
  const execution = { agent, signal: new AbortController().signal }
  await tool.execute(args, execution)
  expect(deliverAgentMessage).toHaveBeenCalledExactlyOnceWith(agent,
    expect.objectContaining({ kind: 'question', target: 'employee', key: 'correction', text: args.message, summary: args.summary }), execution.signal)
  await tool.execute({ ...args, recipient: 'Sofia' }, execution)
  expect(deliverAgentMessage).toHaveBeenLastCalledWith(agent, expect.objectContaining({ target: 'employee' }), execution.signal)
  await expect(tool.execute({ ...args, recipient: 'Other-company Sofia' }, execution)).rejects.toThrow('Read hivemind_hq_contract action list')
  expect(deliverAgentMessage).toHaveBeenCalledTimes(2)
  await tool.execute({ ...args, message_key: 'greeting', message: 'Hi, I am Runtime.', summary: 'Hi, everyone!',
    request_reply: false }, execution)
  expect(deliverAgentMessage).toHaveBeenLastCalledWith(agent,
    expect.objectContaining({ kind: 'update', text: 'Hi, I am Runtime.', summary: 'Hi, everyone!' }), execution.signal)
  profile.status = 'paused'
  await expect(tool.execute({ ...args, recipient: 'Sofia' }, execution)).rejects.toThrow('agent_message_recipient_unavailable')
  expect(deliverAgentMessage).toHaveBeenCalledTimes(3)
})

it('uses the current sender preset directory rather than a sibling realm registry', () => {
  const sender = {} as Agent
  const current = { profiles: vi.fn() }
  const stale = { profiles: vi.fn() }
  const serviceFor = vi.fn(() => current)
  const ctx = { get: () => ({ serviceFor }), hivemindEmployeeDirectory: stale } as unknown as Context
  expect(messageDirectory(ctx, sender)).toBe(current)
  expect(serviceFor).toHaveBeenCalledWith(sender, 'hivemindEmployeeDirectory')
})


describe('company packet recovery independent of native Team retries', () => {
  function recoveryFixture() {
    const packet = { id: 'saved', senderId: 'chief', targetId: 'employee-room', kind: 'question', text: 'Prepare the saved brief.',
      artifactIds: [], delivery: { key: 'same-key', target: 'employee' } }
    const events = [{ type: 'hivemind/room-message-queued', data: packet }] as { type: string; data: unknown }[]
    const profiles = [{ id: 'employee', name: 'Ravi', status: 'active' }]
    const rooms = { deliverAgentMessage: vi.fn(async (_agent: Agent, _input: Record<string, unknown>, _signal: AbortSignal) => {
      events.push({ type: 'hivemind/room-message-delivered', data: { id: 'saved' } }); return {}
    }) }
    const ctx = { hivemindEmployeeDirectory: { profiles: vi.fn(async () => ({ profiles })) },
      logger: { warn: vi.fn() } } as unknown as Context
    const agent = { id: 'chief', session: { header: { agentPreset: 'hivemind-hq' }, snapshotEvents: () => events } } as unknown as Agent
    return { packet, events, profiles, rooms, ctx, agent }
  }
  it('replays a saved failed packet with its exact key and payload, then stops after confirmation', async () => {
    const f = recoveryFixture(), signal = new AbortController().signal
    await reconcileRoomMessages(f.ctx, f.rooms, f.agent, signal)
    await reconcileRoomMessages(f.ctx, f.rooms, f.agent, signal)
    expect(f.rooms.deliverAgentMessage).toHaveBeenCalledTimes(1)
    expect(f.rooms.deliverAgentMessage.mock.calls[0]?.[1]).toMatchObject({ key: 'same-key', target: 'employee', text: f.packet.text })
  })
  it('recovers legacy packets only when an actual saved tool call supplies the matching stable key', async () => {
    const { createHash } = await import('node:crypto')
    const f = recoveryFixture()
    f.packet.id = `agent-message-${createHash('sha256').update(JSON.stringify(['chief', 'same-key'])).digest('hex')}`
    Reflect.deleteProperty(f.packet, 'delivery')
    await reconcileRoomMessages(f.ctx, f.rooms, f.agent, new AbortController().signal)
    expect(f.rooms.deliverAgentMessage).not.toHaveBeenCalled()
    f.events.push({ type: 'tool/call', data: { name: 'hivemind_agent_message',
      arguments: JSON.stringify({ message_key: 'same-key', recipient: 'employee' }) } })
    await reconcileRoomMessages(f.ctx, f.rooms, f.agent, new AbortController().signal)
    expect(f.rooms.deliverAgentMessage).toHaveBeenCalledTimes(1)
  })
  it.each(['missing', 'paused', 'archived'])('does not retry a recipient whose current authorization is %s', async (status) => {
    const f = recoveryFixture()
    if (status === 'missing') f.profiles.length = 0
    else f.profiles[0]!.status = status
    await reconcileRoomMessages(f.ctx, f.rooms, f.agent, new AbortController().signal)
    expect(f.rooms.deliverAgentMessage).not.toHaveBeenCalled()
  })
  it.each(['completed', 'deleted', 'reassigned'])('does not replay work which is now %s', async (status) => {
    const f = recoveryFixture()
    Object.assign(f.packet, { taskId: 'task-1' })
    f.events.push({ type: 'team/task', data: { task: { id: 'task-1', status } } })
    if (status === 'reassigned') f.events.push({ type: 'hivemind/hq-employee-assignment', data: { taskId: 'task-1', sessionId: 'another-room' } })
    await reconcileRoomMessages(f.ctx, f.rooms, f.agent, new AbortController().signal)
    expect(f.rooms.deliverAgentMessage).not.toHaveBeenCalled()
  })
  it('bounds recovery and preserves failed packets for the next admitted turn without creating replies', async () => {
    const f = recoveryFixture()
    f.events.splice(0, 1, ...Array.from({ length: 20 }, (_, i) => ({ type: 'hivemind/room-message-queued', data: { ...f.packet, id: `saved-${i}` } })))
    f.rooms.deliverAgentMessage.mockRejectedValue(new Error('temporarily unavailable'))
    await reconcileRoomMessages(f.ctx, f.rooms, f.agent, new AbortController().signal)
    expect(f.rooms.deliverAgentMessage).toHaveBeenCalledTimes(8)
    expect(f.events).toHaveLength(20)
  })
})
