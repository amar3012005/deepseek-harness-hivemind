import { describe, expect, it, vi } from 'vitest'
import { createAuthenticationProbe } from '../src/client/auth-recovery.ts'

describe('native authentication recovery', () => {
  it('recovers once for confirmed expiry', async () => {
    const reload = vi.fn()
    const recovery = createAuthenticationProbe({ probe: async () => 401, reload })
    await recovery.check()
    await recovery.check()
    expect(reload).toHaveBeenCalledTimes(1)
  })
  it.each([200, 403, 502])('does not reload for %s', async (status) => {
    const reload = vi.fn()
    await createAuthenticationProbe({ probe: async () => status, reload }).check()
    expect(reload).not.toHaveBeenCalled()
  })
  it('bounds network checks and permits later recovery', async () => {
    let now = 0
    const probe = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(401)
    const reload = vi.fn()
    const recovery = createAuthenticationProbe({ probe, reload, now: () => now })
    await recovery.check()
    await recovery.check()
    expect(probe).toHaveBeenCalledTimes(1)
    now = 30000
    await recovery.check()
    expect(reload).toHaveBeenCalledOnce()
  })
  it('does not reload after disposal while the probe is pending', async () => {
    const pending = Promise.withResolvers<number>()
    const reload = vi.fn()
    const recovery = createAuthenticationProbe({ probe: () => pending.promise, reload })
    const checked = recovery.check()
    recovery.dispose()
    pending.resolve(401)
    await checked
    expect(reload).not.toHaveBeenCalled()
  })
})
