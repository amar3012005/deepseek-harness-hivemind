import { expect, it, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { museImageProvider } from '../src/muse-image-provider.ts'
const png = createCanvas(4, 3).toBuffer('image/png')
const request = { content: 'Exact approved visual brief', title: 'Draft', cwd: '/', signal: new AbortController().signal }
it('carries exact reference pixels through the scoped bridge without gateway credentials', async () => {
  const bridge = vi.fn(async (_input: unknown) => ({ data: [{ b64_json: png.toString('base64'), media_type: 'image/png' }] }))
  const result = await museImageProvider(1000, bridge).generate({ ...request, referenceFiles: [{ data: png }], aspectRatio: '4:5' })
  expect(result.data).toEqual(png)
  expect(bridge.mock.calls[0]?.[0]).toMatchObject({ payload: { prompt: request.content, aspect_ratio: '4:5', references: [`data:image/png;base64,${png.toString('base64')}`] } })
})
it('does not regenerate unknown outcomes or silently change unsupported requests', async () => {
  const bridge = vi.fn()
  const provider = museImageProvider(1000, bridge)
  await expect(provider.generate({ ...request, reconcileOnly: true })).rejects.toThrow('unknown')
  await expect(provider.generate({ ...request, aspectRatio: '16:9' })).rejects.toThrow('not silently changed')
  await expect(provider.generate({ ...request, transparentBackground: true })).rejects.toThrow('transparent')
  await expect(provider.generate({ ...request, referenceFiles: Array.from({ length: 5 }, () => ({ data: png })) })).rejects.toThrow('four')
  expect(bridge).not.toHaveBeenCalled()
})
it('reports bridge unavailability without enabling a provider claim', async () => {
  expect(await museImageProvider(1000, async () => ({ ready: false })).availability?.()).toMatchObject({ ready: false, code: 'IMAGE_GATEWAY_UNAVAILABLE' })
})
