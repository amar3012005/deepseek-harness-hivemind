/** Optional shell-owned transport; ordinary served pages keep browser behavior. */
interface ShellTransport {
  fetch?(input: URL, init: RequestInit): Promise<Response>
  saveFile?(blob: Blob, filename: string): Promise<boolean>
}

function transport(): ShellTransport | undefined {
  return (globalThis as typeof globalThis & { __DSH_TRANSPORT__?: ShellTransport }).__DSH_TRANSPORT__
}

export function probeBoot(): Promise<Response> {
  const url = new URL('/api/hivemind/boot', globalThis.location.href)
  const init: RequestInit = { method: 'HEAD', credentials: 'include', cache: 'no-store' }
  const owner = transport()
  return owner?.fetch === undefined ? fetch(url, init) : owner.fetch(url, init)
}

/** Called only by an explicit artifact download action; false is cancellation, not browser fallback. */
export async function saveNativeArtifact(blob: Blob, filename: string): Promise<boolean> {
  const owner = transport()
  if (owner?.saveFile === undefined) return false
  await owner.saveFile(blob, filename)
  return true
}
