import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SpillLocator, type SpillRef } from '@deepseek-ai/dsh-spill'

const execute = vi.fn()
const toolkits = vi.fn(async (): Promise<{ items: Array<{
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
  config: { connectionCallbackBaseUrl?: string; maxDiscoverySearches?: number; withSpill?: boolean } = {},
) {
  const concludeTurn = vi.fn()
  const ask = vi.fn()
  const spills: Array<{ suggestedName: string; content: string }> = []
  let tool: {
    execute(
      args: Record<string, unknown>,
      execution: { signal: AbortSignal; concludeTurn: () => void },
    ): Promise<unknown>
  } | undefined
  const listeners = new Map<string, (...args: never[]) => unknown>()
  const ctx = {
    tools: { register(value: typeof tool) { tool = value } },
    hivemindIdentity: { resolve: vi.fn(async () => identity) },
    userQuestions: { ask },
    on(name: string, listener: (...args: never[]) => unknown) { listeners.set(name, listener) },
    get(name: string) {
      if (name === 'settings') return { get: () => enabled === undefined ? undefined : ({ pluginsEnabled: enabled }) }
      if (name === 'spillStore' && config.withSpill === true) return { saveText: async (input: { suggestedName: string; content: string }) => {
        spills.push(input)
        return { locator: SpillLocator(`private:${spills.length}`), bytes: input.content.length, retrievalHint: 'Inspect privately.' }
      } }
      return undefined
    },
    logger: { warn: vi.fn() },
  }
  apply(ctx as never, { apiKey: 'server-secret', enabledByDefault, ...config })
  return {
    tool: () => ({
      execute: (args: Record<string, unknown>, execution: { signal: AbortSignal }) =>
        tool!.execute(args, { ...execution, concludeTurn }),
    }),
    listeners,
    concludeTurn,
    ask,
    spills,
  }
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

  it('compacts search post-execute even when spill storage is unavailable', async () => {
    const { listeners } = harness()
    const post = listeners.get('tools/post-execute') as (
      execution: { name: string; arguments: Record<string, unknown> },
      result: { isError: boolean; content: Array<{ type: string; text: string }> },
      next: () => Promise<{ kind: string; content: Array<{ type: string; text: string }> }>,
    ) => Promise<{ kind: string; content: Array<{ type: string; text: string }> }>
    const huge = JSON.stringify({ result: { data: { results: [{ primary_tool_slugs: ['SLACK_LIST_CHANNELS'], tool_schemas: { huge: true } }] } } })
    const decision = await post(
      { name: 'hivemind_connected_task', arguments: { action: 'search' } },
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
      queries: [{ app: 'Slack', use_case: 'List Slack channels ordered by name and return channel id and name.' }],
      session: { generate_id: true },
    }, { signal: AbortSignal.abort() })
    expect(JSON.stringify(result)).not.toContain('tool_schemas')
    expect(result).toMatchObject({ status: 'ready', results: [{ primary_tool_slugs: ['SLACK_LIST_CHANNELS'] }] })
  })

  it('persists the original provider response before projecting search and execution', async () => {
    const search = { data: { results: [{ primary_tool_slugs: ['EXAMPLE_READ'], tool_schemas: {
      EXAMPLE_READ: { input_schema: { type: 'object', required: ['query'], properties: {
        query: { type: 'string', minLength: 3 },
      } } },
    } }] } }
    const provider = { data: { value: 'complete provider result', headers: { private: 'transport detail' } } }
    execute.mockResolvedValueOnce(search).mockResolvedValueOnce(provider)
    const app = harness(true, undefined, false, { withSpill: true })
    const agent = { session: { header: { id: 'conversation-receipts' }, snapshotEvents: () => [], append: vi.fn() } }

    const discovered = await app.tool().execute({
      action: 'search', queries: [{ use_case: 'Example: read one value.' }], session: { generate_id: true },
    }, { signal: AbortSignal.abort(), agent, name: 'hivemind_connected_task', callId: 'search-call' } as never)
    const completed = await app.tool().execute({
      action: 'execute', tool_slug: 'EXAMPLE_READ', arguments: { query: 'value' },
    }, { signal: AbortSignal.abort(), agent, name: 'hivemind_connected_task', callId: 'execute-call' } as never)

    expect(app.spills).toMatchObject([
      { suggestedName: 'composio-search-tools.json', content: JSON.stringify(search) },
      { suggestedName: 'composio-example_read.json', content: JSON.stringify(provider) },
    ])
    expect(discovered).toMatchObject({ source_receipt: { locator: 'private:1' } })
    expect(completed).toMatchObject({ source_receipt: { locator: 'private:2' } })
    expect(JSON.stringify(completed)).not.toContain('transport detail')
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
        arguments: JSON.stringify({ action: 'search', session: { generate_id: true } }),
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
    const agent = { session: {
      header: { id: 'conversation-resume' }, snapshotEvents: () => events, append: vi.fn(),
    } }
    const app = harness()
    const next = vi.fn(async () => ({ kind: 'enter', messages: [] }))
    const decision = await app.listeners.get('agent/pre-step')?.(
      { agent, turn: 2 } as never, next as never,
    ) as { messages: unknown[] }
    const projected = JSON.stringify(decision.messages)

    expect(projected).toContain('Unfinished connected-app workflow')
    expect(projected).toContain('workflow-resume')
    expect(projected).toContain('EXAMPLE_READ')
    expect(projected).toContain('Read the newest record')
    expect(projected).toContain('wait_connection')
    expect(execute).not.toHaveBeenCalled()
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
    await tool().execute({ action: 'wait_connection', toolkits: ['slack'], session_id: 'session-1' }, { signal: AbortSignal.abort() })
    expect(execute).toHaveBeenNthCalledWith(1, 'COMPOSIO_MANAGE_CONNECTIONS', { session_id: 'session-1', toolkits: ['slack'] })
    expect(execute).toHaveBeenNthCalledWith(2, 'COMPOSIO_WAIT_FOR_CONNECTIONS', { session_id: 'session-1', toolkits: ['slack'] })
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

  it('returns the exact named toolkit connection card instead of a semantic substitute', async () => {
    toolkits.mockResolvedValueOnce({ items: [{
      slug: 'instagram', name: 'Instagram', logo: 'https://logos.example/instagram.svg',
      connection: { isActive: false },
    }] })
    execute.mockResolvedValueOnce({ data: { redirect_url: 'https://connect.example/instagram' } })
    const app = harness()
    await expect(app.tool().execute({ action: 'connection_status', apps: ['Instagram'] }, { signal: AbortSignal.abort() }))
      .resolves.toMatchObject({
        status: 'connection_required', toolkit: 'instagram', app_label: 'Instagram',
        redirect_url: 'https://connect.example/instagram',
      })
    expect(execute).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledWith('COMPOSIO_MANAGE_CONNECTIONS', { toolkits: ['instagram'] })
    expect(app.concludeTurn).toHaveBeenCalledOnce()
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
    ['unspecified', { status: 'ready' }],
    ['inactive', { toolkit: 'slack', has_active_connection: false }],
    ['unrelated active account', { toolkit: 'gmail', has_active_connection: true }],
    ['conflicting evidence', [{ toolkit: 'slack', status: 'ACTIVE' }, { toolkit: 'slack', status: 'EXPIRED' }]],
  ])('keeps %s connection evidence paused without another model step', async (_label, data) => {
    execute.mockResolvedValue({ data })
    const app = harness()
    await expect(app.tool().execute({ action: 'wait_connection', toolkits: ['slack'], session_id: 'workflow-1' }, { signal: AbortSignal.abort() }))
      .resolves.toMatchObject({ status: 'connection_pending', session_id: 'workflow-1', pending_toolkits: ['slack'] })
    expect(app.concludeTurn).toHaveBeenCalledOnce()
  })

  it('continues only after every requested toolkit is active', async () => {
    execute.mockResolvedValue({ data: { toolkit_connection_statuses: [
      { toolkit: 'slack', status: 'ACTIVE' }, { toolkit: 'gmail', has_active_connection: true },
    ] } })
    const app = harness()
    await expect(app.tool().execute({ action: 'wait_connection', toolkits: ['slack', 'gmail'], session_id: 'workflow-1' }, { signal: AbortSignal.abort() }))
      .resolves.toMatchObject({ status: 'ready', session_id: 'workflow-1', pending_toolkits: [] })
    expect(app.concludeTurn).not.toHaveBeenCalled()
  })

  it('does not wait with a missing workflow session', async () => {
    const app = harness()
    await expect(app.tool().execute({ action: 'wait_connection', toolkits: ['slack'] }, { signal: AbortSignal.abort() }))
      .rejects.toThrow('original search session_id')
    expect(execute).not.toHaveBeenCalled()
  })

  it('preserves provider failure instead of reporting connection success', async () => {
    execute.mockRejectedValue(new Error('provider unavailable'))
    const app = harness()
    await expect(app.tool().execute({ action: 'wait_connection', toolkits: ['slack'], session_id: 'workflow-1' }, { signal: AbortSignal.abort() }))
      .rejects.toThrow('provider unavailable')
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

  it('accepts one selected schema slug through the singular bounded-step field', async () => {
    execute
      .mockResolvedValueOnce({ data: { results: [{
        primary_tool_slugs: ['GMAIL_FETCH_EMAILS'],
        related_tool_slugs: ['GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID'],
      }] } })
      .mockResolvedValueOnce({ data: { tool_schemas: {
        GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID: { input_schema: {
          type: 'object', required: ['message_id'], properties: { message_id: { type: 'string' } },
        } },
      } } })
    const app = harness()
    await app.tool().execute({ action: 'search', queries: [{ app: 'Gmail', use_case: 'Read the newest Gmail subject.' }], session: { generate_id: true } }, { signal: AbortSignal.abort() })
    await expect(app.tool().execute({ action: 'schemas', tool_slug: 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID' }, { signal: AbortSignal.abort() }))
      .resolves.toMatchObject({ status: 'ready' })
    expect(execute).toHaveBeenLastCalledWith('COMPOSIO_GET_TOOL_SCHEMAS', {
      tool_slugs: ['GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID'],
    })
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
    await expect(app.tool().execute(request, execution as never)).rejects.toThrow('returned session id')
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
