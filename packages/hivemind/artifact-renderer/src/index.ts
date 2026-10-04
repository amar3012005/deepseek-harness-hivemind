/** Progressive, provider-neutral PDF artifact rendering for HIVE-MIND. */

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { defaultPageLayout, generatePdf } from '@speajus/markdown-to-pdf'
import { GenerationRegistry, registerGenerationTools } from './generation.ts'
import {
  markdownReportProvider, presentationProvider, spreadsheetProvider, webProvider,
} from './office-providers.ts'
import { codexImageProvider } from './codex-image-provider.ts'
import { openRouterImageProvider } from './image-provider.ts'
import { higgsfieldVideoProvider } from './higgsfield-video-provider.ts'
import { registerMediaWorkflow } from './media-workflow.ts'
import { inspectPdf } from './pdf-inspection.ts'
import { registerCalculator } from './calculator.ts'
import { registerPrivateDesignReferences } from './design-reference.ts'
import { designProfiles, designTheme, evaluateMarkdownDesignQuality, type DesignProfile, type DesignQuality } from './design-kit.ts'
export type { GenerationReceipt } from './generation.ts'
export type { DesignReference } from './design-reference.ts'

export const name = 'hivemind-artifact-renderer'
export const inject = ['tools', 'attachments', 'jobs', 'sessions']

export interface ArtifactRenderRequest {
  readonly title: string
  readonly markdown: string
  readonly pageSize: 'A4' | 'Letter'
  readonly designProfile?: DesignProfile
  readonly cwd: string
  readonly signal: AbortSignal
}

export interface ArtifactRenderResult {
  readonly provider: string
  readonly path: string
  readonly pdf: Uint8Array
  readonly preview: Uint8Array
  readonly pageCount: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    hivemindArtifactRenderer: ArtifactRenderer
  }
}

/** Swappable document-rendering provider used by the model-facing consumer. */
export abstract class ArtifactRenderer extends Service {
  constructor(ctx: Context) { super(ctx, 'hivemindArtifactRenderer') }
  /** Read verified existing PDF bytes without generating a replacement artifact. */
  async inspectSavedPdf(file: FileAttachmentRef, signal: AbortSignal, pages: readonly number[] = [1]): Promise<{
    page_count: number
    preview_page: number
    preview: ImageAttachmentRef
    pages: { page: number; preview: ImageAttachmentRef }[]
  }> {
    const maxBytes = 50_000_000
    if (file.bytes > maxBytes) throw new Error('PDF inspection exceeds bounded file size')
    const chunks: Uint8Array[] = []
    let bytes = 0
    for await (const chunk of this.ctx.attachments.readFileStream(file, signal)) {
      bytes += chunk.byteLength
      if (bytes > maxBytes) throw new Error('PDF inspection exceeds bounded file size')
      chunks.push(chunk)
    }
    const data = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength }
    const inspected = await inspectPdf(data, signal, false, pages)
    const saved = await Promise.all(inspected.previews.map(async item => ({ page: item.page,
      preview: await this.ctx.attachments.saveImage({ data: item.data, mediaType: 'image/png', name: `pdf-page-${item.page}.png` }),
    })))
    const first = saved[0]
    if (!first) throw new Error('PDF inspection returned no page')
    return { page_count: inspected.pageCount, preview_page: first.page, preview: first.preview, pages: saved }
  }
  /** Render one Markdown document to PDF and first-page preview. */
  abstract render(request: ArtifactRenderRequest): Promise<ArtifactRenderResult>
}

export interface Config {
  privateDesignReferenceDirectory?: string
  provider: 'markdown-pdf'
  outputDirectory: string
  attachmentOnly?: boolean
  maxMarkdownChars: number
  imageProvider?: 'codex' | 'openrouter'
  codexImageCommand?: string
  codexImageStateDirectory?: string
  codexImageModel?: string
  imageBaseURL?: string
  imageApiKeyEnv?: string
  imageModel?: string
  imageTimeoutMs?: number
  imageGatewayByokAlias?: string
  videoCommand?: string
  videoModel?: string
  videoTimeoutMs?: number
  videoMaxBytes?: number
  videoResolution?: string
  mediaRequireOwner?: boolean
  mediaAdmissionPath?: string
  mediaGlobalConcurrency?: number
  mediaTenantConcurrency?: number
  mediaMaxQueued?: number
  mediaDailyUserLimit?: number
  mediaMaxBriefChars?: number
  mediaImageAttempts?: number
  mediaRetryBaseDelayMs?: number
}

export const Config: z<Config> = z.object({
  privateDesignReferenceDirectory: z.string().default('/tmp/dsh/private-design-references'),
  provider: z.const('markdown-pdf').default('markdown-pdf'),
  outputDirectory: z.string().default('.hivemind/artifacts'),
  attachmentOnly: z.boolean().default(false),
  maxMarkdownChars: z.natural().min(1_000).max(2_000_000).default(400_000),
  imageProvider: z.union(['codex', 'openrouter']).default('openrouter'),
  codexImageCommand: z.string().default('/opt/deepseek-harness/packages/subagent/subagent-codex/node_modules/@openai/codex/bin/codex.js'),
  codexImageStateDirectory: z.string().default('/tmp/dsh/storages/media-codex'),
  codexImageModel: z.string().default('gpt-5.6-luna'),
  imageBaseURL: z.string().default(''),
  imageApiKeyEnv: z.string().default(''),
  imageModel: z.string().default(''),
  imageGatewayByokAlias: z.string().default(''),
  imageTimeoutMs: z.natural().min(1).max(600_000).default(180_000),
  videoCommand: z.string().default(''),
  videoModel: z.string().default(''),
  videoTimeoutMs: z.natural().min(1).max(3_600_000).default(1_200_000),
  videoMaxBytes: z.natural().min(1_000_000).max(500_000_000).default(150_000_000),
  videoResolution: z.string().default('720p'),
  mediaRequireOwner: z.boolean().default(false),
  mediaAdmissionPath: z.string().default('/tmp/dsh/storages/media-admission.sqlite'),
  mediaGlobalConcurrency: z.natural().min(1).max(64).default(4),
  mediaTenantConcurrency: z.natural().min(1).max(16).default(1),
  mediaMaxQueued: z.natural().min(1).max(1000).default(100),
  mediaDailyUserLimit: z.natural().min(1).max(10000).default(50),
  mediaMaxBriefChars: z.natural().min(100).max(40_000).default(12_000),
  mediaImageAttempts: z.natural().min(1).max(5).default(3),
  mediaRetryBaseDelayMs: z.natural().min(10).max(10_000).default(500),
})

interface ArtifactCreated {
  readonly artifactId: string
  readonly title: string
  readonly mediaType: 'application/pdf'
  readonly provider: string
  readonly path: string
  readonly pageSize: 'A4' | 'Letter'
  readonly pageCount: number
  readonly pdfBytes: number
  readonly pdf: FileAttachmentRef
  readonly preview: ImageAttachmentRef
  readonly designProfile?: DesignProfile
  readonly designQuality: DesignQuality
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** A rendered PDF and preview committed before the event became visible. */
    'hivemind/artifact-created': ArtifactCreated
  }
}

function requiredText(value: string, label: string, max: number): string {
  const trimmed = value.trim()
  if (trimmed === '') throw new TypeError(`hivemind-artifact-renderer: ${label} must be non-empty`)
  if (trimmed.length > max) throw new TypeError(`hivemind-artifact-renderer: ${label} exceeds ${max} characters`)
  return trimmed
}

function safeOutputRoot(cwd: string, configured: string): string {
  if (isAbsolute(configured)) throw new Error('hivemind-artifact-renderer: outputDirectory must be relative')
  const root = resolve(cwd)
  const output = resolve(root, normalize(configured))
  const rel = relative(root, output)
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('hivemind-artifact-renderer: outputDirectory escapes the workspace')
  }
  return output
}

function safeLeaf(title: string): string {
  const leaf = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64)
  return leaf === '' ? 'document' : leaf
}

/** Direct Markdown-to-PDF provider; it does not launch a browser. */
export class MarkdownArtifactRenderer extends ArtifactRenderer {
  constructor(ctx: Context, private readonly config: Config) { super(ctx) }

  override async render(request: ArtifactRenderRequest): Promise<ArtifactRenderResult> {
    request.signal.throwIfAborted()
    const path = this.config.attachmentOnly
      ? `${safeLeaf(request.title)}.pdf`
      : join(safeOutputRoot(request.cwd, this.config.outputDirectory), `${safeLeaf(request.title)}-${randomUUID()}.pdf`)
    if (!this.config.attachmentOnly) await mkdir(safeOutputRoot(request.cwd, this.config.outputDirectory), { recursive: true })
    if (request.markdown.length > this.config.maxMarkdownChars) throw new TypeError(`hivemind-artifact-renderer: markdown exceeds ${this.config.maxMarkdownChars} characters`)
    const pdf = await generatePdf(request.markdown, {
      theme: designTheme(request.designProfile),
      pageLayout: { ...defaultPageLayout, pageSize: request.pageSize.toUpperCase() },
      emojiFont: false,
      languages: ['typescript', 'javascript', 'json', 'bash', 'python'],
      // Model-authored Markdown must never trigger local-file reads or network fetches.
      renderImage: async () => { throw new Error('Markdown images are disabled for PDF rendering') },
    })
    request.signal.throwIfAborted()
    const { pageCount, preview } = await inspectPdf(new Uint8Array(pdf), request.signal, true)
    if (!this.config.attachmentOnly) await writeFile(path, pdf, { flag: 'wx', signal: request.signal })
    return { provider: 'markdown-pdf', path, pdf: new Uint8Array(pdf), preview, pageCount }
  }
}

const outputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    artifact_id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    media_type: { type: 'string', required: true, enum: ['application/pdf'] },
    provider: { type: 'string', required: true },
    path: { type: 'string', required: true },
    page_size: { type: 'string', required: true, enum: ['A4', 'Letter'] },
    page_count: { type: 'number', required: true },
    pdf_bytes: { type: 'number', required: true },
    layout_status: { type: 'string', required: true, enum: ['single_page', 'multi_page'] },
    chat_preview_status: { type: 'string', required: true, enum: ['visible'] },
    design_profile: { type: 'string', enum: [...designProfiles] },
    design_quality: { type: 'object', required: true, additionalProperties: false, properties: {
      status: { type: 'string', required: true, enum: ['ready', 'needs_review'] },
      checks: { type: 'array', required: true, items: { type: 'string' } },
      warnings: { type: 'array', required: true, items: { type: 'string' } },
    } },
    pdf: { type: 'object', required: true, additionalProperties: false, properties: {
      attachmentId: { type: 'string', required: true }, name: { type: 'string', required: true }, bytes: { type: 'number', required: true },
    } },
    preview: { type: 'object', required: true, additionalProperties: false, properties: {
      attachmentId: { type: 'string', required: true }, mediaType: { type: 'string', required: true, enum: ['image/png'] }, bytes: { type: 'number', required: true }, width: { type: 'number', required: true }, height: { type: 'number', required: true }, name: { type: 'string', required: true },
    } },
  },
} as const

/** Register the compact model-facing consumer against an already mounted provider. */
export function registerArtifactTool(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'hivemind_artifact_render',
    description: 'Render finished Markdown directly to a durable PDF with an inline first-page PNG preview. The renderer uses PDFKit and does not launch a browser. The optional HIVE design profile selects print typography and link colors. The durable chat projection is committed before this tool returns and chat_preview_status confirms it is visible to the user even when a text-only model sees the image payload as omitted. The receipt authoritatively reports page_count, pdf_bytes, layout_status, and deterministic design checks; do not lease shell tools to list files, recount pages, rasterize, or re-surface the preview. If explicit visual interpretation is materially required, use the progressive vision lane.',
    parameters: {
      title: { type: 'string', required: true, description: 'Human-readable document title.' },
      markdown: { type: 'string', required: true, description: 'Complete report in Markdown. Use headings, paragraphs, lists, tables, and links. Image references render as placeholders; they are not fetched.' },
      design_profile: { type: 'string', enum: [...designProfiles], description: 'Optional HIVE visual baseline. campaign for externally-facing campaign work, executive for leadership documents, product for product collateral, data for dashboards, editorial for narrative work. Applied locally before rendering and persisted in the receipt.' },
      page_size: { type: 'string', enum: ['A4', 'Letter'], description: 'Use A4 unless the audience or request calls for Letter.' },
    },
    output: {
      schema: outputSchema,
      presentationMeta: (_args, value) => ({ artifact_id: value.artifact_id }),
      render: (_args, value) => [
        { type: 'text', text: `Rendered ${value.title} as ${value.path}: ${value.page_count} page(s), ${value.pdf_bytes} bytes, ${value.layout_status}. Artifact ${value.artifact_id}; provider ${value.provider}. Design checks: ${value.design_quality.status}; ${value.design_quality.warnings.length ? `warnings ${value.design_quality.warnings.join(', ')}` : 'no deterministic warnings'}. chat_preview_status=${value.chat_preview_status}: the durable preview is already visible to the user even if this text-only model sees the image payload as omitted. This receipt is authoritative and terminal for a bounded single-artifact request: answer the user now. Do not render again, list files, rasterize, revalidate, or re-surface it.` },
        { type: 'image', attachment: value.preview as ImageAttachmentRef },
      ],
    },
    isConcurrencySafe: () => false,
    async execute(args, execution) {
      const agent = execution.agent
      if (agent === undefined) throw new Error('hivemind-artifact-renderer: active agent required')
      const title = requiredText(args.title, 'title', 240)
      const markdown = requiredText(args.markdown, 'markdown', config.maxMarkdownChars)
      const designProfile = args.design_profile as DesignProfile | undefined
      const designQuality = evaluateMarkdownDesignQuality(markdown, designProfile)
      const pageSize = args.page_size ?? 'A4'
      const rendered = await ctx.hivemindArtifactRenderer.render({
        title, markdown, pageSize, ...(designProfile === undefined ? {} : { designProfile }),
        cwd: agent.session.header.cwd ?? process.cwd(), signal: execution.signal,
      })
      const filename = `${safeLeaf(title)}.pdf`
      const pdf = await ctx.attachments.saveFile({ data: rendered.pdf, name: filename })
      const previewName = `${safeLeaf(title)}-preview.png`
      const preview = await ctx.attachments.saveImage({ data: rendered.preview, mediaType: 'image/png', name: previewName })
      const event: ArtifactCreated = {
        artifactId: randomUUID(), title, mediaType: 'application/pdf', provider: rendered.provider,
        path: rendered.path, pageSize, pageCount: rendered.pageCount, pdfBytes: rendered.pdf.byteLength, pdf, preview,
        ...(designProfile === undefined ? {} : { designProfile }), designQuality,
      }
      agent.session.append('hivemind/artifact-created', event)
      return {
        artifact_id: event.artifactId, title, media_type: event.mediaType, provider: event.provider,
        path: event.path,
        page_size: event.pageSize,
        page_count: event.pageCount,
        pdf_bytes: event.pdfBytes,
        layout_status: event.pageCount === 1 ? 'single_page' as const : 'multi_page' as const,
        chat_preview_status: 'visible' as const,
        ...(event.designProfile === undefined ? {} : { design_profile: event.designProfile }),
        design_quality: event.designQuality,
        pdf: { attachmentId: String(pdf.attachmentId), name: pdf.name, bytes: pdf.bytes },
        preview: {
          attachmentId: String(preview.attachmentId), mediaType: 'image/png' as const,
          bytes: preview.bytes, width: preview.width, height: preview.height, name: preview.name ?? previewName,
        },
      }
    },
    presentCall(args) { return { card: 'generic', title: 'Render PDF artifact', kind: 'read', rawInput: String(args.title ?? '') } },
  }))
}

/** Mount the selected provider and compact model-facing render tool. */
export function apply(ctx: Context, config: Config): void {
  registerPrivateDesignReferences(ctx, config.privateDesignReferenceDirectory ?? '')
  registerCalculator(ctx)
  if (config.provider === 'markdown-pdf') ctx.plugin(MarkdownArtifactRenderer, config)
  ctx.inject(['hivemindArtifactRenderer'], (rendererCtx) => {
    registerArtifactTool(rendererCtx, config)
    const registry = new GenerationRegistry()
    const { imageModel, imageBaseURL, imageApiKeyEnv } = config
    if (config.imageProvider === 'codex') {
      rendererCtx.effect(() => registry.register(codexImageProvider({
        command: config.codexImageCommand ?? '/opt/deepseek-harness/packages/subagent/subagent-codex/node_modules/@openai/codex/bin/codex.js',
        stateDirectory: config.codexImageStateDirectory ?? '/tmp/dsh/storages/media-codex',
        model: config.codexImageModel ?? 'gpt-5.6-luna', timeoutMs: config.imageTimeoutMs ?? 600_000,
        auth: signal => rendererCtx.serial('hivemind/codex-image-auth', { signal }),
      })))
    } else if (imageModel) {
      if (!imageBaseURL || !imageApiKeyEnv) throw new Error('Configured image model requires imageBaseURL and imageApiKeyEnv')
      rendererCtx.effect(() => registry.register(openRouterImageProvider({
        model: imageModel, baseURL: imageBaseURL, apiKeyEnv: imageApiKeyEnv, timeoutMs: config.imageTimeoutMs ?? 180_000,
        ...(config.imageGatewayByokAlias ? { gatewayByokAlias: config.imageGatewayByokAlias } : {}),
      })))
    }
    if (config.videoModel) {
      if (!config.videoCommand) throw new Error('Configured video model requires videoCommand')
      const videoCommand = config.videoCommand
      const videoModel = config.videoModel
      rendererCtx.effect(() => registry.register(higgsfieldVideoProvider({
        command: videoCommand, model: videoModel, timeoutMs: config.videoTimeoutMs ?? 1_200_000,
        maxBytes: config.videoMaxBytes ?? 150_000_000, resolution: config.videoResolution ?? '720p',
      })))
    }
    for (const provider of [markdownReportProvider, presentationProvider, spreadsheetProvider, webProvider]) {
      rendererCtx.effect(() => registry.register(provider))
    }
    rendererCtx.effect(() => registry.register({
      id: config.provider, format: 'pdf', instructions: 'Provide the finished report as Markdown, or use source_format html for complete self-contained image/text HTML with print CSS. Saved image placeholders require saved_image_ids. For Markdown PDF plus inline preview use hivemind_artifact_render. PDF receipts include actual page count and a first-page raster preview.',
      async generate(request) {
        if (request.sourceFormat === 'html') return webProvider.generate({ ...request, htmlPdf: true })
        const rendered = await rendererCtx.hivemindArtifactRenderer.render({
          ...request, markdown: request.content, pageSize: 'A4',
          ...(request.designProfile === undefined ? {} : { designProfile: request.designProfile }),
        })
        return { pageCount: rendered.pageCount, preview: { data: rendered.preview, mediaType: 'image/png' }, data: rendered.pdf, extension: 'pdf', mediaType: 'application/pdf', designQuality: evaluateMarkdownDesignQuality(request.content, request.designProfile) }
      },
    }))
    registerGenerationTools(rendererCtx, registry, config.outputDirectory, config.maxMarkdownChars, config.attachmentOnly)
    registerMediaWorkflow(rendererCtx, registry, config.outputDirectory, {
      requireOwner: config.mediaRequireOwner === true,
      ...(config.mediaRequireOwner ? { admission: { path: config.mediaAdmissionPath ?? '/tmp/dsh/storages/media-admission.sqlite', globalConcurrency: config.mediaGlobalConcurrency ?? 4, tenantConcurrency: config.mediaTenantConcurrency ?? 1, maxQueued: config.mediaMaxQueued ?? 100, dailyUserLimit: config.mediaDailyUserLimit ?? 50 } } : {}),
      maxBriefChars: config.mediaMaxBriefChars ?? 12_000,
      imageAttempts: config.mediaImageAttempts ?? 3,
      retryBaseDelayMs: config.mediaRetryBaseDelayMs ?? 500,
      attachmentOnly: config.attachmentOnly ?? false,
    })
  })
}
