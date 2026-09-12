import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SpillLocator, type SpillRef } from '@deepseek-ai/dsh-spill'

const execute = vi.fn()
const create = vi.fn(async () => ({ execute }))
const list = vi.fn(async (): Promise<{ items: Array<{ id?: string; status: string; toolkit?: { slug: string } }> }> => ({ items: [] }))
vi.mock('@composio/core', () => ({ Composio: class { sessions = { create }; connectedAccounts = { list } } }))

const { apply, compactComposioSearchReceipt, compactComposioExecutionReceipt } = await import('../src/index.ts')

const receipt: SpillRef = { locator: SpillLocator('private:r1'), bytes: 10, retrievalHint: 'read privately' }

function harness(
  enabled: boolean | undefined = true,
  identity = { orgId: 'org-a', userId: 'user-a' },
  enabledByDefault = false,
) {
  const concludeTurn = vi.fn()
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
    on(name: string, listener: (...args: never[]) => unknown) { listeners.set(name, listener) },
    get(name: string) { return name === 'settings' ? { get: () => enabled === undefined ? undefined : ({ pluginsEnabled: enabled }) } : undefined },
    logger: { warn: vi.fn() },
  }
  apply(ctx as never, { apiKey: 'server-secret', enabledByDefault })
  return {
    tool: () => ({
      execute: (args: Record<string, unknown>, execution: { signal: AbortSignal }) =>
        tool!.execute(args, { ...execution, concludeTurn }),
    }),
    listeners,
    concludeTurn,
  }
}

describe('progressive Composio bridge', () => {
  beforeEach(() => { execute.mockReset(); create.mockClear(); list.mockReset(); list.mockResolvedValue({ items: [] }) })

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

  it('bounds provider executions so MIME and long payloads stay out of the transcript', () => {
    const compact = compactComposioExecutionReceipt({
      data: { text: 'x'.repeat(2000), mime_type: 'text/html', headers: { authorization: 'secret' } },
    })
    expect(JSON.stringify(compact)).not.toContain('authorization')
    expect(JSON.stringify(compact)).not.toContain('mime_type')
    expect(String((compact as { data: { text: string } }).data.text).endsWith('…')).toBe(true)
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
    const slackAgent = { session: { header: { id: 'conversation-slack' } } }
    const gmailAgent = { session: { header: { id: 'conversation-gmail' } } }

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
    const agent = { session: { header: { id: 'conversation-1' } } }
    await app.tool().execute({ action: 'search', queries: [{ app: 'Gmail', use_case: 'Fetch one Gmail message.' }], session: { generate_id: true } }, { signal: AbortSignal.abort(), agent } as never)
    await expect(app.tool().execute({
      action: 'execute', tool_slug: 'GMAIL_FETCH_EMAILS', arguments: { max_results: 1 }, session: { id: 'workflow-1' },
    }, { signal: AbortSignal.abort(), agent } as never)).resolves.toMatchObject({ status: 'ready' })
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
    const agent = { session: { header: { id: 'conversation-restored' }, snapshotEvents: () => events } }
    const restarted = harness()

    await expect(restarted.tool().execute({
      action: 'execute', tool_slug: 'GMAIL_FETCH_EMAILS', arguments: { max_results: 1 }, session_id: 'workflow-restored',
    }, { signal: AbortSignal.abort(), agent } as never)).resolves.toMatchObject({ status: 'ready' })
    expect(execute).toHaveBeenCalledWith('GMAIL_FETCH_EMAILS', { max_results: 1 })
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

  it('always routes a selected mutation to durable approval instead of executing provider side effects', async () => {
    execute.mockResolvedValueOnce({ data: { results: [{ primary_tool_slugs: ['SLACK_SEND_MESSAGE'], tool_schemas: {
      SLACK_SEND_MESSAGE: { input_schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } },
    } }] } })
    const { tool } = harness()
    await tool().execute({ action: 'search', queries: [{ app: 'Slack', use_case: 'Send a Slack message to a named channel after resolving its channel id.' }], session: { generate_id: true } }, { signal: AbortSignal.abort() })
    await expect(tool().execute({ action: 'execute', tool_slug: 'SLACK_SEND_MESSAGE', arguments: { text: 'hello' } }, { signal: AbortSignal.abort() })).resolves.toMatchObject({ status: 'approval_required', mode: 'prepare' })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('refuses guessed fields and requires an authoritative schema before execution', async () => {
    execute.mockResolvedValueOnce({ data: { results: [{ primary_tool_slugs: ['SLACK_FIND_CHANNELS'], tool_schemas: {
      SLACK_FIND_CHANNELS: { input_schema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } } },
    } }] } })
    const app = harness()
    await app.tool().execute({ action: 'search', queries: [{ app: 'Slack', use_case: 'Find the exact Slack channel named davinci and return its id.' }], session: { generate_id: true } }, { signal: AbortSignal.abort() })
    await expect(app.tool().execute({ action: 'execute', tool_slug: 'SLACK_FIND_CHANNELS', arguments: { channel_name: 'davinci' } }, { signal: AbortSignal.abort() })).rejects.toThrow('missing required field: query')
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
    await expect(implicit.tool().execute({ action: 'search', queries: [{ app: 'Gmail', use_case: 'List the five newest Gmail inbox messages, excluding drafts, ordered newest first, returning id, sender, subject, received timestamp, and body snippet.' }], session: { generate_id: true }, search_strategy: 'auto' }, { signal: AbortSignal.abort() })).resolves.toMatchObject({ status: 'ready' })

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
    }, { signal: AbortSignal.abort() })).resolves.toMatchObject({ status: 'ready' })
    expect(execute).toHaveBeenCalledWith('COMPOSIO_SEARCH_TOOLS', {
      queries: [{ use_case: 'Email service: get the newest received message from a named sender.' }],
      session: { generate_id: true },
    })
  })

  it('allows only one connected-app search per agent turn', async () => {
    execute.mockResolvedValue({ data: { results: [] } })
    const app = harness()
    const agent = {}
    const next = vi.fn(async () => undefined)
    await app.listeners.get('agent/pre-step')?.({ agent, turn: 1 } as never, next as never)
    const execution = { signal: AbortSignal.abort(), agent }
    const request = {
      action: 'search',
      queries: [{ app: 'Gmail', use_case: 'List the five newest Gmail inbox messages, ordered newest first, returning sender, subject, timestamp, and snippet.' }],
      session: { generate_id: true },
    }
    await expect(app.tool().execute(request, execution as never)).resolves.toMatchObject({ status: 'ready' })
    await expect(app.tool().execute(request, execution as never)).rejects.toThrow('already completed for this turn')
    expect(execute).toHaveBeenCalledTimes(1)
  })
})
