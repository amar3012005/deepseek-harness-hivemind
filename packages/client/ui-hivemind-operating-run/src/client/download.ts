/** Decode one session-authorized immutable file receipt. */
export function fileArtifactBlob(data: string, mediaType: string, expectedBytes: number): Blob {
  if (expectedBytes > 64 * 1024 * 1024) throw new Error('Artifact exceeds download size limit')
  const decoded = atob(data)
  if (decoded.length !== expectedBytes) throw new Error('Incomplete artifact download')
  const bytes = new Uint8Array(decoded.length)
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i)
  return new Blob([bytes], { type: mediaType })
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
