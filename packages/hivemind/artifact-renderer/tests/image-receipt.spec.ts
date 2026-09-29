import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { GenerationRegistry, generateArtifact } from '../src/generation.ts'

it('records an image attachment in the durable generation event so preview authorization can find it', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'harness-image-receipt-'))
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const preview = { attachmentId: AttachmentId(`sha256:${'ab'.repeat(32)}`), mediaType: 'image/png' as const, bytes: 4, width: 1, height: 1 }
    ctx.provide('attachments', {
      saveFile: async () => ({ attachmentId: preview.attachmentId, name: 'test.png', bytes: 4 }),
      saveImage: async () => preview,
    } as never)
    const registry = new GenerationRegistry()
    registry.register({ id: 'test', format: 'image', instructions: 'Test only', generate: async () => ({ data: Uint8Array.of(1, 2, 3, 4), extension: 'png', mediaType: 'image/png' }) })
    const id = SessionId('image-test')
    const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false, cwd })
    const receipt = await generateArtifact(ctx, registry, 'artifacts', { format: 'image', title: 'Test', content: 'Test image' }, { session } as unknown as Agent, new AbortController().signal)
    expect(session.snapshotEvents().find(event => event.type === 'hivemind/generation-created')?.data).toMatchObject({ preview })
    expect(receipt.content).toEqual([{ type: 'image', attachment: preview }])
  } finally {
    await ctx.fiber.dispose()
    await rm(cwd, { recursive: true, force: true })
  }
})

it('stores a provider-rendered HTML preview separately from the editable HTML file', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'harness-html-preview-'))
  const ctx = new Context()
  try {
    const registry = new GenerationRegistry()
    const preview = { attachmentId: AttachmentId(`sha256:${'cd'.repeat(32)}`), mediaType: 'image/png' as const, bytes: 4, width: 1, height: 1 }
    const saved: string[] = []
    ctx.provide('attachments', {
      saveFile: async ({ name }: { data: Uint8Array; name: string }) => { saved.push(`file:${name}`); return { attachmentId: AttachmentId(`sha256:${'ab'.repeat(32)}`), name, bytes: 4 } },
      saveImage: async ({ name }: { data: Uint8Array; mediaType: string; name: string }) => { saved.push(`preview:${name}`); return { ...preview, name } },
    } as never)
    registry.register({
      id: 'html', format: 'web', instructions: 'test',
      async generate() { return { data: Uint8Array.of(1, 2, 3, 4), extension: 'html', mediaType: 'text/html', preview: { data: Uint8Array.of(5, 6, 7, 8), mediaType: 'image/png', nameSuffix: '-preview.png' } } },
    })
    const id = SessionId('html-preview-test')
    const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false, cwd })
    const receipt = await generateArtifact(ctx, registry, 'artifacts', { format: 'web', title: 'Campaign dashboard', content: '<html></html>' }, { session } as never, new AbortController().signal)
    expect(saved).toEqual(['file:campaign-dashboard.html', 'preview:campaign-dashboard-preview.png'])
    expect(receipt.preview).toMatchObject({ mediaType: 'image/png' })
    expect(receipt.content).toEqual([{ type: 'image', attachment: receipt.preview }])
  } finally {
    await ctx.fiber.dispose()
    await rm(cwd, { recursive: true, force: true })
  }
})
