/** Revalidate signed principals through the existing authoritative Core boundary. No positive cache. */
export async function principalMembershipActive(
  base: string, token: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(3000)])
  try {
    const response = await fetchImpl(`${base}/internal/v1/harness-chat/core/principal`, {
      method: 'GET', headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: bounded,
    })
    if (response.status !== 200 || response.body === null) { await response.body?.cancel(); return false }
    const reader = response.body.getReader()
    let text = ''
    let size = 0
    try {
      while (true) {
        bounded.throwIfAborted()
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > 256) return false
        text += new TextDecoder().decode(chunk.value)
      }
      const result: unknown = JSON.parse(text)
      return typeof result === 'object' && result !== null && !Array.isArray(result)
        && Object.keys(result).length === 1 && 'active' in result && result.active === true
    } finally { await reader.cancel().catch(() => {}) }
  } catch { return false }
}
