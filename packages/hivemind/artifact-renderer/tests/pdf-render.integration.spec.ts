import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { PlaywrightArtifactRenderer } from '../src/index.ts'
import { webProvider } from '../src/office-providers.ts'

it('renders a real paginated PDF and rasterizes its first page', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'hyperagents-pdf-canary-'))
  const ctx = new Context()
  try {
    const renderer = new PlaywrightArtifactRenderer(ctx, { provider: 'playwright', outputDirectory: 'artifacts', timeoutMs: 10_000, maxHtmlChars: 400_000 })
    const result = await renderer.render({ cwd, title: 'Two page canary', pageSize: 'A4', printBackground: true, signal: new AbortController().signal,
      html: '<html><head><style>@page{margin:20mm}h1{color:#163d56}.next{break-before:page}</style></head><body><h1>Evidence first</h1><p>Draft for review.</p><h1 class="next">Validation gate</h1><p>Three interviews.</p></body></html>',
    })
    expect(result.pageCount).toBe(2)
    expect(Buffer.from(result.pdf).subarray(0, 5).toString()).toBe('%PDF-')
    expect(Buffer.from(result.preview).subarray(1, 4).toString()).toBe('PNG')
    expect(await readFile(result.path)).toEqual(Buffer.from(result.pdf))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}, 30_000)

it('renders attachment-only PDF without a writable session workspace', async () => {
  const ctx = new Context()
  const renderer = new PlaywrightArtifactRenderer(ctx, {
    provider: 'playwright', outputDirectory: '.hivemind/artifacts', attachmentOnly: true,
    timeoutMs: 10_000, maxHtmlChars: 400_000,
  })
  const result = await renderer.render({
    cwd: '/nonexistent/hyperagents-session', title: 'Scheduled PDF', pageSize: 'A4',
    printBackground: true, signal: new AbortController().signal,
    html: '<html><body><h1>Scheduled PDF</h1></body></html>',
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
