import { describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
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
