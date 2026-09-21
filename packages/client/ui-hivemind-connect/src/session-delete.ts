/** Install the authenticated, tenant-scoped permanent session deletion bridge. */
export function setupHivemindSessionDeletion(
  fetchImpl: typeof fetch = globalThis.fetch,
): () => void {
  const previous = window.__HIVEMIND_DELETE_SESSION__
  window.__HIVEMIND_DELETE_SESSION__ = async (sessionId: string): Promise<void> => {
    const normalized = sessionId.trim()
    if (normalized === '' || normalized.length > 180 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
      throw new Error('Invalid session identifier')
    }
    const response = await fetchImpl(`/v1/harness-chat/sessions/${encodeURIComponent(normalized)}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: unknown } | null
      throw new Error(typeof payload?.error === 'string' ? payload.error : `Session deletion failed (${response.status})`)
    }
  }
  return () => {
    if (previous === undefined) delete window.__HIVEMIND_DELETE_SESSION__
    else window.__HIVEMIND_DELETE_SESSION__ = previous
  }
}

declare global {
  interface Window {
    __HIVEMIND_DELETE_SESSION__?: (sessionId: string) => Promise<void>
  }
}
