import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceFileBytes } from '@deepseek-ai/dsh-api-workspace-files/types'

/** Read through the session-authorized native Remote, never a public artifact URL. */
export type ReadArtifactPage = (offset: number) => Promise<RemoteResult<WorkspaceFileBytes>>

/** Assemble a bounded, version-consistent binary artifact for browser download. */
export async function artifactBlob(read: ReadArtifactPage, mediaType: string): Promise<Blob> {
  const parts: ArrayBuffer[] = []
  let offset = 0
  let version: string | undefined
  const limit = 64 * 1024 * 1024
  for (;;) {
    const result = await read(offset)
    if (!result.ok) throw new Error('Artifact download failed')
    const page = result.value
    if (page.offset !== offset || (version !== undefined && version !== page.version)) {
      throw new Error('Artifact changed during download; retry')
    }
    version = page.version
    if (page.bytes !== undefined && page.bytes > limit) throw new Error('Artifact exceeds download size limit')
    const decoded = atob(page.data)
    if (offset + decoded.length > limit) throw new Error('Artifact exceeds download size limit')
    const bytes = new Uint8Array(decoded.length)
    for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i)
    parts.push(bytes.buffer)
    offset += bytes.length
    if (page.eof) {
      if (page.bytes !== undefined && page.bytes !== offset) throw new Error('Incomplete artifact download')
      return new Blob(parts, { type: mediaType })
    }
    if (bytes.length === 0) throw new Error('Artifact download made no progress')
  }
}

/** Let the browser save the authorized binary; never route it through the text editor. */
export function saveArtifact(blob: Blob, path: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = path.split(/[\\/]/).pop() || 'artifact'
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
