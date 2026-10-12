import { useEffect, useState } from 'react'
/** Actual settled credits, never a token estimate or company-wide balance. */
export function SessionCredits({ sessionId }: { sessionId?: string | undefined }) {
  const [credits, setCredits] = useState<number>()
  useEffect(() => {
    setCredits(undefined)
    if (!sessionId) return
    const controller = new AbortController()
    let pending = false
    const refresh = async () => {
      if (pending) return
      pending = true
      try {
        const response = await fetch(`/hivemind/dreamer/credits?sessionId=${encodeURIComponent(sessionId)}`, { credentials: 'include', signal: controller.signal })
        if (!response.ok) return
        const value = await response.json() as { credits: number }
        if (Number.isFinite(value.credits) && value.credits >= 0 && !controller.signal.aborted) setCredits(value.credits)
      } catch { /* Preserve the last confirmed value across a temporary disconnect. */ }
      finally { pending = false }
    }
    void refresh()
    const timer = window.setInterval(() => { if (!document.hidden) void refresh() }, 15000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [sessionId])
  return <p style={{ margin: '12px 0 0', paddingTop: 12, borderTop: '1px solid #8882', color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }}>Credits used in this session <strong style={{ float: 'right', fontWeight: 500 }}>{credits === undefined ? '—' : credits.toLocaleString()}</strong></p>
}
