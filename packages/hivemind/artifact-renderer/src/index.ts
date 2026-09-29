/** Progressive, provider-neutral PDF artifact rendering for HIVE-MIND. */

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { chromium } from 'playwright'
import { GenerationRegistry, registerGenerationTools } from './generation.ts'
import { presentationProvider, spreadsheetProvider, webProvider } from './office-providers.ts'
import { openRouterImageProvider } from './image-provider.ts'
import { higgsfieldVideoProvider } from './higgsfield-video-provider.ts'
import { registerMediaWorkflow } from './media-workflow.ts'
import { createCanvas } from '@napi-rs/canvas'
import { registerCalculator } from './calculator.ts'
import { applyDesignProfile, designProfiles, evaluateDesignQuality, type DesignProfile, type DesignQuality } from './design-kit.ts'
export type { GenerationReceipt } from './generation.ts'

export const name = 'hivemind-artifact-renderer'
export const inject = ['tools', 'attachments', 'jobs']

export interface ArtifactRenderRequest {
  readonly title: string
  readonly html: string
  readonly pageSize: 'A4' | 'Letter'
  readonly printBackground: boolean
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
  /** Render one self-contained HTML document to PDF and first-page preview. */
  abstract render(request: ArtifactRenderRequest): Promise<ArtifactRenderResult>
}

export interface Config {
  provider: 'playwright'
  outputDirectory: string
  attachmentOnly?: boolean
  timeoutMs: number
  maxHtmlChars: number
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
  mediaMaxBriefChars?: number
  mediaImageAttempts?: number
  mediaRetryBaseDelayMs?: number
}

export const Config: z<Config> = z.object({
  provider: z.const('playwright').default('playwright'),
  outputDirectory: z.string().default('.hivemind/artifacts'),
  attachmentOnly: z.boolean().default(false),
  timeoutMs: z.natural().min(1).max(120_000).default(30_000),
  maxHtmlChars: z.natural().min(1_000).max(2_000_000).default(400_000),
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

/** Local Playwright provider; consumers can replace this service without changing the tool. */
export class PlaywrightArtifactRenderer extends ArtifactRenderer {
  constructor(ctx: Context, private readonly config: Config) { super(ctx) }

  override async render(request: ArtifactRenderRequest): Promise<ArtifactRenderResult> {
    request.signal.throwIfAborted()
    const path = this.config.attachmentOnly
      ? `${safeLeaf(request.title)}.pdf`
      : join(safeOutputRoot(request.cwd, this.config.outputDirectory), `${safeLeaf(request.title)}-${randomUUID()}.pdf`)
    if (!this.config.attachmentOnly) await mkdir(safeOutputRoot(request.cwd, this.config.outputDirectory), { recursive: true })
    const browser = await chromium.launch({ headless: true })
    try {
      const viewport = request.pageSize === 'Letter'
        ? { width: 1240, height: 1605 }
        : { width: 1240, height: 1754 }
      const page = await browser.newPage({ viewport, deviceScaleFactor: 1, javaScriptEnabled: false, serviceWorkers: 'block' })
      // Rendering is not browsing: untrusted HTML must not access local services
      // or exfiltrate company content. Embed vetted assets as data URLs.
      await page.route('**/*', route => route.abort('blockedbyclient'))
      await page.setContent(request.html, { waitUntil: 'networkidle', timeout: this.config.timeoutMs })
      await page.evaluate(() => document.fonts.ready)
      await page.emulateMedia({ media: 'print' })
      const pdf = await page.pdf({
        format: request.pageSize,
        printBackground: request.printBackground,
        // The compact tool contract owns the requested paper size. Page CSS
        // may style margins, but cannot silently switch A4 to another format.
        preferCSSPageSize: false,
        tagged: true,
      })
      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
      const loading = getDocument({ data: new Uint8Array(pdf), useSystemFonts: true })
      const pdfDocument = await loading.promise
      let preview: Uint8Array
      const pageCount = pdfDocument.numPages
      try {
        const first = await pdfDocument.getPage(1)
        const view = first.getViewport({ scale: 1.5 })
        const canvas = createCanvas(Math.ceil(view.width), Math.ceil(view.height))
        await first.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D, viewport: view }).promise
        preview = await canvas.encode('png')
      } finally { await loading.destroy() }
      if (!this.config.attachmentOnly) await writeFile(path, pdf, { flag: 'wx', signal: request.signal })
      return { provider: 'playwright', path, pdf, preview, pageCount }
    } finally {
      await browser.close()
    }
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
    description: 'Render a finished self-contained HTML document as a durable PDF with an inline first-page PNG preview. The optional HIVE design profile adds a deterministic visual baseline without opening an external design app. The durable chat projection is committed before this tool returns and chat_preview_status confirms it is visible to the user even when a text-only model sees the image payload as omitted. The receipt authoritatively reports page_count, pdf_bytes, layout_status, and deterministic design checks; do not lease shell tools to list files, recount pages, rasterize, or re-surface the preview. If explicit visual interpretation is materially required, use the progressive vision lane. README or Markdown content can be designed into HTML first. Branding is optional unless the request or selected playbook requires it.',
    parameters: {
      title: { type: 'string', required: true, description: 'Human-readable document title.' },
      html: { type: 'string', required: true, description: 'Complete self-contained HTML and CSS. Do not reference local files.' },
      design_profile: { type: 'string', enum: [...designProfiles], description: 'Optional HIVE visual baseline. campaign for externally-facing campaign work, executive for leadership documents, product for product collateral, data for dashboards, editorial for narrative work. Applied locally before rendering and persisted in the receipt.' },
      page_size: { type: 'string', enum: ['A4', 'Letter'], description: 'Use A4 unless the audience or request calls for Letter.' },
      print_background: { type: 'boolean', description: 'Preserve background colors and images. Defaults to true.' },
    },
    output: {
      schema: outputSchema,
      render: (_args, value) => [
        { type: 'text', text: `Rendered ${value.title} as ${value.path}: ${value.page_count} page(s), ${value.pdf_bytes} bytes, ${value.layout_status}. Artifact ${value.artifact_id}; provider ${value.provider}. Design checks: ${value.design_quality.status}; ${value.design_quality.warnings.length ? `warnings ${value.design_quality.warnings.join(', ')}` : 'no deterministic warnings'}. chat_preview_status=${value.chat_preview_status}: the durable preview is already visible to the user even if this text-only model sees the image payload as omitted. This receipt is authoritative; do not use shell tools to list, rasterize, revalidate, or re-surface it.` },
        { type: 'image', attachment: value.preview as ImageAttachmentRef },
      ],
    },
    isConcurrencySafe: () => false,
    async execute(args, execution) {
      const agent = execution.agent
      if (agent === undefined) throw new Error('hivemind-artifact-renderer: active agent required')
      const title = requiredText(args.title, 'title', 240)
      const rawHtml = requiredText(args.html, 'html', config.maxHtmlChars)
      const designProfile = args.design_profile as DesignProfile | undefined
      const html = applyDesignProfile(rawHtml, designProfile)
      const designQuality = evaluateDesignQuality(html, designProfile)
      const pageSize = args.page_size ?? 'A4'
      const rendered = await ctx.hivemindArtifactRenderer.render({
        title, html, pageSize, printBackground: args.print_background ?? true,
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
  registerCalculator(ctx)
  if (config.provider === 'playwright') ctx.plugin(PlaywrightArtifactRenderer, config)
  ctx.inject(['hivemindArtifactRenderer'], (rendererCtx) => {
    registerArtifactTool(rendererCtx, config)
    const registry = new GenerationRegistry()
    const { imageModel, imageBaseURL, imageApiKeyEnv } = config
    if (imageModel) {
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
    for (const provider of [presentationProvider, spreadsheetProvider, webProvider]) rendererCtx.effect(() => registry.register(provider))
    rendererCtx.effect(() => registry.register({
      id: config.provider, format: 'pdf', instructions: 'Provide complete self-contained HTML/CSS with print layout. For PDF plus inline preview use hivemind_artifact_render. This generator returns the PDF file only.',
      async generate(request) {
        const html = applyDesignProfile(request.content, request.designProfile)
        const rendered = await rendererCtx.hivemindArtifactRenderer.render({ ...request, html, pageSize: 'A4', printBackground: true })
        return { data: rendered.pdf, extension: 'pdf', mediaType: 'application/pdf', designQuality: evaluateDesignQuality(html, request.designProfile) }
      },
    }))
    registerGenerationTools(rendererCtx, registry, config.outputDirectory, config.maxHtmlChars, config.attachmentOnly)
    registerMediaWorkflow(rendererCtx, registry, config.outputDirectory, {
      maxBriefChars: config.mediaMaxBriefChars ?? 12_000,
      imageAttempts: config.mediaImageAttempts ?? 3,
      retryBaseDelayMs: config.mediaRetryBaseDelayMs ?? 500,
    })
  })
}
