/** Durable image inspection over existing authorized session attachment receipts. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { loadImage } from '@napi-rs/canvas'
import { savedImageReference } from './html-assets.ts'

export async function inspectSavedImage(ctx: Context, agent: Agent, id: string, signal: AbortSignal): Promise<ImageAttachmentRef> {
  signal.throwIfAborted()
  const ref = savedImageReference(agent, id)
  if (!ref || !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0 || ref.bytes > 30 * 1024 * 1024) throw new Error('Saved image receipt unavailable or exceeds 30 MiB')
  let data: Uint8Array
  if ('mediaType' in ref) data = (await ctx.attachments.readImage(ref, signal)).data
  else {
    const chunks: Uint8Array[] = []; let size = 0
    for await (const chunk of ctx.attachments.readFileStream(ref, signal)) {
      size += chunk.byteLength
      if (size > 30 * 1024 * 1024) throw new Error('Saved image exceeds 30 MiB')
      chunks.push(chunk)
    }
    data = Buffer.concat(chunks)
  }
  if (data.byteLength !== ref.bytes) throw new Error('Saved image size mismatch')
  const bytes = Buffer.from(data)
  const mime = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : undefined
  if (!mime) throw new Error('Saved image must be PNG, JPEG or WebP')
  const image = await loadImage(bytes)
  if (image.width * image.height > 40_000_000) throw new Error('Saved image exceeds pixel budget')
  signal.throwIfAborted()
  return 'mediaType' in ref ? ref : ctx.attachments.saveImage({ data, mediaType: mime, name: 'saved-artifact-inspection' })
}

export function registerArtifactInspection(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'hivemind_artifact_inspect',
    description: 'Inspect actual pixels of an existing saved image by its exact artifact or attachment ID from this session or an accepted transferred receipt. Works after restart when job_list is empty; no job or team task is required. Supports PNG, JPEG and WebP only. Does not generate or change the artifact.',
    parameters: { artifact_id: { type: 'string', required: true, description: 'Exact durable saved image artifact ID or native attachment ID; never a URL or filesystem path.' } },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, value) => [
      { type: 'text', text: `Saved artifact ${String(value.artifact_id)}: inspect the actual image pixels below before describing or judging it.` },
      { type: 'image', attachment: value.preview as unknown as ImageAttachmentRef },
    ] },
    isConcurrencySafe: () => true,
    async execute(args, execution) {
      if (!execution.agent) throw new Error('Active agent required')
      const id = args.artifact_id.trim()
      if (!id || id.length > 256) throw new Error('Exact saved artifact ID required')
      const preview = await inspectSavedImage(ctx, execution.agent, id, execution.signal)
      return { artifact_id: id, preview: { ...preview } }
    },
  }))
}
