import { describe, expect, it, vi } from 'vitest'
import { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { Context } from '@deepseek-ai/cordis'
import { SessionSeq, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { installServiceRecovery, serviceInterrupted, delegatedConnectionReplayHeld } from '../src/service-recovery.ts'
function saved(reason: unknown = { kind: 'interrupted' }): SessionEvent[] {
  return [{ type: 'turn/start', seq: SessionSeq(1), time: 0, data: { turn: 4 } },
    { type: 'turn/end', seq: SessionSeq(2), time: 0, data: { turn: 4, reason } }] as SessionEvent[]
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
    expect(serviceInterrupted([...saved(), { type: 'turn/start', seq: SessionSeq(3), time: 0, data: { turn: 5 } }], 4)).toBe(false)
    expect(serviceInterrupted([...saved(), { type: 'hivemind/hq-rest-confirmed', seq: SessionSeq(3), time: 0, data: {} } as SessionEvent], 4)).toBe(false)
  })
  it('holds unanswered plan-review questions, including crash-repaired unknown results', () => {
    const question = { type: 'tool/call', seq: SessionSeq(3), time: 0,
      data: { turn: 4, step: 1, callId: 'question', name: 'ask_user_question', arguments: '{}' } } as SessionEvent
    const result = (isError: boolean) => ({ type: 'tool/result', seq: SessionSeq(4), time: 0,
      data: { turn: 4, step: 1, message: createToolResultMessage({ callId: ToolCallId('question'), isError, content: [] }) } } as SessionEvent)
    expect(serviceInterrupted([...saved(), question], 4)).toBe(false)
    expect(serviceInterrupted([...saved(), question, result(true)], 4)).toBe(false)
    expect(serviceInterrupted([...saved(), question, result(false)], 4)).toBe(true)
  })
  it('holds pending or cancelled human approval, preserving a granted approval', () => {
    const asked = { type: 'approval/asked', seq: SessionSeq(3), time: 0, data: { id: 'approval' } } as SessionEvent
    const decided = (outcome: string) => ({ type: 'approval/decided', seq: SessionSeq(4), time: 0, data: { id: 'approval', outcome } } as SessionEvent)
    expect(serviceInterrupted([...saved(), asked], 4)).toBe(false)
    expect(serviceInterrupted([...saved(), asked, decided('cancelled')], 4)).toBe(false)
    expect(serviceInterrupted([...saved(), asked, decided('allowed-once')], 4)).toBe(true)
  })
})
function harness() {
  let events = [{ type: 'hivemind/hq-mode', seq: SessionSeq(0), time: 0, data: { revision: 1, enabled: true, changedAt: 0 } },
    ...saved()] as SessionEvent[]
  const agent = { id: 'root', status: 'idle', inbox: { nextStep: [], nextTurn: [] },
    session: { id: 'root', header: { agentPreset: 'hivemind-chat' },
      ownEvents: () => events, snapshotEvents: () => events } }
  events.unshift({ type: 'agent-preset/selected', seq: SessionSeq(0), time: 0, data: { agentPreset: 'hivemind-hq' } } as SessionEvent)
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
    agents: { get: () => agent }, sessions: { flush: async () => true }, agentTeams: { tryMembership: () => ({ root: agent }) },
    sessionPersistence: { open: async () => ({ read, close: async () => {} }) },
    sessionController: { resolveAgent: async () => ({ agent }) }, logger: { warn: vi.fn() } } as unknown as Context
  installServiceRecovery(ctx)
  const arm = () => hooks.get('agent/pre-step')!({ agent, turn: 4 }, async () => ({ kind: 'enter', messages: [] }))
  return { ctx, agent, ensure, remove, read, hooks, arm, guard: () => guard!(agent, record),
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
  h.setEvents([...h.events(), { type: 'hivemind/hq-mode', seq: SessionSeq(3), time: 0, data: { revision: 2, enabled: false, changedAt: 0 } }])
  expect(await h.guard()).toBe(false)
  h.setEvents([...h.events(), { type: 'hivemind/hq-mode', seq: SessionSeq(4), time: 0, data: { revision: 3, enabled: true, changedAt: 0 } }])
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
  h.setEvents([...h.events(), { seq: SessionSeq(3), time: 0, type: 'agent/inbox/spliced', data: {
    inserted: [{ source: { kind: 'schedule', deliveryKey } }],
  } } as SessionEvent])
  expect(await h.guard()).toBe(true)
  expect(h.ensure).toHaveBeenCalledOnce()
  expect(h.read).not.toHaveBeenCalled()
})

function directHarness() {
  const h = harness()
  h.agent.session.header.agentPreset = 'hivemind-hyperagents'
  vi.spyOn(h.ctx.agentTeams, 'tryMembership').mockReturnValue(undefined)
  const room = vi.fn(async () => h.agent.id)
  Object.assign(h.ctx.sessionPersistence, { employeeRoomId: room })
  const events = [
    { type: 'hivemind/session-owner', seq: SessionSeq(0), time: 0, data: { id: 'employee', slug: 'employee', name: 'Employee', role: 'Analyst' } },
    { type: 'turn/start', seq: SessionSeq(1), time: 0, data: { turn: 4 } },
    { type: 'user/message', seq: SessionSeq(2), time: 0, data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Review this document.' }] }) },
    { type: 'turn/end', seq: SessionSeq(3), time: 0, data: { turn: 4, reason: { kind: 'interrupted' } } },
  ] as SessionEvent[]
  h.setEvents(events)
  return { ...h, room, directEvents: events }
}
it('recovers an exact human request in the canonical pinned employee room without inventing HQ autonomy', async () => {
  const h = directHarness()
  await h.arm(); await h.arm()
  expect(h.ensure).toHaveBeenCalledOnce()
  expect(h.record().record.prompt).toContain('"employeeId":"employee"')
  expect(h.record().record.prompt).not.toContain('modeRevision')
  expect(await h.guard()).toBe(true)
  expect(h.room).toHaveBeenCalledWith('employee')
})
it('rejects a direct employee recovery after canonical identity or human request changes', async () => {
  const h = directHarness()
  await h.arm()
  h.room.mockResolvedValue('another-room')
  expect(await h.guard()).toBe(false)
  h.room.mockResolvedValue(h.agent.id)
  h.setEvents([...h.directEvents, { type: 'user/message', seq: SessionSeq(4), time: 0, surfaceOp: 'append', data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Stop working.' }] }) }])
  expect(await h.guard()).toBe(false)
})
it('does not arm direct employee work without a pinned canonical owner or a human request', async () => {
  const h = directHarness()
  h.room.mockResolvedValue('another-room')
  await h.arm()
  expect(h.ensure).not.toHaveBeenCalled()
  h.room.mockResolvedValue(h.agent.id)
  h.setEvents(h.directEvents.filter(event => event.type !== 'user/message'))
  await h.arm()
  expect(h.ensure).not.toHaveBeenCalled()
})
it('does not recover direct employee work after explicit Stop or paused room mode', async () => {
  const h = directHarness()
  await h.arm()
  h.setEvents([...h.directEvents, { type: 'hivemind/hq-mode', seq: SessionSeq(4), time: 0, data: { revision: 2, enabled: false, changedAt: 0 } }])
  expect(await h.guard()).toBe(false)
  h.setEvents(h.directEvents.map(event => event.type === 'turn/end' ? { ...event, data: { turn: 4, reason: { kind: 'aborted', reason: { kind: 'user' } } } } : event))
  expect(await h.guard()).toBe(false)
})

it('recovers only an exact actionable Chief request with the same enabled authority revision', async () => {
  const h = directHarness()
  const chiefEvents = [{ type: 'hivemind/hq-mode', seq: SessionSeq(0), time: 0,
    data: { enabled: true, revision: 1, changedAt: 0 } }] as SessionEvent[]
  const chief = { id: 'chief', session: { header: { agentPreset: 'hivemind-hq' },
    ownEvents: () => chiefEvents, snapshotEvents: () => chiefEvents } }
  vi.spyOn(h.ctx.sessionController, 'resolveAgent').mockResolvedValue({ agent: chief } as never)
  vi.mocked(h.ctx.agentTeams.tryMembership).mockReturnValue({ root: chief } as never)
  const receipt = { type: 'hivemind/room-message-received', seq: SessionSeq(0), time: 0,
    data: { id: 'chief-correction', senderId: 'chief', senderEmployee: 'runtime', kind: 'question' } } as SessionEvent
  const request = { type: 'user/message', seq: SessionSeq(2), time: 0,
    data: createUserMessage({ source: { kind: 'hivemind-agent-message', messageId: 'chief-correction',
      senderId: 'chief', senderSessionId: 'chief' } as never,
    content: [{ type: 'text', text: 'Please correct the current saved brief.' }] }) } as unknown as SessionEvent
  h.setEvents([h.directEvents[0]!, h.directEvents[1]!, request, h.directEvents[3]!])
  await h.arm()
  expect(h.ensure).not.toHaveBeenCalled()
  h.setEvents([h.directEvents[0]!, receipt, h.directEvents[1]!, request, h.directEvents[3]!])
  h.agent.status = 'running'
  h.hooks.get('session/event')!(h.agent.session, receipt)
  await expect.poll(() => h.ensure.mock.calls.length).toBe(1)
  h.agent.status = 'idle'
  expect(h.ensure).toHaveBeenCalledOnce()
  expect(h.record().record.prompt).toContain('"rootId":"chief"')
  expect(h.record().record.prompt).toContain('"modeRevision":1')
  expect(await h.guard()).toBe(true)
  chiefEvents.push({ type: 'hivemind/hq-mode', seq: SessionSeq(1), time: 0,
    data: { enabled: false, revision: 2, changedAt: 1 } })
  expect(await h.guard()).toBe(false)
})

it('never arms quiet Chief scheduling updates as direct requests', async () => {
  const h = directHarness()
  h.setEvents([h.directEvents[0]!, { type: 'hivemind/room-message-received', seq: SessionSeq(0), time: 0,
    data: { id: 'notice', senderId: 'chief', senderEmployee: 'runtime', kind: 'update' } } as SessionEvent,
  h.directEvents[1]!, { type: 'user/message', seq: SessionSeq(2), time: 0,
    data: createUserMessage({ source: { kind: 'hivemind-agent-message', messageId: 'notice',
      senderId: 'chief', senderSessionId: 'chief' } as never,
    content: [{ type: 'text', text: 'Future assignment saved.' }] }) } as unknown as SessionEvent,
  h.directEvents[3]!])
  await h.arm()
  expect(h.ensure).not.toHaveBeenCalled()
})

function delegatedPending(): SessionEvent[] {
  return [
    { seq:SessionSeq(1),type:'turn/start',time:0,data:{ turn:4 } },
    { seq:SessionSeq(2),type:'user/message',time:0,data:createUserMessage({ source:{ kind:'hivemind-agent-message',messageId:'assignment',senderId:SessionId('chief'),senderSessionId:SessionId('chief') },content:[{ type:'text',text:JSON.stringify({ text:'HQ_EMPLOYEE_ASSIGNMENT={"rootId":"chief","taskId":"task-16"}' }) }] }) },
    { seq:SessionSeq(2),type:'hivemind/composio-session',time:0,data:{ routerSessionId:'router',subject:'hivemind:user',userKey:'user' } },
    { seq:SessionSeq(3),type:'tool/call',time:0,data:{ turn:4,step:1,callId:ToolCallId('pending-connection'),name:'hivemind_connected_task',arguments:'{"session":{"id":"upon"}}' } },
    { seq:SessionSeq(4),type:'turn/end',time:0,data:{ turn:4,reason:{ kind:'aborted',reason:{ kind:'user' } } } },
  ] as SessionEvent[]
}
it('holds only exact-turn unsettled delegated provider work before legacy migration',()=>{
  const pending=delegatedPending()
  expect(delegatedConnectionReplayHeld(pending,4)).toBe(true)
  expect(serviceInterrupted(pending,4)).toBe(false)
  expect(delegatedConnectionReplayHeld(pending,5)).toBe(false)
  const failed=pending.map(event=>event.type==='turn/end'?{ ...event,data:{ turn:4,reason:{ kind:'interrupted' } } }:event) as SessionEvent[]
  expect(delegatedConnectionReplayHeld(failed,4)).toBe(false)
  expect(serviceInterrupted(failed,4)).toBe(true)
  const direct=pending.map(event=>event.type==='user/message'?{ ...event,data:createUserMessage({ source:{ kind:'user' },content:[] }) }:event) as SessionEvent[]
  expect(delegatedConnectionReplayHeld(direct,4)).toBe(false)
  expect(serviceInterrupted(direct,4)).toBe(false)
  const result={ seq:SessionSeq(5),type:'tool/result',time:0,data:{ turn:4,step:1,message:createToolResultMessage({ callId:ToolCallId('pending-connection'),isError:false,content:[] }) } } as SessionEvent
  expect(delegatedConnectionReplayHeld([...pending,result],4)).toBe(false)
  const held={ seq:SessionSeq(6),type:'hivemind/hq-blocker-recovery-hold',time:0,data:{ turn:4,callId:'pending-connection',rootId:'chief',taskId:'task-16',checkpointId:'checkpoint' } } as SessionEvent
  expect(delegatedConnectionReplayHeld([...pending,result,held],4)).toBe(true)
})
it('rejects previously queued original recovery at model admission while retaining direct human input',async()=>{
  const h=harness();h.setEvents([...delegatedPending(),{ seq:SessionSeq(5),type:'turn/start',time:0,data:{ turn:5 } }] as SessionEvent[])
  const recovery=createUserMessage({ source:{ kind:'schedule' },content:[{ type:'text',text:'reminder_prompt_json: '+JSON.stringify('[HIVEMIND SERVICE RECOVERY]\n'+JSON.stringify({ sessionId:'root',turn:4,rootId:'chief',modeRevision:1 })) }] })
  const hook=h.hooks.get('agent/pre-step')!
  expect(await hook({ agent:h.agent,turn:5 },async()=>({ kind:'accept',messages:[recovery] }))).toEqual({ kind:'reject' })
  const human=createUserMessage({ source:{ kind:'user' },content:[{ type:'text',text:'New direct question' }] })
  const decision=await hook({ agent:h.agent,turn:5 },async()=>({ kind:'accept',messages:[recovery,human] }))
  expect(decision).toEqual({ kind:'accept',messages:[human] })
})
