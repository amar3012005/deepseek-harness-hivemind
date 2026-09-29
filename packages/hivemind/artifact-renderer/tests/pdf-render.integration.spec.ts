import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
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
