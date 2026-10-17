import { describe, expect, it, vi } from 'vitest'
import { installSelectedCodexModels } from '../src/codex-model-client.ts'

describe('native per-session model precedence', () => {
  it('keeps agent choices independent from the account default', async () => {
    type Request = { agent: { session: { snapshotEvents: () => { type: string }[] } } }
    type Selection = { provider: string; model: string }
    type Hook = (request: Request, next: () => Promise<Selection>) => Promise<Selection>
    let hook!: Hook
    const scope = { llm: { registerAdapter: vi.fn() }, effect: (fn: () => unknown) => fn(), on: (_: string, fn: Hook) => { hook = fn } }
    const ctx = { inject: (_: unknown, fn: (value: typeof scope) => void) => fn(scope) }
    const connections = { binding: () => ({}), status: vi.fn(async () => ({ connected: true, selected_model: 'account-model' })) }
    installSelectedCodexModels(ctx as never, connections as never, async () => ({ orgId: 'org', userId: 'user' }))
    const request = (explicit: boolean) => ({ agent: { session: { snapshotEvents: () => explicit ? [{ type: 'model/selection' }] : [] } } })
    const glm = { provider: 'workspace', model: 'glm' }
    const personal = { provider: 'hivemind-codex-cloud', model: 'agent-model' }
    expect(await hook(request(true), async () => glm)).toEqual({ provider: 'hivemind-codex-cloud', model: 'account-model' })
    expect(await hook(request(true), async () => personal)).toEqual(personal)
    expect(connections.status).toHaveBeenCalledTimes(1)
    expect(await hook(request(false), async () => glm)).toEqual({ provider: 'hivemind-codex-cloud', model: 'account-model' })
  })
})
