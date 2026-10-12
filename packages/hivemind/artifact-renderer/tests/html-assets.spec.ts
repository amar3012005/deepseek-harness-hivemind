import { expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createCanvas } from '@napi-rs/canvas'
import { embedHtmlAssets } from '../src/html-assets.ts'
import { webProvider } from '../src/office-providers.ts'

const image = createCanvas(8, 8).toBuffer('image/png')
const ref = { attachmentId: 'saved-image', name: 'image.png', bytes: image.length }
const agent = (events: unknown[]) => ({ session: { id: 'room', snapshotEvents: () => events } }) as unknown as Agent
const ctx = { attachments: { async *readFileStream() { yield image } } } as unknown as Context
const own = [{ type: 'hivemind/generation-created', data: { artifactId: 'saved-artifact', mediaType: 'image/png', file: ref } }]
const html = '<html><head><style>@page{size:320px 180px;margin:0}.slide{height:180px;break-after:page}.slide:last-child{break-after:auto}</style></head><body style="margin:0"><section class="slide">First slide<img src="hive-asset:saved-image"></section><section class="slide">Second slide</section></body></html>'

it('embeds exact saved image bytes and rejects missing, oversized and unresolved references', async () => {
  const result = await embedHtmlAssets(ctx, agent(own), html, ['saved-image'], new AbortController().signal)
  expect(result).toContain(image.toString('base64'))
  await expect(embedHtmlAssets(ctx, agent([]), html, ['saved-image'], new AbortController().signal)).rejects.toThrow('unavailable')
  await expect(embedHtmlAssets(ctx, agent([{ type: 'hivemind/generation-created', data: { mediaType: 'image/png', file: { ...ref, bytes: 31 * 1024 * 1024 } } }]), html, ['saved-image'], new AbortController().signal)).rejects.toThrow('30 MiB')
  const abort = new AbortController(); abort.abort()
  await expect(embedHtmlAssets(ctx, agent(own), html, ['saved-image'], abort.signal)).rejects.toThrow()
  const wrongSize = [{ type: 'hivemind/generation-created', data: { mediaType: 'image/png', file: { ...ref, bytes: image.length + 1 } } }]
  await expect(embedHtmlAssets(ctx, agent(wrongSize), html, ['saved-image'], new AbortController().signal)).rejects.toThrow('size mismatch')
  await expect(embedHtmlAssets(ctx, agent(own), html, [], new AbortController().signal)).rejects.toThrow('unresolved')
})

it('accepts only recipient-bound, producer-matched transferred file receipts', async () => {
  const data = { targetId: 'room', senderId: 'producer', artifactIds: ['asset'], artifacts: [{ artifactId: 'asset', producerSessionId: 'producer', file: ref }] }
  expect(await embedHtmlAssets(ctx, agent([{ type: 'hivemind/room-message-received', data }]), html, ['saved-image'], new AbortController().signal)).toContain('data:image/png')
  for (const invalid of [{ ...data, targetId: 'other' }, { ...data, senderId: 'other' }, { ...data, artifactIds: [] }, { ...data, artifacts: [null] }]) {
    await expect(embedHtmlAssets(ctx, agent([{ type: 'hivemind/room-message-received', data: invalid }]), html, ['saved-image'], new AbortController().signal)).rejects.toThrow('unavailable')
  }
})

it('renders ordered image/text HTML and exports two ordered PDF pages from the same source', async () => {
  const content = await embedHtmlAssets(ctx, agent(own), html, ['saved-image'], new AbortController().signal)
  const request = { title: 'Deck', content, cwd: '/tmp', sourceFormat: 'html' as const, signal: new AbortController().signal }
  const web = await webProvider.generate(request)
  expect(web.preview?.data.length).toBeGreaterThan(100)
  expect(new TextDecoder().decode(web.data)).toContain('First slide')
  const pdf = await webProvider.generate({ ...request, htmlPdf: true })
  expect(pdf.mediaType).toBe('application/pdf')
  const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loading = getDocument({ data: pdf.data })
  const document = await loading.promise
  expect(document.numPages).toBe(2)
  for (const [index, text] of ['First slide', 'Second slide'].entries()) {
    const page = await document.getPage(index + 1)
    if (index === 0) {
      const operators = await page.getOperatorList()
      expect(operators.fnArray).toContain(OPS.paintImageXObject)
    }
    const content = await page.getTextContent()
    expect(content.items.map(item => 'str' in item ? item.str : '').join(' ')).toContain(text)
  }
  await loading.destroy()
}, 30_000)

it('supports ten slide images without imposing the editing tool five-image limit', async () => {
  const ids = Array.from({ length: 10 }, (_, index) => `image-${index}`)
  const events = ids.map(attachmentId => ({ type: 'hivemind/generation-created', data: { mediaType: 'image/png', file: { ...ref, attachmentId } } }))
  const html = `<html>${ids.map(id => `<img src="hive-asset:${id}">`).join('')}</html>`
  const embedded = await embedHtmlAssets(ctx, agent(events), html, ids, new AbortController().signal)
  expect(embedded.match(/data:image\/png;base64/g)).toHaveLength(10)
})

it('resolves the native background media artifact ID to its exact file attachment', async () => {
  const source = html.replaceAll('hive-asset:saved-image', 'hive-asset:saved-artifact')
  const result = await embedHtmlAssets(ctx, agent(own), source, ['saved-artifact'], new AbortController().signal)
  expect(result).toContain(image.toString('base64'))
  await expect(embedHtmlAssets(ctx, agent(own), source, ['invented-artifact'], new AbortController().signal)).rejects.toThrow('unavailable')
})

it('embeds actual uploaded image pixels only from the latest human message', async () => {
  const uploaded = { attachmentId: 'native-upload', mediaType: 'image/png', width: 8, height: 8 }
  const context = { attachments: { readImage: async () => ({ data: image, mediaType: 'image/png' }) } } as unknown as Context
  const event = { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'image', attachment: uploaded }] } }
  const source = '<html><img src="hive-asset:latest-0"></html>'
  expect(await embedHtmlAssets(context, agent([event]), source, [], new AbortController().signal, true)).toContain(image.toString('base64'))
  await expect(embedHtmlAssets(context, agent([{ ...event, data: { ...event.data, source: { kind: 'plugin' } } }]), source, [], new AbortController().signal, true)).rejects.toThrow('latest human message')
  await expect(embedHtmlAssets(context, agent([event, { type: 'user/message', data: { source: { kind: 'user' }, content: [] } }]), source, [], new AbortController().signal, true)).rejects.toThrow('latest human message')
})

it('admits exact current-session native screenshot pixels by capture or attachment ID for HTML and image generation', async () => {
  const preview = { attachmentId: 'capture-image', mediaType: 'image/png', name: 'screen.png' }
  const events = [{ type: 'hivemind/browser-capture', data: { captureId: 'capture-id', url: 'https://example.org', preview } }]
  const source = '<html><img src="hive-asset:capture-id"></html>'
  const context = { attachments: { readImage: async () => ({ data: image, mediaType: 'image/png' }) } } as unknown as Context
  expect(await embedHtmlAssets(context, agent(events), source, ['capture-id'], new AbortController().signal)).toContain(image.toString('base64'))
  const { referenceFiles } = await import('../src/media-workflow.ts')
  for (const id of ['capture-id', 'capture-image']) {
    const references = await referenceFiles(context, agent(events), [id], false)
    expect(Buffer.from(references[0]!.data)).toEqual(image)
  }
  await expect(referenceFiles(context, agent([]), ['capture-image'], false)).rejects.toThrow('not a saved')
  await expect(embedHtmlAssets(context, agent([]), source, ['capture-id'], new AbortController().signal)).rejects.toThrow('unavailable')
})

it('rejects screenshot references with non-raster MIME and oversized actual bytes', async () => {
  const event = { type: 'hivemind/browser-capture', data: { captureId: 'capture-id', preview: { attachmentId: 'capture-image', mediaType: 'text/html' } } }
  await expect(embedHtmlAssets(ctx, agent([event]), '<img src="hive-asset:capture-id">', ['capture-id'], new AbortController().signal)).rejects.toThrow('unavailable')
  const large = { attachments: { readImage: async () => ({ data: new Uint8Array(31 * 1024 * 1024) }) } } as unknown as Context
  const valid = { ...event, data: { ...event.data, preview: { ...event.data.preview, mediaType: 'image/png' } } }
  await expect(embedHtmlAssets(large, agent([valid]), '<img src="hive-asset:capture-id">', ['capture-id'], new AbortController().signal)).rejects.toThrow('byte budget')
})
