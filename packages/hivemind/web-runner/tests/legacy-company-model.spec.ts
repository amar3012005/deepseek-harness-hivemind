import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { foldSurface } from '@deepseek-ai/dsh-session'
import { migrateLegacyCompanyModel, installLegacyCompanyModelMigration } from '../src/legacy-company-model.ts'

function fixture(preset = 'hivemind-hyperagents', provider = 'openai-codex') {
  const session = Session.create(SessionId('same-mimi-room'))
  session.append('request/header', { header: { config: { provider, model: 'saved-gpt' } }, reason: 'initial' } as never)
  let pending: unknown = null
  const selected = vi.fn((_agent, model) => { pending = model; session.append('model/selection', model) })
  const flush = vi.fn(async () => true)
  const registered = ['platform-route']
  const resolve = vi.fn(async model => model)
  const ctx = {
    sessionProjections: { stateOf: (_session: unknown, key: string) => key === 'agentPreset' ? preset : { pending } },
    sessionController: {
      currentDefaultModelSelection: () => ({ provider: 'platform-route', model: 'platform-model' }), selectForAdmittedRequest: selected,
    },
    llm: { listProviders: () => registered.map(id => ({ id })), resolveCallConfig: resolve },
    sessions: { flush },
  } as unknown as Context
  return { ctx, agent: { session } as never, session, selected, flush, registered, resolve,
    setPending: (value: unknown) => { pending = value },
  }
}
it('durably migrates the same legacy company room without changing history or global settings', async () => {
  const f = fixture()
  const original = f.session.snapshotEvents()
  expect(await migrateLegacyCompanyModel(f.ctx, f.agent, new AbortController().signal)).toBe(true)
  expect(f.selected).toHaveBeenCalledWith(f.agent, { provider: 'platform-route', model: 'platform-model' })
  expect(f.flush).toHaveBeenCalledOnce()
  expect(f.session.snapshotEvents().slice(0, original.length)).toEqual(original)
  expect(f.session.snapshotEvents().at(-1)?.type).toBe('model/selection')
  const cold = Session.create(SessionId('same-restored-room'), f.session.snapshotEvents())
  expect(cold.snapshotEvents().find(event => event.type === 'model/selection')).toEqual(f.session.snapshotEvents().at(-1))
  expect(foldSurface(cold.snapshotEvents()).nodes).toEqual(foldSurface(f.session.snapshotEvents()).nodes)
  expect(await migrateLegacyCompanyModel(f.ctx, f.agent, new AbortController().signal)).toBe(false)
})
it('preserves generic native unavailable routes, live providers and every explicit pending choice', async () => {
  for (const [preset, provider] of [['standard', 'openai-codex'], ['hivemind-hyperagents', 'custom-unavailable'], ['hivemind-hq', 'valid']]) {
    const f = fixture(preset, provider)
    expect(await migrateLegacyCompanyModel(f.ctx, f.agent, new AbortController().signal)).toBe(false)
    expect(f.selected).not.toHaveBeenCalled()
  }
  const live = fixture(); live.registered.push('openai-codex')
  expect(await migrateLegacyCompanyModel(live.ctx, live.agent, new AbortController().signal)).toBe(false)
  const pending = fixture(); pending.setPending({ provider: 'user-choice', model: 'picked' })
  expect(await migrateLegacyCompanyModel(pending.ctx, pending.agent, new AbortController().signal)).toBe(false)
  expect(pending.selected).not.toHaveBeenCalled()
})
it('requires a registered default and preserves a choice that arrives during route validation', async () => {
  const absent = fixture(); absent.registered.length = 0
  expect(await migrateLegacyCompanyModel(absent.ctx, absent.agent, new AbortController().signal)).toBe(false)
  const raced = fixture(); raced.resolve.mockImplementation(async (model) => { raced.setPending({ provider: 'picked', model: 'picked' }); return model })
  expect(await migrateLegacyCompanyModel(raced.ctx, raced.agent, new AbortController().signal)).toBe(false)
  expect(raced.selected).not.toHaveBeenCalled()
})
it('does not enter execution after interrupted persistence or cancelled admission', async () => {
  const f = fixture(); f.flush.mockResolvedValue(false)
  await expect(migrateLegacyCompanyModel(f.ctx, f.agent, new AbortController().signal)).rejects.toThrow('persistence_required')
  const controller = new AbortController(); controller.abort()
  await expect(migrateLegacyCompanyModel(f.ctx, f.agent, controller.signal)).rejects.toThrow()
})

it('leaves rejected native admission unchanged and migrates only an admitted step', async () => {
  const f = fixture()
  let hook!: (input: unknown, next: () => Promise<unknown>) => Promise<unknown>
  const scope = Object.assign(f.ctx, {
    effect: (effect: () => unknown) => effect(),
    on: (_name: string, callback: typeof hook) => { hook = callback; return () => {} },
    inject: (_services: unknown, callback: (value: Context) => void) => callback(scope as unknown as Context),
  })
  installLegacyCompanyModelMigration(scope as unknown as Context)
  const input = { agent: f.agent, signal: new AbortController().signal }
  expect(await hook(input, async () => ({ kind: 'reject' }))).toEqual({ kind: 'reject' })
  expect(f.selected).not.toHaveBeenCalled()
  expect(await hook(input, async () => ({ kind: 'enter', messages: [] }))).toEqual({ kind: 'enter', messages: [] })
  expect(f.selected).toHaveBeenCalledOnce()
})

it('flushes migration through real Cordis declared injection instead of an unrestricted mock scope', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: SessionStore } = await import('@deepseek-ai/dsh-session')
  const root = new Context()
  await root.plugin(SessionStore)
  const f = fixture()
  root.provide('sessionProjections', f.ctx.sessionProjections)
  root.provide('sessionController', f.ctx.sessionController)
  root.provide('llm', f.ctx.llm)
  const session = root.sessions.create(SessionId('same-native-mimi-room'))
  session.append('request/header', { header: { config: { provider: 'openai-codex', model: 'saved-gpt' } }, reason: 'initial' } as never)
  const agent = { session } as never
  let flushes = 0
  root.on('session/flush', () => { flushes++ }, { global: true })
  try {
    const broken = await root.plugin({ name: 'old-company-migration-scope',
      inject: ['sessionController', 'llm', 'sessionProjections'], apply() {},
    })
    expect(() => broken.ctx.sessions.flush(session)).toThrow('cannot get property "sessions" without inject')
    await broken.dispose()
    await root.plugin({ name: 'declared-company-migration-scope', apply: installLegacyCompanyModelMigration })
    const decision = await root.waterfall('agent/pre-step', {
      agent, signal: new AbortController().signal, turn: 1, step: 1, messages: [],
    } as never, async () => ({ kind: 'enter' as const, messages: [] }))
    expect(decision.kind).toBe('enter')
    expect(f.selected).toHaveBeenCalledOnce()
    expect(flushes).toBe(1)
  } finally { await root.fiber.dispose() }
})
