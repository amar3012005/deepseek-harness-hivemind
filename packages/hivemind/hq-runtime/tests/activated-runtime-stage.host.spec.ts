/** Authenticated progressive stage loading through the same Loader topology used by the host. */
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import TeamService from '@deepseek-ai/dsh-experimental-agent-team'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as Persona from '@deepseek-ai/dsh-persona'
import Skills from '@deepseek-ai/dsh-skill'
import ExecutionScope from '@deepseek-ai/dsh-hivemind-execution-scope'
import { TestSessionQuery } from '../../../experimental/agent-team/tests/test-session-query.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import * as Hq from '../src/index.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { dump } from 'js-yaml'
import { expect, it, vi } from 'vitest'

it('loads the authenticated attention stage before the first Runtime model request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hq-activated-stage-'))
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root: join(dir, 'sessions') })
    await ctx.plugin(TestSessionQuery)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Subagents)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    await ctx.plugin(SubagentFork, { providerName: 'fork' })
    await ctx.plugin(TeamService)
    await ctx.plugin(Skills)
    await ctx.plugin(ExecutionScope)
    ctx.provide('agentPresets', { serviceFor: (_agent: unknown, name: string & keyof Context) => ctx.get(name), composedPreset: () => undefined } as never)
    ctx.provide('schedule', { catalog: async () => [] } as never)
    ctx.provide('sessionController', {} as never)
    ctx.provide('hivemindEmployeeDirectory', { profiles: async () => ({ profiles: [] }) } as never)
    ctx.provide('hivemindHq', { mode: () => ({ enabled: false }), workspace: async (agent: Parameters<Context['agentTeams']['listTasks']>[0]) => ({
      mode: { enabled: true, revision: 0, changedAt: 0 }, tasks: ctx.agentTeams.listTasks(agent), calendar: [], wakes: [],
    }) } as never)

    const adapter = new MockAdapter([textResponse('I will inspect the admitted company signal.')])
    const stageBody = 'Authenticated attention stage body from this fixture.'
    const dependencies = { name: 'activated-stage-fixture', async apply(scope: Context) {
      scope.get('llm')!.registerAdapter(['mock'], adapter)
      scope.get('skills')!.register({ name: 'runtime-attention-signal', source: 'runtime', description: 'Fixture attention stage',
        invocation: { modelInvocable: false, userInvocable: false }, content: stageBody })
      scope.get('tools')!.register(defineTool({ name: 'hivemind_research_answer', description: 'Unknown research boundary is closed in this fixture.',
        parameters: {}, output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [] },
        async execute() { throw new Error('unexpected_fixture_research') },
      }))
    } }
    const configPath = join(dir, 'cordis.yml')
    await writeFile(configPath, dump([{ name: 'activated-stage-fixture' }, { name: 'activated-stage-hq' }]))
    ctx.baseUrl = pathToFileURL(dir).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([['activated-stage-fixture', dependencies], ['stage-persona', Persona], ['activated-stage-hq', Hq]])
    ctx.loader.internal = { version: 'v2', async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected fixture module ${specifier}`)
      return modules.get(specifier)
    } } as never
    await ctx.loader.create({ name: 'cordis:include', config: { path: configPath } })
    await ctx.loader.await()
    const loaded = [...ctx.loader.entries()]
    expect(loaded.filter(entry => entry.options.name === 'activated-stage-hq').map(entry => entry.fiber !== undefined)).toEqual([true])
    expect(loaded.filter(entry => entry.options.name === 'activated-stage-fixture').map(entry => entry.fiber !== undefined)).toEqual([true])

    const agent = await ctx.agentLoop.create(SessionId('activated-hq-runtime'), { provider: 'mock', model: 'mock' })
    await agent.ctx.plugin(Persona, { prefix: 'You are Runtime, a scoped company Chief of Staff fixture.' })
    agent.session.append('agent-preset/selected', { agentPreset: 'hivemind-hq' })
    const membership = ctx.agentTeams.tryMembership(agent)
    expect(membership?.role).toBe('lead')
    expect(membership?.root.id).toBe(agent.id)

    const admitted = createUserMessage({
      source: { kind: 'hivemind-runtime-event', eventId: 'attention-fixture-1', action: 'wake', form: 'notice', summary: 'Review a new company signal' },
      content: [{ type: 'text', text: 'Inspect the admitted signal and choose the next authorized action.' }],
    })
    agent.send(admitted, 'next-turn', true)
    await vi.waitFor(() => {
      const failures = agent.session.snapshotEvents().filter(event => event.type === 'turn/end' && event.data.reason.kind === 'error')
      expect(failures, JSON.stringify(failures)).toEqual([])
      expect(adapter.requests).toHaveLength(1)
    })
    await vi.waitFor(() => expect(agent.status).toBe('idle'))
    const request = JSON.stringify(adapter.requests[0])
    expect(request).toContain('runtime-attention-signal')
    expect(request).toContain(stageBody)
    expect(request).toContain('Inspect the admitted signal')
    expect(agent.session.snapshotEvents().some(event => event.type === 'user/message'
      && event.data.source.kind === 'hivemind-hq-stage-skill'
      && event.data.source.skillName === 'runtime-attention-signal')).toBe(true)
    expect(agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === admitted.id)).toBe(true)
  } finally {
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}, 30_000)
