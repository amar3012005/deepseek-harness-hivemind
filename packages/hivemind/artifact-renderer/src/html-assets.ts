/** Embed exact saved image bytes referenced by this authenticated session. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { loadImage } from '@napi-rs/canvas'

/** Authorized image attachments of the latest direct human message, in image order. */
export function latestUploadedImages(agent: Agent): Map<string, ImageAttachmentRef> {
  const uploads = new Map<string, ImageAttachmentRef>()
  {
    const message = agent.session.snapshotEvents().findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
    if (message?.type === 'user/message') {
      const images = message.data.content.filter(part => part.type === 'image' && 'attachment' in part && part.attachment)
      for (const [index, part] of images.entries()) {
        if (part.type === 'image' && 'attachment' in part && part.attachment) uploads.set(`latest-${index}`, part.attachment)
      }
    }
  }
  return uploads
}

/** Resolve only immutable refs committed in this authorized session, including native browser captures. */
export function savedImageReference(agent: Agent, id: string): FileAttachmentRef | ImageAttachmentRef | undefined {
  let ref: FileAttachmentRef | ImageAttachmentRef | undefined
  for (const event of agent.session.snapshotEvents()) {
    if (typeof event.data !== 'object' || event.data === null) continue
    const data = event.data as unknown as Record<string, unknown>
    if (String(event.type) === 'hivemind/generation-created') {
      const file = data['file'] as FileAttachmentRef | undefined
      if (file && (file.attachmentId === id || data['artifactId'] === id) && String(data['mediaType']).startsWith('image/')) ref = file
    }
    if (String(event.type) === 'hivemind/browser-capture') {
      const preview = data['preview'] as ImageAttachmentRef | undefined
      const file = data['file'] as FileAttachmentRef | undefined
      if (preview && typeof preview.attachmentId === 'string' && typeof preview.mediaType === 'string'
        && preview.mediaType.startsWith('image/') && (data['captureId'] === id || preview.attachmentId === id || file?.attachmentId === id)) ref = file && typeof file.attachmentId === 'string' && typeof file.name === 'string' && Number.isSafeInteger(file.bytes) ? file : preview
    }
    if (String(event.type) === 'hivemind/room-message-received' && data['targetId'] === agent.session.id && typeof data['senderId'] === 'string' && Array.isArray(data['artifactIds']) && Array.isArray(data['artifacts'])) {
      for (const item of data['artifacts']) {
        if (typeof item !== 'object' || item === null) continue
        const asset = item as { artifactId?: string; producerSessionId?: string; file?: FileAttachmentRef }
        if (asset.file && (asset.file.attachmentId === id || asset.artifactId === id) && asset.producerSessionId === data['senderId'] && data['artifactIds'].includes(asset.artifactId)) ref = asset.file
      }
    }
  }
  return ref
}

export async function embedHtmlAssets(
  ctx: Context, agent: Agent, html: string, ids: readonly string[], signal: AbortSignal, latestUpload = false,
): Promise<string> {
  const uploads = latestUpload ? latestUploadedImages(agent) : new Map<string, ImageAttachmentRef>()
  const uploadIds = [...uploads.keys()].filter(id => html.includes(`hive-asset:${id}`))
  if (latestUpload && !uploadIds.length) throw new Error('Use a latest-image placeholder from the latest human message')
  if (ids.some(id => id.startsWith('latest-'))) throw new Error('Latest-image placeholders use the upload flag, not saved image IDs')
  if (ids.length + uploadIds.length > 20 || new Set(ids).size !== ids.length) throw new Error('Use at most twenty distinct saved image attachments')
  let total = 0
  for (const id of [...ids, ...uploadIds]) {
    signal.throwIfAborted()
    const ref = savedImageReference(agent, id)
    const upload = uploads.get(id) ?? (ref && 'mediaType' in ref ? ref : undefined)
    let data: Buffer
    if (upload) {
      const image = await ctx.attachments.readImage(upload, signal)
      data = Buffer.from(image.data)
      total += data.byteLength
      if (!data.byteLength || data.byteLength > 30 * 1024 * 1024 || total > 60 * 1024 * 1024) throw new Error('Saved image assets exceed the byte budget')
    } else {
      if (!ref || 'mediaType' in ref || !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0 || ref.bytes > 30 * 1024 * 1024) throw new Error('Saved image attachment is unavailable or exceeds 30 MiB')
      const chunks: Uint8Array[] = []; let bytes = 0
      for await (const chunk of ctx.attachments.readFileStream(ref, signal)) {
        bytes += chunk.byteLength; total += chunk.byteLength
        if (bytes > 30 * 1024 * 1024 || total > 60 * 1024 * 1024) throw new Error('Saved image assets exceed the byte budget')
        chunks.push(chunk)
      }
      data = Buffer.concat(chunks)
      if (bytes !== ref.bytes) throw new Error('Saved image attachment size mismatch')
    }
    const mime = data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
      : data[0] === 255 && data[1] === 216 && data[2] === 255 ? 'image/jpeg'
        : data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : undefined
    if (!mime) throw new Error('Saved image must be PNG, JPEG or WebP')
    const image = await loadImage(data)
    if (image.width * image.height > 40_000_000) throw new Error('Saved image exceeds pixel budget')
    const placeholder = `hive-asset:${id}`
    if (!html.includes(placeholder)) throw new Error('Declared saved image placeholder is unused')
    html = html.split(placeholder).join(`data:${mime};base64,${data.toString('base64')}`)
  }
  if (html.includes('hive-asset:')) throw new Error('HTML contains an unresolved saved image placeholder')
  return html
}
