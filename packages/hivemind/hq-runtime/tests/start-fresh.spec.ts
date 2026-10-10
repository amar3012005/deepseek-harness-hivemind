import { expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HqControl } from '../src/control.ts'
import { tourState } from '../src/tour.ts'

it('fresh start releases old rooms and restores a sleeping Runtime with the first-entry tour', async () => {
  const events: { type: string; data: unknown }[] = []
  const old = { id: 'runtime', session: {} } as Agent
  const fresh = { id: 'runtime', status: 'idle', inbox: { nextTurn: [], nextStep: [] },
    session: { append: (type: string, data: unknown) => events.push({ type, data }), snapshotEvents: () => events } } as unknown as Agent
  const resetFresh = vi.fn(async () => ({ sessions: 3, memories: 4 }))
  const releaseOwnedSessions = vi.fn(async () => {})
  const create = vi.fn(async () => ({ sessionId: 'runtime' }))
  const claim = vi.fn(async () => {})
  const ctx = { hivemindHqOwnership: { freshTargets: async () => ['runtime', 'sofia', 'monny'], resetFresh, claim },
    schedule: { catalog: async () => [] },
    sessionController: { releaseOwnedSessions, create, resolveAgent: async () => ({ agent: fresh }) },
    sessions: { flush: async () => true }, hivemindExecutionScope: { require: () => ({ orgId: 'company', userId: 'admin' }) } }
  const control = { ctx, root: () => old, mode: () => ({ revision: 4 }), setMode: vi.fn(async () => ({ ok: true })) }
  await expect(HqControl.prototype.startFresh.call(control as unknown as HqControl, old, { confirmed: false })).rejects.toThrow('confirmation_required')
  expect(resetFresh).not.toHaveBeenCalled()
  expect(await HqControl.prototype.startFresh.call(control as unknown as HqControl, old, { confirmed: true }))
    .toEqual({ sessions: 3, memories: 4 })
  expect(releaseOwnedSessions).toHaveBeenCalledWith(['runtime', 'sofia', 'monny'])
  expect(create).toHaveBeenCalledWith({ hyperagentRoom: 'runtime' })
  expect(claim).toHaveBeenCalledWith('runtime')
  expect(tourState(ctx as never, fresh)).toMatchObject({ step: 0, presentation: 'active', revision: 0, awakening: 'sleeping', running: false })
  expect(events).toContainEqual({ type: 'hivemind/hq-mode', data: expect.objectContaining({ enabled: false, revision: 0 }) })
})
