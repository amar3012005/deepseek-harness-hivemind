/** Provider registry for finished company artifacts; providers never own the agent loop. */
import type { Context } from '@deepseek-ai/cordis'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, relative, isAbsolute, join } from 'node:path'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MediaOwner } from './media-admission.ts'
import { inspectPdf } from './pdf-inspection.ts'
import { embedHtmlAssets } from './html-assets.ts'
import type { DesignProfile, DesignQuality } from './design-kit.ts'

/** Formats accepted by the compact generation consumer. */
export type GenerationFormat = 'markdown_report' | 'pdf' | 'presentation' | 'spreadsheet' | 'web' | 'image' | 'video'
/** Inputs already prepared by the parent runtime, without another planning model. */
export interface GenerationRequest {
  readonly htmlPdf?: boolean
  readonly sourceFormat?: 'html'
  readonly reconcileOnly?: boolean
  readonly title: string
  readonly content: string
  readonly signal: AbortSignal
  readonly cwd: string
  readonly owner?: MediaOwner
  readonly operationId?: string
  readonly transparentBackground?: boolean
  readonly referenceFiles?: readonly { readonly data: Uint8Array }[]
  readonly referenceImages?: readonly string[]
  readonly sourcePath?: string
  readonly aspectRatio?: string
  readonly durationSeconds?: number
  readonly designProfile?: DesignProfile
}
/** Bytes created by the provider; no delivery claim is made until storage succeeds. */
export interface GeneratedFile {
  readonly pageCount?: number
  readonly data: Uint8Array
  readonly extension: string
  readonly mediaType: string
  /** Optional native thumbnail generated alongside the final binary. */
  readonly preview?: {
    readonly data: Uint8Array
    readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
    readonly nameSuffix?: string
  }
  readonly designQuality?: DesignQuality
}
/** One replaceable generation provider with its exact input guidance. */
export interface GenerationProvider {
  readonly id: string
  readonly format: GenerationFormat
  readonly instructions: string
  availability?(): Promise<{ readonly ready: true } | { readonly ready: false; readonly code: string; readonly action: string }>
  generate(request: GenerationRequest): Promise<GeneratedFile>
}
/** Registry is scoped to its consumer plugin and rejects accidental replacement. */
export class GenerationRegistry {
  private readonly providers = new Map<GenerationFormat, GenerationProvider>()
  /** Register a provider and return its exact removal effect. */
  register(provider: GenerationProvider): () => void {
    if (this.providers.has(provider.format)) throw new Error(`Generation provider already registered: ${provider.format}`)
    this.providers.set(provider.format, provider)
    return () => { if (this.providers.get(provider.format) === provider) this.providers.delete(provider.format) }
  }
  /** Describe only executable capabilities, never hypothetical installed models. */
  list(): { format: GenerationFormat; provider: string; tool: 'hivemind_generate' | 'hivemind_media_generate'; instructions: string }[] {
    return [...this.providers.values()].map(p => ({ format: p.format, provider: p.id, tool: p.format === 'image' || p.format === 'video' ? 'hivemind_media_generate' : 'hivemind_generate', instructions: p.instructions }))
  }
  /** Resolve an exact format, with a useful error for unavailable providers. */
  get(format: GenerationFormat): GenerationProvider {
    const provider = this.providers.get(format)
    if (provider === undefined) throw new Error(`No ${format} generator configured. Available: ${this.list().map(p => p.format).join(', ')}`)
    return provider
  }
}

/** A committed generated file, independent of the rendering provider. */
export interface GenerationReceipt {
  readonly owner?: MediaOwner
  readonly sourceFormat?: 'html'
  readonly savedImageIds?: readonly string[]
  readonly artifactId: string
  readonly title: string
  readonly format: GenerationFormat
  readonly mediaType: string
  readonly provider: string
  readonly path: string
  readonly file: FileAttachmentRef
  readonly sha256: string
  readonly pageCount?: number
  readonly preview?: ImageAttachmentRef
  readonly designProfile?: DesignProfile
  readonly designQuality?: DesignQuality
  /** Conventional image content lets the native Session route authorize async previews. */
  readonly content?: readonly [{ readonly type: 'image'; readonly attachment: ImageAttachmentRef }]
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Generated artifact stored before the completion event is appended. */
    'hivemind/generation-created': GenerationReceipt
  }
}

/** Generate, validate, store, and log one artifact for either a foreground tool or background media job. */
export async function generateArtifact(
  ctx: Context,
  registry: GenerationRegistry,
  outputDirectory: string,
  input: {
    readonly savedImageIds?: readonly string[]
    readonly sourceFormat?: 'html'
    readonly format: GenerationFormat
    readonly title: string
    readonly content: string
    readonly owner?: MediaOwner
    readonly operationId?: string
    readonly reconcileOnly?: boolean
    readonly transparentBackground?: boolean
    readonly referenceFiles?: readonly { readonly data: Uint8Array }[]
    readonly referenceImages?: readonly string[]
    readonly sourcePath?: string
    readonly aspectRatio?: string
    readonly durationSeconds?: number
    readonly designProfile?: DesignProfile
  },
  agent: { readonly session: { readonly header: { readonly cwd?: string }; append(type: 'hivemind/generation-created', receipt: GenerationReceipt): unknown } },
  signal: AbortSignal,
  attachmentOnly = false,
): Promise<GenerationReceipt> {
  const cwd = agent.session.header.cwd ?? process.cwd()
  const root = attachmentOnly ? undefined : resolve(cwd, outputDirectory)
  if (root !== undefined) {
    const rel = relative(resolve(cwd), root)
    if (isAbsolute(outputDirectory) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('Artifact directory must be inside the workspace')
  }
  const provider = registry.get(input.format)
  const generated = await provider.generate({
    title: input.title, content: input.content, cwd, signal,
    ...(input.sourceFormat === undefined ? {} : { sourceFormat: input.sourceFormat }),
    ...(input.reconcileOnly ? { reconcileOnly: true } : {}),
    ...(input.owner === undefined ? {} : { owner: input.owner }),
    ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
    ...(input.transparentBackground === undefined ? {} : { transparentBackground: input.transparentBackground }),
    ...(input.referenceFiles === undefined ? {} : { referenceFiles: input.referenceFiles }),
    ...(input.referenceImages === undefined ? {} : { referenceImages: input.referenceImages }),
    ...(input.sourcePath === undefined ? {} : { sourcePath: input.sourcePath }),
    ...(input.aspectRatio === undefined ? {} : { aspectRatio: input.aspectRatio }),
    ...(input.durationSeconds === undefined ? {} : { durationSeconds: input.durationSeconds }),
    ...(input.designProfile === undefined ? {} : { designProfile: input.designProfile }),
  })
  signal.throwIfAborted()
  if (!generated.data.byteLength) throw new Error('Provider returned an empty artifact')
  const artifactId = randomUUID()
  const leaf = input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'artifact'
  if (!/^[a-z0-9]+$/.test(generated.extension)) throw new Error('Provider returned an invalid file extension')
  const filename = `${leaf}.${generated.extension}`
  const path = root === undefined ? filename : join(root, `${artifactId}-${filename}`)
  if (root !== undefined) {
    await mkdir(root, { recursive: true })
    await writeFile(path, generated.data, { flag: 'wx', mode: 0o600, signal })
  }
  const file = await ctx.attachments.saveFile({ data: generated.data, name: filename })
  const inspection = generated.mediaType === 'application/pdf' && generated.pageCount === undefined ? await inspectPdf(generated.data, signal) : undefined
  const generatedPreview = (inspection ? { data: inspection.preview, mediaType: 'image/png' as const, nameSuffix: '-page-1.png' } : generated.preview) ?? (provider.format === 'image' && (
    generated.mediaType === 'image/png' || generated.mediaType === 'image/jpeg' || generated.mediaType === 'image/webp'
  ) ? { data: generated.data, mediaType: generated.mediaType } : undefined)
  const preview = generatedPreview === undefined
    ? undefined
    : await ctx.attachments.saveImage({
      data: generatedPreview.data,
      mediaType: generatedPreview.mediaType,
      name: generatedPreview.nameSuffix === undefined ? filename : `${leaf}${generatedPreview.nameSuffix}`,
    })
  const receipt: GenerationReceipt = {
    ...(input.owner ? { owner: input.owner } : {}),
    artifactId,
    ...(input.sourceFormat === undefined ? {} : { sourceFormat: input.sourceFormat }),
    ...(input.savedImageIds === undefined ? {} : { savedImageIds: input.savedImageIds }),
    title: input.title,
    format: provider.format,
    mediaType: generated.mediaType,
    provider: provider.id,
    path,
    file,
    ...((inspection?.pageCount ?? generated.pageCount) === undefined ? {} : { pageCount: inspection?.pageCount ?? generated.pageCount }),
    sha256: createHash('sha256').update(generated.data).digest('hex'),
    ...(preview === undefined ? {} : { preview, content: [{ type: 'image', attachment: preview }] }),
    ...(input.designProfile === undefined ? {} : { designProfile: input.designProfile }),
    ...(generated.designQuality === undefined ? {} : { designQuality: generated.designQuality }),
  }
  agent.session.append('hivemind/generation-created', receipt)
  return receipt
}

/** Register discovery and generation through the normal guarded tool pipeline. */
export function registerGenerationTools(
  ctx: Context, registry: GenerationRegistry, outputDirectory: string, maxContentChars: number, attachmentOnly = false,
): void {
  const output = { schema: { type: 'object' as const, additionalProperties: true, properties: {} }, render: (_args: unknown, value: unknown) => {
    const preview = typeof value === 'object' && value !== null && 'preview' in value ? value.preview as ImageAttachmentRef | undefined : undefined
    return [{ type: 'text' as const, text: JSON.stringify(value) }, ...(preview === undefined ? [] : [{ type: 'image' as const, attachment: preview }])]
  } }
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'hivemind_generation_discover',
    description: 'List configured artifact generators only when the requested format or its input representation is unknown. Do not call this for a known self-contained HTML/web request: call hivemind_generate with format "web" and complete HTML directly. Use hivemind_media_generate for image/video; use hivemind_generate or the dedicated PDF renderer for documents.',
    parameters: {},
    output,
    async execute() { return { generators: registry.list() } },
  })))
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'hivemind_generate',
    description: 'Create a finished Markdown report, PDF, presentation, spreadsheet, or web file using a configured generator. For format "web", provide complete self-contained HTML directly; generator discovery is unnecessary. For image/text HTML or PDF use source_format html with saved_image_ids and hive-asset:<saved ID> placeholders. Image and video must use hivemind_media_generate so their long-running lifecycle is tracked. Returns a stored artifact, not a published campaign or sent message.',
    parameters: {
      format: { type: 'string', required: true, enum: ['markdown_report', 'pdf', 'presentation', 'spreadsheet', 'web'] },
      title: { type: 'string', required: true },
      content: { type: 'string', required: true, description: 'For web, complete self-contained HTML. For another known format, provide that generator’s source content. Use discovery only when the representation is unknown.' },
      design_profile: { type: 'string', enum: ['executive', 'editorial', 'campaign', 'product', 'data'], description: 'Optional HIVE visual baseline. Use campaign for marketing, executive for leadership documents, product for product UI, data for KPI dashboards, and editorial for narrative reports. It is applied locally and recorded in the durable receipt; it never opens an external design app.' },
      source_format: { type: 'string', enum: ['html'], description: 'For web or PDF, complete self-contained HTML. PDF uses print CSS/page breaks; omitted PDF remains Markdown.' },
      saved_image_ids: { type: 'array', items: { type: 'string' }, description: 'Up to twenty current-session saved image artifact IDs or attachment IDs. Use hive-asset:<saved ID> in HTML img src or CSS url; exact bytes are embedded server-side. No URLs or filesystem paths.' },
      reference_images: { type: 'array', items: { type: 'string' }, description: 'Optional public HTTPS brand/product image URLs for image generation.' },
    },
    output,
    isConcurrencySafe: () => true,
    async execute(args, execution) {
      const agent = execution.agent
      if (agent === undefined) throw new Error('Generation requires an active session')
      if (!args.title.trim() || args.title.length > 240) throw new Error('Title must contain 1–240 characters')
      if (!args.content.trim() || args.content.length > maxContentChars) throw new Error(`Content must contain 1–${maxContentChars} characters`)
      const referenceImages = args.reference_images ?? []
      if (referenceImages.length > 8 || referenceImages.some((value) => { try { const u = new URL(value); return u.protocol !== 'https:' || Boolean(u.username || u.password) } catch { return true } })) throw new Error('Use at most eight public HTTPS reference image URLs')
      if (args.source_format && !['web', 'pdf'].includes(args.format)) throw new Error('HTML source supports web or PDF only')
      if ((args.saved_image_ids?.length ?? 0) > 0 && args.source_format !== 'html') throw new Error('Saved images require HTML source')
      const content = args.source_format === 'html'
        ? await embedHtmlAssets(ctx, agent, args.content, args.saved_image_ids ?? [], execution.signal)
        : args.content
      const receipt = await generateArtifact(
        ctx,
        registry,
        outputDirectory,
        {
          format: args.format as GenerationFormat, title: args.title, content, referenceImages,
          ...(args.source_format === undefined ? {} : { sourceFormat: args.source_format, savedImageIds: args.saved_image_ids ?? [] }),
          ...(args.design_profile === undefined ? {} : { designProfile: args.design_profile as DesignProfile }),
        },
        agent,
        execution.signal,
        attachmentOnly,
      )
      return {
        artifact_id: receipt.artifactId, title: args.title, format: receipt.format, provider: receipt.provider,
        path: receipt.path, file: receipt.file, sha256: receipt.sha256,
        ...(receipt.preview === undefined ? {} : { preview: receipt.preview }),
        ...(receipt.designProfile === undefined ? {} : { design_profile: receipt.designProfile }),
        ...(receipt.designQuality === undefined ? {} : { design_quality: receipt.designQuality }),
        ...(receipt.pageCount === undefined ? {} : { page_count: receipt.pageCount, preview_page: 1 }),
        status: 'created', validation: 'file_created; deterministic design checks complement optional visual review',
      }
    },
    presentCall(args) { return { card: 'generic', title: 'Generate artifact', kind: 'read', rawInput: String(args.title ?? '') } },
  })))
}
