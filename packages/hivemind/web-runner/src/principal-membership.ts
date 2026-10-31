/**
 * Revalidate signed principals through the existing authoritative Core boundary. This read is uncached; the caller
 * reuses an active answer through StaleWhileRevalidate, bounded by `membershipMaxStaleSeconds`.
 */
export async function principalMembershipActive(
  base: string, token: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    try { return await readMembership(base, token, signal, fetchImpl) }
    catch (error) {
      if (attempt > 0 || signal.aborted) throw error
    }
  }
}

async function readMembership(base: string, token: string, signal: AbortSignal, fetchImpl: typeof fetch): Promise<boolean> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(3000)])
  try {
    const response = await fetchImpl(`${base}/internal/v1/harness-chat/core/principal`, {
      method: 'GET', headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: bounded,
    })
    if ([502, 503, 504].includes(response.status)) {
      await response.body?.cancel(); throw new Error('principal_authority_unavailable')
    }
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
      // Control adds `runtime_enabled` beside `active`; any other field is still refused.
      return typeof result === 'object' && result !== null && !Array.isArray(result)
        && Object.keys(result).every(key => key === 'active' || key === 'runtime_enabled')
        && 'active' in result && result.active === true
        && (!('runtime_enabled' in result) || typeof result.runtime_enabled === 'boolean')
    } finally { await reader.cancel().catch(() => {}) }
  } catch (error) {
    if (error instanceof SyntaxError) return false
    throw error
  }
}
