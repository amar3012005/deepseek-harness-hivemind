import { expect, it } from 'vitest'
import { CodexConnections, CloudCodexAdapter } from '../src/codex-model-client.ts'
import { bridgeToken, verifyBridgeToken } from '../src/codex-connection-protocol.ts'
const owner = { orgId: '76d9ab3d-9162-4fbd-8934-46cacb93545f', userId: 'cd0bc420-f9a9-4c67-bb16-54d56d9b3203' }
const binding = { ...owner, connectionId: 'fixture-user', endpoint: 'https://worker.example', secret: 'a'.repeat(32) }
it('Brain model calls are signed for the authenticated user and cannot select a foreign connection', async () => {
  const calls: { url: string; token: string }[] = []
  const clients = new CodexConnections([{ ...binding, secretEnv: 'FIXTURE', sharedService: true }], () => binding.secret,
    async (url, options) => {
      calls.push({ url: String(url), token: (options?.headers as Record<string, string>).authorization.slice(7) })
      return new Response(JSON.stringify({ available: true, connected: true, selected_model: 'fixture-model', models: ['fixture-model'], platform_fallback: false }))
    })
  expect(clients.binding({ ...owner, userId: 'foreign' })).toBeUndefined()
  expect((await clients.status(owner)).selected_model).toBe('fixture-model')
  expect(calls[0]!.url).toBe('https://worker.example/bridge/fixture-user/status')
  expect(verifyBridgeToken(calls[0]!.token, binding, 'status')).toBe(true)
  expect(verifyBridgeToken(bridgeToken(binding, 'stream'), { ...binding, userId: 'foreign' }, 'stream')).toBe(false)
})
it('Brain stops on an unavailable selected bridge instead of using its prior paid provider', async () => {
  const clients = new CodexConnections([{ ...binding, secretEnv: 'FIXTURE' }], () => binding.secret,
    async () => new Response('{}', { status: 503 }))
  const adapter = new CloudCodexAdapter(clients, async () => owner)
  await expect(adapter.resolveModel('hivemind-codex-cloud', 'fixture', new AbortController().signal)).rejects.toThrow('Connected model metadata unavailable')
})
