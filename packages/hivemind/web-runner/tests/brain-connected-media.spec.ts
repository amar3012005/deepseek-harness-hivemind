import { afterEach, expect, it, vi } from 'vitest'
import type { CodexVoiceConnection } from '../src/codex-voice-connection.ts'
import type { GenerationProvider } from '../../artifact-renderer/src/generation.ts'
import { installCodexConnections } from '../src/codex-connections.ts'
const owner = { orgId: '76d9ab3d-9162-4fbd-8934-46cacb93545f', userId: 'cd0bc420-f9a9-4c67-bb16-54d56d9b3203' }
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
function fixture(identity = owner, connected = true) {
  vi.stubEnv('BRAIN_TEST_SECRET', 'a'.repeat(32))
  const handlers = new Map<string, () => Promise<unknown>>()
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    requests.push(url)
    if (url.endsWith('/status')) return Response.json({ available: true, connected, selected_model: 'gpt-5.6-luna', models: ['gpt-5.6-luna'], platform_fallback: false })
    const body = JSON.parse(String(init.body))
    if (url.endsWith('/images/generate')) return Response.json({ connection_id: 'brain-test', operation_id: body.operation_id, media_type: 'image/png', extension: 'png', data: Buffer.from('image-fixture').toString('base64') })
    if (url.endsWith('/voice/start')) return Response.json({ call_id: 'call-test', sdp: 'answer-sdp' })
    throw Error('Unexpected request')
  }))
  installCodexConnections({ inject() {}, effect() {},
    on(name: string, fn: () => Promise<unknown>) { handlers.set(name, fn) },
    hivemindExecutionScope: { require: () => identity },
  } as never,
  [{ ...owner, connectionId: 'brain-test', endpoint: 'https://bridge.example', secretEnv: 'BRAIN_TEST_SECRET', sharedService: true }],
  { actor: async p => p, authorize: async () => identity, origin: () => 'https://brain.example' })
  return { handlers, requests }
}
it('routes native image generation through the selected user and reconciles the same operation', async () => {
  const { handlers, requests } = fixture()
  const provider = await handlers.get('hivemind/selected-image-provider')!() as GenerationProvider
  const result = await provider.generate({ cwd: '/workspace', owner: { ...owner, sessionId: 'session-test' }, operationId: 'operation-test', content: 'A green leaf', title: 'Leaf', reconcileOnly: true, signal: new AbortController().signal })
  expect(result.data.toString()).toBe('image-fixture')
  expect(requests.at(-1)).toBe('https://bridge.example/bridge/brain-test/images/generate')
})
it('uses the same connection for native live voice without returning credentials', async () => {
  const { handlers, requests } = fixture()
  const voice = await handlers.get('hivemind/codex-voice-connection')!() as CodexVoiceConnection
  const response = await voice.start({ sdp: 'offer', session: {} }, new AbortController().signal)
  expect(await response.text()).toBe('answer-sdp')
  expect(response.headers.get('location')).toBe('/calls/call-test')
  expect(requests.at(-1)).toBe('https://bridge.example/bridge/brain-test/voice/start')
})
it('does not use another user connection or a paid fallback', async () => {
  const { handlers, requests } = fixture({ ...owner, userId: '85601c95-b367-45b4-b66b-069b68c4dfd0' })
  expect(await handlers.get('hivemind/selected-image-provider')!()).toBeUndefined()
  expect(await handlers.get('hivemind/codex-voice-connection')!()).toBeUndefined()
  expect(requests).toEqual([])
})
it('stops disconnected selected media instead of resolving a different provider', async () => {
  const { handlers } = fixture(owner, false)
  await expect(handlers.get('hivemind/selected-image-provider')!()).rejects.toThrow('connection_sign_in_required')
  await expect(handlers.get('hivemind/codex-voice-connection')!()).rejects.toThrow('connection_sign_in_required')
})
