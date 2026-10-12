/** Decode the native authorized file receipt without changing its session scope. */
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
export interface ArtifactFileResult {
  ok: boolean
  value?: { attachment: FileAttachmentRef; data: Uint8Array }
}

/** Validate the exact file receipt and byte budget returned by the native Session Remote. */
export function artifactFileBytes(file: FileAttachmentRef, result: ArtifactFileResult, maxBytes = 64 * 1024 * 1024): Uint8Array {
  if (!result.ok || result.value?.attachment.attachmentId !== file.attachmentId) throw new Error('Artifact preview unavailable')
  const data = result.value.data
  if (data.byteLength !== file.bytes || data.byteLength > maxBytes) throw new Error('Artifact size mismatch')
  return data
}

export function decodeArtifactText(file: FileAttachmentRef, result: ArtifactFileResult): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(artifactFileBytes(file, result, 4 * 1024 * 1024))
}
