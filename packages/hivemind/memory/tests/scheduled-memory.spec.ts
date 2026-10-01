import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { memoryPlugin, scheduledMemoryContext } from '../src/index.ts'

async function fixture(selected = 'Allow') {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  const ask = vi.fn(async (input: { questions: { id: string }[] }) => ({ answers: [{ id: input.questions[0]!.id, selected: [selected] }] }))
  ctx.provide('userQuestions', { ask } as never)
  const save = vi.fn(async () => ({ status: 'saved', memory_id: 'confirmed-receipt' }))
  const recall = vi.fn(async () => ({ status: 'ready' }))
  const entities = vi.fn(async () => ({ status: 'ready' }))
  const fiber = await ctx.isolate('hivemindScheduledMemoryPolicy').plugin(memoryPlugin({ defaultLimit: 5 }, {
    context: async () => ({}), entities, recall, save, profiles: async () => ({}),
  }))
  const events: { seq: number; type: string; data: unknown }[] = []
  const flush = vi.fn(async () => true)
  ctx.provide('sessions', { flush } as never)
  const agent = { ctx: { get: (name: string) => fiber.ctx.get(name as never), sessions: { flush } }, session: {
    header: { id: 'session-owner' }, snapshotEvents: () => [...events],
    append: (type: string, data: unknown) => events.push({ seq: events.length + 1, type, data }),
  } }
  const execution = { agent, signal: new AbortController().signal } as never
  function due(prompt: string, id = 'schedule-1', key = 'occurrence-1') {
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', { source: { kind: 'schedule', deliveryKey: key }, content: [{ type: 'text', text: `reminders_json: ${JSON.stringify([{ schedule_id: id, reminder_prompt: prompt }])}` }] })
  }
  const call = () => fiber.ctx.tools.get('hivemind_save_memory')!.execute({ title: 'Verified decision', content: 'Use the approved company strategy.', source_type: 'decision', scope: 'organization' }, execution)
  return { ctx, fiber, ask, save, recall, entities, agent, execution, events, flush, due, call }
}

describe('scheduled company-memory permission', () => {
  it('prepares creation through a scoped event when the Agent root cannot see the capability service', async () => {
    const f = await fixture('Do not allow')
    expect(f.ctx.get('hivemindScheduledMemoryPolicy')).toBeUndefined()
    await f.ctx.waterfall('schedule/prepare-create', f.agent as never, 'schedule-1', 'Save company memories.', 'organization', undefined, new AbortController().signal, async () => false)
    expect(f.ask).toHaveBeenCalledOnce()
    f.due('Save company memories.')
    expect(await f.call()).toMatchObject({ status: 'awaiting_approval' })
    expect(f.save).not.toHaveBeenCalled()
    await f.fiber.dispose()
  })
  it('does not ask company-write permission for a private HyperAgent memory task', async () => {
    const f = await fixture()
    const prompt = 'Save reusable memories using hyperagents_memory.'
    await f.fiber.ctx.get('hivemindScheduledMemoryPolicy')!.prepare(f.agent as never, 'schedule-1', prompt, undefined, undefined, new AbortController().signal)
    expect(f.ask).not.toHaveBeenCalled()
    expect(f.events).toEqual([])
    f.due(prompt)
    // Skipping a private-memory question never grants company-memory access.
    expect(await f.call()).toMatchObject({ status: 'awaiting_approval' })
    expect(f.save).not.toHaveBeenCalled()
    await f.fiber.dispose()
  })
  it('captures approval before creation and reuses it during an unattended occurrence', async () => {
    const f = await fixture()
    const prompt = 'Save the confirmed decision to company memories.'
    await f.fiber.ctx.get('hivemindScheduledMemoryPolicy')!.prepare(f.agent as never, 'schedule-1', prompt, 'organization', undefined, new AbortController().signal)
    expect(f.flush).toHaveBeenCalledOnce()
    f.due(prompt)
    expect(await f.call()).toMatchObject({ status: 'saved' })
    expect(f.ask).toHaveBeenCalledOnce()
    expect(f.save).toHaveBeenCalledOnce()
    await f.fiber.dispose()
  })
  it.each(['Do not allow', ''])('asks again during the run after a declined creation decision: %s', async (selected) => {
    const f = await fixture(selected)
    const prompt = 'Save the confirmed decision to company memories.'
    await f.fiber.ctx.get('hivemindScheduledMemoryPolicy')!.prepare(f.agent as never, 'schedule-1', prompt, 'organization', undefined, new AbortController().signal)
    f.due(prompt)
    expect(await f.call()).toMatchObject({ status: 'awaiting_approval' })
    expect(f.ask).toHaveBeenCalledTimes(2)
    expect(f.save).not.toHaveBeenCalled()
    await f.fiber.dispose()
  })
  it('asks for legacy schedules without a creation grant', async () => {
    const f = await fixture()
    f.due('Save company memories.')
    expect(await f.call()).toMatchObject({ status: 'awaiting_approval' })
    expect(f.ask).toHaveBeenCalledOnce()
    expect(f.save).not.toHaveBeenCalled()
    await f.fiber.dispose()
  })
  it('invalidates permission when the reminder prompt changes', async () => {
    const f = await fixture()
    await f.fiber.ctx.get('hivemindScheduledMemoryPolicy')!.prepare(f.agent as never, 'schedule-1', 'Save verified decisions.', 'organization', undefined, new AbortController().signal)
    f.due('Save all recalled memories instead.')
    expect(await f.call()).toMatchObject({ status: 'awaiting_approval' })
    expect(f.ask).toHaveBeenCalledTimes(2)
    expect(f.save).not.toHaveBeenCalled()
    await f.fiber.dispose()
  })
  it('rejects destination escalation from a personal grant to organization scope', async () => {
    const f = await fixture()
    const prompt = 'Save verified decisions.'
    await f.fiber.ctx.get('hivemindScheduledMemoryPolicy')!.prepare(f.agent as never, 'schedule-1', prompt, 'personal', undefined, new AbortController().signal)
    f.due(prompt)
    expect(await f.call()).toMatchObject({ status: 'awaiting_approval' })
    expect(f.save).not.toHaveBeenCalled()
    await f.fiber.dispose()
  })
  it('waits for the native answer and writes only after approval', async () => {
    const f = await fixture('Do not allow')
    const prompt = 'Save company memories.'
    await f.fiber.ctx.get('hivemindScheduledMemoryPolicy')!.prepare(f.agent as never, 'schedule-1', prompt, 'organization', undefined, new AbortController().signal)
    const answer = Promise.withResolvers<{ answers: { id: string; selected: string[] }[] }>()
    f.ask.mockImplementationOnce(async () => answer.promise)
    f.due(prompt)
    const running = f.call()
    await vi.waitFor(() => expect(f.ask).toHaveBeenCalledTimes(2))
    expect(f.save).not.toHaveBeenCalled()
    expect(f.events.some(event => event.type === 'hivemind/scheduled-memory-pending')).toBe(true)
    const input = f.ask.mock.calls[1]![0]
    answer.resolve({ answers: [{ id: input.questions[0]!.id, selected: ['Organization'] }] })
    expect(await running).toMatchObject({ status: 'saved' })
    expect(f.save).toHaveBeenCalledOnce()
    await f.fiber.dispose()
  })
  it('retains an offline write and resumes its exact payload without duplicates', async () => {
    const f = await fixture()
    f.ask.mockRejectedValueOnce(Object.assign(new Error('Offline'), { code: 'NO_PROVIDER' }))
    f.due('Save company memories.')
    const waiting = await f.call() as { pending_id: string }
    expect(waiting).toMatchObject({ status: 'awaiting_approval' })
    expect(f.save).not.toHaveBeenCalled()
    f.agent.session.append('turn/start', { turn: 2 })
    f.agent.session.append('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Resume pending memory.' }] })
    f.ask.mockImplementationOnce(async input => ({ answers: [{ id: input.questions[0]!.id, selected: ['Organization'] }] }))
    const tool = f.fiber.ctx.tools.get('hivemind_pending_memory')!
    expect(await tool.execute({ action: 'resume', pending_id: waiting.pending_id }, f.execution)).toMatchObject({ status: 'saved' })
    expect(await tool.execute({ action: 'resume', pending_id: waiting.pending_id }, f.execution)).toMatchObject({ status: 'saved' })
    expect(f.save).toHaveBeenCalledOnce()
    expect(await tool.execute({ action: 'list' }, f.execution)).toMatchObject({ items: [] })
    await f.fiber.dispose()
  })
  it('requires acknowledged persistence before accepting a schedule grant', async () => {
    const f = await fixture()
    f.flush.mockResolvedValue(false)
    await expect(f.fiber.ctx.get('hivemindScheduledMemoryPolicy')!.prepare(f.agent as never, 'schedule-1', 'Save verified decisions.', 'organization', undefined, new AbortController().signal)).rejects.toThrow('durably acknowledged')
    await f.fiber.dispose()
  })
  it('resolves legacy dreaming to Flashbacks rather than organization scope without an approval', async () => {
    const f = await fixture()
    f.ctx.provide('hivemindFlashbacksDestination', { resolve: async () => 'tenant-flashbacks-id' })
    f.due('Run the nightly Dreamer and save derived Flashbacks.')
    expect(await f.call()).toMatchObject({ status: 'saved' })
    expect(f.save).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ scope: 'project', project: 'tenant-flashbacks-id', derived: true }), expect.anything(), expect.anything())
    expect(f.ask).not.toHaveBeenCalled()
    await f.fiber.dispose()
  })
  it('repairs the two malformed read calls from the trace before dispatch', async () => {
    const f = await fixture()
    const tool = f.fiber.ctx.tools.get('hivemind_meta')!
    await tool.execute({ operation: 'recall', recall: { query: 'verified decisions', limit: 30 } }, f.execution)
    await tool.execute({ operation: 'entities', entities: { entities: { query: 'SINGULANCE', limit: 10 } } }, f.execution)
    expect(f.recall).toHaveBeenCalledWith(expect.objectContaining({ limit: 25 }), expect.anything(), expect.anything())
    expect(f.entities).toHaveBeenCalledWith(expect.objectContaining({ query: 'SINGULANCE', limit: 10 }), expect.anything(), expect.anything())
    await f.fiber.dispose()
  })
  it('does not confuse a later human turn with an earlier schedule occurrence', async () => {
    const f = await fixture()
    f.due('Save company memories.')
    expect(scheduledMemoryContext(f.agent as never)?.key).toBe('occurrence-1')
    f.agent.session.append('turn/start', { turn: 2 })
    f.agent.session.append('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'reminders_json: []' }] })
    expect(scheduledMemoryContext(f.agent as never)).toBeUndefined()
    await f.fiber.dispose()
  })
})
