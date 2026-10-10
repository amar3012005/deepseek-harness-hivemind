import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { expect, it, vi } from 'vitest'
import { ApiSessionList } from '../src/list.ts'
it('reuses same-list scoped navigation facts and only asks fallback providers for missing rows', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore); await ctx.plugin(SessionProjectionRegistry)
  const facts = { agentPreset: 'hivemind-hq', started: true }
  const record = (id: string, navigation?: typeof facts) => ({ header: { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1, cwd: '/fixture', isSeeded: false }, live: false, persisted: true, ...(navigation === undefined ? {} : { navigation }) })
  const records = [record('runtime', facts)]
  const effectivePresets = vi.fn(async () => new Map()), startedSessions = vi.fn(async () => new Set())
  ctx.provide('sessionQuery', { listSessions: async () => records } as never)
  ctx.provide('sessionPersistence', { effectivePresets, startedSessions } as never)
  const list = new ApiSessionList(ctx)
  try {
    expect(await list.list()).toMatchObject([{ agentPreset: 'hivemind-hq', blank: false }])
    expect(effectivePresets).not.toHaveBeenCalled(); expect(startedSessions).not.toHaveBeenCalled()
    records.push(record('fallback'))
    expect(await list.list()).toMatchObject([{ blank: false }, { blank: true }])
    expect(effectivePresets).toHaveBeenCalledWith([SessionId('fallback')], undefined)
    expect(startedSessions).toHaveBeenCalledWith([SessionId('fallback')], undefined)
  } finally { await ctx.fiber.dispose() }
})
