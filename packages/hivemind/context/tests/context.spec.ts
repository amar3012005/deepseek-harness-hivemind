import { describe, expect, it, vi } from 'vitest'
import { createUserMessage, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { contextPlugin, type ProfileSnapshot } from '../src/index.ts'

function user(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function mount(snapshotFor = vi.fn(async (): Promise<ProfileSnapshot> => ({
  identity: { userId: 'user-1', orgId: 'org-1' },
  initialContext: 'never injected for ordinary requests',
  fullContext: 'Authenticated profile context',
}))) {
  let preStep: ((payload: never, next: () => Promise<unknown>) => Promise<unknown>) | undefined
  const ctx = {
    on(event: string, listener: typeof preStep) {
      if (event === 'agent/pre-step') preStep = listener
      return () => {}
    },
  }
  contextPlugin({ historyTurns: 3, historyMaxChars: 3_000, profileContextMaxChars: 4_000 }, snapshotFor).apply(ctx as never)
  const agent = {
    session: { surface: { nodes: [] }, eventAt: () => undefined, snapshotEvents: () => [] },
  }
  return { agent, preStep: preStep!, snapshotFor }
}

describe('HIVE progressive context', () => {
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
    expect(harness.snapshotFor).not.toHaveBeenCalled()
  })
  it('does not inject profile context or fetch identity for a greeting', async () => {
    const harness = mount()
    const decision = await harness.preStep({ agent: harness.agent, turn: 1, signal: new AbortController().signal } as never, async () => ({
      kind: 'enter' as const,
      messages: [user('hello')],
    })) as { messages: ReturnType<typeof user>[]; startsRequestSeries?: boolean }

    expect(decision.messages).toHaveLength(1)
    expect(decision.startsRequestSeries).toBeUndefined()
    expect(harness.snapshotFor).not.toHaveBeenCalled()
  })

  it('does not duplicate the system routing contract before a current connected-service request', async () => {
    const harness = mount()
    const decision = await harness.preStep({ agent: harness.agent, turn: 1, signal: new AbortController().signal } as never, async () => ({
      kind: 'enter' as const,
      messages: [user('When was the last email from Uwe?')],
    })) as { messages: ReturnType<typeof user>[]; startsRequestSeries?: boolean }

    expect(decision.startsRequestSeries).toBeUndefined()
    expect(decision.messages).toHaveLength(1)
    expect(decision.messages[0]).toBeDefined()
    expect(JSON.stringify(decision.messages)).not.toContain('HIVE-MIND request boundary')
    expect(harness.snapshotFor).not.toHaveBeenCalled()
  })

  it('injects the authenticated profile alone for an identity request', async () => {
    const harness = mount()
    const decision = await harness.preStep({ agent: harness.agent, turn: 1, signal: new AbortController().signal } as never, async () => ({
      kind: 'enter' as const,
      messages: [user('What do you know about me?')],
    })) as { messages: ReturnType<typeof user>[]; startsRequestSeries?: boolean }

    expect(decision.startsRequestSeries).toBe(true)
    expect(decision.messages).toHaveLength(2)
    expect(decision.messages[0]?.source).toMatchObject({ kind: 'plugin', plugin: 'dsh-hivemind-runtime/identity-context' })
    expect(harness.snapshotFor).toHaveBeenCalledOnce()
  })

  it('suppresses the skill catalog when authoritative identity context is sufficient', async () => {
    const harness = mount()
    const catalog = createUserMessage({
      content: [{ type: 'text', text: 'skill catalog' }],
      source: { kind: 'skill-catalog', form: 'catalog', entries: [{ name: 'unused', description: 'unused' }] },
    })
    const request = user('What do you know about me?')
    const decision = await harness.preStep({ agent: harness.agent, turn: 1, signal: new AbortController().signal } as never, async () => ({
      kind: 'enter' as const,
      messages: [request, catalog],
    })) as { messages: ReturnType<typeof user>[] }

    expect(decision.messages).toHaveLength(2)
    expect(decision.messages[0]?.source).toMatchObject({ kind: 'plugin', plugin: 'dsh-hivemind-runtime/identity-context' })
    expect(decision.messages[1]).toBe(request)
    expect(JSON.stringify(decision.messages)).not.toContain('skill-catalog')
  })

  it.each([
    'Read my emails from a contact, then retrieve my profile bio from a connected service and save both in HIVE-MIND.',
    'Get my profile from a connected application.',
    'Compare our company profile with the latest external evidence.',
  ])('does not treat a profile mention within a workflow as an identity-only request: %s', async (request) => {
    const harness = mount()
    const message = user(request)
    const decision = await harness.preStep({ agent: harness.agent, turn: 1, signal: new AbortController().signal } as never, async () => ({
      kind: 'enter' as const, messages: [message],
    })) as { messages: ReturnType<typeof user>[] }
    expect(harness.snapshotFor).not.toHaveBeenCalled()
    expect(decision.messages.at(-1)).toBe(message)
    expect(JSON.stringify(decision.messages)).not.toContain('identity-context')
  })
})
