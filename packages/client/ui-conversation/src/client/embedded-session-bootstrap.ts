import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'

/** Wait for the authoritative catalog before choosing or creating an embedded session. */
export function setupEmbeddedSessionBootstrap(sessions: Pick<ISessions, 'list' | 'open' | 'create'>): () => void {
  let creating = false
  let pending: ReturnType<typeof setTimeout> | undefined
  const ensureSession = (): void => {
    const state = sessions.list.getSnapshot()
    if (state.current !== undefined || creating || pending !== undefined) return
    pending = setTimeout(() => {
      pending = undefined
      const settled = sessions.list.getSnapshot()
      if (settled.phase !== 'ready' || settled.current !== undefined) return
      const existing = settled.ids[0]
      if (existing !== undefined) {
        sessions.open(existing)
        return
      }
      creating = true
      void sessions.create().then((id) => { sessions.open(id) }).finally(() => {
        creating = false
        ensureSession()
      })
    }, state.phase === 'ready' ? 50 : 750)
  }
  const stop = sessions.list.subscribe(ensureSession)
  ensureSession()
  return () => {
    if (pending !== undefined) clearTimeout(pending)
    stop()
  }
}
