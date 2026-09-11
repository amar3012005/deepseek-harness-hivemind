import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SpillLocator, type SpillRef } from '@deepseek-ai/dsh-spill'

const execute = vi.fn()
const create = vi.fn(async () => ({ execute }))
vi.mock('@composio/core', () => ({ Composio: class { sessions = { create } } }))

const { apply, compactComposioSearchReceipt } = await import('../src/index.ts')

const receipt: SpillRef = { locator: SpillLocator('private:r1'), bytes: 10, retrievalHint: 'read privately' }

function harness(enabled: boolean | undefined = true, identity = { orgId: 'org-a', userId: 'user-a' }, enabledByDefault = false) {
  let tool: { execute(args: Record<string, unknown>, execution: { signal: AbortSignal }): Promise<unknown> } | undefined
  const listeners = new Map<string, (...args: never[]) => unknown>()
  const ctx = {
    tools: { register(value: typeof tool) { tool = value } },
    hivemindIdentity: { resolve: vi.fn(async () => identity) },
    on(name: string, listener: (...args: never[]) => unknown) { listeners.set(name, listener) },
    get(name: string) { return name === 'settings' ? { get: () => enabled === undefined ? undefined : ({ pluginsEnabled: enabled }) } : undefined },
    logger: { warn: vi.fn() },
  }
  apply(ctx as never, { apiKey: 'server-secret', enabledByDefault })
  return { tool: () => tool!, listeners }
}

describe('progressive Composio bridge', () => {
  beforeEach(() => { execute.mockReset(); create.mockClear() })

  it('preserves Composio planning skill while dropping schemas', () => {
    expect(compactComposioSearchReceipt({ operations: [{ tool: 'COMPOSIO_SEARCH_TOOLS', status: 'completed' }], data: {
      results: [{ primary_tool_slugs: ['SLACK_SEND_MESSAGE'], toolkits: ['slack'], recommended_plan_steps: ['resolve channel'], known_pitfalls: ['do not guess'], difficulty: 'medium', tool_schemas: { huge: true } }],
      recommended_plan_steps: ['connect first'], known_pitfalls: ['confirm destination'], difficulty: 'hard',
    } }, receipt)).toMatchObject({
      results: [{ recommended_plan_steps: ['resolve channel'], known_pitfalls: ['do not guess'], difficulty: 'medium' }],
      recommended_plan_steps: ['connect first'], known_pitfalls: ['confirm destination'], difficulty: 'hard',
      operations: [{ tool: 'COMPOSIO_SEARCH_TOOLS', status: 'completed' }],
    })
    expect(JSON.stringify(compactComposioSearchReceipt({ data: { results: [{ primary_tool_slugs: ['X'], tool_schemas: { huge: true } }] } }, receipt))).not.toContain('tool_schemas')
  })

  it('reuses the stable authenticated user connection while isolating selected tools', async () => {
    execute.mockResolvedValueOnce({ data: { results: [{ primary_tool_slugs: ['SLACK_LIST_CHANNELS'] }] } })
    const first = harness(true, { orgId: 'org-a', userId: 'same-user' })
    await first.tool().execute({ action: 'search', queries: [{ use_case: 'List Slack channels ordered by name and return channel id and name.' }], session: { generate_id: true } }, { signal: AbortSignal.abort() })
    expect(create).toHaveBeenCalledWith('hivemind:same-user', { mcp: true })
    await expect(first.tool().execute({ action: 'execute', tool_slug: 'GMAIL_FETCH_EMAILS', arguments: {} }, { signal: AbortSignal.abort() })).rejects.toThrow('not selected')
  })

  it('supports connection management and bounded waiting', async () => {
    execute.mockResolvedValue({ status: 'ready' })
    const { tool } = harness()
    await tool().execute({ action: 'manage_connection', toolkits: ['slack'], session_id: 'session-1' }, { signal: AbortSignal.abort() })
    await tool().execute({ action: 'wait_connection', toolkits: ['slack'], session_id: 'session-1' }, { signal: AbortSignal.abort() })
    expect(execute).toHaveBeenNthCalledWith(1, 'COMPOSIO_MANAGE_CONNECTIONS', { session_id: 'session-1', toolkits: ['slack'] })
    expect(execute).toHaveBeenNthCalledWith(2, 'COMPOSIO_WAIT_FOR_CONNECTIONS', { session_id: 'session-1', toolkits: ['slack'] })
  })

  it('turns a disconnected search into one durable session-bound connection receipt', async () => {
    execute
      .mockResolvedValueOnce({ data: {
        results: [{ primary_tool_slugs: ['SLACK_SEND_MESSAGE'], toolkits: ['slack'] }],
        toolkit_connection_statuses: [{ toolkit: 'slack', has_active_connection: false }],
        session: { id: 'workflow-1' },
      } })
      .mockResolvedValueOnce({ data: { redirect_url: 'https://connect.example/slack' } })
    const { tool } = harness()
    await expect(tool().execute({
      action: 'search',
      queries: [{ use_case: 'Send a Slack message to a named channel after resolving its channel id.' }],
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
  })

  it('always routes a selected mutation to durable approval instead of executing provider side effects', async () => {
    execute.mockResolvedValueOnce({ data: { results: [{ primary_tool_slugs: ['SLACK_SEND_MESSAGE'] }] } })
    const { tool } = harness()
    await tool().execute({ action: 'search', queries: [{ use_case: 'Send a Slack message to a named channel after resolving its channel id.' }], session: { generate_id: true } }, { signal: AbortSignal.abort() })
    await expect(tool().execute({ action: 'execute', tool_slug: 'SLACK_SEND_MESSAGE', arguments: { text: 'hello' } }, { signal: AbortSignal.abort() })).resolves.toMatchObject({ status: 'approval_required', mode: 'prepare' })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('denies bridge execution when the capability latch is off', async () => {
    const { tool } = harness(false)
    await expect(tool().execute({ action: 'search', queries: [{ use_case: 'Read Gmail inbox messages.' }], session: { generate_id: true } }, { signal: AbortSignal.abort() })).rejects.toThrow('disabled')
  })

  it('uses the scoped profile default only when the UI has no explicit latch', async () => {
    execute.mockResolvedValueOnce({ data: { results: [] } })
    const implicit = harness(undefined, undefined, true)
    await expect(implicit.tool().execute({ action: 'search', queries: [{ use_case: 'List the five newest Gmail inbox messages, excluding drafts, ordered newest first, returning id, sender, subject, received timestamp, and body snippet.' }], session: { generate_id: true }, search_strategy: 'auto' }, { signal: AbortSignal.abort() })).resolves.toMatchObject({ status: 'ready' })

    const explicitOff = harness(false, undefined, true)
    await expect(explicitOff.tool().execute({ action: 'search', queries: [{ use_case: 'Read Gmail inbox messages.' }], session: { generate_id: true } }, { signal: AbortSignal.abort() })).rejects.toThrow('disabled')
  })

  it('passes structured parallel search parameters to Composio without flattening them', async () => {
    execute.mockResolvedValueOnce({ data: { results: [] } })
    const { tool } = harness()
    await tool().execute({
      action: 'search',
      queries: [
        { use_case: 'List the five newest Gmail inbox messages, excluding drafts, ordered newest first, returning id, sender, subject, received timestamp, and body snippet.' },
        { use_case: 'Fetch complete Gmail message content for selected message ids.', known_fields: 'result_limit:5' },
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

  it('rejects vague legacy search calls before spending a provider request', async () => {
    const { tool } = harness()
    await expect(tool().execute({ action: 'search', task: 'read inbox' }, { signal: AbortSignal.abort() })).rejects.toThrow('Search requires queries')
    expect(execute).not.toHaveBeenCalled()
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
      queries: [{ use_case: 'List the five newest Gmail inbox messages, ordered newest first, returning sender, subject, timestamp, and snippet.' }],
      session: { generate_id: true },
    }
    await expect(app.tool().execute(request, execution as never)).resolves.toMatchObject({ status: 'ready' })
    await expect(app.tool().execute(request, execution as never)).rejects.toThrow('already completed for this turn')
    expect(execute).toHaveBeenCalledTimes(1)
  })
})
