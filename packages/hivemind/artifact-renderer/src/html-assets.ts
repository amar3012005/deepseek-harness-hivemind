/** Embed exact saved image bytes referenced by this authenticated session. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { loadImage } from '@napi-rs/canvas'

export async function embedHtmlAssets(
  ctx: Context, agent: Agent, html: string, ids: readonly string[], signal: AbortSignal,
): Promise<string> {
  if (ids.length > 20 || new Set(ids).size !== ids.length) throw new Error('Use at most twenty distinct saved image attachments')
  let total = 0
  for (const id of ids) {
    signal.throwIfAborted()
    let ref: FileAttachmentRef | undefined
    for (const event of agent.session.snapshotEvents()) {
      if (typeof event.data !== 'object' || event.data === null) continue
      const data = event.data as unknown as Record<string, unknown>
      if (String(event.type) === 'hivemind/generation-created') {
        const file = data['file'] as FileAttachmentRef | undefined
        if (file && (file.attachmentId === id || data['artifactId'] === id) && String(data['mediaType']).startsWith('image/')) ref = file
      }
      if (String(event.type) === 'hivemind/room-message-received' && data['targetId'] === agent.session.id && typeof data['senderId'] === 'string' && Array.isArray(data['artifactIds']) && Array.isArray(data['artifacts'])) {
        for (const item of data['artifacts']) {
          if (typeof item !== 'object' || item === null) continue
          const asset = item as { artifactId?: string; producerSessionId?: string; file?: FileAttachmentRef }
          if (asset.file && (asset.file.attachmentId === id || asset.artifactId === id) && asset.producerSessionId === data['senderId'] && data['artifactIds'].includes(asset.artifactId)) ref = asset.file
        }
      }
    }
    if (!ref || !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0 || ref.bytes > 30 * 1024 * 1024) throw new Error('Saved image attachment is unavailable or exceeds 30 MiB')
    const chunks: Uint8Array[] = []; let bytes = 0
    for await (const chunk of ctx.attachments.readFileStream(ref, signal)) {
      bytes += chunk.byteLength; total += chunk.byteLength
      if (bytes > 30 * 1024 * 1024 || total > 60 * 1024 * 1024) throw new Error('Saved image assets exceed the byte budget')
      chunks.push(chunk)
    }
    const data = Buffer.concat(chunks)
    if (bytes !== ref.bytes) throw new Error('Saved image attachment size mismatch')
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
