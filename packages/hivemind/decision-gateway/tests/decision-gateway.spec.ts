import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply, type Config } from '../src/index.ts'

const secret = 'decision-gateway-test-secret-at-least-32-bytes'

function config(mode: Config['mode'] = 'active'): Config {
  return {
    mode,
    serviceApiBase: 'http://control-plane:3000',
    serviceHttpOrigins: [],
    serviceSecretEnv: 'TEST_DECISION_SECRET',
    timeoutMs: 1_000,
  }
}

function user(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function mount(pluginConfig: Config) {
  let preStep: ((payload: never, next: () => Promise<unknown>) => Promise<unknown>) | undefined
  const ctx = {
    effect(callback: () => (() => void) | undefined) { return callback() },
    on(event: string, listener: typeof preStep) {
      if (event === 'agent/pre-step') preStep = listener
      return () => {}
    },
    hivemindExecutionScope: {
      require: () => ({ userId: 'user-1', orgId: 'org-1', profile: 'hivemind-chat' }),
    },
  }
  apply(ctx as never, pluginConfig)
  return { preStep }
}

function agent() {
  const append = vi.fn()
  const releases: Array<ReturnType<typeof vi.fn>> = []
  const restrict = vi.fn(() => {
    const release = vi.fn()
    releases.push(release)
    return release
  })
  const tools = new Map([['hivemind_meta', {}], ['hivemind_save_memory', {}], ['hivemind_update_profile', {}], ['hivemind_connected_task', {}]])
  return {
    value: {
      session: { append },
      ctx: { tools: { get: (name: string) => tools.get(name), restrict } },
    } as unknown as Agent,
    append,
    restrict,
    releases,
  }
}

afterEach(() => {
  delete process.env.TEST_DECISION_SECRET
  vi.restoreAllMocks()
})

describe('HIVE decision gateway consumer', () => {
  it('narrows only the admitted first request and lifts the restriction before continuation', async () => {
    process.env.TEST_DECISION_SECRET = secret
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      status: 'selected', mode: 'active', selected: 'composio_search', authoritative: true,
      receipt: { source: 'jev' },
    }))))
    const harness = mount(config())
    const subject = agent()
    const enter = async () => ({ kind: 'enter' as const, messages: [user('Find my latest Gmail message')] })

    await harness.preStep?.({ agent: subject.value, turn: 1, step: 1, signal: new AbortController().signal } as never, enter)
    expect(subject.restrict).toHaveBeenCalledWith({ allow: ['hivemind_connected_task'] })
    expect(subject.append).toHaveBeenCalledWith('hivemind/decision', expect.objectContaining({ status: 'selected', selected: 'composio_search' }), { ignorable: true })

    await harness.preStep?.({ agent: subject.value, turn: 1, step: 2, signal: new AbortController().signal } as never,
      async () => ({ kind: 'enter' as const, messages: [] }))
    expect(subject.releases[0]).toHaveBeenCalledOnce()
  })

  it('keeps the current tool surface when Core defers or fails', async () => {
    process.env.TEST_DECISION_SECRET = secret
    const responses = [
      new Response(JSON.stringify({ status: 'defer', mode: 'active', authoritative: false, reason: 'low_confidence' })),
      new Response('unavailable', { status: 503 }),
    ]
    vi.stubGlobal('fetch', vi.fn(async () => responses.shift()!))
    const harness = mount(config())
    const subject = agent()
    const enter = async () => ({ kind: 'enter' as const, messages: [user('Handle this')] })

    await harness.preStep?.({ agent: subject.value, turn: 1, step: 1, signal: new AbortController().signal } as never, enter)
    await harness.preStep?.({ agent: subject.value, turn: 2, step: 1, signal: new AbortController().signal } as never, enter)

    expect(subject.restrict).not.toHaveBeenCalled()
    expect(subject.append).toHaveBeenNthCalledWith(1, 'hivemind/decision', expect.objectContaining({ status: 'defer' }), { ignorable: true })
    expect(subject.append).toHaveBeenNthCalledWith(2, 'hivemind/decision', expect.objectContaining({ status: 'defer', reason: 'decision service returned 503' }), { ignorable: true })
  })

  it('exposes only the direct memory-save tool for an admitted save intent', async () => {
    process.env.TEST_DECISION_SECRET = secret
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      status: 'selected', mode: 'active', selected: 'hivemind_save', authoritative: true,
      receipt: { source: 'deterministic', reason: 'explicit_hivemind_save_intent' },
    }))))
    const harness = mount(config())
    const subject = agent()

    await harness.preStep?.({ agent: subject.value, turn: 1, step: 1, signal: new AbortController().signal } as never,
      async () => ({ kind: 'enter' as const, messages: [user('save this to hivemind')] }))

    expect(subject.restrict).toHaveBeenCalledWith({ allow: ['hivemind_save_memory'] })
  })

  it('exposes only profile update for an admitted profile change', async () => {
    process.env.TEST_DECISION_SECRET = secret
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      status: 'selected', mode: 'active', selected: 'hivemind_profile_update', authoritative: true,
      receipt: { source: 'jev' },
    }))))
    const harness = mount(config())
    const subject = agent()

    await harness.preStep?.({ agent: subject.value, turn: 1, step: 1, signal: new AbortController().signal } as never,
      async () => ({ kind: 'enter' as const, messages: [user('change my name to ASTER HELIUS')] }))

    expect(subject.restrict).toHaveBeenCalledWith({ allow: ['hivemind_update_profile'] })
  })

  it('off mode registers no pre-step listener', () => {
    expect(mount(config('off')).preStep).toBeUndefined()
  })
})
