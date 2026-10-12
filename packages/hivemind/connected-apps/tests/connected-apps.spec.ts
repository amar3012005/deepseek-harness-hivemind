import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { SpillLocator, type SpillRef } from '@deepseek-ai/dsh-spill'

const execute = vi.fn()
const toolkits = vi.fn(async (_query?: { search: string; limit: number }, _options?: { signal: AbortSignal }): Promise<{ items: Array<{
  slug: string
  name?: string
  logo?: string
  connection?: { isActive?: boolean }
}> }> => ({ items: [] }))
const create = vi.fn(async () => ({ execute, toolkits, sessionId: 'router-created' }))
const use = vi.fn(async () => ({ execute, toolkits, sessionId: 'router-restored' }))
const list = vi.fn(async (): Promise<{ items: Array<{ id?: string; status: string; toolkit?: { slug: string } }> }> => ({ items: [] }))
vi.mock('@composio/core', () => ({ Composio: class { sessions = { create, use }; connectedAccounts = { list } } }))

const { apply, compactComposioSearchReceipt, compactComposioExecutionReceipt } = await import('../src/index.ts')

const receipt: SpillRef = { locator: SpillLocator('private:r1'), bytes: 10, retrievalHint: 'read privately' }

function harness(
  enabled: boolean | undefined = true,
  identity = { orgId: 'org-a', userId: 'user-a' },
  enabledByDefault = false,
  config: {
    connectionCallbackBaseUrl?: string
    maxDiscoverySearches?: number
    withSpill?: boolean
    serviceApiBase?: string
    serviceSecretEnv?: string
  } = {},
  delegatedReport?: (event: string, payload: unknown) => Promise<unknown>,
) {
  const concludeTurn = vi.fn()
  const ask = vi.fn()
  const spills: Array<{ suggestedName: string; content: string }> = []
  const flush = vi.fn(async () => true)
  let tool: {
    execute(
      args: Record<string, unknown>,
      execution: { signal: AbortSignal; concludeTurn: () => void },
    ): Promise<unknown>
  } | undefined
  const listeners = new Map<string, (...args: never[]) => unknown>()
  let registeredAgent: unknown
  const ctx = {
    serial: delegatedReport ?? (async () => undefined),
    tools: { register(value: typeof tool) { tool = value } },
    sessions: { flush },
    effect<T>(callback: () => T) { return callback() },
    hivemindIdentity: { resolve: vi.fn(async () => identity) },
    userQuestions: { ask },
    on(name: string, listener: (...args: never[]) => unknown) { listeners.set(name, listener) },
    get(name: string) {
      if (name === 'settings') return { describe: () => enabled === undefined ? [] : [{ ns: 'hivemind-plugins', value: { pluginsEnabled: enabled } }] }
      if (name === 'agents') return { get: () => registeredAgent }
      if (name === 'spillStore' && config.withSpill === true) return { saveText: async (input: { suggestedName: string; content: string }) => {
        spills.push(input)
        return { locator: SpillLocator(`private:${spills.length}`), bytes: input.content.length, retrievalHint: 'Inspect privately.' }
      } }
      return undefined
    },
    logger: { warn: vi.fn() },
  }
  // Optional Cordis services must use get(); undeclared property access throws
  // in the production host instead of returning an absent service.
  Object.defineProperty(ctx, 'hivemindHq', { get() { throw new Error('cannot get property "hivemindHq" without inject') } })
  apply(ctx as never, { apiKey: 'server-secret', enabledByDefault, ...config })
  return {
    tool: () => ({
      execute: (args: Record<string, unknown>, execution: { signal: AbortSignal }) =>
        tool!.execute(args, { ...execution, concludeTurn }),
    }),
    listeners,
    setAgent(agent: unknown) { registeredAgent = agent },
    concludeTurn,
    ask,
    spills,
    flush,
  }
}


function savedSearch(callId: string, response: unknown) {
  return [
    { type: 'tool/call', data: { name: 'hivemind_connected_task', callId, arguments: JSON.stringify({
      action: 'search', queries: [{ use_case: 'Example: read one value.', result_fields: ['value'] }],
      session: { generate_id: true },
    }) } },
    { type: 'tool/result', data: { message: { source: { callId }, content: [{ type: 'tool-result',
      content: [{ type: 'text', text: JSON.stringify(response) }],
    }] } } },
  ]
}

describe('progressive Composio bridge', () => {
  beforeEach(() => {
    execute.mockReset(); toolkits.mockReset(); toolkits.mockResolvedValue({ items: [] })
    create.mockClear(); use.mockClear(); list.mockReset(); list.mockResolvedValue({ items: [] })
  })

  it('preserves planning and projects selected schemas into compact execution contracts', () => {
    expect(compactComposioSearchReceipt({ operations: [{ tool: 'COMPOSIO_SEARCH_TOOLS', status: 'completed' }], data: {
      results: [{ primary_tool_slugs: ['SLACK_SEND_MESSAGE'], toolkits: ['slack'], recommended_plan_steps: ['resolve channel'], known_pitfalls: ['do not guess'], difficulty: 'medium', tool_schemas: {
        SLACK_SEND_MESSAGE: { input_schema: { type: 'object', required: ['channel', 'text'], properties: {
          channel: { type: 'string', description: 'Exact Slack channel id.' },
          text: { type: 'string', description: 'Message text.' },
        } } },
      } }],
      recommended_plan_steps: ['connect first'], known_pitfalls: ['confirm destination'], difficulty: 'hard',
    } }, receipt)).toMatchObject({
      results: [{ recommended_plan_steps: ['resolve channel'], known_pitfalls: ['do not guess'], difficulty: 'medium' }],
      recommended_plan_steps: ['connect first'], known_pitfalls: ['confirm destination'], difficulty: 'hard',
      execution_contracts: [{ tool_slug: 'SLACK_SEND_MESSAGE', required_fields: ['channel', 'text'], properties: {
        channel: { type: 'string' }, text: { type: 'string' },
      } }],
      operations: [{ tool: 'COMPOSIO_SEARCH_TOOLS', status: 'completed' }],
    })
    const projected = JSON.stringify(compactComposioSearchReceipt({ data: { results: [{ primary_tool_slugs: ['X'], tool_schemas: { huge: true } }] } }, receipt))
    expect(projected).not.toContain('tool_schemas')
    expect(projected).not.toContain('huge')
  })

  it('compacts discovery without private spill storage', () => {
    const compact = compactComposioSearchReceipt({
      result: { data: { results: [{ primary_tool_slugs: ['SLACK_LIST_CHANNELS'], tool_schemas: { huge: true } }] } },
    })
    expect(JSON.stringify(compact)).not.toContain('tool_schemas')
    expect(compact).toMatchObject({ results: [{ primary_tool_slugs: ['SLACK_LIST_CHANNELS'] }] })
    expect(compact).not.toHaveProperty('source_receipt')
  })

  it('promotes the real provider workflow session id to the stable receipt', () => {
    expect(compactComposioSearchReceipt({ result: { data: {
      session: { id: 'workflow-real-123', instructions: 'continue this workflow' },
      results: [{ primary_tool_slugs: ['EXAMPLE_READ'] }],
    } } })).toMatchObject({ session_id: 'workflow-real-123', session: { id: 'workflow-real-123' } })
  })

  it('preserves execution contracts when a search receipt is projected again', () => {
    const first = compactComposioSearchReceipt({ data: { results: [{
      primary_tool_slugs: ['GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID'],
      tool_schemas: { GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID: { input_schema: {
        type: 'object', required: ['message_id'], properties: { message_id: { type: 'string' } },
      } } },
    }] } })!
    expect(first.execution_contracts).toBeDefined()
    expect(compactComposioSearchReceipt(first)?.execution_contracts).toEqual(first.execution_contracts)
  })

  it('retains provider schema fingerprints and versions through durable projection', () => {
    const compact = compactComposioSearchReceipt({ data: { results: [{
      primary_tool_slugs: ['EXAMPLE_READ'], tool_schemas: { EXAMPLE_READ: {
        schema_hash: 'schema-v2', tool_version: '2', input_schema: {
          type: 'object', required: ['query'], properties: { query: { type: 'string' } },
        },
      } },
    }] } })
    expect(compact).toMatchObject({ execution_contracts: [{
      tool_slug: 'EXAMPLE_READ', schema_hash: 'schema-v2', tool_version: '2',
    }] })
    expect(compactComposioSearchReceipt(compact)?.execution_contracts).toEqual(compact?.execution_contracts)
  })

  it('retains complete plans and nested schema keywords through repeated projection', () => {
    const steps = Array.from({ length: 7 }, (_, index) => `${index}: ${'prerequisite '.repeat(40)}`)
    const schema = { type: 'object', additionalProperties: false, required: ['target'], properties: {
      target: { oneOf: [{ type: 'string', minLength: 3 }, { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } }] },
    } }
    const first = compactComposioSearchReceipt({ data: { results: [{ primary_tool_slugs: ['EXAMPLE_READ'],
      recommended_plan_steps: steps, known_pitfalls: steps, tool_schemas: { EXAMPLE_READ: { input_schema: schema } },
    }] } })!
    const second = compactComposioSearchReceipt(first)
    expect(second).toMatchObject({ results: [{ recommended_plan_steps: steps, known_pitfalls: steps }],
      execution_contracts: [{ properties: schema.properties, schema_keywords: { type: 'object', additionalProperties: false } }],
    })
  })

  it('omits non-authoritative schema examples while preserving exact validation and guidance', () => {
    const compact = compactComposioSearchReceipt({ data: { results: [{
      primary_tool_slugs: ['EXAMPLE_READ'],
      tool_schemas: { EXAMPLE_READ: { input_schema: {
        type: 'object', required: ['query'], additionalProperties: false, properties: {
          query: {
            type: 'string', minLength: 3, pattern: '^[a-z]+$',
            description: 'Exact query syntax supplied by the provider.',
            examples: ['alpha', 'beta'],
          },
        },
      } } },
    }] } })
    expect(compact).toMatchObject({ execution_contracts: [{
      tool_slug: 'EXAMPLE_READ', required_fields: ['query'],
      properties: { query: {
        type: 'string', minLength: 3, pattern: '^[a-z]+$',
        description: 'Exact query syntax supplied by the provider.',
      } },
      schema_keywords: { type: 'object', additionalProperties: false },
    }] })
    expect(JSON.stringify(compact)).not.toContain('alpha')
    expect(JSON.stringify(compact)).not.toContain('beta')
  })

  it('bounds provider executions so MIME and long payloads stay out of the transcript', () => {
    const compact = compactComposioExecutionReceipt({
      data: { text: 'x'.repeat(2000), mime_type: 'text/html', headers: { authorization: 'secret' } },
    })
    expect(JSON.stringify(compact)).not.toContain('authorization')
    expect(JSON.stringify(compact)).not.toContain('mime_type')
    expect(String((compact as { data: { text: string } }).data.text).endsWith('…')).toBe(true)
  })

  it('redacts authentication material from connected-app model projections', () => {
    const compact = compactComposioExecutionReceipt({ data: {
      subject: 'Your verification code',
      snippet: 'A new sign-in to your account was detected.',
      safe: 'Quarterly planning invitation',
    } })
    const rendered = JSON.stringify(compact)
    expect(rendered).not.toContain('verification code')
    expect(rendered).not.toContain('sign-in')
    expect(rendered).toContain('[Authentication-related content redacted]')
    expect(rendered).toContain('Quarterly planning invitation')
  })

  it('keeps readable evidence while omitting duplicated MIME transport trees generically', () => {
    const compact = compactComposioExecutionReceipt({ data: { records: [{
      id: 'record-1', messageText: 'Readable evidence for the model.',
      payload: {
        mimeType: 'multipart/alternative',
        headers: Array.from({ length: 30 }, (_, index) => ({ name: `X-${index}`, value: 'transport noise' })),
        parts: [{ mimeType: 'text/plain', body: { data: 'UmVhZGFibGUgZXZpZGVuY2U=', size: 18 } }],
      },
    }] } }) as { data: { records: Array<Record<string, unknown>> }; projection_policy: string }
    expect(compact.data.records[0]).toMatchObject({ id: 'record-1', messageText: 'Readable evidence for the model.' })
    expect(compact.data.records[0]).not.toHaveProperty('payload')
    expect(compact.projection_policy).toContain('MIME transport')
  })

  it('retains nested email evidence through repeated execution projection', () => {
    const provider = { result: { data: { messages: [{
      messageId: 'message-1', to: 'recipient@example.com',
      timestamp: '2026-09-12T12:00:00Z', subject: 'Project update',
      metadata: { sender: { address: 'sender@example.com' } },
    }] } } }
    const projected = compactComposioExecutionReceipt(provider)
    expect(projected).toMatchObject(provider)
    expect(compactComposioExecutionReceipt(projected)).toMatchObject(provider)
    expect(JSON.stringify(projected)).not.toContain('[truncated]')
  })

  it('projects only requested provider evidence fields while retaining structural containers', () => {
    const projected = compactComposioExecutionReceipt({ data: { messages: [{
      id: 'message-1', subject: 'Project update', received_at: '2026-09-12T12:00:00Z',
      body: 'large unrequested body', sender: { name: 'Rama', address: 'rama@example.com' },
    }] } }, receipt, ['subject', 'received_at'])

    expect(projected).toMatchObject({
      data: { messages: [{ subject: 'Project update', received_at: '2026-09-12T12:00:00Z' }] },
      source_receipt: { receipt_id: expect.any(String), bytes: 10 },
    })
    expect(JSON.stringify(projected)).not.toContain('large unrequested body')
    expect(JSON.stringify(projected)).not.toContain('rama@example.com')
  })

  it('reports absent requested keys without substituting unrelated provider evidence', () => {
    const projected = compactComposioExecutionReceipt(
      { data: { actual_key: 'provider evidence' } }, undefined, ['unknown_key'],
    )
    expect(projected).toMatchObject({ missing_result_fields: ['unknown_key'], projection_status: 'incomplete' })
    expect(JSON.stringify(projected)).not.toContain('provider evidence')
  })

  it('projects exact nested schema paths without including sibling fields', () => {
    const projected = compactComposioExecutionReceipt({ data: {
      answer: 'Supported search answer', citations: ['https://example.com/news'], private_body: 'omit this',
    } }, undefined, ['data.answer', 'data.citations'])
    expect(projected).toMatchObject({
      'data.answer': 'Supported search answer', 'data.citations': ['https://example.com/news'], projection_status: 'complete',
    })
    expect(JSON.stringify(projected)).not.toContain('omit this')
  })

  it('marks requested result projections complete only when every field is present', () => {
    expect(compactComposioExecutionReceipt({ subject: 'Draft title', id: 'draft-1' }, undefined, ['subject', 'id']))
      .toMatchObject({ projection_status: 'complete', subject: 'Draft title', id: 'draft-1' })
  })

  it('preserves only a bounded provider continuation cursor beside compact evidence', () => {
    const projected = compactComposioExecutionReceipt({ data: {
      messages: [{ subject: 'first page' }], nextPageToken: 'page-2', body: 'unrelated payload',
    } }, receipt, ['subject']) as Record<string, unknown>
    expect(projected).toMatchObject({
      data: { messages: [{ subject: 'first page' }] },
      pagination: { cursor: 'page-2', cursor_field: 'nextPageToken' },
    })
    expect(JSON.stringify(projected)).not.toContain('unrelated payload')
  })

  it('compacts search post-execute even when spill storage is unavailable', async () => {
    const { listeners } = harness()
    const post = listeners.get('tools/post-execute') as (
      execution: { name: string; arguments: Record<string, unknown> },
      result: { isError: boolean; content: Array<{ type: string; text: string }> },
      next: () => Promise<{ kind: string; content: Array<{ type: string; text: string }> }>,
    ) => Promise<{ kind: string; content: Array<{ type: string; text: string }> }>
    const huge = JSON.stringify({ result: { data: { results: [{ primary_tool_slugs: ['SLACK_LIST_CHANNELS'], tool_schemas: { huge: true } }] } } })
    const decision = await post(
      { name: 'mcp__composio__COMPOSIO_SEARCH_TOOLS', arguments: { action: 'search' } },
      { isError: false, content: [{ type: 'text', text: huge }] },
      async () => ({ kind: 'accept', content: [{ type: 'text', text: huge }] }),
    )
    expect(decision.kind).toBe('accept')
    expect(decision.content[0]?.text).not.toContain('tool_schemas')
    expect(decision.content[0]?.text).toContain('SLACK_LIST_CHANNELS')
  })

  it('does not flush the raw COMPOSIO_SEARCH_TOOLS payload into the tool result', async () => {
    execute.mockResolvedValueOnce({ data: { results: [{ primary_tool_slugs: ['SLACK_LIST_CHANNELS'], tool_schemas: { huge: true } }] } })
    const { tool } = harness()
    const result = await tool().execute({
      action: 'search',
      queries: [{
        app: 'Slack', use_case: 'List Slack channels ordered by name and return channel id and name.',
        result_fields: ['id', 'name'],
      }],
      session: { generate_id: true },
    }, { signal: AbortSignal.abort() })
    expect(execute).toHaveBeenCalledWith('COMPOSIO_SEARCH_TOOLS', expect.objectContaining({
      queries: [{ use_case: 'List Slack channels ordered by name and return channel id and name.' }],
    }))
    expect(JSON.stringify(execute.mock.calls[0]?.[1])).not.toContain('result_fields')
    expect(JSON.stringify(result)).not.toContain('tool_schemas')
    expect(result).toMatchObject({ status: 'ready', results: [{ primary_tool_slugs: ['SLACK_LIST_CHANNELS'] }] })
  })

  it('persists the original provider response before projecting search and execution', async () => {
    const search = { data: { results: [{ primary_tool_slugs: ['EXAMPLE_READ'], tool_schemas: {
      EXAMPLE_READ: { input_schema: { type: 'object', required: ['query'], properties: {
        query: { type: 'string', minLength: 3 },
      } } },
    } }] } }
    const provider = { data: {
      value: 'complete provider result', unrelated: 'not requested', headers: { private: 'transport detail' },
    } }
    execute.mockResolvedValueOnce(search).mockResolvedValueOnce(provider)
    const app = harness(true, undefined, false, { withSpill: true })
    const events: unknown[] = []
    const agent = { session: { header: { id: 'conversation-receipts' }, snapshotEvents: () => events, append: vi.fn() } }

    const discovered = await app.tool().execute({
      action: 'search', queries: [{ use_case: 'Example: read one value.', result_fields: ['value'] }],
      session: { generate_id: true },
    }, { signal: AbortSignal.abort(), agent, name: 'hivemind_connected_task', callId: 'search-call' } as never)
    events.push(...savedSearch('search-call', search))
    const completed = await app.tool().execute({
      action: 'execute', tool_slug: 'EXAMPLE_READ', arguments: { query: 'value' },
    }, { signal: AbortSignal.abort(), agent, name: 'hivemind_connected_task', callId: 'execute-call' } as never)

    expect(app.spills).toMatchObject([
      { suggestedName: 'composio-search-tools.json', content: JSON.stringify(search) },
      { suggestedName: 'composio-example_read.json', content: JSON.stringify(provider) },
    ])
    expect(discovered).toMatchObject({ source_receipt: { bytes: expect.any(Number), receipt_id: expect.any(String) } })
    expect(completed).toMatchObject({ source_receipt: { bytes: expect.any(Number), receipt_id: expect.any(String) } })
    expect(JSON.stringify(discovered)).not.toContain('private:1')
    expect(JSON.stringify(completed)).not.toContain('private:2')
    expect(JSON.stringify(completed)).not.toContain('transport detail')
    expect(JSON.stringify(completed)).not.toContain('not requested')
  })

  it('uses the authenticated Core receipt service when configured, never a spill path', async () => {
    const identity = {
      orgId: '67503d34-97e9-49a8-8c52-8ee30cc7603e',
      userId: '54f5568b-4d6a-4ae1-9a33-48cb2909d59b',
    }
    const search = { data: { results: [{ primary_tool_slugs: ['EXAMPLE_READ'], tool_schemas: {
      EXAMPLE_READ: { schema_hash: 'v1', input_schema: { type: 'object', required: ['query'], properties: {
        query: { type: 'string' },
      } } },
    } }] } }
    const provider = { data: { value: 'selected evidence', unrelated: 'must stay private' } }
    execute.mockResolvedValueOnce(search).mockResolvedValueOnce(provider)
    const requests: Array<{ url: string; body: Record<string, unknown>; authorization: string }> = []
    process.env.TEST_CONNECTED_RECEIPT_SECRET = 'runner-service-secret-that-is-at-least-32-bytes'
    vi.stubGlobal('fetch', vi.fn(async (url: URL, init: RequestInit) => {
      requests.push({
        url: String(url), body: JSON.parse(String(init.body)),
        authorization: String((init.headers as Record<string, string>).authorization),
      })
      if (String(url).endsWith('/credit-operations')) {
        return new Response(JSON.stringify({ admitted: true, service: 'composio_tool_call' }), { status: 200 })
      }
      return new Response(JSON.stringify({ receipt_id: '62f448d1-8c82-4e41-a44d-f380384e0b49', bytes: 123 }), { status: 201 })
    }))
    try {
      const app = harness(true, identity, false, {
        serviceApiBase: 'http://127.0.0.1:3000', serviceSecretEnv: 'TEST_CONNECTED_RECEIPT_SECRET', withSpill: true,
      })
      const events: unknown[] = []
      const agent = { session: { header: { id: 'session-12345678' }, snapshotEvents: () => events, append: vi.fn() } }
      app.setAgent(agent)
      await app.listeners.get('agent/pre-step')?.({ agent, turn: 1, step: 1, signal: new AbortController().signal, messages: [] } as never, (async () => ({ kind: 'accept', messages: [] })) as never)
      await app.tool().execute({
        action: 'search', queries: [{ use_case: 'Example: read one value.', result_fields: ['value'] }],
        session: { generate_id: true },
      }, { signal: AbortSignal.abort(), agent, name: 'hivemind_connected_task', callId: 'search-call' } as never)
      events.push(...savedSearch('search-call', search))
      const completed = await app.tool().execute({
        action: 'execute', tool_slug: 'EXAMPLE_READ', arguments: { query: 'value' },
      }, { signal: AbortSignal.abort(), agent, name: 'hivemind_connected_task', callId: 'execute-call' } as never)
      await app.listeners.get('session/event')?.(agent.session as never, {
        type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } },
      } as never)

      expect(app.spills).toEqual([])
      expect(requests).toHaveLength(3)
      expect(requests.filter(request => request.url.endsWith('/receipts'))).toHaveLength(2)
      expect(requests[1]?.url).toBe('http://127.0.0.1:3000/internal/v1/harness-chat/credit-operations')
      expect(requests.every(request => request.authorization.split('.').length === 3)).toBe(true)
      expect(requests[2]?.body).toMatchObject({
        session_id: 'session-12345678', call_id: 'execute-call', tool: 'EXAMPLE_READ',
        allowed_fields: ['value'], approved_projection: { value: 'selected evidence' },
      })
      expect(requests[1]?.body).toMatchObject({ kind: 'composio_execution', turn_id: 1, tool: 'EXAMPLE_READ' })
      expect(JSON.stringify(requests[2]?.body.approved_projection)).not.toContain('must stay private')
      expect(completed).toMatchObject({ source_receipt: { receipt_id: '62f448d1-8c82-4e41-a44d-f380384e0b49', bytes: 123 } })
    } finally {
      delete process.env.TEST_CONNECTED_RECEIPT_SECRET
      vi.unstubAllGlobals()
    }
  })

  it('settles a no-tool turn from the committed Session event with a stable idempotency key', async () => {
    const requests: Array<{ body: Record<string, unknown> }> = []
    process.env.TEST_CONNECTED_RECEIPT_SECRET = 'runner-service-secret-that-is-at-least-32-bytes'
    vi.stubGlobal('fetch', vi.fn(async (_url: URL, init: RequestInit) => {
      requests.push({ body: JSON.parse(String(init.body)) })
      return new Response(JSON.stringify({ admitted: true }), { status: 200 })
    }))
    try {
      const app = harness(true, { orgId: 'org-settlement', userId: 'user-settlement' }, false, {
        serviceApiBase: 'http://127.0.0.1:3000', serviceSecretEnv: 'TEST_CONNECTED_RECEIPT_SECRET',
      })
      const signal = new AbortController().signal
      const agent = { session: { header: { id: 'settled-session' }, snapshotEvents: () => [], append: vi.fn() } }
      app.setAgent(agent)
      await app.listeners.get('agent/pre-step')?.({ agent, turn: 7, step: 1, signal, messages: [] } as never,
        (async () => ({ kind: 'accept', messages: [] })) as never)
      const settled = { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } }
      await app.listeners.get('session/event')?.(agent.session as never, settled as never)
      await app.listeners.get('session/event')?.(agent.session as never, settled as never)

      expect(requests.map(request => request.body)).toEqual([
        { session_id: 'settled-session', turn_id: 7, call_id: 'turn-7', kind: 'no_tool_turn' },
        { session_id: 'settled-session', turn_id: 7, call_id: 'turn-7', kind: 'no_tool_turn' },
      ])
    } finally {
      delete process.env.TEST_CONNECTED_RECEIPT_SECRET
      vi.unstubAllGlobals()
    }
  })

  it('reuses the stable authenticated user connection while isolating selected tools', async () => {
    execute.mockResolvedValueOnce({ data: { results: [{ primary_tool_slugs: ['SLACK_LIST_CHANNELS'] }] } })
    const first = harness(true, { orgId: 'org-a', userId: 'same-user' })
    await first.tool().execute({ action: 'search', queries: [{ app: 'Slack', use_case: 'List Slack channels ordered by name and return channel id and name.' }], session: { generate_id: true } }, { signal: AbortSignal.abort() })
    expect(create).toHaveBeenCalledWith('hivemind:same-user', { mcp: true, connectedAccounts: {} })
    await expect(first.tool().execute({ action: 'execute', tool_slug: 'GMAIL_FETCH_EMAILS', arguments: {} }, { signal: AbortSignal.abort() })).rejects.toThrow('not selected')
  })

  it('isolates selected tools and contracts between conversations for the same authenticated user', async () => {
    execute
      .mockResolvedValueOnce({ data: { session: { id: 'workflow-slack' }, results: [{
        primary_tool_slugs: ['SLACK_FIND_CHANNELS'], tool_schemas: {
          SLACK_FIND_CHANNELS: { input_schema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } } },
        },
      }] } })
      .mockResolvedValueOnce({ data: { session: { id: 'workflow-gmail' }, results: [{
        primary_tool_slugs: ['GMAIL_FETCH_EMAILS'], tool_schemas: {
          GMAIL_FETCH_EMAILS: { input_schema: { type: 'object', required: ['max_results'], properties: { max_results: { type: 'integer' } } } },
        },
      }] } })
      .mockResolvedValueOnce({ data: { channels: [] } })
    const app = harness(true, { orgId: 'org-a', userId: 'same-user' })
    const slackAgent = { session: { header: { id: 'conversation-slack' }, snapshotEvents: () => [], append: vi.fn() } }
    const gmailAgent = { session: { header: { id: 'conversation-gmail' }, snapshotEvents: () => [], append: vi.fn() } }

    await app.tool().execute({ action: 'search', queries: [{ app: 'Slack', use_case: 'Find a Slack channel.' }], session: { generate_id: true } }, { signal: AbortSignal.abort(), agent: slackAgent } as never)
    await app.tool().execute({ action: 'search', queries: [{ app: 'Gmail', use_case: 'Fetch recent Gmail messages.' }], session: { generate_id: true } }, { signal: AbortSignal.abort(), agent: gmailAgent } as never)

    await expect(app.tool().execute({ action: 'execute', tool_slug: 'SLACK_FIND_CHANNELS', arguments: { query: 'general' }, session_id: 'workflow-slack' }, { signal: AbortSignal.abort(), agent: slackAgent } as never))
      .resolves.toMatchObject({ status: 'ready' })
    await expect(app.tool().execute({ action: 'execute', tool_slug: 'SLACK_FIND_CHANNELS', arguments: { query: 'general' }, session_id: 'workflow-slack' }, { signal: AbortSignal.abort(), agent: gmailAgent } as never))
      .rejects.toThrow('current conversation-scoped search')
  })

  it('accepts the returned workflow id in the shared session envelope for later actions', async () => {
    execute
      .mockResolvedValueOnce({ data: { session: { id: 'workflow-1' }, results: [{
        primary_tool_slugs: ['GMAIL_FETCH_EMAILS'], tool_schemas: {
          GMAIL_FETCH_EMAILS: { input_schema: { type: 'object', required: ['max_results'], properties: { max_results: { type: 'integer' } } } },
        },
      }] } })
      .mockResolvedValueOnce({ data: { messages: [] } })
    const app = harness()
    const agent = { session: { header: { id: 'conversation-1' }, snapshotEvents: () => [], append: vi.fn() } }
    await app.tool().execute({ action: 'search', queries: [{ app: 'Gmail', use_case: 'Fetch one Gmail message.' }], session: { generate_id: true } }, { signal: AbortSignal.abort(), agent } as never)
    await expect(app.tool().execute({
      action: 'execute', tool_slug: 'GMAIL_FETCH_EMAILS', arguments: { max_results: 1 }, session: { id: 'workflow-1' },
    }, { signal: AbortSignal.abort(), agent } as never)).resolves.toMatchObject({ status: 'ready' })
  })

  it('restores the durable Composio router session without relisting accounts', async () => {
    execute.mockResolvedValueOnce({ data: { results: [] } })
    const events = [{
      type: 'hivemind/composio-session',
      data: { version: 1, userKey: 'hivemind:user-a', subject: 'hivemind:user-a', routerSessionId: 'router-existing' },
    }]
    const agent = { session: { header: { id: 'conversation-1' }, snapshotEvents: () => events, append: vi.fn() } }
    const app = harness()

    await app.tool().execute({
      action: 'search', queries: [{ use_case: 'Email service: list the newest message.' }], session: { generate_id: true },
    }, { signal: AbortSignal.abort(), agent } as never)

    expect(use).toHaveBeenCalledWith('router-existing', { mcp: true })
    expect(create).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
  })

  it('restores selected contracts from durable conversation events after a runner restart', async () => {
    execute.mockResolvedValueOnce({ data: { messages: [{ subject: 'Latest' }] } })
    const projectedSearch = {
      status: 'ready',
      session: { id: 'workflow-restored' },
      results: [{ primary_tool_slugs: ['GMAIL_FETCH_EMAILS'], related_tool_slugs: [], toolkits: ['gmail'] }],
      execution_contracts: [{
        tool_slug: 'GMAIL_FETCH_EMAILS', required_fields: ['max_results'],
        properties: { max_results: { type: 'integer' } },
      }],
    }
    const events = [
      { type: 'tool/call', data: {
        callId: 'call-search', name: 'hivemind_connected_task',
        arguments: JSON.stringify({
          action: 'search', session: { generate_id: true },
          queries: [{ use_case: 'Read the newest email.', result_fields: ['subject'] }],
        }),
      } },
      { type: 'tool/result', data: { message: {
        source: { kind: 'tool', callId: 'call-search' },
        content: [{ type: 'tool-result', content: [{ type: 'text', text: JSON.stringify(projectedSearch) }] }],
      } } },
    ]
    const agent = { session: { header: { id: 'conversation-restored' }, snapshotEvents: () => events, append: vi.fn() } }
    const restarted = harness()

    await expect(restarted.tool().execute({
      action: 'execute', tool_slug: 'GMAIL_FETCH_EMAILS', arguments: { max_results: 1 }, session_id: 'workflow-restored',
    }, { signal: AbortSignal.abort(), agent } as never)).resolves.toMatchObject({ status: 'ready' })
    expect(execute).toHaveBeenCalledWith('GMAIL_FETCH_EMAILS', { max_results: 1 })
  })

  it('projects an unfinished connected workflow into a later turn without repeating discovery', async () => {
    const events = [
      { type: 'tool/call', data: {
        turn: 1, callId: 'call-search', name: 'hivemind_connected_task',
        arguments: JSON.stringify({
          action: 'search',
          queries: [{ app: 'Example', use_case: 'Read the newest record and return its title.' }],
          session: { generate_id: true },
        }),
      } },
      { type: 'tool/result', data: { message: {
        source: { kind: 'tool', callId: 'call-search' },
        content: [{ type: 'tool-result', content: [{ type: 'text', text: JSON.stringify({
          status: 'connection_required', session_id: 'workflow-resume', toolkit: 'example',
          results: [{ primary_tool_slugs: ['EXAMPLE_READ'], toolkits: ['example'] }],
          execution_contracts: [{
            tool_slug: 'EXAMPLE_READ', required_fields: ['limit'],
            properties: { limit: { type: 'integer', minimum: 1, maximum: 5 } },
          }],
        }) }] }],
      } } },
    ]
    const visible: unknown[] = []
    const agent = { session: {
      header: { id: 'conversation-resume' }, snapshotEvents: () => events, deriveMessages: () => visible, append: vi.fn(),
    } }
    const app = harness()
    const next = vi.fn(async () => ({ kind: 'enter', messages: [] }))
    const decision = await app.listeners.get('agent/pre-step')?.(
      { agent, turn: 2, messages: [] } as never, next as never,
    ) as { messages: unknown[] }
    const projected = JSON.stringify(decision.messages)

    expect(projected).toContain('Unfinished connected-app workflow')
    expect(projected).toContain('workflow-resume')
    expect(projected).toContain('EXAMPLE_READ')
    expect(projected).toContain('Read the newest record')
    expect(projected).toContain('wait_connection')
    expect(execute).not.toHaveBeenCalled()

    visible.push(...decision.messages)
    const repeated = await app.listeners.get('agent/pre-step')?.(
      { agent, turn: 2, step: 2, messages: [] } as never, next as never,
    ) as { messages: unknown[] }
    expect(repeated.messages).toEqual([])
  })

  it('injects a connected receipt only when its evidence is absent from the visible session', async () => {
    const events: unknown[] = [{ type: 'hivemind/connected-receipt', data: {
      version: 1, tool: 'GMAIL_FETCH_EMAILS', receipt: {
        status: 'ready', source_receipt: { receipt_id: 'receipt-visible-1', bytes: 128 },
      },
    } }]
    const visible: unknown[] = []
    const agent = { session: {
      header: { id: 'conversation-receipt' }, snapshotEvents: () => events,
      deriveMessages: () => visible, append: vi.fn(),
    } }
    const app = harness()
    const next = vi.fn(async () => ({ kind: 'enter', messages: [] }))
    const first = await app.listeners.get('agent/pre-step')?.(
      { agent, turn: 1, step: 1, messages: [] } as never, next as never,
    ) as { messages: unknown[] }

    expect(first.messages).toHaveLength(1)
    expect(JSON.stringify(first.messages)).toContain('receipt-visible-1')
    visible.push(...first.messages)

    const nextStep = await app.listeners.get('agent/pre-step')?.(
      { agent, turn: 1, step: 2, messages: [] } as never, next as never,
    ) as { messages: unknown[] }
    expect(nextStep.messages).toEqual([])

    events.push({ type: 'hivemind/connected-receipt', data: {
      version: 1, tool: 'GMAIL_GET_EMAIL', receipt: {
        status: 'ready', source_receipt: { receipt_id: 'receipt-visible-2', bytes: 256 },
      },
    } })
    const updated = await app.listeners.get('agent/pre-step')?.(
      { agent, turn: 2, step: 1, messages: [] } as never, next as never,
    ) as { messages: unknown[] }
    expect(JSON.stringify(updated.messages)).toContain('receipt-visible-2')
    expect(updated.messages).toHaveLength(1)
  })

  it('restores a bounded pagination cursor as an unfinished continuation only', async () => {
    const events = [
      { type: 'tool/call', data: { turn: 1, callId: 'call-search', name: 'hivemind_connected_task', arguments: JSON.stringify({
        action: 'search', session: { generate_id: true }, queries: [{ use_case: 'List records.' }],
      }) } },
      { type: 'tool/result', data: { message: { source: { callId: 'call-search' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: JSON.stringify({
        status: 'ready', session_id: 'workflow-pages', results: [{ primary_tool_slugs: ['EXAMPLE_LIST'] }],
        execution_contracts: [{ tool_slug: 'EXAMPLE_LIST', required_fields: [], properties: {} }],
      }) }] }] } } },
      { type: 'tool/call', data: { turn: 1, callId: 'call-page-1', name: 'hivemind_connected_task', arguments: JSON.stringify({
        action: 'execute', session_id: 'workflow-pages', tool_slug: 'EXAMPLE_LIST', arguments: {},
      }) } },
      { type: 'tool/result', data: { message: { source: { callId: 'call-page-1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: JSON.stringify({
        status: 'ready', pagination: { cursor: 'next-2', cursor_field: 'nextPageToken' },
      }) }] }] } } },
    ]
    const agent = { session: { header: { id: 'conversation-pages' }, snapshotEvents: () => events, append: vi.fn() } }
    const app = harness()
    const next = vi.fn(async () => ({ kind: 'enter', messages: [] }))
    const decision = await app.listeners.get('agent/pre-step')?.(
      { agent, turn: 2, messages: [] } as never, next as never,
    ) as { messages: unknown[] }
    const projected = JSON.stringify(decision.messages)
    expect(projected).toContain('continue_page')
    expect(projected).toContain('next-2')
    expect(projected).toContain('pagination_pages')
  })

  it('does not project an unfinished workflow into an unrelated human request', async () => {
    const events = [
      { type: 'tool/call', data: { turn: 1, callId: 'call-search', name: 'hivemind_connected_task', arguments: JSON.stringify({
        action: 'search', session: { generate_id: true }, queries: [{ use_case: 'List recent Gmail messages from Rama.' }],
      }) } },
      { type: 'tool/result', data: { message: { source: { callId: 'call-search' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: JSON.stringify({
        status: 'ready', session_id: 'workflow-gmail', results: [{ primary_tool_slugs: ['GMAIL_FETCH_EMAILS'] }],
        execution_contracts: [{ tool_slug: 'GMAIL_FETCH_EMAILS', required_fields: [], properties: {} }],
      }) }] }] } } },
      { type: 'tool/call', data: { turn: 1, callId: 'call-page-1', name: 'hivemind_connected_task', arguments: JSON.stringify({
        action: 'execute', session_id: 'workflow-gmail', tool_slug: 'GMAIL_FETCH_EMAILS', arguments: {},
      }) } },
      { type: 'tool/result', data: { message: { source: { callId: 'call-page-1' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: JSON.stringify({
        status: 'ready', pagination: { cursor: 'next-2', cursor_field: 'nextPageToken' },
      }) }] }] } } },
    ]
    const agent = { session: { header: { id: 'conversation-pivot' }, snapshotEvents: () => events, append: vi.fn() } }
    const next = vi.fn(async () => ({ kind: 'enter', messages: [] }))
    const app = harness()
    const decision = await app.listeners.get('agent/pre-step')?.({
      agent, turn: 2, messages: [{
        role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: 'What do you know about me and my company?' }],
      }],
    } as never, next as never) as { messages: unknown[] }

    expect(decision.messages).toEqual([])
  })

  it.each(['user', 'hivemind-runtime-event'])('keeps old receipts out of a new %s request throughout its turn', async (kind) => {
    const events = [{ type: 'hivemind/connected-receipt', data: {
      version: 1, tool: 'connection_authorization', receipt: {
        status: 'connection_required', session_id: 'old-vercel', request_call_id: 'old-call', toolkits: ['vercel'],
      },
    } }]
    const agent = { session: { header: { id: 'new-purpose' }, snapshotEvents: () => events, append: vi.fn() } }
    const app = harness()
    const next = vi.fn(async () => ({ kind: 'enter', messages: [] }))
    const first = await app.listeners.get('agent/pre-step')?.({
      agent, turn: 2, messages: [{ role: 'user', source: { kind }, content: [{ type: 'text', text: 'Find our catalog information.' }] }],
    } as never, next as never) as { messages: unknown[] }
    expect(first.messages).toEqual([])
    const later = await app.listeners.get('agent/pre-step')?.({ agent, turn: 2, step: 2, messages: [] } as never, next as never) as { messages: unknown[] }
    expect(later.messages).toEqual([])
    events.push({ type: 'hivemind/connected-receipt', data: { version: 1, tool: 'CATALOG_READ', receipt: {
      status: 'ready', session_id: 'current-catalog', request_call_id: 'current-call', toolkits: ['catalog'],
    } } })
    const current = await app.listeners.get('agent/pre-step')?.({ agent, turn: 2, step: 3, messages: [] } as never, next as never) as { messages: unknown[] }
    expect(JSON.stringify(current.messages)).toContain('current-catalog')
    expect(JSON.stringify(current.messages)).not.toContain('old-vercel')
  })

  it('projects an unfinished workflow when the user explicitly continues it', async () => {
    const events = [
      { type: 'tool/call', data: { turn: 1, callId: 'call-search', name: 'hivemind_connected_task', arguments: JSON.stringify({
        action: 'search', session: { generate_id: true }, queries: [{ use_case: 'List records.' }],
      }) } },
      { type: 'tool/result', data: { message: { source: { callId: 'call-search' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: JSON.stringify({
        status: 'ready', session_id: 'workflow-continue', results: [{ primary_tool_slugs: ['EXAMPLE_LIST'] }],
        execution_contracts: [{ tool_slug: 'EXAMPLE_LIST', required_fields: [], properties: {} }],
      }) }] }] } } },
    ]
    const agent = { session: { header: { id: 'conversation-continue' }, snapshotEvents: () => events, append: vi.fn() } }
    const next = vi.fn(async () => ({ kind: 'enter', messages: [] }))
    const app = harness()
    const decision = await app.listeners.get('agent/pre-step')?.({
      agent, turn: 2, messages: [{
        role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue with the same task.' }],
      }],
    } as never, next as never) as { messages: unknown[] }

    expect(JSON.stringify(decision.messages)).toContain('workflow-continue')
  })

  it('does not project a workflow after its native approval was rejected', async () => {
    const events = [
      { type: 'tool/call', data: {
        turn: 1, callId: 'call-search', name: 'hivemind_connected_task',
        arguments: JSON.stringify({ action: 'search', session: { generate_id: true } }),
      } },
      { type: 'tool/result', data: { message: {
        source: { kind: 'tool', callId: 'call-search' },
        content: [{ type: 'tool-result', isError: false, content: [{ type: 'text', text: JSON.stringify({
          status: 'ready', session_id: 'workflow-send',
          results: [{ primary_tool_slugs: ['EXAMPLE_SEND'], toolkits: ['example'] }],
          execution_contracts: [{ tool_slug: 'EXAMPLE_SEND', required_fields: ['text'], properties: { text: { type: 'string' } } }],
        }) }] }],
      } } },
      { type: 'tool/call', data: {
        turn: 1, callId: 'call-execute', name: 'hivemind_connected_task',
        arguments: JSON.stringify({ action: 'execute', session_id: 'workflow-send', tool_slug: 'EXAMPLE_SEND', arguments: { text: 'hello' } }),
      } },
      { type: 'tool/result', data: { message: {
        source: { kind: 'tool', callId: 'call-execute' },
        content: [{ type: 'tool-result', isError: true, content: [{
          type: 'text', text: 'Error: the user rejected tool "hivemind_connected_task"',
        }] }],
      } } },
    ]
    const agent = { session: {
      header: { id: 'conversation-rejected' }, snapshotEvents: () => events, append: vi.fn(),
    } }
    const app = harness()
    const next = vi.fn(async () => ({ kind: 'enter', messages: [] }))
    const decision = await app.listeners.get('agent/pre-step')?.(
      { agent, turn: 2, messages: [] } as never, next as never,
    ) as { messages: unknown[] }

    expect(decision.messages).toEqual([])
  })

  it('reuses an active legacy organization connection until the user reconnects canonically', async () => {
    list
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [{ id: 'ca-gmail', status: 'ACTIVE', toolkit: { slug: 'gmail' } }] })
    execute.mockResolvedValueOnce({ data: { results: [{ primary_tool_slugs: ['GMAIL_FETCH_EMAILS'] }] } })
    const app = harness(true, { orgId: 'org-legacy', userId: 'user-a' })
    await app.tool().execute({ action: 'search', queries: [{ app: 'Gmail', use_case: 'Read Gmail inbox messages.' }], session: { generate_id: true } }, { signal: AbortSignal.abort() })
    expect(create).toHaveBeenCalledWith('org-legacy', { mcp: true, connectedAccounts: { gmail: ['ca-gmail'] } })
  })

  it('binds canonical active connected accounts into the Composio session', async () => {
    list.mockResolvedValueOnce({ items: [{ id: 'ca-gmail', status: 'ACTIVE', toolkit: { slug: 'gmail' } }] })
    execute.mockResolvedValueOnce({ data: { results: [{ primary_tool_slugs: ['GMAIL_FETCH_EMAILS'] }] } })
    const app = harness(true, { orgId: 'org-a', userId: 'user-a' })
    await app.tool().execute({ action: 'search', queries: [{ app: 'Gmail', use_case: 'Read five Gmail inbox messages.' }], session: { generate_id: true } }, { signal: AbortSignal.abort() })
    expect(create).toHaveBeenCalledWith('hivemind:user-a', { mcp: true, connectedAccounts: { gmail: ['ca-gmail'] } })
  })

  it('supports connection management and bounded waiting', async () => {
    execute.mockResolvedValue({ status: 'ready' })
    const { tool } = harness()
    await tool().execute({ action: 'manage_connection', toolkits: ['slack'], session_id: 'session-1' }, { signal: AbortSignal.abort() })
    await tool().execute({ action: 'wait_connection', toolkits: ['slack'], session_id: 'session-1' }, { signal: new AbortController().signal })
    expect(execute).toHaveBeenNthCalledWith(1, 'COMPOSIO_MANAGE_CONNECTIONS', { session_id: 'session-1', toolkits: ['slack'] })
    expect(execute).toHaveBeenCalledOnce()
    expect(toolkits).toHaveBeenCalledWith({ search: 'slack', limit: 8 }, { signal: expect.any(AbortSignal) })
  })

  it('checks an explicitly named toolkit without semantic tool search', async () => {
    toolkits.mockResolvedValueOnce({ items: [{
      slug: 'instagram', name: 'Instagram', logo: 'https://logos.example/instagram.svg',
      connection: { isActive: true },
    }] })
    const app = harness()
    await expect(app.tool().execute({ action: 'connection_status', apps: ['Instagram'] }, { signal: AbortSignal.abort() }))
      .resolves.toMatchObject({
        status: 'ready', toolkit: 'instagram', app_label: 'Instagram',
        logo_url: 'https://logos.example/instagram.svg', connected_toolkits: ['instagram'],
        toolkit_connection_statuses: [{ toolkit: 'instagram', app_label: 'Instagram', has_active_connection: true }],
      })
    expect(toolkits).toHaveBeenCalledWith({ search: 'Instagram', limit: 8 })
    expect(execute).not.toHaveBeenCalled()
    expect(app.concludeTurn).not.toHaveBeenCalled()
  })

  it('keeps an active connection check in the same turn so the original task can continue', async () => {
    toolkits.mockResolvedValueOnce({ items: [{
      slug: 'gmail', name: 'Gmail', connection: { isActive: true },
    }] })
    const app = harness()
    const result = await app.tool().execute(
      { action: 'connection_status', apps: ['Gmail'] },
      { signal: AbortSignal.abort() },
    )
    expect(result).toMatchObject({
      status: 'ready', connected_toolkits: ['gmail'],
      next_action: 'continue_current_request',
    })
    const guidance = typeof result === 'object' && result !== null && 'next_action_guidance' in result
      ? result.next_action_guidance
      : undefined
    if (typeof guidance !== 'string') throw new TypeError('expected continuation guidance')
    expect(guidance).toContain('same user request')
    expect(app.concludeTurn).not.toHaveBeenCalled()
  })

  it('reports a disconnected named toolkit without initiating OAuth', async () => {
    toolkits.mockResolvedValueOnce({ items: [{
      slug: 'instagram', name: 'Instagram', logo: 'https://logos.example/instagram.svg',
      connection: { isActive: false },
    }] })
    const app = harness()
    await expect(app.tool().execute({ action: 'connection_status', apps: ['Instagram'] }, { signal: AbortSignal.abort() }))
      .resolves.toMatchObject({
        status: 'not_connected', toolkit: 'instagram', app_label: 'Instagram',
        disconnected_toolkits: ['instagram'],
        toolkit_connection_statuses: [{ toolkit: 'instagram', has_active_connection: false }],
      })
    expect(execute).not.toHaveBeenCalled()
    expect(app.concludeTurn).not.toHaveBeenCalled()
  })

  it('configures a conversation callback URL on the authenticated Composio session', async () => {
    toolkits.mockResolvedValueOnce({ items: [{
      slug: 'instagram', name: 'Instagram', connection: { isActive: true },
    }] })
    const app = harness(true, { orgId: 'org-a', userId: 'user-a' }, false, {
      connectionCallbackBaseUrl: 'https://next.preview.singulancelabs.com/hivemind/app/overview',
    })
    const agent = { session: { header: { id: 'session-123' }, snapshotEvents: () => [], append: vi.fn() } }
    await app.tool().execute({ action: 'connection_status', apps: ['Instagram'] }, { signal: AbortSignal.abort(), agent } as never)
    expect(create).toHaveBeenCalledWith('hivemind:user-a', {
      mcp: true,
      connectedAccounts: {},
      manageConnections: {
        enable: true,
        callbackUrl: 'https://next.preview.singulancelabs.com/hivemind/app/overview/session/session-123?hivemind_connection=complete&hivemind_session=session-123',
      },
    })
  })

  it.each([
    ['unspecified', []],
    ['inactive', [{ slug: 'slack', name: 'Slack', connection: { isActive: false } }]],
    ['unrelated active account', [{ slug: 'gmail', name: 'Gmail', connection: { isActive: true } }]],
    ['conflicting evidence', [{ slug: 'slack', name: 'Slack', connection: { isActive: true } }, { slug: 'slack', name: 'Slack', connection: { isActive: false } }]],
  ])('keeps %s connection evidence paused without another model step', async (_label, items) => {
    toolkits.mockResolvedValue({ items })
    const app = harness()
    await expect(app.tool().execute({ action: 'wait_connection', toolkits: ['slack'], session_id: 'workflow-1' }, { signal: new AbortController().signal }))
      .resolves.toMatchObject({ status: 'connection_pending', session_id: 'workflow-1', pending_toolkits: ['slack'], next_action: 'remain_parked' })
    expect(app.concludeTurn).toHaveBeenCalledOnce()
    expect(execute).not.toHaveBeenCalled()
  })

  it('continues only after every requested toolkit is active', async () => {
    toolkits.mockResolvedValue({ items: [
      { slug: 'slack', name: 'Slack', connection: { isActive: true } },
      { slug: 'gmail', name: 'Gmail', connection: { isActive: true } },
    ] })
    const app = harness()
    await expect(app.tool().execute({ action: 'wait_connection', toolkits: ['slack', 'gmail'], session_id: 'workflow-1' }, { signal: new AbortController().signal }))
      .resolves.toMatchObject({ status: 'ready', session_id: 'workflow-1', pending_toolkits: [] })
    expect(app.concludeTurn).not.toHaveBeenCalled()
    expect(toolkits).toHaveBeenCalledTimes(2)
    expect(execute).not.toHaveBeenCalled()
  })

  it('does not wait with a missing workflow session', async () => {
    const app = harness()
    await expect(app.tool().execute({ action: 'wait_connection', toolkits: ['slack'] }, { signal: new AbortController().signal }))
      .rejects.toThrow('original search session_id')
    expect(execute).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('parks on provider failure without reporting connection success or repeating authorization', async () => {
    toolkits.mockRejectedValue(new Error('provider unavailable'))
    const app = harness()
    await expect(app.tool().execute({ action: 'wait_connection', toolkits: ['slack'], session_id: 'workflow-1' }, { signal: new AbortController().signal }))
      .resolves.toMatchObject({ status: 'connection_pending', connection_check: 'unavailable' })
    expect(app.concludeTurn).toHaveBeenCalledOnce()
    expect(execute).not.toHaveBeenCalled()
    expect(app.ask).not.toHaveBeenCalled()
  })

  it('cancels a slow provider status request at five seconds and parks the same workflow', async () => {
    toolkits.mockImplementationOnce(async (_query, options) => {
      if (options === undefined) throw new Error('Access check must pass SDK cancellation')
      return await new Promise<Awaited<ReturnType<typeof toolkits>>>((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      })
    })
    const app = harness()
    await expect(app.tool().execute({ action: 'wait_connection', toolkits: ['slack'], session_id: 'workflow-1' }, { signal: new AbortController().signal }))
      .resolves.toMatchObject({ status: 'connection_pending', session_id: 'workflow-1', connection_check: 'timed_out', next_action: 'remain_parked' })
    expect(app.concludeTurn).toHaveBeenCalledOnce()
    expect(execute).not.toHaveBeenCalled()
    expect(app.ask).not.toHaveBeenCalled()
  }, 7_000)

  it.each(['user_declined', 'no_longer_needed'])('persists exact %s cancellation without provider calls and refuses later continuation', async (reason) => {
    const app = harness()
    const events: Array<{ type: string; data: Record<string, unknown> }> = [{ type: 'hivemind/connected-receipt', data: {
      version: 1, tool: 'connection_authorization', workflowSessionId: 'workflow-1',
      receipt: { status: 'connection_required', request_call_id: 'original-call', toolkit: 'slack', session_id: 'workflow-1' } } }]
    const agent = { session: { header: { id: 'restored-room' }, snapshotEvents: () => events,
      append: vi.fn((type: string, data: Record<string, unknown>) => events.push({ type, data })) } }
    const execution = { signal: new AbortController().signal, agent } as never
    await expect(app.tool().execute({ action: 'cancel_connection', session_id: 'workflow-1', request_call_id: 'wrong' }, execution)).rejects.toThrow('exact saved request')
    await expect(app.tool().execute({ action: 'cancel_connection', session_id: 'workflow-1', request_call_id: 'original-call', cancellation_reason: reason }, execution)).resolves.toMatchObject({ status: 'cancelled' })
    await app.tool().execute({ action: 'cancel_connection', session_id: 'workflow-1', request_call_id: 'original-call' }, execution)
    expect(agent.session.append).toHaveBeenCalledOnce()
    expect(JSON.stringify(events.at(-1))).toContain(reason)
    expect(app.flush).toHaveBeenCalledTimes(2)
    await expect(app.tool().execute({ action: 'wait_connection', session_id: 'workflow-1' }, execution)).rejects.toThrow('cancelled')
    expect(execute).not.toHaveBeenCalled()
    expect(toolkits).not.toHaveBeenCalled()
  })

  it('preserves another app authorization in the same workflow after exact cancellation', async () => {
    const app = harness()
    toolkits.mockResolvedValue({ items: [{ slug: 'gmail', name: 'Gmail', connection: { isActive: true } }] })
    const events = ['gmail', 'slack'].map(toolkit => ({ type: 'hivemind/connected-receipt', data: {
      version: 1, tool: 'connection_authorization', workflowSessionId: 'workflow-1',
      receipt: { status: toolkit === 'slack' ? 'cancelled' : 'connection_required', toolkit,
        session_id: 'workflow-1', request_call_id: `${toolkit}-call` } } }))
    const agent = { session: { header: { id: 'restored-room' }, snapshotEvents: () => events, append: vi.fn() } }
    await expect(app.tool().execute({ action: 'wait_connection', session_id: 'workflow-1', toolkits: ['gmail'] },
      { signal: new AbortController().signal, agent } as never)).resolves.toMatchObject({ status: 'ready' })
    expect(agent.session.append).toHaveBeenCalledWith('hivemind/connected-receipt', expect.objectContaining({ receipt: expect.objectContaining({ request_call_id: 'gmail-call', status: 'ready' }) }))
  })

  it('recovers exact saved toolkits after reload and leaves one original notification unchanged across Continue clicks', async () => {
    toolkits.mockResolvedValue({ items: [{ slug: 'slack', name: 'Slack', connection: { isActive: false } }] })
    const app = harness()
    const receipt = { status: 'connection_required', request_call_id: 'original-call', toolkit: 'slack',
      session_id: 'workflow-1', notification_status: 'accepted', redirect_url: 'https://connect.example/slack' }
    const events = [{ type: 'hivemind/connected-receipt', data: { version: 1,
      tool: 'connection_authorization', workflowSessionId: 'workflow-1', receipt } }]
    const agent = { session: { header: { id: 'restored-room' }, snapshotEvents: () => events, append: vi.fn() } }
    for (let click = 0; click < 2; click++) {
      await expect(app.tool().execute({ action: 'wait_connection', session_id: 'workflow-1' },
        { signal: new AbortController().signal, agent } as never))
        .resolves.toMatchObject({ status: 'connection_pending', session_id: 'workflow-1', pending_toolkits: ['slack'] })
    }
    expect(toolkits).toHaveBeenCalledTimes(2)
    expect(app.concludeTurn).toHaveBeenCalledTimes(2)
    expect(agent.session.append).not.toHaveBeenCalledWith('hivemind/connected-receipt', expect.anything())
    expect(receipt.notification_status).toBe('accepted')
    expect(execute).not.toHaveBeenCalled()
    expect(app.ask).not.toHaveBeenCalled()
  })

  it('checks every original app even when Continue supplies a partial toolkit list', async () => {
    toolkits.mockResolvedValue({ items: [
      { slug: 'slack', name: 'Slack', connection: { isActive: true } },
      { slug: 'gmail', name: 'Gmail', connection: { isActive: false } },
    ] })
    const app = harness()
    const events = [{ type: 'hivemind/connected-receipt', data: { version: 1,
      tool: 'connection_authorization', workflowSessionId: 'workflow-1',
      receipt: { status: 'connection_required', pending_toolkits: ['slack', 'gmail'], request_call_id: 'original' } } }]
    const agent = { session: { header: { id: 'room' }, snapshotEvents: () => events, append: vi.fn() } }
    await expect(app.tool().execute({ action: 'wait_connection', toolkits: ['slack'], session_id: 'workflow-1' },
      { signal: new AbortController().signal, agent } as never))
      .resolves.toMatchObject({ status: 'connection_pending', pending_toolkits: ['gmail'] })
    expect(toolkits).toHaveBeenCalledTimes(2)
    expect(agent.session.append).not.toHaveBeenCalledWith('hivemind/connected-receipt', expect.anything())
    await expect(app.tool().execute({ action: 'wait_connection', toolkits: ['notion'], session_id: 'workflow-1' },
      { signal: new AbortController().signal, agent } as never)).rejects.toThrow('original saved workflow')
    expect(toolkits).toHaveBeenCalledTimes(2)
  })

  it('preserves cancellation by the caller rather than treating it as provider timeout', async () => {
    toolkits.mockRejectedValue(new Error('cancelled'))
    const app = harness()
    await expect(app.tool().execute({ action: 'wait_connection', toolkits: ['slack'], session_id: 'workflow-1' }, { signal: AbortSignal.abort() }))
      .rejects.toThrow('cancelled')
    expect(app.concludeTurn).not.toHaveBeenCalled()
  })

  it('concludes a disconnected search with one session-bound connection receipt', async () => {
    execute
      .mockResolvedValueOnce({ data: {
        results: [{ primary_tool_slugs: ['SLACK_SEND_MESSAGE'], toolkits: ['slack'] }],
        toolkit_connection_statuses: [{ toolkit: 'slack', has_active_connection: false }],
        session: { id: 'workflow-1' },
      } })
      .mockResolvedValueOnce({ data: { redirect_url: 'https://connect.example/slack' } })
    const { tool, concludeTurn } = harness()
    await expect(tool().execute({
      action: 'search',
      queries: [{ app: 'Slack', use_case: 'Send a Slack message to a named channel after resolving its channel id.' }],
      session: { generate_id: true },
    }, { signal: AbortSignal.abort() })).resolves.toMatchObject({
      status: 'connection_required',
      operations: [
        { tool: 'COMPOSIO_SEARCH_TOOLS', status: 'completed' },
        { tool: 'COMPOSIO_MANAGE_CONNECTIONS', status: 'completed' },
      ],
      toolkit: 'slack',
      app_label: 'Slack',
      redirect_url: 'https://connect.example/slack',
      session_id: 'workflow-1',
    })
    expect(execute).toHaveBeenNthCalledWith(2, 'COMPOSIO_MANAGE_CONNECTIONS', {
      toolkits: ['slack'], session_id: 'workflow-1',
    })
    expect(concludeTurn).toHaveBeenCalledOnce()
  })

  it('settles an aborted connection question as a durable resumable receipt', async () => {
    execute
      .mockResolvedValueOnce({ data: {
        results: [{ primary_tool_slugs: ['ASANA_LIST_TASKS'], toolkits: ['asana'] }],
        toolkit_connection_statuses: [{ toolkit: 'asana', has_active_connection: false }],
        session: { id: 'workflow-asana' },
      } })
      .mockResolvedValueOnce({ data: { redirect_url: 'https://connect.example/asana' } })
    const app = harness()
    app.ask.mockRejectedValue(Object.assign(
      new Error('ask_user_question was aborted before the user answered'),
      { code: 'ASK_ABORTED' },
    ))
    const agent = { id: 'agent-1', session: { header: { id: 'conversation-1' }, snapshotEvents: () => [], append: vi.fn() } }

    await expect(app.tool().execute({
      action: 'search', queries: [{ app: 'Asana', use_case: 'List current Asana tasks.' }], session: { generate_id: true },
    }, { signal: new AbortController().signal, agent } as never)).resolves.toMatchObject({
      status: 'connection_required',
      toolkit: 'asana',
      redirect_url: 'https://connect.example/asana',
      session_id: 'workflow-asana',
    })
    expect(execute).toHaveBeenCalledTimes(2)
    expect(app.concludeTurn).toHaveBeenCalledOnce()
  })

  it.each([
    { name: 'missing toolkit', statuses: [{ toolkit: 'slack', status: 'ACTIVE' }], ready: false },
    { name: 'contradictory toolkit', statuses: [{ toolkit: 'slack', status: 'ACTIVE' }, { toolkit: 'gmail', status: 'ACTIVE' }, { toolkit: 'gmail', status: 'PENDING' }], ready: false },
    { name: 'all affirmative toolkits', statuses: [{ toolkit: 'slack', status: 'ACTIVE' }, { toolkit: 'gmail', status: 'ACTIVE' }], ready: true },
  ])('updates only the matching saved authorization after verified access: $name', async ({ statuses, ready }) => {
    toolkits.mockResolvedValue({ items: statuses.map(item => ({ slug: item.toolkit, name: item.toolkit, connection: { isActive: item.status === 'ACTIVE' } })) })
    const app = harness()
    const events = [
      { type: 'hivemind/connected-receipt', data: { version: 1, tool: 'connection_authorization',
        workflowSessionId: 'workflow-1', receipt: { status: 'connection_required', request_call_id: 'original-call',
          session_id: 'workflow-1', pending_toolkits: ['slack', 'gmail'], app_label: 'Slack', reason: 'Review the company sources.' } } },
      { type: 'hivemind/connected-receipt', data: { version: 1, tool: 'connection_authorization',
        workflowSessionId: 'foreign-workflow', receipt: { status: 'connection_required', request_call_id: 'foreign-call',
          session_id: 'foreign-workflow' } } },
    ]
    const agent = { id: 'runtime-room', session: { header: { id: 'runtime-room' }, snapshotEvents: () => events, append: vi.fn() } }
    await expect(app.tool().execute({ action: 'wait_connection', toolkits: ['slack', 'gmail'], session_id: 'workflow-1' },
      { signal: new AbortController().signal, agent, callId: 'verify-call' } as never))
      .resolves.toMatchObject({ status: ready ? 'ready' : 'connection_pending' })
    const authorizationUpdates = agent.session.append.mock.calls.filter(([type, data]) =>
      type === 'hivemind/connected-receipt' && data.tool === 'connection_authorization')
    if (ready) {
      expect(authorizationUpdates).toEqual([['hivemind/connected-receipt', {
        version: 1, tool: 'connection_authorization', workflowSessionId: 'workflow-1', receipt: {
          status: 'ready', request_call_id: 'original-call', session_id: 'workflow-1', pending_toolkits: ['slack', 'gmail'],
          app_label: 'Slack', reason: 'Review the company sources.',
        },
      }]])
      expect(app.flush).toHaveBeenCalledOnce()
      expect(app.concludeTurn).not.toHaveBeenCalled()
    } else {
      expect(authorizationUpdates).toEqual([])
      expect(app.flush).not.toHaveBeenCalled()
      expect(app.concludeTurn).toHaveBeenCalledOnce()
    }
    expect(app.ask).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect(events[0]?.data.receipt.status).toBe('connection_required')
    expect(events[1]?.data.receipt.status).toBe('connection_required')
  })

  it.each(['accepted', 'not_sent', 'unknown'] as const)(
    'ends the Runtime connection turn after one saved request and one email attempt (%s)', async (outcome) => {
      execute.mockResolvedValueOnce({ data: {
        results: [{ primary_tool_slugs: ['ASANA_LIST_TASKS'], toolkits: ['asana'] }],
        toolkit_connection_statuses: [{ toolkit: 'asana', has_active_connection: false }],
        session: { id: 'workflow-asana' },
      } }).mockResolvedValueOnce({ data: { redirect_url: 'https://connect.example/asana' } })
      const order: string[] = []
      const serial = vi.fn(async (event: string) => event === 'hivemind/runtime-connection-owner' ? true : undefined)
      const app = harness(true, undefined, false, {
        serviceApiBase: 'http://127.0.0.1:3000', serviceSecretEnv: 'TEST_RUNTIME_CONNECTION_SECRET',
      }, serial)
      app.flush.mockImplementation(async () => { order.push('flush'); return true })
      const agent = { id: 'runtime-room', session: { header: { id: 'runtime-room' }, snapshotEvents: () => [], append: vi.fn() } }
      const emails: Array<Record<string, unknown>> = []
      process.env.TEST_RUNTIME_CONNECTION_SECRET = 'runtime-connection-secret-at-least-32-bytes'
      vi.stubGlobal('fetch', vi.fn(async (url: URL, init: RequestInit) => {
        if (String(url).endsWith('/administrator-message')) {
          order.push('email')
          emails.push(JSON.parse(String(init.body)))
          expect(agent.session.append).toHaveBeenCalledWith('hivemind/connected-receipt', expect.objectContaining({
            version: 1, tool: 'connection_authorization', workflowSessionId: 'workflow-asana',
            receipt: expect.objectContaining({ status: 'connection_required', request_call_id: 'connection-call',
              session_id: 'workflow-asana', app_label: 'Asana', reason: 'List current Asana tasks.' }),
          }))
          const token = String((init.headers as Record<string, string>).authorization).split(' ')[1]!
          const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())
          expect(claims).toMatchObject({ operating_role: 'runtime', operating_session: 'runtime-room', org_id: 'org-a', sub: 'user-a' })
          if (outcome === 'unknown') throw new Error('connection lost after send')
          return new Response(JSON.stringify({ status: 'accepted' }), { status: outcome === 'not_sent' ? 503 : 200 })
        }
        return new Response(JSON.stringify({ receipt_id: 'receipt-1', bytes: 10 }), { status: 201 })
      }))
      try {
        await expect(app.tool().execute({ action: 'search', queries: [{ app: 'Asana', use_case: 'List current Asana tasks.' }],
          session: { generate_id: true } }, { signal: new AbortController().signal, agent,
          callId: 'connection-call', name: 'hivemind_connected_task' } as never))
          .resolves.toMatchObject({ status: 'connection_required', notification_status: outcome, session_id: 'workflow-asana' })
        expect(emails).toEqual([{ message_key: 'connection-call-user-request', kind: 'approval',
          request_call_id: 'connection-call', subject: 'Connect Asana', message: 'List current Asana tasks.' }])
        expect(order).toEqual(['flush', 'email'])
        expect(serial).toHaveBeenCalledWith('hivemind/runtime-connection-owner', agent)
        expect(app.ask).not.toHaveBeenCalled()
        expect(execute).toHaveBeenCalledTimes(2)
        expect(app.concludeTurn).toHaveBeenCalledOnce()
      } finally {
        delete process.env.TEST_RUNTIME_CONNECTION_SECRET
        vi.unstubAllGlobals()
      }
    },
  )

  it('hands a Runtime-delegated missing connector to its durable blocker without a human popup', async () => {
    execute.mockResolvedValueOnce({ data: {
      results: [{ primary_tool_slugs: ['ASANA_LIST_TASKS'], toolkits: ['asana'] }],
      toolkit_connection_statuses: [{ toolkit: 'asana', has_active_connection: false }],
      session: { id: 'workflow-asana' },
    } }).mockResolvedValueOnce({ data: { redirect_url: 'https://connect.example/asana' } })
    const report = vi.fn(async () => ({ status: 'blocked_reported', blocker_id: 'blocker', task_id: 'task-1',
      checkpoint_id: 'checkpoint', message_id: 'message' }))
    const app = harness(true, { orgId: 'org-a', userId: 'user-a' }, false, {}, report)
    const agent = { id: 'employee', session: { header: { id: 'room' }, snapshotEvents: () => [], append: vi.fn() } }
    await expect(app.tool().execute({ action: 'search', queries: [{ app: 'Asana', use_case: 'List Asana tasks' }],
      session: { generate_id: true } }, { signal: new AbortController().signal, agent, callId: 'call' } as never))
      .resolves.toMatchObject({ status: 'blocked_reported', session_id: 'workflow-asana' })
    expect(report).toHaveBeenCalledWith('hivemind/delegated-connection-blocker', expect.objectContaining({
      workflowSessionId: 'workflow-asana', toolkits: ['asana'],
    }))
    expect(app.ask).not.toHaveBeenCalled()
    expect(app.concludeTurn).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('pauses natively and resumes the original search contract after verified connection', async () => {
    execute
      .mockResolvedValueOnce({ data: {
        results: [{
          primary_tool_slugs: ['ASANA_LIST_TASKS'],
          toolkits: ['asana'],
          recommended_plan_steps: ['List the requested tasks.'],
          tool_schemas: { ASANA_LIST_TASKS: { input_schema: {
            type: 'object', required: ['workspace_id'], properties: { workspace_id: { type: 'string' } },
          } } },
        }],
        toolkit_connection_statuses: [{ toolkit: 'asana', has_active_connection: false }],
        session: { id: 'workflow-asana' },
      } })
      .mockResolvedValueOnce({ data: { redirect_url: 'https://connect.example/asana' } })
      .mockResolvedValueOnce({ data: { toolkit: 'asana', status: 'ACTIVE' } })
    const app = harness()
    app.ask.mockResolvedValue({ answers: [{
      id: 'hivemind-connected-app-authorization:workflow-asana:asana',
      selected: ["I've connected Asana — continue"],
    }] })
    const agent = { id: 'agent-1', session: { header: { id: 'conversation-1' }, snapshotEvents: () => [], append: vi.fn() } }
    const result = await app.tool().execute({
      action: 'search',
      queries: [{ app: 'Asana', use_case: 'List current Asana tasks.' }],
      session: { generate_id: true },
    }, { signal: new AbortController().signal, agent } as never)

    expect(app.ask).toHaveBeenCalledOnce()
    expect(app.ask.mock.calls[0]?.[0]).toMatchObject({ questions: [{
      id: 'hivemind-connected-app-authorization:workflow-asana:asana',
      question: 'Connect Asana to continue, then return here.',
      options: [
        { label: 'Connect Asana' },
        { label: "I've connected Asana — continue" },
      ],
    }], agent })
    const asked = app.ask.mock.calls[0]?.[0] as { questions: Array<{ detail?: string }> }
    const detail = asked.questions[0]?.detail
    expect(detail).toContain('Authorize in a new tab, then continue this request.')
    expect(detail).toContain('<!-- hivemind-connected-app-authorization:')
    expect(detail).toContain(encodeURIComponent('https://connect.example/asana'))
    expect(execute).toHaveBeenNthCalledWith(3, 'COMPOSIO_WAIT_FOR_CONNECTIONS', {
      session_id: 'workflow-asana', toolkits: ['asana'],
    })
    expect(result).toMatchObject({
      status: 'ready',
      session_id: 'workflow-asana',
      toolkit: 'asana',
      app_label: 'Asana',
      connected_toolkits: ['asana'],
      toolkit_connection_statuses: [{ toolkit: 'asana', has_active_connection: true, status_message: 'ACTIVE' }],
      results: [{ primary_tool_slugs: ['ASANA_LIST_TASKS'], recommended_plan_steps: ['List the requested tasks.'] }],
      execution_contracts: [{ tool_slug: 'ASANA_LIST_TASKS', required_fields: ['workspace_id'] }],
    })
    expect(app.concludeTurn).not.toHaveBeenCalled()
  })

  it('keeps the same tool call paused when verification is not yet active', async () => {
    execute
      .mockResolvedValueOnce({ data: {
        results: [{ primary_tool_slugs: ['SLACK_FETCH_TEAM_INFO'], toolkits: ['slack'] }],
        toolkit_connection_statuses: [{ toolkit: 'slack', has_active_connection: false }],
        session: { id: 'workflow-slack' },
      } })
      .mockResolvedValueOnce({ data: { redirect_url: 'https://connect.example/slack' } })
      .mockResolvedValueOnce({ data: { toolkit: 'slack', status: 'PENDING' } })
      .mockResolvedValueOnce({ data: { toolkit: 'slack', status: 'ACTIVE' } })
    const app = harness()
    app.ask.mockResolvedValue({ answers: [{
      id: 'hivemind-connected-app-authorization:workflow-slack:slack',
      selected: ["I've connected Slack — continue"],
    }] })
    const agent = { id: 'agent-1', session: { header: { id: 'conversation-1' }, snapshotEvents: () => [], append: vi.fn() } }

    await expect(app.tool().execute({
      action: 'search', queries: [{ app: 'Slack', use_case: 'Read Slack workspace information.' }], session: { generate_id: true },
    }, { signal: new AbortController().signal, agent } as never)).resolves.toMatchObject({ status: 'ready' })

    expect(app.ask).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenNthCalledWith(1, 'COMPOSIO_SEARCH_TOOLS', expect.any(Object))
    expect(execute).toHaveBeenNthCalledWith(2, 'COMPOSIO_MANAGE_CONNECTIONS', expect.any(Object))
    expect(execute).toHaveBeenNthCalledWith(3, 'COMPOSIO_WAIT_FOR_CONNECTIONS', expect.any(Object))
    expect(execute).toHaveBeenNthCalledWith(4, 'COMPOSIO_WAIT_FOR_CONNECTIONS', expect.any(Object))
    expect(app.concludeTurn).not.toHaveBeenCalled()
  })

  it('does not make a schema absent from provider discovery executable', async () => {
    execute
      .mockResolvedValueOnce({ data: { results: [{
        primary_tool_slugs: ['GMAIL_FETCH_EMAILS'],
        related_tool_slugs: ['GMAIL_LIST_LABELS'],
      }] } })
      .mockResolvedValueOnce({ data: { tool_schemas: {
        GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID: { input_schema: {
          type: 'object', required: ['message_id'], properties: { message_id: { type: 'string' } },
        } },
      } } })
    const app = harness()
    await app.tool().execute({ action: 'search', queries: [{ app: 'Gmail', use_case: 'Read the newest Gmail subject.' }], session: { generate_id: true } }, { signal: AbortSignal.abort() })
    await expect(app.tool().execute({ action: 'schemas', tool_slug: 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID' }, { signal: AbortSignal.abort() }))
      .rejects.toThrow('Schema request contains a tool not selected by the current search')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('loads an exact read-only follow-up from the provider plan before execution', async () => {
    execute
      .mockResolvedValueOnce({ data: { session: { id: 'workflow-pr' }, results: [{
        primary_tool_slugs: ['GITHUB_GET_A_PULL_REQUEST'],
        recommended_plan_steps: [
          '[Required] [Step] GITHUB_GET_A_PULL_REQUEST for PR details',
          '[Required] [Step] GITHUB_LIST_COMMITS_ON_A_PULL_REQUEST for commit history',
          '[Optional] GITHUB_COMPARE_TWO_COMMITS for diff fallback',
        ],
        tool_schemas: { GITHUB_GET_A_PULL_REQUEST: { input_schema: {
          type: 'object', required: ['pull_number'], properties: { pull_number: { type: 'integer' } },
        } } },
      }] } })
      .mockResolvedValueOnce({ data: { number: 122 } })
      .mockResolvedValueOnce({ data: { tool_schemas: { GITHUB_LIST_COMMITS_ON_A_PULL_REQUEST: { input_schema: {
        type: 'object', required: ['pull_number'], properties: { pull_number: { type: 'integer' } },
      } } } } })
      .mockResolvedValueOnce({ data: { commits: [{ sha: '3bdbfc0' }] } })
    const app = harness()
    const first = await app.tool().execute({ action: 'search', queries: [{ app: 'GitHub', use_case: 'Inspect PR 122 commits.' }], session: { generate_id: true } }, { signal: AbortSignal.abort() })
    expect(first).toMatchObject({ session_id: 'workflow-pr' })
    await app.tool().execute({ action: 'execute', session_id: 'workflow-pr', tool_slug: 'GITHUB_GET_A_PULL_REQUEST', arguments: { pull_number: 122 } }, { signal: AbortSignal.abort() })
    await expect(app.tool().execute({ action: 'execute', session_id: 'workflow-pr', tool_slug: 'GITHUB_LIST_COMMITS_ON_A_PULL_REQUEST', arguments: { pull_number: 122 } }, { signal: AbortSignal.abort() }))
      .rejects.toThrow('Tool was not selected')
    await expect(app.tool().execute({ action: 'schemas', session_id: 'workflow-pr', tool_slug: 'GITHUB_LIST_COMMITS_ON_A_PULL_REQUEST' }, { signal: AbortSignal.abort() }))
      .resolves.toMatchObject({ execution_contracts: [{ tool_slug: 'GITHUB_LIST_COMMITS_ON_A_PULL_REQUEST' }] })
    await expect(app.tool().execute({ action: 'execute', session_id: 'workflow-pr', tool_slug: 'GITHUB_LIST_COMMITS_ON_A_PULL_REQUEST', arguments: { pull_number: 122 } }, { signal: AbortSignal.abort() }))
      .resolves.toMatchObject({ status: 'ready' })
    expect(execute).toHaveBeenNthCalledWith(3, 'COMPOSIO_GET_TOOL_SCHEMAS', { session_id: 'workflow-pr', tool_slugs: ['GITHUB_LIST_COMMITS_ON_A_PULL_REQUEST'] })
    expect(execute).toHaveBeenNthCalledWith(4, 'GITHUB_LIST_COMMITS_ON_A_PULL_REQUEST', { pull_number: 122 })
  })

  it('never promotes a write or unrelated toolkit from a provider plan', async () => {
    execute.mockResolvedValueOnce({ data: { session: { id: 'workflow-safe' }, results: [{
      primary_tool_slugs: ['GITHUB_GET_A_PULL_REQUEST'],
      recommended_plan_steps: ['GITHUB_DELETE_A_REPOSITORY', 'SLACK_FETCH_MESSAGES'],
    }] } })
    const app = harness()
    await app.tool().execute({ action: 'search', queries: [{ app: 'GitHub', use_case: 'Inspect PR 122.' }], session: { generate_id: true } }, { signal: AbortSignal.abort() })
    for (const slug of ['GITHUB_DELETE_A_REPOSITORY', 'SLACK_FETCH_MESSAGES']) {
      await expect(app.tool().execute({ action: 'schemas', session_id: 'workflow-safe', tool_slug: slug }, { signal: AbortSignal.abort() }))
        .rejects.toThrow('Schema request contains a tool not selected')
    }
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('asks for the toolkit selected by the search instead of an unrelated missing toolkit', async () => {
    execute
      .mockResolvedValueOnce({ data: {
        results: [{ primary_tool_slugs: ['GMAIL_FETCH_EMAILS'], toolkits: ['gmail'] }],
        toolkit_connection_statuses: [
          { toolkit: 'agent_mail', has_active_connection: false },
          { toolkit: 'gmail', has_active_connection: false },
        ],
        session: { id: 'workflow-gmail' },
      } })
      .mockResolvedValueOnce({ data: { redirect_url: 'https://connect.example/gmail' } })
    const app = harness()
    await expect(app.tool().execute({
      action: 'search', queries: [{ app: 'Gmail', use_case: 'Read five Gmail inbox messages.' }], session: { generate_id: true },
    }, { signal: AbortSignal.abort() })).resolves.toMatchObject({ toolkit: 'gmail', app_label: 'Gmail' })
  })

  it('does not gate a selected app on a disconnected optional fallback toolkit', async () => {
    execute.mockResolvedValueOnce({ data: {
      results: [{
        primary_tool_slugs: ['GMAIL_FETCH_EMAILS'],
        related_tool_slugs: ['GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', 'GOOGLEDRIVE_FIND_FILE'],
        toolkits: ['gmail', 'googledrive'],
      }],
      toolkit_connection_statuses: [
        { toolkit: 'gmail', has_active_connection: true },
        { toolkit: 'googledrive', has_active_connection: false },
      ],
      session: { id: 'workflow-gmail' },
    } })
    const app = harness()
    await expect(app.tool().execute({
      action: 'search',
      queries: [{ app: 'Gmail', use_case: 'Read the newest Gmail message.' }],
      session: { generate_id: true },
    }, { signal: AbortSignal.abort() })).resolves.toMatchObject({ status: 'ready' })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(app.concludeTurn).not.toHaveBeenCalled()
  })

  it('asks once through the native approval seam before a selected mutation executes', async () => {
    execute.mockResolvedValueOnce({ data: { results: [{ primary_tool_slugs: ['SLACK_SEND_MESSAGE'], tool_schemas: {
      SLACK_SEND_MESSAGE: { input_schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } },
    } }] } }).mockResolvedValueOnce({ data: { ok: true, message_id: 'message-1' } })
    const app = harness()
    const agent = { session: { header: { id: 'conversation-write' }, snapshotEvents: () => [], append: vi.fn() } }
    await app.tool().execute({ action: 'search', queries: [{ app: 'Slack', use_case: 'Send a Slack message to a named channel after resolving its channel id.' }], session: { generate_id: true } }, { signal: AbortSignal.abort(), agent } as never)
    const pre = app.listeners.get('tools/pre-execute') as (
      execution: { name: string; arguments: Record<string, unknown>; agent: unknown },
      next: () => Promise<{ kind: 'allow' }>,
    ) => Promise<{ kind: string; reason?: string }>
    await expect(pre({
      name: 'hivemind_connected_task',
      arguments: { action: 'execute', tool_slug: 'SLACK_SEND_MESSAGE', arguments: { text: 'hello' } },
      agent,
    }, async () => ({ kind: 'allow' }))).resolves.toMatchObject({ kind: 'ask' })
    await expect(app.tool().execute({
      action: 'execute', tool_slug: 'SLACK_SEND_MESSAGE', arguments: { text: 'hello' },
    }, { signal: AbortSignal.abort(), agent } as never)).resolves.toMatchObject({ status: 'ready' })
    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenLastCalledWith('SLACK_SEND_MESSAGE', { text: 'hello' })
  })

  it('does not repeat a completed mutation when the same native call is retried', async () => {
    execute.mockResolvedValueOnce({ data: { results: [{ primary_tool_slugs: ['SLACK_SEND_MESSAGE'], tool_schemas: {
      SLACK_SEND_MESSAGE: { input_schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } },
    } }] } })
    const key = createHash('sha256').update(JSON.stringify({
      workflow: 'hivemind:user-a:conversation-write:current', tool_slug: 'SLACK_SEND_MESSAGE',
      arguments: { text: 'hello' }, operation_id: 'default',
    })).digest('hex')
    const events = [
      { type: 'tool/call', data: { name: 'hivemind_connected_task', callId: 'write-call', arguments: JSON.stringify({ action: 'execute' }) } },
      { type: 'tool/result', data: { message: { source: { callId: 'write-call' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: JSON.stringify({ status: 'ready', idempotency_key: key, source_receipt: { locator: 'private:write' } }) }] }] } } },
    ]
    const agent = { session: { header: { id: 'conversation-write' }, snapshotEvents: () => events, append: vi.fn() } }
    const app = harness()
    await app.tool().execute({ action: 'search', queries: [{ app: 'Slack', use_case: 'Send one Slack message.' }], session: { generate_id: true } }, { signal: AbortSignal.abort(), agent } as never)
    await expect(app.tool().execute({
      action: 'execute', tool_slug: 'SLACK_SEND_MESSAGE', arguments: { text: 'hello' },
    }, { signal: AbortSignal.abort(), agent, callId: 'write-call' } as never)).resolves.toMatchObject({
      status: 'duplicate', idempotency_key: key,
    })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('refuses guessed fields and requires an authoritative schema before execution', async () => {
    execute.mockResolvedValueOnce({ data: { results: [{ primary_tool_slugs: ['SLACK_FIND_CHANNELS'], tool_schemas: {
      SLACK_FIND_CHANNELS: { input_schema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } } },
    } }] } })
    const app = harness()
    await app.tool().execute({ action: 'search', queries: [{ app: 'Slack', use_case: 'Find the exact Slack channel named davinci and return its id.' }], session: { generate_id: true } }, { signal: AbortSignal.abort() })
    await expect(app.tool().execute({ action: 'execute', tool_slug: 'SLACK_FIND_CHANNELS', arguments: { channel_name: 'davinci' } }, { signal: AbortSignal.abort() })).rejects.toThrow("required property 'query'")
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('validates nested constraints from the authoritative schema before provider execution', async () => {
    execute.mockResolvedValueOnce({ data: { results: [{ primary_tool_slugs: ['EXAMPLE_READ'], tool_schemas: {
      EXAMPLE_READ: { input_schema: { type: 'object', additionalProperties: false, required: ['filter'], properties: {
        filter: { type: 'object', additionalProperties: false, required: ['ids'], properties: {
          ids: { type: 'array', minItems: 1, items: { type: 'string', minLength: 3 } },
        } },
      } } },
    } }] } })
    const app = harness()
    await app.tool().execute({ action: 'search', queries: [{ use_case: 'Example: read selected values.' }], session: { generate_id: true } }, { signal: AbortSignal.abort() })
    await expect(app.tool().execute({
      action: 'execute', tool_slug: 'EXAMPLE_READ', arguments: { filter: { ids: ['x'], guessed: true } },
    }, { signal: AbortSignal.abort() })).rejects.toThrow('authoritative schema')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('normalizes omitted arguments to an empty object only for a zero-required-field contract', async () => {
    execute
      .mockResolvedValueOnce({ data: { results: [{ primary_tool_slugs: ['SLACK_FETCH_TEAM_INFO'], tool_schemas: {
        SLACK_FETCH_TEAM_INFO: { input_schema: { type: 'object', required: [], properties: {
          team: { type: 'string' },
        } } },
      } }] } })
      .mockResolvedValueOnce({ data: { team: { name: 'Davinci AI' } } })
    const app = harness()
    await app.tool().execute({ action: 'search', queries: [{ app: 'Slack', use_case: 'Get the Slack workspace name.' }], session: { generate_id: true } }, { signal: AbortSignal.abort() })
    await expect(app.tool().execute({ action: 'execute', tool_slug: 'SLACK_FETCH_TEAM_INFO' }, { signal: AbortSignal.abort() }))
      .resolves.toMatchObject({ status: 'ready' })
    expect(execute).toHaveBeenLastCalledWith('SLACK_FETCH_TEAM_INFO', {})
  })

  it('denies bridge execution when the capability latch is off', async () => {
    const { tool } = harness(false)
    await expect(tool().execute({ action: 'search', queries: [{ app: 'Gmail', use_case: 'Read Gmail inbox messages.' }], session: { generate_id: true } }, { signal: AbortSignal.abort() })).rejects.toThrow('disabled')
  })

  it('uses the scoped profile default only when the UI has no explicit latch', async () => {
    execute.mockResolvedValueOnce({ data: { results: [] } })
    const implicit = harness(undefined, undefined, true)
    await expect(implicit.tool().execute({ action: 'search', queries: [{ app: 'Gmail', use_case: 'List the five newest Gmail inbox messages, excluding drafts, ordered newest first, returning id, sender, subject, received timestamp, and body snippet.' }], session: { generate_id: true }, search_strategy: 'auto' }, { signal: AbortSignal.abort() })).resolves.toMatchObject({ status: 'no_matching_tool' })

    const explicitOff = harness(false, undefined, true)
    await expect(explicitOff.tool().execute({ action: 'search', queries: [{ app: 'Gmail', use_case: 'Read Gmail inbox messages.' }], session: { generate_id: true } }, { signal: AbortSignal.abort() })).rejects.toThrow('disabled')
  })

  it('passes structured parallel search parameters to Composio without flattening them', async () => {
    execute.mockResolvedValueOnce({ data: { results: [] } })
    const { tool } = harness()
    await tool().execute({
      action: 'search',
      queries: [
        { app: 'Gmail', use_case: 'List the five newest Gmail inbox messages, excluding drafts, ordered newest first, returning id, sender, subject, received timestamp, and body snippet.' },
        { app: 'Gmail', use_case: 'Fetch complete Gmail message content for selected message ids.', known_fields: 'result_limit:5' },
      ],
      session: { generate_id: true },
      model: 'deepseek-chat',
      search_strategy: 'auto',
    }, { signal: AbortSignal.abort() })
    expect(execute).toHaveBeenCalledWith('COMPOSIO_SEARCH_TOOLS', {
      queries: [
        { use_case: 'List the five newest Gmail inbox messages, excluding drafts, ordered newest first, returning id, sender, subject, received timestamp, and body snippet.' },
        { use_case: 'Fetch complete Gmail message content for selected message ids.', known_fields: 'result_limit:5' },
      ],
      session: { generate_id: true },
      model: 'deepseek-chat',
      search_strategy: 'auto',
    })
  })

  it('accepts a query-nested workflow session but forwards one top-level provider session', async () => {
    execute.mockResolvedValueOnce({ data: { session: { id: 'mail-workflow' }, results: [] } })
    const { tool } = harness()
    await tool().execute({ action: 'search', queries: [{
      use_case: 'Search received messages by sender', known_fields: 'sender_contains:singulance, limit:2',
      session: { generate_id: true },
    }] }, { signal: AbortSignal.abort() })
    expect(execute).toHaveBeenCalledWith('COMPOSIO_SEARCH_TOOLS', {
      queries: [{ use_case: 'Search received messages by sender', known_fields: 'sender_contains:singulance, limit:2' }],
      session: { generate_id: true },
    })
  })

  it('rejects conflicting nested workflow sessions before provider discovery', async () => {
    const { tool } = harness()
    await expect(tool().execute({ action: 'search', queries: [{
      use_case: 'Search records', session: { id: 'other-workflow' },
    }], session: { id: 'current-workflow' } }, { signal: AbortSignal.abort() })).rejects.toThrow('same workflow session')
    expect(execute).not.toHaveBeenCalled()
  })

  it('retries a received-message search once when discovery selects drafts', async () => {
    execute
      .mockResolvedValueOnce({ data: { session: { id: 'mail-workflow' }, results: [{
        primary_tool_slugs: ['GMAIL_LIST_DRAFTS'], toolkits: ['gmail'],
      }] } })
      .mockResolvedValueOnce({ data: { session: { id: 'mail-workflow' }, results: [{
        primary_tool_slugs: ['GMAIL_FETCH_EMAILS'], toolkits: ['gmail'], tool_schemas: {
          GMAIL_FETCH_EMAILS: { input_schema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } } },
        },
      }] } })
    const app = harness(true, undefined, false, { withSpill: true })
    const agent = { session: { header: { id: 'received-mail-canary' }, snapshotEvents: () => [], append: vi.fn() } }
    const value = await app.tool().execute({ action: 'search', queries: [{
      app: 'Gmail', use_case: 'Fetch the 5 latest emails from Singulance, newest first, excluding drafts',
    }], session: { generate_id: true } }, {
      signal: new AbortController().signal, agent, name: 'hivemind_connected_task', callId: 'search-call',
    } as never)
    expect(value).toMatchObject({ status: 'ready', session_id: 'mail-workflow',
      execution_contracts: [{ tool_slug: 'GMAIL_FETCH_EMAILS' }],
      operations: [{ tool: 'COMPOSIO_SEARCH_TOOLS' }, { tool: 'COMPOSIO_SEARCH_TOOLS' }],
    })
    expect(JSON.stringify(value)).not.toContain('GMAIL_LIST_DRAFTS')
    expect(app.spills).toHaveLength(1)
    expect(execute).toHaveBeenNthCalledWith(2, 'COMPOSIO_SEARCH_TOOLS', expect.objectContaining({
      session: { id: 'mail-workflow' }, search_strategy: 'tool_search',
    }))
  })

  it('does not authorize a drafts contract when refined discovery still selects drafts', async () => {
    execute.mockResolvedValue({ data: { session: { id: 'mail-workflow' }, results: [{
      primary_tool_slugs: ['GMAIL_LIST_DRAFTS'], toolkits: ['gmail'],
    }] } })
    const app = harness()
    const value = await app.tool().execute({ action: 'search', queries: [{
      use_case: 'Read my inbox emails from Singulance',
    }], session: { generate_id: true } }, { signal: new AbortController().signal })
    expect(value).toMatchObject({ status: 'no_matching_tool', results: [], next_action: 'refine_search' })
    await expect(app.tool().execute({ action: 'execute', tool_slug: 'GMAIL_LIST_DRAFTS', arguments: {} },
      { signal: new AbortController().signal })).rejects.toThrow('not selected')
  })

  it('keeps draft listing available when the user actually requests drafts', async () => {
    execute.mockResolvedValueOnce({ data: { session: { id: 'draft-workflow' }, results: [{
      primary_tool_slugs: ['GMAIL_LIST_DRAFTS'], toolkits: ['gmail'], tool_schemas: {
        GMAIL_LIST_DRAFTS: { input_schema: { type: 'object', required: [], properties: {} } },
      },
    }] } })
    const value = await harness().tool().execute({ action: 'search', queries: [{
      app: 'Gmail', use_case: 'List my five newest email drafts',
    }], session: { generate_id: true } }, { signal: new AbortController().signal })
    expect(value).toMatchObject({ status: 'ready', execution_contracts: [{ tool_slug: 'GMAIL_LIST_DRAFTS' }] })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('lets authenticated discovery choose the provider when the user named only a service', async () => {
    execute.mockResolvedValueOnce({ data: { results: [] } })
    const { tool } = harness()
    await tool().execute({
      action: 'search',
      queries: [{
        use_case: 'Email service: find the newest received message from Uwe, ordered newest first, limit 1, returning sender, subject, timestamp, and snippet.',
        known_fields: 'sender_name:Uwe',
      }],
      session: { generate_id: true },
    }, { signal: AbortSignal.abort() })

    expect(execute).toHaveBeenCalledWith('COMPOSIO_SEARCH_TOOLS', {
      queries: [{
        use_case: 'Email service: find the newest received message from Uwe, ordered newest first, limit 1, returning sender, subject, timestamp, and snippet.',
        known_fields: 'sender_name:Uwe',
      }],
      session: { generate_id: true },
    })
  })

  it('rejects vague legacy search calls before spending a provider request', async () => {
    const { tool } = harness()
    await expect(tool().execute({ action: 'search', task: 'read inbox' }, { signal: AbortSignal.abort() })).rejects.toThrow('Search requires queries')
    expect(execute).not.toHaveBeenCalled()
  })

  it('does not invent a provider for a provider-neutral service search', async () => {
    execute.mockResolvedValueOnce({ data: { results: [] } })
    const { tool } = harness()
    await expect(tool().execute({
      action: 'search',
      queries: [{ use_case: 'Email service: get the newest received message from a named sender.' }],
      session: { generate_id: true },
    }, { signal: AbortSignal.abort() })).resolves.toMatchObject({ status: 'no_matching_tool' })
    expect(execute).toHaveBeenCalledWith('COMPOSIO_SEARCH_TOOLS', {
      queries: [{ use_case: 'Email service: get the newest received message from a named sender.' }],
      session: { generate_id: true },
    })
  })

  it('permits refined discovery in the same workflow but rejects repeated searches', async () => {
    execute
      .mockResolvedValueOnce({ data: { session: { id: 'workflow-1' }, results: [] } })
      .mockResolvedValueOnce({ data: { session: { id: 'workflow-1' }, results: [] } })
    const app = harness()
    const agent = { session: { header: { id: 'conversation-1' }, snapshotEvents: () => [], append: vi.fn() } }
    const next = vi.fn(async () => undefined)
    await app.listeners.get('agent/pre-step')?.({ agent, turn: 1 } as never, next as never)
    const execution = { signal: AbortSignal.abort(), agent }
    const request = {
      action: 'search',
      queries: [{ app: 'Gmail', use_case: 'List the five newest Gmail inbox messages, ordered newest first, returning sender, subject, timestamp, and snippet.' }],
      session: { generate_id: true },
    }
    await expect(app.tool().execute(request, execution as never)).resolves.toMatchObject({ status: 'no_matching_tool' })
    await expect(app.tool().execute({
      action: 'search',
      queries: [{ app: 'Gmail', use_case: 'Find the Gmail message identifier needed by the selected detail tool.' }],
      session: { id: 'workflow-1' },
      search_strategy: 'tool_search',
    }, execution as never)).resolves.toMatchObject({ status: 'no_matching_tool' })
    await expect(app.tool().execute(request, execution as never)).rejects.toThrow('search repeated without new evidence')
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('does not authorize an unrelated toolkit returned for an explicitly named app', async () => {
    execute
      .mockResolvedValueOnce({ data: {
        session: { id: 'workflow-linkedin' },
        results: [{ primary_tool_slugs: ['LINKEDIN_GET_POST_CONTENT'], toolkits: ['linkedin'] }],
        toolkit_connection_statuses: [{ toolkit: 'linkedin', has_active_connection: true }],
      } })
      .mockResolvedValueOnce({ data: {
        session: { id: 'workflow-linkedin' },
        results: [{ primary_tool_slugs: ['SALESROBOT_FIND_POSTS'], toolkits: ['linkedin', 'salesrobot'] }],
        toolkit_connection_statuses: [{ toolkit: 'salesrobot', has_active_connection: false }],
      } })
    const app = harness()
    const agent = { session: { header: { id: 'conversation-1' }, snapshotEvents: () => [], append: vi.fn() } }
    const next = vi.fn(async () => undefined)
    await app.listeners.get('agent/pre-step')?.({ agent, turn: 1 } as never, next as never)
    const execution = { signal: AbortSignal.abort(), agent }
    await app.tool().execute({
      action: 'search',
      queries: [{ app: 'LinkedIn', use_case: 'Get one LinkedIn post by identifier.' }],
      session: { generate_id: true },
    }, execution as never)
    await expect(app.tool().execute({
      action: 'search',
      queries: [{ app: 'LinkedIn', use_case: 'List the newest LinkedIn post and return its identifier.' }],
      session: { id: 'workflow-linkedin' },
      search_strategy: 'tool_search',
    }, execution as never)).resolves.toMatchObject({
      status: 'no_matching_tool',
      results: [],
      next_action: 'refine_search',
      next_action_guidance: expect.stringContaining('Do not check connection status or connect another app'),
    })
    expect(execute).toHaveBeenCalledTimes(2)
    expect(app.concludeTurn).not.toHaveBeenCalled()
  })

  it('replaces unscoped provider connection guidance with one bounded refinement', async () => {
    execute.mockResolvedValueOnce({ data: {
      session: { id: 'workflow-linkedin' },
      results: [{ primary_tool_slugs: ['SALESROBOT_FIND_POSTS'], toolkits: ['linkedin', 'salesrobot'] }],
      toolkit_connection_statuses: [{ toolkit: 'salesrobot', has_active_connection: false }],
      next_steps_guidance: ['CALL COMPOSIO_MANAGE_CONNECTIONS for salesrobot'],
    } })
    const app = harness()
    const agent = { session: { header: { id: 'conversation-1' }, snapshotEvents: () => [], append: vi.fn() } }
    const next = vi.fn(async () => undefined)
    await app.listeners.get('agent/pre-step')?.({ agent, turn: 1 } as never, next as never)

    await expect(app.tool().execute({
      action: 'search',
      queries: [{ app: 'LinkedIn', use_case: 'List the newest LinkedIn post and return its identifier.' }],
      session: { generate_id: true },
    }, { signal: AbortSignal.abort(), agent } as never)).resolves.toMatchObject({
      status: 'no_matching_tool',
      results: [],
      next_action: 'refine_search',
      next_action_guidance: expect.stringContaining('Do not check connection status or connect another app'),
    })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(app.concludeTurn).not.toHaveBeenCalled()
  })

  it('replays bounded negative discovery across plugin restart without another provider search', async () => {
    const events: unknown[] = []
    const agent = { session: { header: { id: 'durable-discovery' }, snapshotEvents: () => events,
      append: (type: string, data: unknown) => { events.push({ type, data }) },
    } }
    const context = { signal: new AbortController().signal, agent }
    const request = (use_case: string, known_fields = '') => ({ action: 'search', queries: [{ app: 'Example', use_case, known_fields }], session: { id: 'work' } })
    async function run(app: ReturnType<typeof harness>, args: Record<string, unknown>) {
      const callId = `call-${events.length}`
      events.push({ type: 'tool/call', data: { name: 'hivemind_connected_task', callId, arguments: JSON.stringify(args) } })
      const value = await app.tool().execute(args, context as never)
      const projected = compactComposioSearchReceipt(value)!
      events.push({ type: 'tool/result', data: { message: { source: { callId }, content: [
        { type: 'tool-result', content: [{ type: 'text', text: JSON.stringify(projected) }] },
      ] } } })
      return projected
    }
    execute.mockResolvedValue({ data: { session: { id: 'work' }, results: [] } })
    const first = await run(harness(), request('Find the latest item'))
    expect(first).toMatchObject({ status: 'no_matching_tool', next_action: 'refine_search' })
    use.mockResolvedValueOnce({ execute, toolkits, sessionId: 'router-created' })
    const restarted = harness(true, undefined, false, { maxDiscoverySearches: 10 })
    const duplicate = await run(restarted, request('Find the latest item'))
    expect(duplicate).toMatchObject({ discovery: { cache_hit: true }, operations: [], next_action: 'report_discovery_limit' })
    expect(execute).toHaveBeenCalledTimes(1)
    const refined = await run(restarted, request('Find an item listing operation'))
    expect(refined.next_action).toBe('report_discovery_limit')
    const exhausted = await run(restarted, request('Search another listing description'))
    expect(exhausted).toMatchObject({ discovery: { cache_hit: true }, next_action: 'report_discovery_limit' })
    expect(execute).toHaveBeenCalledTimes(2)
    expect(exhausted.next_action_guidance).toContain('does not prove the provider cannot support it')
    await run(restarted, request('Find an item listing operation', 'identifier:new-evidence'))
    expect(execute).toHaveBeenCalledTimes(3)
    // An expired entry cannot block discovery indefinitely.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300_001)
    try {
      await run(restarted, request('Find the latest item'))
      expect(execute).toHaveBeenCalledTimes(4)
    } finally { vi.restoreAllMocks() }
  })

  it('does not turn a failed provider search into an unavailable capability', async () => {
    execute.mockResolvedValue({ successful: false, data: { results: [] } })
    await expect(harness().tool().execute({ action: 'search', queries: [{ use_case: 'Find items' }], session: { generate_id: true } },
      { signal: new AbortController().signal })).rejects.toThrow('no capability conclusion')
  })

  it('rejects mixed primary ownership rather than authorizing an unrelated app', async () => {
    execute.mockResolvedValue({ data: { session: { id: 'mixed' }, results: [{
      primary_tool_slugs: ['EXAMPLE_GET_ITEM', 'OTHER_LIST_ITEMS'], toolkits: ['example', 'other'],
    }], toolkit_connection_statuses: [
      { toolkit: 'example', has_active_connection: true }, { toolkit: 'other', has_active_connection: false },
    ] } })
    const app = harness()
    await expect(app.tool().execute({ action: 'search', queries: [{ app: 'Example', use_case: 'Get my latest item' }],
      session: { generate_id: true } }, { signal: new AbortController().signal })).resolves.toMatchObject({
      status: 'no_matching_tool', results: [], next_action: 'refine_search',
    })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(app.ask).not.toHaveBeenCalled()
  })

  it('bounds ready searches that never advance to provider execution after replay', async () => {
    const events = [1, 2].flatMap(id => [
      { type: 'tool/call', data: { name: 'hivemind_connected_task', callId: String(id),
        arguments: JSON.stringify({ action: 'search', session: { id: 'work' } }) } },
      { type: 'tool/result', data: { message: { source: { callId: String(id) }, content: [
        { type: 'tool-result', content: [{ type: 'text', text: JSON.stringify({ status: 'ready', session: { id: 'work' },
          discovery: { version: 1, router_id: 'router-created', recorded_at: Date.now(), cache_hit: false } }) }] },
      ] } } },
    ])
    const agent = { session: { header: { id: 'bounded' }, snapshotEvents: () => events, append: vi.fn() } }
    const app = harness()
    const result = await app.tool().execute({ action: 'search', queries: [{ app: 'Example', use_case: 'Rephrase the same listing request' }],
      session: { id: 'work' } }, { signal: new AbortController().signal, agent } as never)
    expect(compactComposioSearchReceipt(result)).toMatchObject({ status: 'discovery_exhausted',
      next_action: 'use_existing_evidence', operations: [], results: [],
    })
    expect(execute).not.toHaveBeenCalled()
    expect(app.ask).not.toHaveBeenCalled()
  })
})
