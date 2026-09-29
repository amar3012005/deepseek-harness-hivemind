import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { Context } from '@deepseek-ai/cordis'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { expect, it } from 'vitest'
import { MarkdownArtifactRenderer } from '../src/index.ts'
import { webProvider } from '../src/office-providers.ts'

it('renders a real paginated PDF and rasterizes its first page', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'hyperagents-pdf-canary-'))
  const ctx = new Context()
  try {
    const renderer = new MarkdownArtifactRenderer(ctx, { provider: 'markdown-pdf', outputDirectory: 'artifacts', maxMarkdownChars: 400_000 })
    const markdown = ['# Two page canary', ...Array.from({ length: 36 }, (_, index) => `## Evidence ${index + 1}\n\nHannover-based insurance research confirms the source passage and documents the verification context for this report. The supplied source remains linked and reviewable.`)].join('\n\n')
    const result = await renderer.render({ cwd, title: 'Two page canary', pageSize: 'A4', markdown, signal: new AbortController().signal })
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
