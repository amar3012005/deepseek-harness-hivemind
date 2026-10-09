import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createBrowserTimeZoneConfirmation } from '@deepseek-ai/dsh-time-context'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { HqControl } from '../src/control.ts'
import { installRest, recoverRest, restState, restScheduleId, restBriefing, acknowledgeRestNotes, leaveRestNote, restWakeDisplay, greetingOnly } from '../src/rest.ts'

const request = { handoff_id: 'rest-test', wake_at: '2030-01-01T01:00:00Z', summary: 'Review the existing task', next_steps: ['Inspect current receipts'], blockers: ['Waiting for evidence'] }
function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
  let events: SessionEvent[] = [], durable: SessionEvent[] = []
  const schedules = new Map<string, {
    id: string
    sessionId: string
    prompt: string
    title: string
    kind: string
    status: string
    scheduledAt: string
  }>()
  const tools = new Map<string, ToolDefinition>()
  const hooks = new Map<string, (input: unknown) => unknown>()
  let agent: Agent
  const prompt = vi.fn()
  const makeAgent = () => ({ id: 'root', session: { header: { agentPreset: 'hivemind-hq' }, snapshotEvents: () => events,
    ownEvents: () => events, append: (type: string, data: unknown) => {
      events.push({ seq: events.length, time: Date.now(), type, data } as SessionEvent)
    } }, prompt, steer: vi.fn() }) as unknown as Agent
  agent = makeAgent()
  const flush = vi.fn(async () => { durable = structuredClone(events); return true })
  type WakeInput = { at?: string; after_seconds?: number; prompt: string; title: string }
  const ensure = vi.fn(async (sessionId: string, key: string, input: WakeInput) => {
    if (input.at && Date.parse(input.at) <= Date.now()) throw new Error('past_schedule_validation')
    const id = restScheduleId(sessionId, key.replace('hq-rest-', ''))
    const schedule = { id, sessionId, prompt: input.prompt, title: input.title, kind: 'at', status: 'active', scheduledAt: input.at ?? new Date(Date.now() + (input.after_seconds ?? 1) * 1000).toISOString() }
    schedules.set(id, schedule); return schedule
  })
  const remove = vi.fn(async ({ id }: { id: string }) => ({ id, deleted: schedules.delete(id) }))
  const ctx = { effect: (callback: () => unknown) => callback(),
    on: (name: string, handler: (input: unknown) => unknown) => { hooks.set(name, handler); return () => {} },
    tools: { register: (tool: ToolDefinition) => { tools.set(tool.name, tool); return () => {} } },
    agentTeams: { membership: (subject: Agent) => ({ role: 'lead', root: subject }) },
    sessions: { flush }, schedule: { catalog: async () => [...schedules.values()], ensure, delete: remove },
    hivemindHq: { restState: (subject: Agent) => restState(ctx, subject), workspace: async () => ({ tasks: [{ id: 'task-3', revision: 2, status: 'in_progress', owner: 'Ravi', artifactIds: ['saved-report'], reviewStatus: 'uncertain' }] }), mode: () => ({ enabled: false }) },
  } as unknown as Context
  installRest(ctx)
  const execute = (args = request) => tools.get('hivemind_hq_rest')!.execute(args, { agent, signal: new AbortController().signal } as never)
  return { ctx, tools, hooks, get agent() { return agent }, get events() { return events },
    schedules, ensure, remove, flush, execute, prompt,
    crash: () => { events = structuredClone(durable); agent = makeAgent(); return agent } }
}
afterEach(() => vi.useRealTimers())
describe('native Runtime voluntary rest', () => {
  it('ends a greeting without forcing sleep tools but retains the check for work', async () => {
    const f = fixture()
    f.ctx.hivemindHq.mode = () => ({ enabled: true }) as never
    f.agent.session.append('turn/start', { turn: 1 } as never)
    const human = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] })
    f.agent.session.append('user/message', human, { surfaceOp: 'none' } as never)
    await f.hooks.get('agent/turn-stopping')!({ agent: f.agent, turn: 1, signal: new AbortController().signal })
    expect(f.agent.steer).not.toHaveBeenCalled()
    f.agent.session.append('tool/call', { name: 'runtime_user_agenda', callId: 'save', arguments: {}, turn: 1, step: 1 } as never)
    await f.hooks.get('agent/turn-stopping')!({ agent: f.agent, turn: 1, signal: new AbortController().signal })
    expect(f.agent.steer).toHaveBeenCalledOnce()
  })
  it('classifies only social exchanges, never work or mixed event delivery', () => {
    const human = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
    const passive = createUserMessage({ source: { kind: 'plugin', plugin: 'time-context' }, content: [{ type: 'text', text: 'Current time' }] })
    const signal = createUserMessage({ source: { kind: 'plugin', plugin: 'runtime-attention' }, content: [{ type: 'text', text: 'New company evidence' }] })
    expect(greetingOnly([human('hi'), passive])).toBe(true)
    expect(greetingOnly([human('hii'), passive])).toBe(true)
    expect(greetingOnly([human('hello!')])).toBe(true)
    expect(greetingOnly([human('hi, fix the CRM')])).toBe(false)
    expect(greetingOnly([human('Wakeup ! chief')])).toBe(false)
    expect(greetingOnly([human('hi'), signal])).toBe(false)
    expect(greetingOnly([signal])).toBe(false)
    expect(greetingOnly([])).toBe(false)
  })
  it('accepts exactly four hours but rejects longer sleeps before saving any intent', async () => {
    const f = fixture()
    await expect(f.execute({ ...request, wake_at: '2030-01-01T04:00:00.001Z' })).rejects.toThrow('hq_rest_wake_exceeds_four_hours')
    expect(f.events).toHaveLength(0)
    expect(f.ensure).not.toHaveBeenCalled()
    await expect(f.execute({ ...request, wake_at: '2030-01-01T04:00:00Z' })).resolves.toMatchObject({ status: 'rest_ready' })
  })

  it('guides a current relevant invitation before handoff without creating a new request registry', () => {
    const f = fixture()
    const schema = JSON.stringify(f.tools.get('hivemind_hq_rest')!.parameters)
    expect(schema).toContain('current final sleep turn before saving this handoff')
    expect(schema).toContain('Omit the invitation once evidence resolves the need')
    expect(restBriefing(f.agent, []).text).toContain('A direct human wake is not silent scheduled maintenance')
    expect(restBriefing(f.agent, []).text).toContain('including when reusing the saved handoff or rest state')
    expect(f.events).toHaveLength(0)
    expect(f.ensure).not.toHaveBeenCalled()
  })
  it('supersedes only its own active rest timers and preserves inactive and unrelated schedules', async () => {
    const f = fixture()
    await f.execute()
    const old = f.schedules.get(restScheduleId('root', request.handoff_id))!
    const delivered = { ...old, id: 'delivered', status: 'inactive' }
    const employee = { ...old, id: 'employee-assignment', sessionId: 'employee-room' }
    const user = { ...old, id: 'user-reminder', title: 'Runtime rest: custom' }
    f.schedules.set(delivered.id, delivered)
    f.schedules.set(employee.id, employee)
    f.schedules.set(user.id, user)
    await f.execute({ ...request, handoff_id: 'next-rest' })
    expect(f.schedules.has(old.id)).toBe(false)
    expect(f.schedules.has(delivered.id)).toBe(true)
    expect(f.schedules.has(employee.id)).toBe(true)
    expect(f.schedules.has(user.id)).toBe(true)
  })
  it('retains the earlier wake on failed replacement and reconciles interrupted cleanup', async () => {
    const f = fixture()
    await f.execute()
    const oldId = restScheduleId('root', request.handoff_id)
    f.ensure.mockRejectedValueOnce(new Error('replacement failed'))
    await expect(f.execute({ ...request, handoff_id: 'next-rest' })).rejects.toThrow('replacement failed')
    expect(f.schedules.has(oldId)).toBe(true)
    f.remove.mockRejectedValueOnce(new Error('cleanup interrupted'))
    await expect(recoverRest(f.ctx, f.agent)).rejects.toThrow('cleanup interrupted')
    expect(f.schedules.has(oldId)).toBe(true)
    await recoverRest(f.ctx, f.agent)
    expect(f.schedules.has(oldId)).toBe(false)
    expect(f.schedules.size).toBe(1)
  })
  it('disarms native goal rounds only after a future wake and handoff are confirmed', async () => {
    const f = fixture()
    const disarm = vi.fn(() => {
      expect(f.events.at(-1)?.type).toBe('hivemind/hq-rest-confirmed')
      expect(f.schedules.size).toBe(1)
    })
    Object.assign(f.ctx, { get: (name: string) => name === 'goals' ? { disarm } : undefined })
    await f.execute()
    expect(disarm).toHaveBeenCalledExactlyOnceWith(f.agent)
    const failed = fixture()
    const blockedDisarm = vi.fn()
    Object.assign(failed.ctx, { get: () => ({ disarm: blockedDisarm }) })
    failed.ensure.mockRejectedValueOnce(new Error('schedule unavailable'))
    await expect(failed.execute()).rejects.toThrow('schedule unavailable')
    expect(blockedDisarm).not.toHaveBeenCalled()
  })
  it('confirms a reused handoff in the current turn without duplicating its wake', async () => {
    const f = fixture()
    await f.execute()
    f.agent.session.append('turn/start', { turn: 2 } as never)
    const start = f.events.at(-1)!.seq
    await f.execute()
    expect(f.events.findLast(event => event.type === 'hivemind/hq-rest-confirmed')?.seq).toBeGreaterThan(start)
    expect(f.events.filter(event => event.type === 'hivemind/hq-rest-intent')).toHaveLength(1)
    expect(f.ensure).toHaveBeenCalledTimes(1)
  })

  it('checkpoints an exact host snapshot and one wake, replays after original time passes', async () => {
    const f = fixture()
    expect(await f.execute()).toMatchObject({ status: 'rest_ready', autonomyPaused: true })
    const intent = f.events.find(event => event.type === 'hivemind/hq-rest-intent')
    expect(intent?.data).toMatchObject({ tasks: [{ id: 'task-3', status: 'in_progress', artifactIds: ['saved-report'], reviewStatus: 'uncertain' }] })
    vi.setSystemTime(new Date('2030-01-01T02:00:00Z'))
    f.schedules.forEach((wake) => { wake.status = 'inactive' })
    expect(await f.execute()).toMatchObject({ status: 'wake_committed_inactive', wakeStatus: 'inactive' })
    expect(f.ensure).toHaveBeenCalledTimes(1)
    expect(f.events.filter(event => event.type === 'hivemind/hq-rest-intent')).toHaveLength(1)
    expect(f.events.filter(event => event.type === 'hivemind/hq-rest-wake')).toHaveLength(1)
    await expect(f.execute({ ...request, summary: 'Changed plan' })).rejects.toThrow('hq_rest_identity_conflict')
    await expect(f.execute({ ...request, summary: 'Changed plan' })).rejects.toThrow('call hivemind_hq_rest_state to inspect the current rest state')
    await expect(f.execute({ ...request, summary: 'Changed plan' })).rejects.toThrow('use a new handoff_id')
    expect(f.events.filter(event => event.type === 'hivemind/hq-rest-intent')).toHaveLength(1)
  })
  it('repairs a saved intent after crash and overdue time, preserving original requested instant', async () => {
    const f = fixture()
    f.ensure.mockRejectedValueOnce(new Error('provider unavailable'))
    await expect(f.execute()).rejects.toThrow('provider unavailable')
    f.crash(); vi.setSystemTime(new Date('2030-01-01T02:00:00Z'))
    await recoverRest(f.ctx, f.agent)
    expect((await restState(f.ctx, f.agent)).latest).toMatchObject({ requestedWakeAt: '2030-01-01T01:00:00.000Z', effectiveWakeAt: '2030-01-01T02:00:01.000Z', ready: true })
  })
  it('repairs missing binding after wake succeeded but its checkpoint failed, without rescheduling', async () => {
    const f = fixture()
    const persist = f.flush.getMockImplementation()!
    f.flush.mockImplementationOnce(persist).mockResolvedValueOnce(false)
    await expect(f.execute()).rejects.toThrow('hq_rest_persistence_required')
    f.crash()
    vi.setSystemTime(new Date('2030-01-01T02:00:00Z'))
    await recoverRest(f.ctx, f.agent)
    expect(f.ensure).toHaveBeenCalledTimes(1)
    expect(f.events.filter(event => event.type === 'hivemind/hq-rest-wake')).toHaveLength(1)
  })
  it('never recreates an explicitly missing committed wake, or accepts a first past deadline', async () => {
    const f = fixture()
    await f.execute(); f.schedules.clear()
    await expect(f.execute()).rejects.toThrow('hq_rest_committed_wake_missing')
    expect(f.ensure).toHaveBeenCalledTimes(1)
    await expect(f.execute({ ...request, handoff_id: 'new-past', wake_at: '2029-12-31T23:00:00Z' })).rejects.toThrow('hq_rest_new_wake_must_be_future')
  })
  it('allows recovery after deletion without resurrecting the timer and permits a new handoff', async () => {
    const f = fixture()
    await f.execute(); f.schedules.clear()
    await expect(recoverRest(f.ctx, f.agent)).resolves.toBeUndefined()
    expect(f.ensure).toHaveBeenCalledTimes(1)
    expect((await restState(f.ctx, f.agent)).latest).toMatchObject({ ready: false, wakeStatus: null })
    await expect(f.execute()).rejects.toThrow('hq_rest_committed_wake_missing')
    await f.execute({ ...request, handoff_id: 'replacement', summary: 'Cancelled test; resume normal operations' })
    expect((await restState(f.ctx, f.agent)).latest).toMatchObject({ handoffId: 'replacement', ready: true })
  })
  it('serializes parallel rest identities and exposes exact older wake separately from latest', async () => {
    const f = fixture()
    await Promise.all([f.execute(), f.execute()])
    expect(f.ensure).toHaveBeenCalledTimes(1)
    await Promise.all([f.execute({ ...request, handoff_id: 'newer-a', summary: 'First newer plan' }), f.execute({ ...request, handoff_id: 'newer', summary: 'Newer plan' })])
    expect(f.schedules.has(restScheduleId('root', 'rest-test'))).toBe(false)
    expect(f.schedules.size).toBe(1)
    await expect(f.execute()).rejects.toThrow('hq_rest_committed_wake_missing')
    const message = createUserMessage({ content: [{ type: 'text', text: 'HQ_REST_WAKE[rest-test]' }], source: { kind: 'schedule' } as never })
    const briefing = restBriefing(f.agent, [message]).text
    expect(briefing).toContain('"latestHandoff":{"id":"newer"')
    expect(briefing).toContain('"wakeHandoffs":[{"id":"rest-test"')
    expect(briefing).toContain('"superseded":true')
  })
  it('does not reschedule older superseded partial intents', async () => {
    const f = fixture()
    f.ensure.mockRejectedValueOnce(new Error('partial failure'))
    await expect(f.execute()).rejects.toThrow('partial failure')
    await f.execute({ ...request, handoff_id: 'newer' })
    await recoverRest(f.ctx, f.agent)
    await expect(f.execute()).rejects.toThrow('hq_rest_superseded_pending_intent')
    expect(f.schedules.size).toBe(1)
  })
  it('guards all retries after leaving HQ, and keeps unrelated turn-end acknowledgments quiet', async () => {
    const f = fixture(); await f.execute()
    f.agent.session.append('agent-preset/selected', { agentPreset: 'hivemind-chat' } as never)
    await expect(f.execute()).rejects.toThrow('hq_rest_requires_hq_lead')
    await acknowledgeRestNotes(f.ctx, f.agent)
    expect(f.ensure).toHaveBeenCalledTimes(1)
  })
})
describe('human quiet note admission', () => {
  it('does not wake a paused Agent, preserves a pending wake and validates identical retry', async () => {
    const f = fixture(); await f.execute()
    await leaveRestNote(f.ctx, f.agent, { id: 'note-one', text: 'Inspect this on the next wake' })
    await leaveRestNote(f.ctx, f.agent, { id: 'note-one', text: 'Inspect this on the next wake' })
    expect(f.prompt).not.toHaveBeenCalled()
    expect(f.ensure).toHaveBeenCalledTimes(1)
    expect(f.events.filter(event => event.type === 'hivemind/hq-rest-note')).toHaveLength(1)
    await expect(leaveRestNote(f.ctx, f.agent, { id: 'note-one', text: 'Changed text' })).rejects.toThrow('hq_rest_note_identity_conflict')
    expect((await restState(f.ctx, f.agent)).notes[0]?.status).toBe('pending')
  })
  it('marks presented only after native admission persistence, never applied/fulfilled', async () => {
    const f = fixture()
    await leaveRestNote(f.ctx, f.agent, { id: 'note-one', text: 'Evidence only' })
    const projection = restBriefing(f.agent, [])
    expect((await restState(f.ctx, f.agent)).notes[0]?.status).toBe('pending')
    f.agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: projection.text }], source: { kind: 'plugin', plugin: 'hivemind-hq/wake-briefing', form: 'recall', sections: [projection.section] } }), { surfaceOp: 'none' } as never)
    f.flush.mockResolvedValueOnce(false)
    await expect(acknowledgeRestNotes(f.ctx, f.agent)).rejects.toThrow('hq_rest_persistence_required')
    expect((await restState(f.ctx, f.agent)).notes[0]?.status).toBe('pending')
    await acknowledgeRestNotes(f.ctx, f.agent)
    expect((await restState(f.ctx, f.agent)).notes[0]?.status).toBe('presented')
  })
  it('rejects pending note overflow explicitly without losing accepted notes', async () => {
    const f = fixture()
    for (let index = 0; index < 20; index++) await leaveRestNote(f.ctx, f.agent, { id: `note-${index}`, text: 'Pending human note' })
    await expect(leaveRestNote(f.ctx, f.agent, { id: 'overflow', text: 'Not silently accepted' })).rejects.toThrow('hq_rest_pending_note_capacity')
    expect((await restState(f.ctx, f.agent)).notes).toHaveLength(20)
  })
  it('rejects cross-scope/non-HQ Remote callers without writing or waking', async () => {
    const f = fixture()
    const control = Object.create(HqControl.prototype) as HqControl
    Object.defineProperty(control, 'ctx', { value: f.ctx })
    const other = { ...f.agent, session: { ...f.agent.session, header: { agentPreset: 'hivemind-chat' } } } as unknown as Agent
    await expect(control.leaveRestNote(other, { id: 'note-cross', text: 'No authority' })).rejects.toThrow('hq_human_control_requires_hq_root')
    expect(f.events).toHaveLength(0)
  })
})


it('reads exact rest state without mutation, scheduling or reopening a past receipt', async () => {
  const f = fixture()
  await f.execute()
  const before = structuredClone(f.events)
  vi.setSystemTime(new Date('2030-01-02T00:00:00Z'))
  const tool = f.tools.get('hivemind_hq_rest_state')!
  const result = await tool.execute({}, { agent: f.agent, signal: new AbortController().signal } as never)
  expect(JSON.stringify(result)).toContain(request.handoff_id)
  expect(result).toMatchObject({ exactRetry: { ...request, wake_at: '2030-01-01T01:00:00.000Z' } })
  expect(JSON.stringify(result)).toContain('2030-01-01T01:00:00.000Z')
  expect(f.events).toEqual(before)
  expect(f.ensure).toHaveBeenCalledOnce()
  const other = { session: { header: { agentPreset: 'hyperagents' }, snapshotEvents: () => [], ownEvents: () => [] } } as unknown as Agent
  await expect(tool.execute({}, { agent: other } as never)).rejects.toThrow('hq_rest_requires_hq_lead')
})

it('formats persisted UTC instants in the actual confirmed zone with explicit UTC fallback', () => {
  const iso = '2026-10-05T07:00:00.000Z'
  const events = [{ type: 'user/message', data: createBrowserTimeZoneConfirmation('Europe/Berlin') }] as SessionEvent[]
  expect(restWakeDisplay(events, iso)).toMatchObject({ iso, timeZone: 'Europe/Berlin', local: '2026-10-05T09:00:00+02:00[Europe/Berlin]' })
  expect(restWakeDisplay([], iso)).toMatchObject({ iso, timeZone: 'UTC', local: '2026-10-05T07:00:00+00:00[UTC]' })
})
