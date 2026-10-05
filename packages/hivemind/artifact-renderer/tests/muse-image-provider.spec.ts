import { afterEach, expect, it, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { museImageProvider } from '../src/muse-image-provider.ts'
const png = createCanvas(4, 3).toBuffer('image/png')
const request = { content: 'Exact approved visual brief', title: 'Draft', cwd: '/', signal: new AbortController().signal }
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })
function configure() {
  for (const [key, value] of Object.entries({ CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_AI_GATEWAY_ID: 'gateway', CLOUDFLARE_AI_GATEWAY_TOKEN: 'test-token', CLOUDFLARE_AI_GATEWAY_OPENROUTER_BYOK_ALIAS: 'alias' })) vi.stubEnv(key, value)
}
it('uses only the gateway and carries exact native reference pixels', async () => {
  configure()
  const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64'), media_type: 'image/png' }] })))
  vi.stubGlobal('fetch', fetch)
  const result = await museImageProvider(1000).generate({ ...request, referenceFiles: [{ data: png }], aspectRatio: '4:5' })
  expect(result.data).toEqual(png)
  const call = fetch.mock.calls[0] as unknown as [string, RequestInit]
  expect(call[0]).toBe('https://gateway.ai.cloudflare.com/v1/account/gateway/openrouter/images')
  const body = JSON.parse(String(call[1].body)) as { prompt: string; input_references: { image_url: { url: string } }[] }
  expect(body.prompt).toBe(request.content)
  expect(body.input_references[0]?.image_url.url).toBe(`data:image/png;base64,${png.toString('base64')}`)
})
it('does not regenerate unknown outcomes or silently change unsupported requests', async () => {
  configure(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  const provider = museImageProvider(1000)
  await expect(provider.generate({ ...request, reconcileOnly: true })).rejects.toThrow('unknown')
  await expect(provider.generate({ ...request, aspectRatio: '16:9' })).rejects.toThrow('not silently changed')
  await expect(provider.generate({ ...request, transparentBackground: true })).rejects.toThrow('transparent')
  await expect(provider.generate({ ...request, referenceFiles: Array.from({ length: 5 }, () => ({ data: png })) })).rejects.toThrow('four')
  expect(fetch).not.toHaveBeenCalled()
})
it('reports credential absence without enabling a provider claim', async () => {
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', '')
  expect(await museImageProvider(1000).availability?.()).toMatchObject({ ready: false, code: 'IMAGE_GATEWAY_UNAVAILABLE' })
})
