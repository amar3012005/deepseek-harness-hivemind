import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'

const providerExecute = vi.fn()
vi.mock('@composio/core', () => ({ Composio: class {
  sessions = {
    create: async () => ({ execute: providerExecute, sessionId: 'router-owned', toolkits: async () => ({ items: [] }) }),
  }
  connectedAccounts = { list: async () => ({ items: [] }) }
} }))
const { apply } = await import('../src/index.ts')

afterEach(() => { vi.unstubAllGlobals(); delete process.env.TEST_RECEIPT_OWNERSHIP_SECRET; providerExecute.mockReset() })

it('bridge owns one raw receipt even when discovery has no projectable results', async () => {
  // A strict same-session/call immutable store models Core's existing protection.
  const stored = new Map<string, string>()
  const attempts: Record<string, unknown>[] = []
  process.env.TEST_RECEIPT_OWNERSHIP_SECRET = 'isolated-receipt-owner-test-secret-at-least-32-bytes'
  vi.stubGlobal('fetch', vi.fn(async (url: URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    if (String(url).endsWith('/credit-operations')) return new Response(JSON.stringify({ admitted: true }), { status: 200 })
    expect(String(url)).toBe('http://127.0.0.1:3000/internal/v1/harness-chat/receipts')
    attempts.push(body)
    const key = `${String(body.session_id)}:${String(body.call_id)}`
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex')
    if (stored.has(key) && stored.get(key) !== hash) return new Response(JSON.stringify({ error: 'receipt_call_conflict' }), { status: 409 })
    stored.set(key, hash)
    return new Response(JSON.stringify({ receipt_id: 'e0182b49-1ee3-4e2f-bf83-39e6ae0c3c25', bytes: 123 }), { status: 201 })
  }))
  providerExecute.mockResolvedValue({ data: { session_id: 'workflow-empty', provider_note: 'No selected tool returned.' } })
  const listeners = new Map<string, (...args: never[]) => unknown>()
  let tool: { execute: (args: unknown, execution: unknown) => Promise<unknown> } | undefined
  const prior = { type: 'tool/call', data: { callId: 'earlier-business-call', name: 'hivemind_connected_task' } }
  const events: unknown[] = [prior]
  const agent = { session: { header: { id: 'session-receipt-owner' }, snapshotEvents: () => events, append: vi.fn((type, data) => events.push({ type, data })) } }
  const ctx = {
    tools: { register(value: typeof tool) { tool = value } },
    hivemindIdentity: { resolve: async () => ({ orgId: '67503d34-97e9-49a8-8c52-8ee30cc7603e', userId: '54f5568b-4d6a-4ae1-9a33-48cb2909d59b' }) },
    sessions: { flush: vi.fn(async () => true) },
    effect<T>(callback: () => T) { return callback() },
    on(name: string, listener: (...args: never[]) => unknown) { listeners.set(name, listener) },
    get(name: string) { return name === 'settings' ? { describe: () => [{ ns: 'hivemind-plugins', value: { pluginsEnabled: true } }] } : undefined },
    logger: { warn: vi.fn() },
  }
  apply(ctx as never, { apiKey: 'isolated-provider-key', serviceApiBase: 'http://127.0.0.1:3000', serviceSecretEnv: 'TEST_RECEIPT_OWNERSHIP_SECRET', durableReceiptsRequired: true })
  const args = { action: 'search', queries: [{ use_case: 'Find existing B and B records.' }], session: { generate_id: true } }
  const execution = { name: 'hivemind_connected_task', arguments: args, callId: 'one-search-call', signal: new AbortController().signal, agent, concludeTurn: vi.fn() }
  const projected = await tool!.execute(args, execution)
  const content = [{ type: 'text', text: JSON.stringify(projected) }]
  const post = listeners.get('tools/post-execute') as (...args: unknown[]) => Promise<unknown>
  const decision = await post(execution, { isError: false, content }, async () => ({ kind: 'accept', content }))
  expect(decision).toEqual({ kind: 'accept', content })
  expect(providerExecute).toHaveBeenCalledTimes(1)
  expect(attempts).toHaveLength(1)
  expect(attempts[0]?.raw_receipt).toEqual({ data: { session_id: 'workflow-empty', provider_note: 'No selected tool returned.' } })
  expect(events[0]).toBe(prior)
  expect(prior).toEqual({ type: 'tool/call', data: { callId: 'earlier-business-call', name: 'hivemind_connected_task' } })
})
