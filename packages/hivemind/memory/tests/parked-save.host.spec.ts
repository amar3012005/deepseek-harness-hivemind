import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { memoryPlugin, saveOperationId } from '../src/index.ts'

async function fixture() {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(UserQuestions)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const saved = vi.fn(async (_agent: Agent, _request: import('../src/index.ts').SaveRequest, _signal: AbortSignal, _execution: unknown) => ({ status: 'saved', memory_id: 'receipt-1' }))
  const plugin = memoryPlugin({ defaultLimit: 5 }, {
    context: async () => ({}), entities: async () => ({}), recall: async () => ({}),
    profiles: async () => ({}), save: saved,
  })
  let fiber = await ctx.plugin(plugin)
  const inbox: UserMessage[] = []
  const session = Session.create(SessionId('memory-parked-fixture'))
  const agent = { id: session.id, session, inbox: { nextTurn: [], nextStep: inbox },
    steer: (message: UserMessage) => { inbox.push(message) }, inject: vi.fn(),
  } as unknown as Agent
  ctx.agents.enter(agent, undefined)
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const signal = new AbortController().signal
  const callId = ToolCallId('memory-save-call')
  const args = { operation: 'save', save: { title: 'Confirmed priority', content: 'Release existing customer work first.', scope: 'personal' } }
  const execute = () => ctx.tools.execute({ agent, signal, callId, name: 'hivemind_meta', arguments: args })
  const question = () => ctx.sessionProjections.stateOf(session, 'userQuestions')!.questions.active[0]!
  const answer = async (selected: string[]) => {
    const current = question()
    await ctx.userQuestions.answer(agent, callId, { answers: [{ id: current.questions[0]!.id, selected }] })
    const message = inbox.shift()!
    session.append('user/message', message, { surfaceOp: 'append' })
  }
  const step = () => ctx.waterfall('agent/pre-step', { agent, signal, turn: 2, step: 1, messages: [] }, async () => ({ kind: 'enter' as const, messages: [] }))
  return { ctx, agent, session, saved, execute, question, answer, step, args,
    restart: async () => { await fiber.dispose(); fiber = await ctx.plugin(plugin) },
  }
}

describe('native parked memory saves', () => {
  it('parks visibly and concludes with no foreground answerer or provider write', async () => {
    const f = await fixture()
    try {
      const result = await f.execute()
      expect(result).toMatchObject({ isError: false, concludesTurn: true, value: { pending: true } })
      expect(f.question()).toMatchObject({ callId: 'memory-save-call', state: 'continued' })
      expect(f.saved).not.toHaveBeenCalled()
      await f.step()
      expect(f.saved).not.toHaveBeenCalled()
    } finally { await f.ctx.fiber.dispose() }
  })

  it('restores the exact prepared request and writes once after an admitted reply', async () => {
    const f = await fixture()
    try {
      await f.execute()
      await f.restart()
      await f.answer(['Personal'])
      await f.step()
      await f.step()
      expect(f.saved).toHaveBeenCalledOnce()
      expect(f.saved.mock.calls[0]?.[1]).toMatchObject({ title: 'Confirmed priority', scope: 'personal', idempotencyKey: expect.stringMatching(/^saveop:/) })
      expect(await f.ctx.userQuestions.answer(f.agent, ToolCallId('memory-save-call'), { answers: [] })).toBe(false)
    } finally { await f.ctx.fiber.dispose() }
  })

  it.each([{ selected: [] }, { selected: ['Unlisted destination'] }, { selected: ['Personal', 'Organization'] }])('declines without a write for %j', async ({ selected }) => {
    const f = await fixture()
    try {
      await f.execute()
      await f.answer(selected)
      await f.step()
      expect(f.saved).not.toHaveBeenCalled()
      expect(f.session.snapshotEvents().filter(event => event.type === 'hivemind/memory-save').at(-1)?.data).toMatchObject({ status: 'cancelled' })
    } finally { await f.ctx.fiber.dispose() }
  })

  it('recovers only an exact prepared legacy call without re-executing it', async () => {
    const f = await fixture()
    try {
      const callId = ToolCallId('memory-save-call')
      const request = { title: 'Confirmed priority', content: 'Release existing customer work first.', sourceType: 'conversation' as const, scope: 'personal' as const }
      f.session.append('tool/call', { turn: 1, step: 1, callId, name: 'hivemind_meta', arguments: JSON.stringify(f.args) })
      f.session.append('hivemind/memory-save', { status: 'prepared', operation_id: saveOperationId({ agent: f.agent } as never, request) })
      Object.assign(f.agent, { status: 'idle', runMaintenance: async (work: (signal: AbortSignal) => Promise<boolean>) => work(new AbortController().signal) })
      expect(await f.ctx.hivemindMemoryApproval.recoverPrepared(f.agent, callId)).toBe(true)
      expect(await f.ctx.hivemindMemoryApproval.recoverPrepared(f.agent, callId)).toBe(false)
      expect(f.question().state).toBe('continued')
      expect(f.saved).not.toHaveBeenCalled()
      await f.answer(['Personal'])
      await f.step()
      expect(f.saved).toHaveBeenCalledOnce()
    } finally { await f.ctx.fiber.dispose() }
  })

  it('does not recover an uncertain executing write or a busy driver', async () => {
    const f = await fixture()
    try {
      const callId = ToolCallId('memory-save-call')
      Object.assign(f.agent, { status: 'running' })
      await expect(f.ctx.hivemindMemoryApproval.recoverPrepared(f.agent, callId)).rejects.toThrow('idle driver')
      Object.assign(f.agent, { status: 'idle', runMaintenance: async (work: (signal: AbortSignal) => Promise<boolean>) => work(new AbortController().signal) })
      f.session.append('tool/call', { turn: 1, step: 1, callId, name: 'hivemind_meta', arguments: JSON.stringify(f.args) })
      f.session.append('hivemind/memory-save', { status: 'executing', operation_id: 'uncertain' })
      expect(await f.ctx.hivemindMemoryApproval.recoverPrepared(f.agent, callId)).toBe(false)
      expect(f.saved).not.toHaveBeenCalled()
    } finally { await f.ctx.fiber.dispose() }
  })

  it('rejects a foreign respondent through native admission and retains the checkpoint', async () => {
    const f = await fixture()
    try {
      await f.execute()
      f.ctx.on('user-questions/late-answer-admission', async () => { throw new Error('wrong organization') })
      await expect(f.answer(['Personal'])).rejects.toThrow('wrong organization')
      expect(f.question().state).toBe('continued')
      expect(f.saved).not.toHaveBeenCalled()
    } finally { await f.ctx.fiber.dispose() }
  })
})
