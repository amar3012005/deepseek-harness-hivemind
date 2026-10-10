import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HqControl } from '../src/control.ts'

function fixture() {
  const agent = { id: 'fixture-root' } as unknown as Agent
  const fresh = { id: 'fixture-root', session: { append: vi.fn() } }
  const calls: string[] = []
  const record = (name: string, value: unknown) => vi.fn(async () => { calls.push(name); return value })
  const ctx = {
    hivemindHqOwnership: { freshTargets: record('scope', ['fixture-root', 'fixture-employee']),
      resetFresh: record('reset', { sessions: 2, memories: 1 }), claim: record('claim', undefined) },
    schedule: { catalog: record('catalog', [{ sessionId: 'fixture-employee', id: 'owned' }, { sessionId: 'foreign-root', id: 'foreign' }]), delete: record('delete', undefined) },
    sessionController: { releaseOwnedSessions: record('release', undefined), create: record('create', { sessionId: 'fixture-root' }),
      resolveAgent: record('resolve', { agent: fresh }) }, sessions: { flush: record('flush', true) },
  }
  const control = Object.assign(Object.create(HqControl.prototype), { ctx, root: () => agent,
    mode: () => ({ revision: 3 }), setMode: record('pause', { ok: true }) }) as HqControl
  return { agent, fresh, calls, ctx, control }
}

describe('human Start fresh lifecycle boundaries', () => {
  it('requires explicit confirmation before resolving any reset scope', async () => {
    const f = fixture()
    await expect(f.control.startFresh(f.agent, { confirmed: false })).rejects.toThrow('fresh_reset_confirmation_required')
    expect(f.calls).toEqual([])
  })
  it('pauses and releases owned sessions before resetting, then persists the new room without waking it', async () => {
    const f = fixture()
    await expect(f.control.startFresh(f.agent, { confirmed: true })).resolves.toEqual({ sessions: 2, memories: 1 })
    expect(f.calls).toEqual(['scope', 'pause', 'catalog', 'delete', 'release', 'reset', 'create', 'resolve', 'flush', 'claim'])
    expect(f.ctx.schedule.delete).toHaveBeenCalledWith({ sessionId: 'fixture-employee', id: 'owned' })
    expect(f.ctx.sessionController.create).toHaveBeenCalledWith({ hyperagentRoom: 'runtime' })
    expect(f.fresh.session.append).toHaveBeenCalledExactlyOnceWith('hivemind/hq-public-investigation', { enabled: false })
  })
  it('does not delete persisted state when an active owner cannot release its lease', async () => {
    const f = fixture()
    f.ctx.sessionController.releaseOwnedSessions.mockRejectedValueOnce(new Error('foreign_live_owner'))
    await expect(f.control.startFresh(f.agent, { confirmed: true })).rejects.toThrow('foreign_live_owner')
    expect(f.ctx.hivemindHqOwnership.resetFresh).not.toHaveBeenCalled()
    expect(f.ctx.sessionController.create).not.toHaveBeenCalled()
  })
  it('does not claim completion when recreated room persistence fails', async () => {
    const f = fixture()
    f.ctx.sessions.flush.mockResolvedValueOnce(false)
    await expect(f.control.startFresh(f.agent, { confirmed: true })).rejects.toThrow('fresh_reset_room_not_persisted')
    expect(f.ctx.hivemindHqOwnership.claim).not.toHaveBeenCalled()
  })
})
