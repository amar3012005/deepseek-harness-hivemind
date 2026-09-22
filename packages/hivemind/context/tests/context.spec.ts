import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { contextPlugin } from '../src/index.ts'

function user(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function mount(
  events: unknown[] = [],
  profileBrief?: (agent: Agent, signal: AbortSignal, turn: number) => Promise<string | undefined>,
  turnInstruction?: (agent: Agent, turn: number) => string | undefined,
) {
  let preStep: ((payload: never, next: () => Promise<unknown>) => Promise<unknown>) | undefined
  const ctx = {
    effect(callback: () => (() => void) | undefined) {
      return callback()
    },
    on(event: string, listener: typeof preStep) {
      if (event === 'agent/pre-step') preStep = listener
      return () => {}
    },
  }
  contextPlugin({
    historyTurns: 3,
    historyMaxChars: 3_000,
    capabilityToolName: 'hivemind_capabilities',
    ...(profileBrief === undefined ? {} : { profileBrief }),
    ...(turnInstruction === undefined ? {} : { turnInstruction }),
  }).apply(ctx as never)
  const agent = {
    session: {
      surface: { nodes: [] },
      eventAt: (seq: number) => events.find(event => (event as { seq?: number }).seq === seq),
      snapshotEvents: () => events,
    },
  }
  return { agent, preStep: preStep! }
}

describe('HIVE progressive context', () => {
  it('re-reads the authoritative turn instruction on every new turn', async () => {
    let language = 'en'
    const harness = mount([], undefined, () => `Reply language: ${language}`)
    const run = async (turn: number, text: string) => await harness.preStep({
      agent: harness.agent, turn, signal: new AbortController().signal,
    } as never, async () => ({ kind: 'enter' as const, messages: [user(text)] })) as { messages: ReturnType<typeof user>[] }
    const first = await run(1, 'hello')
    language = 'de'
    const second = await run(2, 'hello again')
    const texts = (messages: ReturnType<typeof user>[]) => messages.map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'))
    expect(texts(first.messages)).toEqual(['Reply language: en', 'hello'])
    expect(texts(second.messages)).toEqual(['Reply language: de', 'hello again'])
  })

  it('replaces completed tool history without requiring a profile anchor and leaves current work intact', async () => {
    const harness = mount()
    const events = [
      { type: 'system/message', seq: 0 },
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, surfaceOp: 'append', data: user('Find the latest item') },
      { type: 'tool/result', seq: 3, surfaceOp: 'append', data: { turn: 1, message: createToolResultMessage({
        callId: 'one' as never, content: [{ type: 'text', text: 'LARGE_OLD_TOOL_RECEIPT' }], isError: false,
      }) } },
      { type: 'assistant/message', seq: 4, surfaceOp: 'append', data: { turn: 1, message: createAssistantMessage({
        source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'The latest item is ready.' }],
      }) } },
      { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 6, data: { turn: 2 } },
      { type: 'user/message', seq: 7, surfaceOp: 'append', data: user('Current work already admitted') },
    ]
    const append = vi.fn()
    const agent = { session: { surface: { nodes: [0, 2, 3, 4, 7] }, snapshotEvents: () => events,
      eventAt: (seq: number) => events.find(event => event.seq === seq), append,
    } }
    const decision = await harness.preStep({ agent, turn: 2, signal: new AbortController().signal } as never,
      async () => ({ kind: 'enter', messages: [user('Next question')] })) as { startsRequestSeries?: boolean }
    expect(decision.startsRequestSeries).toBe(true)
    expect(append.mock.calls[0]?.[2]).toEqual({ surfaceOp: { op: 'replace', startSeq: 2, endSeq: 4 }, sourceEventSeqs: [2, 3, 4] })
    const text = JSON.stringify(append.mock.calls[0]?.[1])
    expect(text).toContain('Find the latest item')
    expect(text).toContain('The latest item is ready.')
    expect(text).not.toContain('LARGE_OLD_TOOL_RECEIPT')
    expect(text).not.toContain('Current work already admitted')
    expect(events).toHaveLength(8)
  })
  it('starts a greeting with no skill catalog', async () => {
    const harness = mount()
    const catalog = createUserMessage({
      content: [{ type: 'text', text: 'skill catalog' }],
      source: { kind: 'skill-catalog', form: 'catalog', entries: [{ name: 'unused', description: 'unused' }] },
    })
    const decision = await harness.preStep({ agent: harness.agent, turn: 1, signal: new AbortController().signal } as never, async () => ({
      kind: 'enter' as const,
      messages: [user('hello'), catalog],
    })) as { messages: ReturnType<typeof user>[]; startsRequestSeries?: boolean }

    expect(decision.messages).toHaveLength(1)
    expect(decision.startsRequestSeries).toBeUndefined()
  })

  it('does not inject authenticated profile context before the model requests it', async () => {
    const harness = mount()
    const request = user('What do you know about me?')
    const first = await harness.preStep({ agent: harness.agent, turn: 1, signal: new AbortController().signal } as never, async () => ({
      kind: 'enter' as const,
      messages: [request],
    })) as { messages: ReturnType<typeof user>[] }
    expect(first.messages).toEqual([request])

    const second = await harness.preStep({ agent: harness.agent, turn: 1, signal: new AbortController().signal } as never, async () => ({
      kind: 'enter' as const,
      messages: [request],
    })) as { messages: ReturnType<typeof user>[] }
    expect(second.messages).toEqual([request])
  })

  it('injects a server-owned brief on the first turn and refreshes it for a later direct profile question', async () => {
    const brief = vi.fn(async (_agent: Agent, _signal: AbortSignal, turn: number) => `profile-v${turn}`)
    const harness = mount([], brief)
    const first = await harness.preStep({ agent: harness.agent, turn: 1, signal: new AbortController().signal } as never, async () => ({
      kind: 'enter' as const,
      messages: [user('hello')],
    })) as { messages: ReturnType<typeof user>[] }
    const ordinary = await harness.preStep({ agent: harness.agent, turn: 2, signal: new AbortController().signal } as never, async () => ({
      kind: 'enter' as const,
      messages: [user('Draft a note')],
    })) as { messages: ReturnType<typeof user>[] }
    const profile = await harness.preStep({ agent: harness.agent, turn: 3, signal: new AbortController().signal } as never, async () => ({
      kind: 'enter' as const,
      messages: [user('What is my company profile?')],
    })) as { messages: ReturnType<typeof user>[] }

    const texts = (messages: ReturnType<typeof user>[]) => messages.map(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'))
    expect(texts(first.messages)).toEqual(['profile-v1', 'hello'])
    expect(texts(ordinary.messages)).toEqual(['Draft a note'])
    expect(texts(profile.messages)).toEqual(['profile-v3', 'What is my company profile?'])
    expect(brief).toHaveBeenCalledTimes(2)
  })

  it('leaves the first model step to answer or request capabilities', async () => {
    const harness = mount()
    const request = user("Can you tell me exactly what's going on?")
    const catalog = createUserMessage({
      content: [{ type: 'text', text: 'skill catalog' }],
      source: { kind: 'skill-catalog', form: 'catalog', entries: [{ name: 'unused', description: 'unused' }] },
    })
    const decision = await harness.preStep({ agent: harness.agent, turn: 1, signal: new AbortController().signal } as never, async () => ({
      kind: 'enter' as const,
      messages: [request, catalog],
    })) as { messages: ReturnType<typeof user>[]; startsRequestSeries?: boolean }

    expect(decision.startsRequestSeries).toBeUndefined()
    expect(decision.messages).toEqual([request])
  })

  it('reveals the native catalog after the model requests capabilities', async () => {
    const events = [{
      type: 'tool/call', seq: 1, data: { turn: 1, step: 1, callId: 'call-1', name: 'hivemind_capabilities', arguments: '{}' },
    }]
    const harness = mount(events)
    const catalog = createUserMessage({
      content: [{ type: 'text', text: 'skill catalog' }],
      source: { kind: 'skill-catalog', form: 'catalog', entries: [{ name: 'unused', description: 'unused' }] },
    })
    const request = user('Current request')
    const decision = await harness.preStep({ agent: harness.agent, turn: 1, signal: new AbortController().signal } as never, async () => ({
      kind: 'enter' as const,
      messages: [request, catalog],
    })) as { messages: ReturnType<typeof user>[] }

    expect(decision.messages).toHaveLength(2)
    expect(decision.messages).toEqual([request, catalog])
  })
})
