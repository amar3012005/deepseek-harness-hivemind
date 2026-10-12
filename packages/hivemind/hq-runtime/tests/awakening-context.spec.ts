import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Session, SessionId, SessionLogOffset, deriveEventMessage } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { awakeningContext, awakeningMethod, installAwakening } from '../src/awakening.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

vi.mock('../src/rest.ts', () => ({ isHqLead: () => true }))

it('keeps unfinished orientation saved without displacing an unrelated current human task', async () => {
  const events = [
    { seq: 0, type: 'hivemind/hq-awakening-start', data: { version: 1, turn: 1 } },
    { seq: 1, type: 'hivemind/hq-awakening-checkpoint', data: { stage: 'company', blocked: false, summary: 'Known company' } },
    { seq: 2, type: 'turn/start', data: { turn: 9 } },
  ]
  const agent = { session: { snapshotEvents: () => events } } as unknown as Agent
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Recover the internal release verification only.' }] })
  expect(await awakeningContext({} as Context, agent, 9, [message])).toBe('')
  expect(await awakeningContext({} as Context, agent, 9, [])).toContain('Current unfinished checkpoint: evidence')
  expect(events).toHaveLength(3)
})

it('bounds latest checkpoint findings while keeping exact history references', async () => {
  const events = [
    { seq: 0, type: 'hivemind/hq-awakening-start', data: { version: 1, turn: 1 } },
    ...Array.from({ length: 20 }, (_, index) => ({ seq: index + 1, type: 'hivemind/hq-awakening-checkpoint', data: { stage: 'company', blocked: false, summary: `Finding ${index}: ${'old detail '.repeat(2000)}` } })),
  ]
  const agent = { session: { snapshotEvents: () => events } } as unknown as Agent
  const text = await awakeningContext({} as Context, agent, 2, [])
  expect(text).toContain('Finding 19:')
  expect(text).not.toContain('Finding 18:')
  expect(text).toContain('"sequence":20')
  expect(text.length).toBeLessThan(1500)
})

it('routes a later employee result to operating review without reloading incomplete orientation', async () => {
  const events = [
    { seq: 0, type: 'hivemind/hq-awakening-start', data: { version: 1, turn: 1 } },
    { seq: 1, type: 'hivemind/hq-awakening-checkpoint', data: { stage: 'company', blocked: false, summary: 'Known company' } },
    { seq: 2, type: 'turn/start', data: { turn: 9 } },
  ]
  const agent = { session: { snapshotEvents: () => events } } as unknown as Agent
  const message = createUserMessage({ source: { kind: 'agent-message', form: 'relay', senderSessionId: SessionId('worker') }, content: [{ type: 'text', text: 'The assigned verification has a model blocker.' }] })
  expect(await awakeningContext({} as Context, agent, 9, [message])).toBe('')
  expect(await awakeningContext({} as Context, agent, 1, [message])).toContain('Current unfinished checkpoint: evidence')
  expect(events).toHaveLength(3)
})

it('keeps an unfinished awakening briefing compact and points to native loaded guidance', async () => {
  const events = [
    { type: 'hivemind/hq-awakening-start', data: { version: 1, turn: 1 } },
    { type: 'hivemind/hq-awakening-checkpoint', data: { stage: 'company', blocked: false, summary: 'Known company' } },
  ]
  const agent = { session: { snapshotEvents: () => events } } as unknown as Agent
  const briefing = await awakeningContext({} as Context, agent, 2, [])
  expect(briefing).toContain('runtime-company-awakening')
  expect(briefing).toContain('Current unfinished checkpoint: evidence')
  expect(briefing).toContain('Known company')
  expect(briefing).not.toContain('parallel_search')
  expect(briefing).not.toContain('3–5')
  expect(briefing.length).toBeLessThan(1000)
})

it('does not reinsert awakening guidance after its conversation checkpoint', async () => {
  const events = [
    { type: 'hivemind/hq-awakening-start', data: { version: 1, turn: 1 } },
    ...['company', 'evidence', 'team', 'strategy', 'conversation'].map(stage => ({ type: 'hivemind/hq-awakening-checkpoint', data: { stage, blocked: false } })),
  ]
  const agent = { session: { snapshotEvents: () => events } } as unknown as Agent
  expect(await awakeningContext({} as Context, agent, 2, [])).toBe('')
})


it.each(['Wake up, Chief! Continue our agenda.', 'Wakeup Chief'])('does not restart completed onboarding for a later human wake command: %s', async (text) => {
  const append = vi.fn()
  const events = [
    { type: 'hivemind/hq-awakening-start', data: { version: 1, turn: 1 } },
    ...['company', 'evidence', 'team', 'strategy', 'conversation'].map(stage => ({ type: 'hivemind/hq-awakening-checkpoint', data: { stage, blocked: false } })),
  ]
  const agent = { session: { snapshotEvents: () => events, append } } as unknown as Agent
  const messages = [{ source: { kind: 'user' }, content: [{ type: 'text', text }] }] as never
  expect(await awakeningContext({} as Context, agent, 4, messages)).toBe('')
  expect(append).not.toHaveBeenCalled()
})


it.each([
  ['conversation', undefined, undefined, true],
  ['conversation', 'artifact-id', undefined, false],
  ['conversation', undefined, '/api/image.png', false],
  ['company', undefined, undefined, false],
  ['strategy', undefined, undefined, false],
])('allows receipt-free invitations only without references (%s, %s, %s)', async (stage, reference, image, allowed) => {
  const register = vi.fn<(tool: ToolDefinition) => void>()
  const ctx = { effect: (callback: () => unknown) => callback(),
    tools: { register }, sessions: { flush: async () => true } } as unknown as Context
  installAwakening(ctx)
  const tool = register.mock.calls[0]?.[0]
  if (!tool) throw new Error('tool missing')
  const agent = { session: { snapshotEvents: () => [{ type: 'hivemind/hq-awakening-start', data: {} }], append: vi.fn() } }
  const result = tool.execute({ stage, summary: 'Please call when ready.', evidence_refs: [], ...(reference ? { reference } : {}), ...(image ? { image } : {}) }, { agent } as never)
  if (allowed) await expect(result).resolves.toMatchObject({ status: 'checkpoint_saved' })
  else await expect(result).rejects.toThrow('hq_awakening_receipt_required')
})


it.each(['conversation', 'company', 'strategy'])('only a plain invitation is admitted outside awakening (%s)', async (stage) => {
  const register = vi.fn<(tool: ToolDefinition) => void>()
  installAwakening({ effect: (callback: () => unknown) => callback(), tools: { register },
    sessions: { flush: async () => true } } as unknown as Context)
  const agent = { session: { snapshotEvents: () => [], append: vi.fn() } }
  const tool = register.mock.calls[0]?.[0]
  if (!tool) throw new Error('tool missing')
  const result = tool.execute({ stage, summary: 'Please call when ready.', evidence_refs: [] }, { agent } as never)
  if (stage === 'conversation') await expect(result).resolves.toMatchObject({ status: 'checkpoint_saved' })
  else await expect(result).rejects.toThrow('hq_awakening_not_started')
})

it.each([
  ['Wake up, Chief!', 'user', true],
  ['Wakeup Chief', 'user', true],
  ['Wakeup ! chief', 'user', true],
  ['Wakeup, Chief! Review our current work.', 'user', true],
  ['Wakeup Chiefly', 'user', false],
  ['Please explain Wakeup Chief', 'user', false],
  ['"Wakeup Chief" is the command', 'user', false],
  ['Wakeup Chief', 'schedule', false],
  ['Wakeup Chief', 'plugin', false],
  ['Wake up, Chief! I want to grow our LinkedIn presence over the next week.', 'user', true],
  ['wake up chief: Review this agenda', 'user', true],
  ['Wake up Chiefly', 'user', false],
  ['Please explain Wake up, Chief!', 'user', false],
  ['"Wake up, Chief!" is the command', 'user', false],
  ['Wake up, Chief! Review this agenda', 'schedule', false],
  ['Wake up, Chief!', 'plugin', false],
])('matches only a leading direct human command: %s (%s)', async (text, kind, expected) => {
  const append = vi.fn()
  const setMode = vi.fn().mockResolvedValue({ ok: true })
  const ctx = { sessions: { flush: vi.fn().mockResolvedValue(true) },
    hivemindHq: { mode: () => ({ enabled: false, revision: 0 }), setMode } } as unknown as Context
  const agent = { session: { snapshotEvents: () => [], append } } as unknown as Agent
  const messages = [{ source: { kind }, content: [{ type: 'text', text }] }] as never
  const result = await awakeningContext(ctx, agent, 1, messages)
  expect(append).toHaveBeenCalledTimes(expected ? 1 : 0)
  expect(setMode).toHaveBeenCalledTimes(expected ? 1 : 0)
  expect(Boolean(result)).toBe(expected)
})


it('does not close incomplete orientation merely because a conversation invitation was saved', async () => {
  const events = [{ type: 'hivemind/hq-awakening-start', data: {} },
    { type: 'hivemind/hq-awakening-checkpoint', data: { stage: 'conversation', blocked: false } }]
  expect(await awakeningContext({} as Context, { session: { snapshotEvents: () => events } } as unknown as Agent, 2, [])).toContain('Current unfinished checkpoint: company')
})

it('loads the full native method scoped to the agent before orientation, reusing an already visible body', async () => {
  const get = vi.fn(async () => ({ name: 'runtime-company-awakening', invocation: { modelInvocable: true }, content: 'Complete current method, including its final rule.' }))
  const ctx = { get: () => ({ get }) } as unknown as Context
  const agent = { session: { header: { cwd: '/company' }, surface:{ nodes:[] }, snapshotEvents:()=>[] } } as unknown as Agent
  const signal = new AbortController().signal
  const method = await awakeningMethod(ctx, agent, [], signal)
  expect(get).toHaveBeenCalledWith('runtime-company-awakening', { scope: agent, cwd: '/company', signal })
  expect(JSON.stringify(method)).toContain('including its final rule.')
  expect(await awakeningMethod(ctx, agent, method, signal)).toEqual([])
  await expect(awakeningMethod({ get: () => undefined } as unknown as Context, agent, [], signal)).rejects.toThrow('hq_awakening_skill_unavailable')
})


it('reuses the native method surface after cold restore and replaces only its changed projection', async () => {
  let body='Original complete method.'
  const ctx={ get:()=>({ get:async()=>({ name:'runtime-company-awakening',invocation:{ modelInvocable:true },content:body }) }) } as unknown as Context
  const session=Session.create(SessionId('awakening-method-cold'))
  const agent={ session } as unknown as Agent
  const signal=new AbortController().signal
  const [method]=await awakeningMethod(ctx,agent,[],signal)
  if (!method) throw new Error('method missing')
  session.append('user/message',method,{ surfaceOp:'append' })
  expect(await awakeningMethod(ctx,agent,[],signal)).toEqual([])
  const history=session.snapshotEvents()
  const restored=Session.create(session.id,history,session.header,SessionLogOffset(0))
  const restoredAgent={ session:restored } as unknown as Agent
  expect(await awakeningMethod(ctx,restoredAgent,[],signal)).toEqual([])
  body='Updated complete method.'
  expect(await awakeningMethod(ctx,restoredAgent,[],signal)).toEqual([])
  expect(restored.snapshotEvents().slice(0,history.length)).toEqual(history)
  const current=restored.surface.nodes.flatMap(seq=>restored.snapshotEvents().filter(event=>event.seq===seq).map(deriveEventMessage))
  expect(JSON.stringify(current)).toContain(body)
  expect(JSON.stringify(current)).not.toContain('Original complete method.')
  expect(await awakeningMethod(ctx,restoredAgent,[],signal)).toEqual([])
})
