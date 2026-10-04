import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { Context } from '@deepseek-ai/cordis'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { expect, it, vi } from 'vitest'
import { MarkdownArtifactRenderer } from '../src/index.ts'
import { GenerationRegistry, generateArtifact } from '../src/generation.ts'
import { inspectPdf } from '../src/pdf-inspection.ts'
import { webProvider } from '../src/office-providers.ts'

it('renders a real paginated PDF and rasterizes its first page', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'hyperagents-pdf-canary-'))
  const ctx = new Context()
  try {
    const renderer = new MarkdownArtifactRenderer(ctx, { provider: 'markdown-pdf', outputDirectory: 'artifacts', maxMarkdownChars: 400_000 })
    const markdown = ['# Two page canary', ...Array.from({ length: 36 }, (_, index) => `## Evidence ${index + 1}\n\nHannover-based insurance research confirms the source passage and documents the verification context for this report. The supplied source remains linked and reviewable.`)].join('\n\n')
    const result = await renderer.render({ cwd, title: 'Two page canary', pageSize: 'A4', markdown, signal: new AbortController().signal })
    expect(GlobalWorkerOptions.workerSrc).toBe(import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'))
    expect(result.pageCount).toBeGreaterThan(1)
    expect(Buffer.from(result.pdf).subarray(0, 5).toString()).toBe('%PDF-')
    expect(Buffer.from(result.preview).subarray(1, 4).toString()).toBe('PNG')
    const inspectionTask = getDocument({ data: new Uint8Array(result.pdf), useSystemFonts: true,
      standardFontDataUrl: new URL('.', import.meta.resolve('pdfjs-dist/standard_fonts/FoxitSans.pfb')).href })
    const inspection = await inspectionTask.promise
    try {
      const firstPage = await inspection.getPage(1)
      const content = await firstPage.getTextContent()
      expect(content.items.map(item => 'str' in item ? item.str : '').join(' ')).toContain('Hannover-based insurance research')
    } finally { await inspectionTask.destroy() }
    const image = await loadImage(Buffer.from(result.preview))
    const canvas = createCanvas(image.width, image.height)
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0)
    const pixels = context.getImageData(0, 0, image.width, image.height).data
    let darkPixels = 0
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index]! < 160 && pixels[index + 1]! < 160 && pixels[index + 2]! < 160) darkPixels += 1
    }
    expect(darkPixels).toBeGreaterThan(5_000)
    expect(await readFile(result.path)).toEqual(Buffer.from(result.pdf))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}, 30_000)

it('renders attachment-only PDF without a writable session workspace', async () => {
  const ctx = new Context()
  const renderer = new MarkdownArtifactRenderer(ctx, {
    provider: 'markdown-pdf', outputDirectory: '.hivemind/artifacts', attachmentOnly: true,
    maxMarkdownChars: 400_000,
  })
  const result = await renderer.render({
    cwd: '/nonexistent/hyperagents-session', title: 'Scheduled PDF', pageSize: 'A4',
    signal: new AbortController().signal,
    markdown: '# Scheduled PDF',
  })
  expect(result.path).toBe('scheduled-pdf.pdf')
  expect(Buffer.from(result.pdf).subarray(0, 5).toString()).toBe('%PDF-')
  expect(Buffer.from(result.preview).subarray(1, 4).toString()).toBe('PNG')
}, 30_000)

it('renders a generated HTML artifact to a native PNG preview without network access', async () => {
  const result = await webProvider.generate({
    cwd: process.cwd(), title: 'HTML canary', signal: new AbortController().signal,
    content: '<html><head><style>body{background:#10233c;color:#fff;font:32px sans-serif;padding:48px}</style></head><body>HIVE-MIND dashboard</body></html>',
  })
  expect(result.mediaType).toBe('text/html')
  expect(result.preview?.mediaType).toBe('image/png')
  expect(Buffer.from(result.preview?.data ?? []).subarray(1, 4).toString()).toBe('PNG')
}, 30_000)


it('stores actual HTML PDF page count and first-page preview in the native receipt', async () => {
  const registry = new GenerationRegistry()
  registry.register({ ...webProvider, format: 'pdf', generate: request => webProvider.generate({ ...request, htmlPdf: true }) })
  const saveImage = vi.fn(async (_input: unknown) => ({ attachmentId: 'preview', name: 'page-1.png', bytes: 100 }))
  const ctx = { attachments: { saveFile: async () => ({ attachmentId: 'pdf', name: 'brief.pdf', bytes: 100 }), saveImage } } as unknown as Context
  const append = vi.fn()
  const receipt = await generateArtifact(ctx, registry, 'artifacts', {
    format: 'pdf', sourceFormat: 'html', title: 'Two pages',
    content: '<html><body><h1>First page</h1><div style="break-before:page"><h1>Second page</h1></div></body></html>',
  }, { session: { header: {}, append } }, new AbortController().signal, true)
  expect(receipt.pageCount).toBe(2)
  const pdfBytes = await webProvider.generate({ cwd: process.cwd(), title: 'Inspect saved', signal: new AbortController().signal, htmlPdf: true,
    content: '<html><body>First<div style="break-before:page">Second</div></body></html>' })
  const selected = await inspectPdf(pdfBytes.data, new AbortController().signal, false, [1, 2])
  expect(selected.previews.map(page => page.page)).toEqual([1, 2])
  await expect(inspectPdf(pdfBytes.data, new AbortController().signal, false, [3])).rejects.toThrow('outside')
  expect(receipt.preview?.attachmentId).toBe('preview')
  expect(receipt.content?.[0].attachment).toBe(receipt.preview)
  expect(append).toHaveBeenCalledWith('hivemind/generation-created', receipt)
  const bytes = saveImage.mock.calls[0]?.[0] as { data: Uint8Array }
  expect(Buffer.from(bytes.data).subarray(1, 4).toString()).toBe('PNG')
}, 30_000)


it.each([{ pages: [0] }, { pages: [1, 1] }, { pages: [1, 2, 3, 4, 5] }, { pages: [1.5] }])('rejects invalid bounded PDF page selections %j', async ({ pages }) => {
  await expect(inspectPdf(new Uint8Array(), new AbortController().signal, false, pages)).rejects.toThrow('distinct positive')
})


it('does not rasterize a saved PDF when the native attachment integrity read fails', async () => {
  const ctx = new Context()
  ctx.provide('attachments')
  ctx.set('attachments', { async *readFileStream() { throw new Error('integrity mismatch'); yield new Uint8Array() } } as never)
  const renderer = new MarkdownArtifactRenderer(ctx, { provider: 'markdown-pdf', outputDirectory: 'artifacts', maxMarkdownChars: 1000 })
  await expect(renderer.inspectSavedPdf({ attachmentId: 'invalid', name: 'brief.pdf', bytes: 10 } as never,
    new AbortController().signal)).rejects.toThrow('integrity mismatch')
})
