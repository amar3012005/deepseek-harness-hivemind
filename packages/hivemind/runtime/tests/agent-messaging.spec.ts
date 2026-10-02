import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { installAgentMessaging } from '../src/agent-messaging.ts'

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
