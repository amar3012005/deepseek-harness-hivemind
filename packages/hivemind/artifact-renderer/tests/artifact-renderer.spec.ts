import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type PreToolDecision } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import {
  ArtifactRenderer, registerArtifactTool, type ArtifactRenderRequest, type ArtifactRenderResult, type Config,
} from '../src/index.ts'

const config: Config = {
  provider: 'playwright', outputDirectory: '.hivemind/artifacts', timeoutMs: 30_000, maxHtmlChars: 400_000,
}

class FakeRenderer extends ArtifactRenderer {
  calls: ArtifactRenderRequest[] = []
  failure: Error | undefined

  override render(request: ArtifactRenderRequest): Promise<ArtifactRenderResult> {
    this.calls.push(request)
    if (this.failure !== undefined) return Promise.reject(this.failure)
    return Promise.resolve({
      provider: 'fake-playwright', path: '/workspace/.hivemind/artifacts/report.pdf',
      pdf: Uint8Array.of(37, 80, 68, 70), preview: Uint8Array.of(137, 80, 78, 71), pageCount: 1,
    })
  }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const renderer = new FakeRenderer(ctx)
  const saves: string[] = []
  ctx.provide('attachments', {
    saveFile: ({ data, name }: { data: Uint8Array; name: string }) => {
      saves.push(`pdf:${name}`)
      return Promise.resolve({ attachmentId: AttachmentId(`sha256:${'aa'.repeat(32)}`), name, bytes: data.byteLength })
    },
    saveImage: ({ data, name }: { data: Uint8Array; name: string }) => {
      saves.push(`preview:${name}`)
      return Promise.resolve({ attachmentId: AttachmentId(`sha256:${'bb'.repeat(32)}`), mediaType: 'image/png' as const, name, bytes: data.byteLength, width: 1240, height: 1754 })
    },
  } as never)
  registerArtifactTool(ctx, config)
  const id = SessionId('artifact-test')
  const session = Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION, id, createdAt: 0, isSeeded: false, cwd: '/workspace',
  })
  const agent = { session } as unknown as Agent
  return { ctx, renderer, saves, session, agent }
}

describe('hivemind_artifact_render', () => {
  it('stores both files before committing one durable artifact event and renders an inline preview', async () => {
    const { ctx, renderer, saves, session, agent } = await setup()
    const result = await ctx.tools.execute({
      signal: new AbortController().signal, callId: ToolCallId('render-1'), name: 'hivemind_artifact_render', agent,
      arguments: { title: 'Market Report', html: '<html><body>Evidence</body></html>' },
    })

    expect(result.isError).toBe(false)
    expect(renderer.calls).toHaveLength(1)
    expect(renderer.calls[0]).toMatchObject({ pageSize: 'A4', printBackground: true, cwd: '/workspace' })
    expect(saves).toEqual(['pdf:market-report.pdf', 'preview:market-report-preview.png'])
    expect(result.content.map(block => block.type)).toEqual(['text', 'image'])
    expect(session.snapshotEvents().filter(event => event.type === 'hivemind/artifact-created')).toHaveLength(1)
    expect(result.value).toMatchObject({
      media_type: 'application/pdf', provider: 'fake-playwright', page_size: 'A4',
      page_count: 1, pdf_bytes: 4, layout_status: 'single_page', chat_preview_status: 'visible',
    })
    expect(result.content[0]).toMatchObject({ type: 'text' })
    expect((result.content[0] as { text: string }).text).toContain('This receipt is authoritative')
    expect((result.content[0] as { text: string }).text).toContain('chat_preview_status=visible')
    expect((result.content[0] as { text: string }).text).toContain('text-only model sees the image payload as omitted')
  })

  it('applies a selected HIVE design profile and records bounded quality checks', async () => {
    const { ctx, renderer, session, agent } = await setup()
    const result = await ctx.tools.execute({
      signal: new AbortController().signal, callId: ToolCallId('render-profile'), name: 'hivemind_artifact_render', agent,
      arguments: { title: 'Campaign brief', html: '<html><head></head><body><h1>Launch</h1></body></html>', design_profile: 'campaign' },
    })

    expect(result.isError).toBe(false)
    expect(renderer.calls[0]?.html).toContain('hivemind-design-profile')
    expect(result.value).toMatchObject({ design_profile: 'campaign', design_quality: { status: 'needs_review' } })
    const event = session.snapshotEvents().find(item => item.type === 'hivemind/artifact-created')
    expect(event?.data).toMatchObject({ designProfile: 'campaign', designQuality: { status: 'needs_review' } })
  })

  it('does not claim or project an artifact when the provider fails', async () => {
    const { ctx, renderer, session, agent } = await setup()
    renderer.failure = new Error('render failed')
    const result = await ctx.tools.execute({
      signal: new AbortController().signal, callId: ToolCallId('render-fail'), name: 'hivemind_artifact_render', agent,
      arguments: { title: 'Market Report', html: '<html></html>' },
    })
    expect(result.isError).toBe(true)
    expect(session.snapshotEvents().some(event => event.type === 'hivemind/artifact-created')).toBe(false)
  })

  it('honors native Harness authorization before invoking the rendering provider', async () => {
    const { ctx, renderer, session, agent } = await setup()
    ctx.on('tools/pre-execute', async (): Promise<PreToolDecision> => ({ kind: 'deny', reason: 'rendering is not allowed here' }))
    const result = await ctx.tools.execute({
      signal: new AbortController().signal, callId: ToolCallId('render-denied'), name: 'hivemind_artifact_render', agent,
      arguments: { title: 'Market Report', html: '<html></html>' },
    })
    expect(result.isError).toBe(true)
    expect(renderer.calls).toHaveLength(0)
    expect(session.snapshotEvents().some(event => event.type === 'hivemind/artifact-created')).toBe(false)
  })
})
