/** Re-enter the existing admission flow only after an authoritative expiry. */
export function createAuthenticationProbe(options: {
  probe: () => Promise<number>
  reload: () => void
  now?: () => number
}): { check: () => Promise<void>; dispose: () => void } {
  let disposed = false
  let pending = false
  let recovered = false
  let lastCheck = -Infinity
  const now = options.now ?? Date.now
  return {
    async check() {
      if (disposed || pending || recovered || now() - lastCheck < 30000) return
      pending = true
      lastCheck = now()
      try {
        const status = await options.probe()
        if (!disposed && status === 401) {
          recovered = true
          options.reload()
        }
      } catch {
        // Network failures remain owned by the native Connection loop.
      } finally { pending = false }
    },
    dispose() { disposed = true },
  }
}
