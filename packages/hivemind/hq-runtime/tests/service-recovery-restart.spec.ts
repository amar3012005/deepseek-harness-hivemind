/** Isolated native AgentLoop/JSONL/Schedule persistence restart proof. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import ScheduleService from '@deepseek-ai/dsh-schedule'
import { expect, it, vi } from 'vitest'
// Single-process proof: mock only unavailable Darwin advisory-lock syscall, not persistence or delivery.
vi.mock('@deepseek-ai/node-addon-system/flock', () => ({ tryLockExclusive: async () => {}, unlock: async () => {} }))
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { installServiceRecovery } from '../src/service-recovery.ts'

it('restores a crash-repaired native session and delivers one persisted recovery occurrence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hq-recovery-proof-'))
  const contexts: Context[] = []
  const id = SessionId('isolated-restart-owner')
  const adapter = new MockAdapter([textResponse('I’m continuing the saved work.')])
  async function open() {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: join(root, 'schedule') })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    ctx.provide('sessionController', { resolveAgent: async () => {
      const agent = ctx.agents.get(id)
      if (!agent) throw new Error('agent not restored yet')
      return { agent }
    } } as never)
    await ctx.plugin(ScheduleService)
    installServiceRecovery(ctx)
    return ctx
  }
  try {
    const first = await open()
    const agent = (await first.agents.create({ sessionId: id })).agent
    agent.session.append('agent-preset/selected', { agentPreset: 'hivemind-hq' })
    agent.session.append('hivemind/hq-mode', { revision: 1, enabled: true, changedAt: Date.now() })
    agent.session.append('turn/start', { turn: 0 })
    agent.session.append('step/start', { turn: 0, step: 0 })
    await first.sessions.flush(agent.session)
    const prompt = '[HIVEMIND SERVICE RECOVERY]\n' + JSON.stringify({ sessionId: id, rootId: id, turn: 0, modeRevision: 1 }) + '\nResume saved work.'
    const saved = await first.schedule.ensure(id, 'hivemind-service-recovery-turn-0', {
      title: 'Service interruption recovery', after_seconds: 1, prompt,
    })
    await first.fiber.dispose()
    const second = await open()
    const restored = (await second.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })).agent
    expect(restored.session.ownEvents().some(event => event.type === 'turn/end' && event.data.reason.kind === 'interrupted')).toBe(true)
    const inserted = Promise.withResolvers<undefined>()
    second.on('agent/inbox/inserted', ({ message }) => { if (message.source.kind === 'schedule') inserted.resolve(undefined) })
    {
      await Promise.race([inserted.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('no persisted recovery delivery')), 4000))])
      await second.sessions.flush(restored.session)
      const deliveries = restored.session.ownEvents().flatMap(event => event.type === 'agent/inbox/spliced'
        ? event.data.inserted.filter(message => message.source.kind === 'schedule') : [])
      expect(deliveries).toHaveLength(1)
      expect(deliveries[0]?.source.kind).toBe('schedule')
      await expect.poll(async () => (await second.schedule.catalog()).find(row => row.id === saved.id)?.status).toBe('inactive')
      await expect.poll(() => restored.session.ownEvents().filter(event => event.type === 'assistant/message').length).toBe(1)
      expect(adapter.requests).toHaveLength(1)
      await restored.whenIdle()
      await second.fiber.dispose()
      const third = await open()
      const again = (await third.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })).agent
      expect((await third.schedule.catalog()).find(row => row.id === saved.id)?.status).toBe('inactive')
      expect(again.session.ownEvents().filter(event => event.type === 'assistant/message')).toHaveLength(1)
      expect(adapter.requests).toHaveLength(1)
    }
  } finally {
    for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 10000)
