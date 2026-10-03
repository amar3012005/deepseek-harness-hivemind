/** Decode the native authorized file receipt without changing its session scope. */
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
export function decodeArtifactText(file: FileAttachmentRef, result: {
  ok: boolean
  value?: { attachment: FileAttachmentRef; data: string }
}): string {
  if (!result.ok || result.value?.attachment.attachmentId !== file.attachmentId) throw new Error('Artifact preview unavailable')
  const binary = atob(result.value.data)
  if (binary.length !== file.bytes || binary.length > 4 * 1024 * 1024) throw new Error('Artifact size mismatch')
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0)))
}
