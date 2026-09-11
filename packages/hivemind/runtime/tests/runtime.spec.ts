import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import {
  apply, completedExchanges, hiveMemoryBudgetExhausted, hiveTurnCapabilities,
  recentConversationText, type Config,
} from '../src/index.ts'

interface HarnessMock {
  tools: Map<string, ToolDefinition>
  preStep?: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>
  inboxInserted?: (payload: { agent: Agent; message: UserMessage }) => void
  turnStopping?: (payload: { agent: Agent }) => void
  toolResult?: (execution: { agent?: Agent; name: string }) => void
  skills: Map<string, { description: string; content: string }>
}

const roots: string[] = []
const signal = new AbortController().signal
const agent = {} as Agent
const CONNECTED_TASK_NAME = 'hivemind_connected_task'

afterEach(async () => {
  delete process.env.TEST_HIVE_RUNNER_SECRET
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function authorityFile(mode = 0o600, apiUrl = 'http://127.0.0.1:3099'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-hivemind-'))
  roots.push(root)
  const path = join(root, 'icarus.json')
  await writeFile(path, JSON.stringify({
    hivemind: {
      connected: true,
      token: 'test-secret-token',
      apiUrl,
    },
  }), { mode: 0o600 })
  await chmod(path, mode)
  return path
}

function config(icarusConfigPath: string): Config {
  return {
    agentFeaturesEnabled: true,
    legacyToolsEnabled: true,
    icarusConfigPath,
    requestTimeoutMs: 2_000,
    responseMaxBytes: 64_000,
    profileContextMaxChars: 4_000,
    profileBriefMaxChars: 500,
    recallResultLimit: 7,
    recallItemMaxChars: 2_000,
    historyTurns: 5,
    historyMaxChars: 8_000,
  }
}

function mount(pluginConfig: Config): HarnessMock {
  const tools = new Map<string, ToolDefinition>()
  const skills = new Map<string, { description: string; content: string }>()
  const harness: HarnessMock = { tools, skills }
  const ctx = {
    on(event: string, listener: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) {
      if (event === 'agent/pre-step') harness.preStep = listener
      if (event === 'agent/inbox/inserted') {
        harness.inboxInserted = listener as unknown as NonNullable<HarnessMock['inboxInserted']>
      }
      if (event === 'agent/turn-stopping') {
        harness.turnStopping = listener as unknown as NonNullable<HarnessMock['turnStopping']>
      }
      if (event === 'tools/result') {
        harness.toolResult = listener as unknown as NonNullable<HarnessMock['toolResult']>
      }
      return () => {}
    },
    plugin(plugin: { apply(inner: unknown): void }) {
      plugin.apply(ctx)
      return { dispose: async () => {} }
    },
    tools: {
      get(name: string) {
        return tools.get(name)
      },
      register(tool: ToolDefinition) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
    skills: {
      register(skill: { name: string; description: string; content: string }) {
        skills.set(skill.name, skill)
        return () => skills.delete(skill.name)
      },
    },
    hivemindIdentity: { register: () => () => {} },
    hivemindExecutionScope: {
      require: () => ({
        userId: '54f5568b-4d6a-4ae1-9a33-48cb2909d59b',
        orgId: '67503d34-97e9-49a8-8c52-8ee30cc7603e',
        profile: 'hivemind-chat', variation: 'preview',
      }),
    },
  }
  apply(ctx as never, pluginConfig)
  return harness
}

function execContext(subject: Agent = agent) {
  return { agent: subject, signal } as never
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function textOfForTest(message: UserMessage): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

function user(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function profileResponses(extra: Response[] = []): void {
  const responses = [
    jsonResponse({ ok: true, profile: { user_id: 'user-1', org_id: 'org-1', name: 'Amar' } }),
    jsonResponse({ context: 'Singulance builds governed AI systems.' }),
    jsonResponse({ facts: [
      { key: 'company', value: 'Singulance' },
      { key: 'company:website', value: 'https://singulancelabs.com' },
      { key: 'company:location', value: 'Hannover, Germany' },
      { key: 'company:what_it_does', value: 'Builds governed AI systems.' },
      { key: 'company:mission', value: 'Give organizations a trustworthy company brain.' },
      { key: 'company:icp', value: 'Regulated European enterprises.' },
    ] }),
    ...extra,
  ]
  vi.stubGlobal('fetch', vi.fn(async () => {
    const next = responses.shift()
    if (next === undefined) throw new Error('unexpected fetch')
    return next
  }))
}

function tool(harness: HarnessMock, name: string): ToolDefinition {
  const definition = harness.tools.get(name)
  if (definition === undefined) throw new Error(`missing tool ${name}`)
  return definition
}

describe('HIVE-MIND runtime', () => {
  it('uses the request-scoped service proxy without reading an ICARUS credential', async () => {
    const pluginConfig = config('/does/not/exist')
    pluginConfig.authorityMode = 'scoped-service'
    pluginConfig.serviceApiBase = 'http://127.0.0.1:8081'
    pluginConfig.serviceSecretEnv = 'TEST_HIVE_RUNNER_SECRET'
    process.env.TEST_HIVE_RUNNER_SECRET = 'runner-service-secret-that-is-at-least-32-bytes'
    const requests: Array<{ url: string; authorization: string }> = []
    const responses = [
      jsonResponse({ ok: true, profile: { user_id: '54f5568b-4d6a-4ae1-9a33-48cb2909d59b', org_id: '67503d34-97e9-49a8-8c52-8ee30cc7603e' } }),
      jsonResponse({ context: 'Singulance builds governed AI systems.' }),
      jsonResponse({ facts: [{ key: 'company', value: 'Singulance' }] }),
    ]
    vi.stubGlobal('fetch', vi.fn(async (url: URL, init: RequestInit) => {
      requests.push({ url: String(url), authorization: String((init.headers as Record<string, string>).authorization) })
      return responses.shift() as Response
    }))
    const harness = mount(pluginConfig)
    await tool(harness, 'hivemind_profile_context').execute({}, execContext())
    expect(requests.map(item => item.url)).toEqual([
      'http://127.0.0.1:8081/internal/v1/harness-chat/core/api/profile',
      'http://127.0.0.1:8081/internal/v1/harness-chat/core/api/profiles/context',
      'http://127.0.0.1:8081/internal/v1/harness-chat/core/api/profiles',
    ])
    expect(requests.every(item => item.authorization.split('.').length === 3)).toBe(true)
    expect(JSON.stringify(requests)).not.toContain('ICARUS')
    delete process.env.TEST_HIVE_RUNNER_SECRET
  })

  it('uses the internal Compose control-plane origin with the runner service token', async () => {
    const pluginConfig = config('/does/not/exist')
    pluginConfig.authorityMode = 'scoped-service'
    pluginConfig.serviceApiBase = 'http://control-plane:3000'
    pluginConfig.serviceHttpOrigins = ['http://control-plane:3000']
    pluginConfig.serviceSecretEnv = 'TEST_HIVE_RUNNER_SECRET'
    process.env.TEST_HIVE_RUNNER_SECRET = 'runner-service-secret-that-is-at-least-32-bytes'
    const requests: string[] = []
    const responses = [
      jsonResponse({ ok: true, profile: { user_id: '54f5568b-4d6a-4ae1-9a33-48cb2909d59b', org_id: '67503d34-97e9-49a8-8c52-8ee30cc7603e' } }),
      jsonResponse({ context: 'Singulance builds governed AI systems.' }),
      jsonResponse({ facts: [{ key: 'company', value: 'Singulance' }] }),
    ]
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
      requests.push(String(url))
      return responses.shift() as Response
    }))
    const harness = mount(pluginConfig)
    await tool(harness, 'hivemind_profile_context').execute({}, execContext())
    expect(requests[0]).toBe('http://control-plane:3000/internal/v1/harness-chat/core/api/profile')
    delete process.env.TEST_HIVE_RUNNER_SECRET
  })

  it('rejects an ICARUS credential file writable by group', async () => {
    const path = await authorityFile(0o660)
    const harness = mount(config(path))

    await expect(tool(harness, 'hivemind_profile_context').execute({}, execContext()))
      .rejects.toThrow('ICARUS config must not be writable by group or others')
  })

  it('rejects an ICARUS API origin outside the fixed allowlist', async () => {
    const path = await authorityFile(0o600, 'https://attacker.example')
    const harness = mount(config(path))

    await expect(tool(harness, 'hivemind_profile_context').execute({}, execContext()))
      .rejects.toThrow('ICARUS API base must be HTTPS core.singulancelabs.com or loopback')
  })

  it('sanitizes transport failures even when the provider error contains the credential', async () => {
    const path = await authorityFile()
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('test-secret-token')
    }))
    const harness = mount(config(path))

    const error = await tool(harness, 'hivemind_profile_context').execute({}, execContext())
      .then(() => undefined, (failure: unknown) => failure)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toBe('HiveMindRuntimeError: hivemind-runtime: HIVE-MIND request failed')
    expect(JSON.stringify(error)).not.toContain('test-secret-token')
  })

  it('injects compact profile context before the first step and keeps tenant fields out of model-visible output', async () => {
    const path = await authorityFile()
    profileResponses()
    const harness = mount(config(path))
    const scopedAgent = {
      session: {
        surface: { nodes: [] },
        eventAt: () => undefined,
        snapshotEvents: () => [],
      },
    } as unknown as Agent
    const next = vi.fn(async () => ({
      kind: 'enter' as const,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })],
    }))
    const decision = await harness.preStep?.({ agent: scopedAgent, turn: 1, step: 0, signal }, next) as {
      kind: 'enter'
      messages: Array<{ content: Array<{ type: string; text?: string }>; source: { kind: string; plugin?: string } }>
      startsRequestSeries?: true
    }
    const value = await tool(harness, 'hivemind_profile_context').execute({}, execContext(scopedAgent))

    expect(next).toHaveBeenCalledOnce()
    expect(decision.startsRequestSeries).toBe(true)
    expect(decision.messages).toHaveLength(2)
    expect(decision.messages[0]?.source).toMatchObject({ kind: 'plugin', plugin: 'dsh-hivemind-runtime/profile' })
    expect(decision.messages[0]?.content[0]?.text).toContain('Location: Hannover, Germany')
    expect(decision.messages[0]?.content[0]?.text).toContain('Mission: Give organizations a trustworthy company brain.')
    expect(decision.messages[0]?.content[0]?.text).toContain('HIVE-MIND is the authenticated company brain')
    expect(decision.messages[0]?.content[0]?.text).toContain('Before a substantive response')
    expect(decision.messages[0]?.content[0]?.text).toContain('what do you know about me?')
    expect(decision.messages[0]?.content[0]?.text).toContain('Do not recall for greetings, general knowledge, transformations')
    expect(decision.messages[0]?.content[0]?.text).toContain('valid_at')
    expect(decision.messages[0]?.content[0]?.text).toContain('Use `save` only for a stable preference')
    expect(value).toEqual({
      status: 'ready',
      context: expect.stringContaining('Company: Singulance'),
    })
    expect(JSON.stringify(value)).not.toContain('user-1')
    expect(JSON.stringify(value)).not.toContain('org-1')
  })

  it('supplies authenticated full profile context for an identity request without a model skill load', async () => {
    const path = await authorityFile()
    profileResponses()
    const harness = mount(config(path))
    const scopedAgent = {
      session: {
        surface: { nodes: [] },
        eventAt: () => undefined,
        snapshotEvents: () => [],
      },
    } as unknown as Agent
    const decision = await harness.preStep?.({
      agent: scopedAgent,
      turn: 1,
      step: 0,
      signal,
    }, async () => ({
      kind: 'enter' as const,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'What do u know about me?' }], source: { kind: 'user' } })],
    })) as {
      kind: 'enter'
      messages: UserMessage[]
    }

    expect(decision.messages).toHaveLength(3)
    expect(decision.messages[1]?.source).toMatchObject({
      kind: 'plugin',
      plugin: 'dsh-hivemind-runtime/identity-context',
    })
    expect(textOfForTest(decision.messages[1] as UserMessage)).toContain('Singulance builds governed AI systems.')
    expect(textOfForTest(decision.messages[1] as UserMessage)).not.toContain('user-1')
    expect(harness.skills.get('hivemind-company-brain')).toMatchObject({
      invocation: { modelInvocable: false, userInvocable: true },
    })
  })

  it('selects only the HIVE routers required by the current request', () => {
    expect(hiveTurnCapabilities([user('hello')])).toEqual({ memory: false, connectedApps: false })
    expect(hiveTurnCapabilities([user('what do u know about me?')])).toEqual({ memory: false, connectedApps: false })
    expect(hiveTurnCapabilities([user('Find my last five decisions')])).toEqual({ memory: true, connectedApps: false })
    expect(hiveTurnCapabilities([user('Check my last five Gmail messages')])).toEqual({ memory: true, connectedApps: true })
    expect(hiveTurnCapabilities([user('Find my last five decisions and send them to Rama in Slack')])).toEqual({ memory: true, connectedApps: true })
  })

  it('exhausts the HIVE memory budget after one focused call in the current turn', () => {
    const events = [{
      type: 'tool/call', seq: 1, time: 1,
      data: { turn: 4, step: 1, callId: 'call-1', name: 'hivemind_meta', arguments: '{}' },
    }] as unknown as SessionEvent[]
    expect(hiveMemoryBudgetExhausted(events, 4)).toBe(true)
    expect(hiveMemoryBudgetExhausted(events, 5)).toBe(false)
    expect(hiveMemoryBudgetExhausted([{ ...events[0], data: { ...events[0]!.data, name: 'hivemind_connected_task' } }] as SessionEvent[], 4)).toBe(false)
  })

  it('removes the memory router immediately after its first settled result', async () => {
    const harness = mount(config(await authorityFile()))
    const lift = vi.fn()
    const restrict = vi.fn(() => lift)
    const scopedAgent = { ctx: { tools: { restrict } } } as unknown as Agent

    harness.toolResult?.({ agent: scopedAgent, name: 'hivemind_meta' })
    expect(restrict).toHaveBeenCalledOnce()
    expect(restrict).toHaveBeenCalledWith({ deny: ['hivemind_meta'] })

    harness.toolResult?.({ agent: scopedAgent, name: 'hivemind_meta' })
    expect(restrict).toHaveBeenCalledOnce()
    harness.turnStopping?.({ agent: scopedAgent })
    expect(lift).toHaveBeenCalledOnce()
  })

  it('removes unneeded HIVE routers before assembly and restores them after the turn', async () => {
    const harness = mount(config(await authorityFile()))
    harness.tools.set(CONNECTED_TASK_NAME, { ...tool(harness, 'hivemind_meta'), name: CONNECTED_TASK_NAME })
    const lift = vi.fn()
    const restrict = vi.fn(() => lift)
    const scopedAgent = { ctx: { tools: { restrict } } } as unknown as Agent

    harness.inboxInserted?.({ agent: scopedAgent, message: user('hello') })
    expect(restrict).toHaveBeenLastCalledWith({ deny: ['hivemind_meta', CONNECTED_TASK_NAME] })

    harness.inboxInserted?.({ agent: scopedAgent, message: user('Explain TCP congestion control') })
    expect(lift).toHaveBeenCalledOnce()
    expect(restrict).toHaveBeenLastCalledWith({ deny: [CONNECTED_TASK_NAME] })

    harness.inboxInserted?.({ agent: scopedAgent, message: user('Find my last five decisions and send them in Slack') })
    expect(lift).toHaveBeenCalledTimes(2)
    expect(restrict).toHaveBeenCalledTimes(2)

    harness.turnStopping?.({ agent: scopedAgent })
  })

  it('exposes only the progressive meta-tool when compatibility tools are disabled', async () => {
    const pluginConfig = config(await authorityFile())
    pluginConfig.legacyToolsEnabled = false
    const harness = mount(pluginConfig)

    expect([...harness.tools.keys()]).toEqual(['hivemind_meta'])
    expect(harness.skills.get('hivemind-company-brain')).toMatchObject({
      description: expect.stringContaining('Load only for a company-memory task'),
      content: expect.stringContaining('not a workspace path'),
      invocation: { modelInvocable: false, userInvocable: true },
    })
    expect(harness.skills.get('hivemind-company-brain')?.content).toContain('Never save secrets')
  })

  it('mounts connection routes without contributing model features when globally disabled', async () => {
    const pluginConfig = config(await authorityFile())
    pluginConfig.agentFeaturesEnabled = false
    const harness = mount(pluginConfig)

    expect(harness.preStep).toBeUndefined()
    expect(harness.tools.size).toBe(0)
  })

  it('projects only completed user requests and final answers', () => {
    const firstUser = createUserMessage({ content: [{ type: 'text', text: 'Question one' }], source: { kind: 'user' } })
    const toolResult = createToolResultMessage({ callId: 'call-1' as never, content: [{ type: 'text', text: 'secret tool payload' }], isError: false })
    const firstAnswer = createAssistantMessage({ content: [{ type: 'text', text: 'Final one' }], source: { provider: 'test', model: 'test' } })
    const events = [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 1, data: firstUser, surfaceOp: 'append' },
      { type: 'tool/result', seq: 2, time: 2, data: { turn: 1, step: 0, message: toolResult }, surfaceOp: 'append' },
      { type: 'assistant/message', seq: 3, time: 3, data: { turn: 1, step: 1, message: firstAnswer, stream: [] }, surfaceOp: 'append' },
      { type: 'turn/end', seq: 4, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 5, time: 5, data: { turn: 2 } },
    ] as never

    const exchanges = completedExchanges(events)
    const text = recentConversationText(exchanges, 5, 8_000)

    expect(exchanges).toEqual([{ turn: 1, user: 'Question one', assistant: 'Final one' }])
    expect(text).toContain('Question one')
    expect(text).toContain('Final one')
    expect(text).not.toContain('secret tool payload')
    expect(text).toContain('separate user message after this block is the current request')
  })

  it('bounds the projected conversation to the latest three completed exchanges', () => {
    const exchanges = [1, 2, 3, 4].map(turn => ({
      turn,
      user: `User ${turn}`,
      assistant: `Final ${turn}`,
    }))

    const text = recentConversationText(exchanges, 3, 3_000)

    expect(text).not.toContain('User 1')
    expect(text).not.toContain('Final 1')
    for (const turn of [2, 3, 4]) {
      expect(text).toContain(`User ${turn}`)
      expect(text).toContain(`Final ${turn}`)
    }
  })

  it('replaces prior tool history before a new turn while preserving the profile context', async () => {
    profileResponses()
    const profile = createUserMessage({
      content: [{ type: 'text', text: 'Organization brief' }],
      source: { kind: 'plugin', plugin: 'dsh-hivemind-runtime/profile' },
    })
    const user = createUserMessage({ content: [{ type: 'text', text: 'Find the decision' }], source: { kind: 'user' } })
    const result = createToolResultMessage({ callId: 'call-1' as never, content: [{ type: 'text', text: 'large private result' }], isError: false })
    const answer = createAssistantMessage({ content: [{ type: 'text', text: 'The decision was approved.' }], source: { provider: 'test', model: 'test' } })
    const events = [
      { type: 'user/message', seq: 0, time: 0, data: profile, surfaceOp: 'append' },
      { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 2, time: 2, data: user, surfaceOp: 'append' },
      { type: 'tool/result', seq: 3, time: 3, data: { turn: 1, step: 0, message: result }, surfaceOp: 'append' },
      { type: 'assistant/message', seq: 4, time: 4, data: { turn: 1, step: 1, message: answer, stream: [] }, surfaceOp: 'append' },
      { type: 'turn/end', seq: 5, time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 6, time: 6, data: { turn: 2 } },
    ] as unknown as SessionEvent[]
    const findEvent = (seq: number) => events.find(event => event.seq === seq)
    const append = vi.fn()
    const scopedAgent = {
      session: {
        surface: { nodes: [0, 2, 3, 4] },
        eventAt: findEvent,
        snapshotEvents: () => events,
        append,
      },
    } as unknown as Agent
    const harness = mount(config(await authorityFile()))
    const next = vi.fn(async () => ({
      kind: 'enter' as const,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'Follow up' }], source: { kind: 'user' } })],
    }))

    const decision = await harness.preStep?.({ agent: scopedAgent, turn: 2, step: 7, signal }, next) as { startsRequestSeries?: true }

    expect(decision.startsRequestSeries).toBe(true)
    expect(append).toHaveBeenCalledOnce()
    const [type, message, options] = append.mock.calls[0] as [string, UserMessage, { surfaceOp: object; sourceEventSeqs: number[] }]
    expect(type).toBe('user/message')
    expect(options).toEqual({ surfaceOp: { op: 'replace', startSeq: 2, endSeq: 4 }, sourceEventSeqs: [2, 3, 4] })
    expect(textOfForTest(message)).toContain('The decision was approved.')
    expect(textOfForTest(message)).not.toContain('large private result')

    await harness.preStep?.({ agent: scopedAgent, turn: 2, step: 8, signal }, next)
    expect(append).toHaveBeenCalledOnce()
  })

  it('sends the governed recall payload without tenant identifiers', async () => {
    const path = await authorityFile()
    profileResponses([jsonResponse({ memories: [{ id: 'memory-1', title: 'Decision', content: 'A governed memory.' }], user_id: 'user-1', org_id: 'org-1' })])
    const harness = mount(config(path))

    const value = await tool(harness, 'hivemind_recall').execute({ query: 'What did we decide?' }, execContext())
    const fetchMock = vi.mocked(fetch)
    const recallInit = fetchMock.mock.calls[3]?.[1]
    const recallBody = recallInit?.body
    const payload: unknown = JSON.parse(typeof recallBody === 'string' ? recallBody : '')

    expect(payload).toEqual({ query_context: 'What did we decide?', max_memories: 7, mode: 'memory' })
    expect(payload).not.toHaveProperty('user_id')
    expect(payload).not.toHaveProperty('org_id')
    expect(value).toEqual({
      status: 'ready',
      result: { results: [{ id: 'memory-1', title: 'Decision', content: 'A governed memory.' }], count: 1 },
    })
    expect(recallInit?.redirect).toBe('manual')
  })

  it('normalizes model-authored all-project sentinels to authenticated scope', async () => {
    const path = await authorityFile()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ memories: [] })))
    const harness = mount(config(path))

    await tool(harness, 'hivemind_meta').execute({
      operation: 'recall',
      recall: { query: 'Named document', project: 'all' },
    }, execContext())
    const recallBody = vi.mocked(fetch).mock.calls[0]?.[1]?.body
    const payload: unknown = JSON.parse(typeof recallBody === 'string' ? recallBody : '')

    expect(payload).not.toHaveProperty('project')
  })

  it('converts focused media recall inputs into authenticated evidence filters', async () => {
    const path = await authorityFile()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ memories: [] })))
    const harness = mount(config(path))

    await tool(harness, 'hivemind_meta').execute({
      operation: 'recall',
      recall: {
        query: 'image.jpg glass cafe',
        mode: 'evidence',
        media_kind: 'image',
        filename: 'image.jpg',
        entities: ['glass', 'cafe'],
        source_platforms: ['knowledge-upload'],
        tags: ['image'],
        sort: 'date_desc',
      },
    }, execContext())
    const recallBody = vi.mocked(fetch).mock.calls[0]?.[1]?.body
    const payload: unknown = JSON.parse(typeof recallBody === 'string' ? recallBody : '')

    expect(payload).toEqual({
      query_context: 'image.jpg glass cafe',
      max_memories: 7,
      mode: 'evidence',
      tags: ['image', 'kind:image', 'filename:image.jpg', 'entity:glass', 'entity:cafe'],
      source_platforms: ['knowledge-upload'],
      sort: 'date_desc',
    })
  })

  it('saves only a bounded, profile-scoped memory and returns a compact receipt', async () => {
    const path = await authorityFile()
    profileResponses([jsonResponse({
      id: 'memory-1',
      title: 'Approved positioning',
      memory_type: 'decision',
      citation_id: 'memory:memory-1',
      user_id: 'user-1',
      org_id: 'org-1',
    })])
    const harness = mount(config(path))

    const value = await tool(harness, 'hivemind_meta').execute({
      operation: 'save',
      save: {
        title: 'Approved positioning',
        content: 'The team confirmed the privacy-first positioning.',
        source_type: 'decision',
        tags: ['positioning'],
      },
    }, execContext())
    const saveInit = vi.mocked(fetch).mock.calls[3]?.[1]
    const saveBody = JSON.parse(String(saveInit?.body))

    expect(saveInit).toMatchObject({ method: 'POST', redirect: 'manual' })
    expect(saveBody).toMatchObject({
      title: 'Approved positioning',
      memory_type: 'decision',
      source_platform: 'deepseek-harness',
      user_id: 'user-1',
      org_id: 'org-1',
      smartIngest: true,
      sync: true,
    })
    expect(value).toEqual({
      status: 'saved',
      id: 'memory-1',
      title: 'Approved positioning',
      memory_type: 'decision',
      citation_id: 'memory:memory-1',
    })
    expect(JSON.stringify(value)).not.toContain('user-1')
    expect(JSON.stringify(value)).not.toContain('org-1')
  })

  it('rejects a correction without the exact prior-memory reference', async () => {
    const harness = mount(config(await authorityFile()))
    await expect(tool(harness, 'hivemind_meta').execute({
      operation: 'save',
      save: { title: 'Correction', content: 'Corrected fact.', relationship: 'update' },
    }, execContext())).rejects.toThrow('related_to is required when relationship is set')
  })

  it('refuses credential-shaped memory content before making a network request', async () => {
    const harness = mount(config(await authorityFile()))
    await expect(tool(harness, 'hivemind_meta').execute({
      operation: 'save',
      save: { title: 'Credential', content: 'api_key: sk_abcdefghijklmnop' },
    }, execContext())).rejects.toThrow('save refuses credential material')
  })

  it('maps a correction to the canonical version relationship after validating its prior id', async () => {
    const path = await authorityFile()
    profileResponses([jsonResponse({ id: 'replacement-id' })])
    const harness = mount(config(path))

    await tool(harness, 'hivemind_meta').execute({
      operation: 'save',
      save: { title: 'Correction', content: 'Corrected fact.', relationship: 'update', related_to: 'prior-id' },
    }, execContext())
    const saveBody = JSON.parse(String(vi.mocked(fetch).mock.calls[3]?.[1]?.body))

    expect(saveBody.relationship).toEqual({ type: 'Updates', target_id: 'prior-id' })
  })

  it('returns one bounded evidence list instead of the verbose recall transport envelope', async () => {
    const path = await authorityFile()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      memories: [{ id: 'duplicate', content: 'transport copy' }],
      raw: [{ id: 'duplicate', content: 'raw copy', user_id: 'user-1', org_id: 'org-1' }],
      spine: { supporting_facts: [{ id: 'duplicate', content: 'spine copy' }] },
      results: [{
        id: 'memory-1',
        title: 'Named document fact',
        content: 'A'.repeat(2_500),
        citation_id: 'memory:memory-1',
        source: 'knowledge_base',
        score: 0.97,
      }],
      mode_used: 'memory',
      search_method: 'persisted-hybrid',
      timing_ms: 42,
    })))
    const harness = mount(config(path))

    const value = await tool(harness, 'hivemind_meta').execute({
      operation: 'recall',
      recall: { query: 'Named document' },
    }, execContext()) as { result: Record<string, unknown> }

    expect(value.result).not.toHaveProperty('memories')
    expect(value.result).not.toHaveProperty('raw')
    expect(value.result).not.toHaveProperty('spine')
    expect(value.result).toMatchObject({
      count: 1,
      mode_used: 'memory',
      search_method: 'persisted-hybrid',
      timing_ms: 42,
    })
    const results = value.result.results as Array<Record<string, unknown>>
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      id: 'memory-1',
      title: 'Named document fact',
      citation_id: 'memory:memory-1',
      source: 'knowledge_base',
      score: 0.97,
    })
    expect(String(results[0]?.content)).toHaveLength(2_000)
  })

  it('fetches server-scoped HyperAgent profiles without model-provided tenant input', async () => {
    const path = await authorityFile()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      ok: true,
      contract: 'hivemind.hyperagent-profiles.v1',
      scope: { user_id: 'user-1', org_id: 'org-1', authority: 'server-derived-from-api-key' },
      profiles: [{
        id: 'marta',
        name: 'Marta Silva',
        slug: 'marta-silva',
        avatar_url: 'https://cdn.example/marta.png',
        team_id: 'legal',
        scope: 'organization',
        status: 'active',
        persona: 'Challenge unsupported compliance claims.',
        role_archetype: 'Skeptic',
        peer_review_targets: ['ravi'],
        tools: ['hivemind_recall'],
        policy_rules: { requires_evidence: true },
        persona_contract: { version: 'v1' },
        active_prompt_version: '2026-09-07',
      }],
      count: 1,
      generated_at: '2026-09-07T00:00:00.000Z',
    })))
    const harness = mount(config(path))

    const value = await tool(harness, 'hivemind_hyperagent_profiles').execute({}, execContext())
    const [request, init] = vi.mocked(fetch).mock.calls[0] ?? []

    const requestUrl = typeof request === 'string' ? request : request instanceof URL ? request.href : request?.url
    expect(requestUrl).toBe('https://api.singulancelabs.com/v1/hyperagents/profiles')
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual' })
    expect(init?.headers).toMatchObject({ accept: 'application/json', authorization: 'Bearer test-secret-token' })
    expect(value).toMatchObject({ status: 'ready', contract: 'hivemind.hyperagent-profiles.v1', count: 1 })
    expect(JSON.stringify(value)).not.toContain('user-1')
    expect(JSON.stringify(value)).not.toContain('org-1')
  })

  it('omits tenant parameters from every tool schema', async () => {
    const harness = mount(config(await authorityFile()))

    for (const definition of harness.tools.values()) {
      const serialized = JSON.stringify(definition.parameters)
      expect(serialized).not.toContain('user_id')
      expect(serialized).not.toContain('org_id')
    }
  })

})
