import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply, type Config } from '../src/index.ts'

const originalFetch = globalThis.fetch

afterEach(() => { globalThis.fetch = originalFetch })

async function setup(
  snapshotEvents?: ReadonlyArray<{ type: string; data: unknown }>,
  jobs?: { start(spec: { run(): { done: Promise<unknown> } }): unknown },
  executionMode: 'remote' | 'local-web' = 'remote',
  configured: Partial<Config> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'hivemind-research-'))
  const configPath = join(directory, 'icarus.json')
  await writeFile(configPath, JSON.stringify({ hivemind: { connected: true, token: 'test-token', apiUrl: 'http://127.0.0.1:8787' } }), { mode: 0o600 })
  const tools = new Map<string, ToolDefinition>()
  const events: Array<{ type: string; data: unknown }> = []
  const hooks = new Map<string, (...args: unknown[]) => unknown>()
  const ctx = {
    tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {} } },
    hivemindExecutionScope: { require() { return { userId: 'user-1', orgId: 'org-1', profile: 'hivemind-chat' as const, variation: 'test' } } },
    web: {
      search: vi.fn(async (_query: { query: string }, _signal: AbortSignal) => ({ sources: [{ url: 'https://parallel.test/source', title: 'Parallel source', snippet: 'Current evidence.' }], truncated: false })),
      fetch: vi.fn(async ({ url }: { url: string }) => ({ url, statusCode: 200, body: { kind: 'html' as const, content: '<title>Official page</title><main>First-party evidence.</main>' }, truncated: false })),
    },
    get(name: string) { return name === 'jobs' ? jobs : undefined },
    on(name: string, listener: (...args: unknown[]) => unknown) { hooks.set(name, listener); return () => {} },
  }
  apply(ctx as never, { icarusConfigPath: configPath, maxResults: 5, maxUrls: 4, executionMode, ...configured })
  const request = tools.get('hivemind_research_request')
  const status = tools.get('hivemind_research_status')
  const gather = tools.get('hivemind_research_gather')
  const answer = tools.get('hivemind_research_answer')
  if (request === undefined || status === undefined || gather === undefined || answer === undefined) throw new Error('research tools were not registered')
  const agent = {
    session: {
      append(type: string, data: unknown) { events.push({ type, data }) },
      ...(snapshotEvents === undefined ? {} : { snapshotEvents() { return [...snapshotEvents, ...events] } }),
    },
  } as unknown as Agent
  return { request, status, gather, answer, agent, events, hooks, web: ctx.web }
}

describe('hivemind research tools', () => {
  it('runs a citation-ready research answer through one concurrent gather phase', async () => {
    const { answer, agent, events, web } = await setup([{ type: 'turn/start', data: { turn: 1 } }], undefined, 'local-web')
    let active = 0
    let peak = 0
    web.search.mockImplementation(async () => {
      active += 1
      peak = Math.max(peak, active)
      await Promise.resolve()
      active -= 1
      return { sources: [{ url: `https://parallel.test/${active}`, title: 'Official evidence', snippet: 'Cited evidence.' }], truncated: false }
    })

    await expect(answer.execute({
      objective: 'Research the current official DORA requirements for insurers.',
      questions: ['DORA insurer scope and application date.', 'DORA ICT third-party risk requirements for insurers.'],
      source_requirements: ['first_party', 'regulator'],
    }, { agent, signal: new AbortController().signal } as never)).resolves.toMatchObject({
      status: 'succeeded',
      all_objectives_terminal: true,
      next: 'All listed evidence states are terminal. Synthesize from this combined receipt; do not call research_status or launch duplicate research for covered objectives.',
    })
    expect(peak).toBe(3)
    expect(web.search.mock.calls.map(([query]) => query.query)).toEqual([
      'Research the current official DORA requirements for insurers.',
      'DORA insurer scope and application date.',
      'DORA ICT third-party risk requirements for insurers.',
    ])
    expect(events.map(event => event.type)).toEqual([
      'hivemind/research-workflow-started',
      'hivemind/research-requested', 'hivemind/research-receipt',
      'hivemind/research-requested', 'hivemind/research-receipt',
      'hivemind/research-requested', 'hivemind/research-receipt',
      'hivemind/research-gathered',
      'hivemind/research-workflow-terminal',
    ])
    expect(events.at(-1)?.data).toMatchObject({ status: 'completed', evidenceState: 'ready', turn: 1 })
  })

  it('does not reopen a terminal research task during the same user turn', async () => {
    const { answer, agent, events, web } = await setup([{ type: 'turn/start', data: { turn: 7 } }], undefined, 'local-web')
    const first = await answer.execute({ objective: 'Find current official DORA requirements.' }, { agent, signal: new AbortController().signal } as never)
    const beforeDuplicate = web.search.mock.calls.length

    await expect(answer.execute({ objective: 'Summarize the current official DORA requirements and cite the regulator sources.' }, { agent, signal: new AbortController().signal } as never)).resolves.toMatchObject({
      status: 'already_completed',
      workflow: { status: 'completed', turn: 7 },
    })

    expect(first).toMatchObject({ status: 'succeeded' })
    expect(web.search).toHaveBeenCalledTimes(beforeDuplicate)
    expect(events.filter(event => event.type === 'hivemind/research-workflow-started')).toHaveLength(1)
    expect(events.filter(event => event.type === 'hivemind/research-workflow-terminal')).toHaveLength(1)
  })

  it('keeps a queued remote task active until its durable job receipt settles', async () => {
    const { answer, agent, events } = await setup([{ type: 'turn/start', data: { turn: 9 } }], undefined, 'remote', { inlineWaitMs: 0 })
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ job_id: 'queued-1', status: 'queued' }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'queued-1', status: 'queued', results: [] }), { status: 200 })) as typeof globalThis.fetch

    await expect(answer.execute({ objective: 'Track a pending regulator update.' }, { agent, signal: new AbortController().signal } as never)).resolves.toMatchObject({
      all_objectives_terminal: false,
      workflow: { status: 'running', turn: 9 },
    })

    expect(events.map(event => event.type)).toEqual([
      'hivemind/research-workflow-started',
      'hivemind/research-requested',
      'hivemind/research-receipt',
    ])
  })

  it('records cancellation as a terminal task state without an automatic retry', async () => {
    const { answer, agent, events, web } = await setup([{ type: 'turn/start', data: { turn: 11 } }], undefined, 'local-web')
    web.search.mockImplementation(async (_query: unknown, signal: AbortSignal) => {
      signal.throwIfAborted()
      return { sources: [], truncated: false }
    })
    const controller = new AbortController()
    controller.abort(new Error('user cancelled'))

    await expect(answer.execute({ objective: 'Find current public evidence.' }, { agent, signal: controller.signal } as never)).resolves.toMatchObject({
      status: 'cancelled',
      workflow: { status: 'cancelled', turn: 11 },
    })
    expect(events.at(-1)?.data).toMatchObject({ status: 'cancelled', evidenceState: 'unavailable' })
  })

  it('can expose only the stable research-answer entry point', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hivemind-research-lean-'))
    const configPath = join(directory, 'icarus.json')
    await writeFile(configPath, JSON.stringify({ hivemind: { connected: true, token: 'test-token', apiUrl: 'http://127.0.0.1:8787' } }), { mode: 0o600 })
    const tools = new Map<string, ToolDefinition>()
    const ctx = {
      tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {} } },
      hivemindExecutionScope: { require() { return { userId: 'user-1', orgId: 'org-1', profile: 'hivemind-chat' as const, variation: 'test' } } },
      web: {
        search: vi.fn(async () => ({ sources: [], truncated: false })),
        fetch: vi.fn(),
      },
      get() { return undefined },
      on() { return () => {} },
    }
    apply(ctx as never, { icarusConfigPath: configPath, executionMode: 'local-web', exposeAdvancedTools: false })
    expect([...tools.keys()]).toEqual(['hivemind_research_answer'])
  })

  it('leaves terminal local evidence in the native tool result when continuation injection is disabled', async () => {
    const { hooks } = await setup(undefined, undefined, 'local-web', { injectTerminalReceipts: false })

    expect(hooks.get('agent/pre-step')).toBeUndefined()
  })

  it('fans out independent objectives concurrently and returns one deduplicated gather receipt', async () => {
    const { gather, agent, events, hooks, web } = await setup([{ type: 'hivemind/run-plan', data: { runId: 'run-gather', planId: 'plan-gather' } }], undefined, 'local-web')
    let active = 0
    let peak = 0
    web.search.mockImplementation(async ({ query }: { query: string }) => {
      active += 1
      peak = Math.max(peak, active)
      await Promise.resolve()
      active -= 1
      return { sources: [
        { url: 'https://example.test/shared', title: 'Shared', snippet: query },
        { url: `https://example.test/${query.includes('regulation') ? 'regulation' : 'adoption'}`, title: query, snippet: 'Evidence.' },
      ], truncated: false }
    })

    const result = await gather.execute({
      objectives: ['Find current banking regulation evidence.', 'Find current banking adoption evidence.'],
      source_requirements: ['first_party'],
      limit_per_objective: 3,
    }, { agent, signal: new AbortController().signal } as never) as {
      receipt: { sources: Array<{ url: string }> }
    }

    expect(peak).toBe(2)
    expect(result).toMatchObject({ status: 'succeeded', receipt: { runId: 'run-gather', provider: 'parallel' } })
    expect(result.receipt.sources.map((source: { url: string }) => source.url)).toEqual([
      'https://example.test/shared',
      'https://example.test/regulation',
      'https://example.test/adoption',
    ])
    expect(events.map(event => event.type)).toEqual([
      'hivemind/research-requested', 'hivemind/research-receipt',
      'hivemind/research-requested', 'hivemind/research-receipt',
      'hivemind/research-gathered',
    ])
    const preStep = hooks.get('agent/pre-step')
    if (preStep === undefined) throw new Error('research completion hook was not registered')
    const next = async () => ({ kind: 'enter' as const, messages: [], startsRequestSeries: false })
    await expect(preStep({ agent }, next)).resolves.toMatchObject({ messages: [] })

    const replayAgent = { session: { append(type: string, data: unknown) { events.push({ type, data }) }, snapshotEvents() { return [
      { type: 'hivemind/run-plan', data: { runId: 'run-gather', planId: 'plan-gather' } },
      ...events,
    ] } } } as unknown as Agent
    const before = web.search.mock.calls.length
    await expect(gather.execute({ objectives: ['A new question.', 'Another new question.'] }, { agent: replayAgent, signal: new AbortController().signal } as never)).resolves.toMatchObject({ status: 'already_gathered' })
    expect(web.search).toHaveBeenCalledTimes(before)
  })

  it('keeps successful gather evidence when another lane fails', async () => {
    const { gather, agent, web } = await setup(undefined, undefined, 'local-web')
    web.search.mockImplementation(async ({ query }: { query: string }) => {
      if (query.includes('fails')) throw new Error('provider unavailable')
      return { sources: [{ url: 'https://example.test/ready', title: 'Ready', snippet: 'Evidence.' }], truncated: false }
    })
    await expect(gather.execute({ objectives: ['This succeeds.', 'This fails.'] }, { agent, signal: new AbortController().signal } as never)).resolves.toMatchObject({
      status: 'partial',
      receipt: { objectives: [{ evidenceState: 'ready' }, { evidenceState: 'unavailable', error: 'provider unavailable' }] },
    })
  })

  it('accepts one evidence objective while still rejecting duplicate gather work', async () => {
    const { gather, agent, web } = await setup(undefined, undefined, 'local-web')
    await expect(gather.execute({ objectives: ['Only one.'] }, { agent, signal: new AbortController().signal } as never)).resolves.toMatchObject({
      status: 'succeeded',
      receipt: { objectives: [{ objective: 'Only one.', evidenceState: 'ready' }] },
    })
    const beforeDuplicate = web.search.mock.calls.length
    await expect(gather.execute({ objectives: ['Same.', 'Same.'] }, { agent, signal: new AbortController().signal } as never)).rejects.toThrow('must be unique')
    expect(web.search).toHaveBeenCalledTimes(beforeDuplicate)
  })

  it('executes research locally through the configured Harness web provider', async () => {
    const { request, status, agent, events, web } = await setup(undefined, undefined, 'local-web')
    const result = await request.execute(
      { objective: 'Find current regulator evidence.', research_type: 'focused_fact' },
      { agent, signal: new AbortController().signal } as never,
    ) as { receipt: { jobId: string; sources: Array<{ url: string }> } }
    expect(web.search).toHaveBeenCalledWith({ query: 'Find current regulator evidence.', maxResults: 5 }, expect.any(AbortSignal))
    expect(result).toMatchObject({
      status: 'succeeded',
      research: { route: 'local:web' },
      receipt: { provider: 'parallel', evidenceState: 'ready', sources: [{ url: 'https://parallel.test/source' }] },
    })
    expect(globalThis.fetch).toBe(originalFetch)
    await expect(status.execute({ job_id: result.receipt.jobId }, { agent: { session: { ...agent.session, snapshotEvents: () => events } }, signal: new AbortController().signal } as never)).resolves.toMatchObject({ receipt: { provider: 'parallel' } })
  })

  it('resolves the leading first-party URL and title within the same governed request', async () => {
    const { request, agent, web } = await setup(undefined, undefined, 'local-web')
    web.fetch.mockResolvedValueOnce({
      url: 'https://parallel.test/source/canonical',
      statusCode: 200,
      body: { kind: 'html', content: '<html><head><title>Canonical Search Docs</title></head><body>Evidence</body></html>' },
      truncated: false,
    })
    const result = await request.execute({
      objective: 'Find the official documentation title and URL.',
      research_type: 'focused_fact',
      source_requirements: ['first_party'],
    }, { agent, signal: new AbortController().signal } as never) as {
      receipt: { sources: Array<{ url: string; title?: string }> }
      next: string
    }

    expect(web.fetch).toHaveBeenCalledTimes(1)
    expect(result.receipt.sources[0]).toMatchObject({
      url: 'https://parallel.test/source/canonical',
      title: 'Canonical Search Docs',
    })
    expect(result.next).toContain('already includes its resolved URL and document title')
  })

  it('keeps full durable evidence while bounding excerpts returned to the model', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hivemind-research-'))
    const configPath = join(directory, 'icarus.json')
    await writeFile(configPath, JSON.stringify({ hivemind: { connected: true, token: 'test-token', apiUrl: 'http://127.0.0.1:8787' } }), { mode: 0o600 })
    const tools = new Map<string, ToolDefinition>()
    const events: Array<{ type: string; data: unknown }> = []
    const fullExcerpt = 'e'.repeat(600)
    const ctx = {
      tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {} } },
      hivemindExecutionScope: { require() { return { userId: 'user-1', orgId: 'org-1', profile: 'hivemind-chat' as const, variation: 'test' } } },
      web: {
        search: vi.fn(async () => ({ sources: [{ url: 'https://parallel.test/source', title: 'Parallel source', snippet: fullExcerpt }], truncated: false })),
        fetch: vi.fn(),
      },
      get() { return undefined },
      on() { return () => {} },
    }
    apply(ctx as never, { icarusConfigPath: configPath, maxResults: 5, maxUrls: 4, modelExcerptChars: 120, executionMode: 'local-web' })
    const request = tools.get('hivemind_research_request')
    if (request === undefined) throw new Error('research tool was not registered')
    const agent = { session: { append(type: string, data: unknown) { events.push({ type, data }) } } } as unknown as Agent
    const result = await request.execute(
      { objective: 'Find current evidence.', research_type: 'focused_fact' },
      { agent, signal: new AbortController().signal } as never,
    ) as { receipt: { sources: Array<{ excerpt: string }> } }
    expect(result.receipt.sources[0]?.excerpt).toHaveLength(120)
    expect((events.at(-1)?.data as { sources: Array<{ excerpt: string }> }).sources[0]?.excerpt).toHaveLength(600)
  })

  it('routes a known URL to a governed crawl and persists the request receipt', async () => {
    const { request, agent, events } = await setup()
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ job_id: 'crawl-1', status: 'queued' }), { status: 202 }))
    globalThis.fetch = fetch as typeof globalThis.fetch
    await expect(request.execute({ objective: 'Extract the privacy policy.', research_type: 'known_url', urls: ['https://example.test/privacy'], limit: 3, wait_for_result: false }, { agent, signal: new AbortController().signal } as never)).resolves.toMatchObject({ research: { jobId: 'crawl-1', type: 'known_url', route: '/api/web/crawl/jobs' } })
    expect(fetch).toHaveBeenCalledWith(new URL('http://127.0.0.1:8787/api/web/crawl/jobs'), expect.objectContaining({ method: 'POST' }))
    expect(events).toEqual([{ type: 'hivemind/research-requested', data: expect.objectContaining({ jobId: 'crawl-1', objective: 'Extract the privacy policy.' }) }])
  })

  it('caps an oversized positive result request at the deployment bound', async () => {
    const { request, agent } = await setup()
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ job_id: 'search-capped', status: 'queued' }), { status: 202 }))
    globalThis.fetch = fetch as typeof globalThis.fetch
    await request.execute({ objective: 'Find current evidence.', research_type: 'focused_fact', limit: 12, wait_for_result: false }, { agent, signal: new AbortController().signal } as never)
    expect(JSON.parse(String((fetch.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({ limit: 5 })
  })

  it('automatically links research receipts to the active operating run', async () => {
    const { request, agent, events } = await setup([{ type: 'hivemind/run-plan', data: { runId: 'run-market' } }])
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ job_id: 'crawl-run', status: 'queued' }), { status: 202 })) as typeof globalThis.fetch
    await request.execute({ objective: 'Retrieve current banking evidence.', research_type: 'focused_fact', wait_for_result: false }, { agent, signal: new AbortController().signal } as never)
    expect(events).toEqual([{ type: 'hivemind/research-requested', data: expect.objectContaining({ jobId: 'crawl-run', runId: 'run-market' }) }])
  })

  it('routes multi-hop work to durable research and preserves a failed status as a receipt', async () => {
    const { request, status, agent, events } = await setup()
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ job_id: 'research-1', status: 'queued' }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'research-1', status: 'failed', runtime_used: 'lightpanda', error: 'provider_timeout', results: [] }), { status: 200 })) as typeof globalThis.fetch
    await request.execute({ objective: 'Compare sovereign AI markets.', research_type: 'multi_hop', wait_for_result: false }, { agent, signal: new AbortController().signal } as never)
    await expect(status.execute({ job_id: 'research-1' }, { agent, signal: new AbortController().signal } as never)).resolves.toMatchObject({ status: 'failed', receipt: { jobId: 'research-1', provider: 'lightpanda', error: 'provider_timeout' } })
    expect(events.at(-1)).toEqual({ type: 'hivemind/research-receipt', data: expect.objectContaining({ status: 'failed' }) })
  })

  it('returns a compact source receipt rather than a provider-specific raw job payload', async () => {
    const { status, agent, events } = await setup()
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'search-1',
      status: 'succeeded',
      runtime_used: 'tavily',
      results: [
        { title: 'Official launch', url: 'https://example.test/launch', snippet: 'Primary evidence.' },
        { title: 'Duplicate', url: 'https://example.test/launch', snippet: 'Must be deduplicated.' },
        { title: 'Ignored', url: 'file:///private/path', snippet: 'Not web evidence.' },
      ],
      internal_provider_trace: { secret: 'must-not-reach-model' },
    }), { status: 200 })) as typeof globalThis.fetch

    await expect(status.execute({ job_id: 'search-1' }, { agent, signal: new AbortController().signal } as never)).resolves.toEqual({
      status: 'succeeded',
      receipt: {
        jobId: 'search-1',
        status: 'succeeded',
        provider: 'tavily',
        resultCount: 3,
        evidenceState: 'ready',
        sources: [{ url: 'https://example.test/launch', title: 'Official launch', excerpt: 'Primary evidence.' }],
      },
      next: 'This job is already terminal. Use the cited sources, or open one returned URL with the browser capability only when rendered page evidence is needed; do not poll it again.',
    })
    expect(events.at(-1)).toEqual({ type: 'hivemind/research-receipt', data: expect.objectContaining({ evidenceState: 'ready', sources: [{ url: 'https://example.test/launch', title: 'Official launch', excerpt: 'Primary evidence.' }] }) })
  })

  it('waits briefly for the just-created job and records a terminal receipt by default', async () => {
    const { request, agent, events } = await setup()
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ job_id: 'research-inline', status: 'queued' }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'research-inline', status: 'succeeded', runtime_used: 'tavily', results: [{ title: 'EU source', url: 'https://example.test/eu', snippet: 'Current evidence.' }] }), { status: 200 })) as typeof globalThis.fetch

    await expect(request.execute({ objective: 'Validate current EU demand.', research_type: 'focused_fact' }, { agent, signal: new AbortController().signal } as never)).resolves.toMatchObject({
      status: 'succeeded',
      receipt: { jobId: 'research-inline', evidenceState: 'ready', sources: [{ url: 'https://example.test/eu' }] },
    })
    expect(events.map(event => event.type)).toEqual(['hivemind/research-requested', 'hivemind/research-receipt'])
  })

  it('routes production research through the authenticated HIVE job proxy', async () => {
    vi.stubEnv('HIVE_TEST_SERVICE_SECRET', 'test-secret-with-at-least-thirty-two-bytes')
    try {
      const { request, agent } = await setup(undefined, undefined, 'remote', {
        authorityMode: 'scoped-service',
        serviceApiBase: 'http://control-plane:3000',
        serviceSecretEnv: 'HIVE_TEST_SERVICE_SECRET',
      })
      const calls: Array<{ url: string; authorization: string }> = []
      globalThis.fetch = vi.fn(async (url, init) => {
        calls.push({
          url: String(url),
          authorization: String(new Headers(init?.headers).get('authorization')),
        })
        return calls.length === 1
          ? new Response(JSON.stringify({ job_id: 'scoped-1', status: 'queued' }), { status: 202 })
          : new Response(JSON.stringify({ id: 'scoped-1', status: 'succeeded', runtime_used: 'tavily', results: [
            { title: 'Regulator source', url: 'https://example.test/regulator', snippet: 'Primary evidence.' },
          ] }), { status: 200 })
      }) as typeof globalThis.fetch

      await expect(request.execute({ objective: 'Find official DORA obligations.' }, {
        agent, signal: new AbortController().signal,
      } as never)).resolves.toMatchObject({ receipt: { evidenceState: 'ready', provider: 'tavily' } })
      expect(calls.map(call => call.url)).toEqual([
        'http://control-plane:3000/internal/v1/harness-chat/core/api/web/search/jobs',
        'http://control-plane:3000/internal/v1/harness-chat/core/api/web/jobs/scoped-1',
      ])
      expect(calls.every(call => call.authorization.startsWith('Bearer '))).toBe(true)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('uses the native job registry to watch a pending durable receipt without a second model tool call', async () => {
    const started: Array<{ run(): { done: Promise<unknown> } }> = []
    const { status, agent, events } = await setup(undefined, { start(spec) { started.push(spec); return 'hivemind_research-1' } })
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'research-pending', status: 'queued', results: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'research-pending', status: 'succeeded', runtime_used: 'parallel', results: [{ title: 'Evidence', url: 'https://example.test/evidence' }] }), { status: 200 })) as typeof globalThis.fetch

    await expect(status.execute({ job_id: 'research-pending' }, { agent, signal: new AbortController().signal } as never)).resolves.toMatchObject({ receipt: { evidenceState: 'pending' } })
    expect(started).toHaveLength(1)
    await started[0]!.run().done
    expect(events.at(-1)).toEqual({ type: 'hivemind/research-receipt', data: expect.objectContaining({ jobId: 'research-pending', evidenceState: 'ready', provider: 'parallel' }) })
  })

  it('injects each terminal durable receipt once into the next parent model request', async () => {
    const receipt = { jobId: 'research-ready', status: 'succeeded', evidenceState: 'ready' as const, sources: [{ url: 'https://example.test/evidence' }], provider: 'parallel' }
    const { agent, events, hooks } = await setup([{ type: 'hivemind/research-receipt', data: receipt }])
    const next = vi.fn(async () => ({ kind: 'enter' as const, messages: [], startsRequestSeries: false }))
    const hook = hooks.get('agent/pre-step')
    if (hook === undefined) throw new Error('research completion hook was not registered')
    const first = await hook({ agent }, next) as { messages: Array<{ content: Array<{ text?: string }> }> }
    expect(first.messages[0]?.content[0]?.text).toContain('Research research-ready is ready via parallel; 1 source.')
    const second = await hook({ agent }, next) as { messages: unknown[] }
    expect(second.messages).toEqual([])
    expect(events).toEqual([])
  })

  it('accepts a blank optional runtime attribution without discarding the research receipt', async () => {
    const { status, agent, events } = await setup()
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'research-blank-runtime',
      status: 'failed',
      runtime_used: '',
      error: 'provider_unavailable',
      results: [],
    }), { status: 200 })) as typeof globalThis.fetch

    await expect(status.execute(
      { job_id: 'research-blank-runtime' },
      { agent, signal: new AbortController().signal } as never,
    )).resolves.toMatchObject({
      status: 'failed',
      receipt: {
        jobId: 'research-blank-runtime',
        error: 'provider_unavailable',
      },
    })
    expect(events.at(-1)).toEqual({
      type: 'hivemind/research-receipt',
      data: expect.not.objectContaining({ provider: expect.anything() }),
    })
  })

  it('requires a first-party or regulator requirement for legal compliance', async () => {
    const { request, agent } = await setup()
    await expect(request.execute({ objective: 'Verify GDPR claims.', research_type: 'legal_compliance' }, { agent, signal: new AbortController().signal } as never)).rejects.toThrow('requires first_party or regulator')
  })

  it('fails closed when the research authority rejects the request', async () => {
    const { status, agent, events } = await setup()
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })) as typeof globalThis.fetch
    await expect(status.execute({ job_id: 'private-job' }, { agent, signal: new AbortController().signal } as never)).rejects.toThrow('request failed with status 401')
    expect(events).toEqual([])
  })
})
