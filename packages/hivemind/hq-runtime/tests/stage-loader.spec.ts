/** File-backed Loader, native AgentLoop/Teams/Session/Tools/Persona and model request.
 * External model and persisted company directory/control reads are fixture-owned. */
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Subagents from '@deepseek-ai/dsh-subagent'
import TeamService from '@deepseek-ai/dsh-experimental-agent-team'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as Persona from '@deepseek-ai/dsh-persona'
import * as Hq from '../src/index.ts'
import { TestSessionQuery } from '../../../experimental/agent-team/tests/test-session-query.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { load, DEFAULT_SCHEMA, Type, dump } from 'js-yaml'
import { expect, it, vi } from 'vitest'

it('admits current stage before the first model request, saves full history and skips social board reads through real Loader', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-stage-loader-'))
  const ctx = new Context()
  let boardReads = 0
  const adapter = new MockAdapter([textResponse('I will inspect the current deployment evidence.'), textResponse('Hello!')])
  const dependencies = { name: 'stage-fixture', async apply(scope: Context) {
    await mountAgentLoopTestDependencies(scope)
    await scope.plugin(JsonlSessionPersistence, { root: join(dir, 'sessions') })
    await scope.plugin(TestSessionQuery)
    await scope.plugin(AgentLoop, { agents: [] })
    await scope.plugin(Subagents)
    scope.provide('agentPresets', { serviceFor: (_agent: unknown, name: string & keyof Context) => scope.get(name), composedPreset: () => undefined } as never)
    await scope.plugin(TeamService)
    scope.provide('schedule', { catalog: async () => [] } as never)
    scope.provide('sessionController', {} as never)
    scope.provide('hivemindEmployeeDirectory', { profiles: async () => ({ profiles: [] }) } as never)
    scope.provide('hivemindHq', { mode: () => ({ enabled: false }), workspace: async (agent: Parameters<Context['agentTeams']['listTasks']>[0]) => {
      boardReads++
      return { mode: { enabled: false, revision: 0, changedAt: 0 }, tasks: scope.get('agentTeams')!.listTasks(agent), calendar: [], wakes: [] }
    } } as never)
    scope.get('llm')!.registerAdapter(['mock'], adapter)
    scope.get('tools')!.register(defineTool({ name: 'hivemind_research_answer', description: 'External search fixture; never called.', parameters: {}, output: { schema:{ type:'object',properties:{},additionalProperties:false },render:()=>[] }, execute: async () => { throw Error('unexpected external search') } }))
  } }
  try {
    const schema = DEFAULT_SCHEMA.extend(new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value }))
    const preset = load(await readFile(new URL('../../../preset/agent-presets/presets/hivemind-hq/agent.cordis.yml', import.meta.url), 'utf8'), { schema }) as { id: string; config: { patches: { id: string; config: Persona.Config }[] } }[]
    const persona = preset.find(row => row.id === 'hivemind-chat-base')!.config.patches.find(row => row.id === 'persona')!.config
    const configPath = join(dir, 'cordis.yml')
    await writeFile(configPath, dump([{ name: 'stage-fixture' }, { name: 'stage-hq' }]))
    ctx.baseUrl = pathToFileURL(dir).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([['stage-fixture', dependencies], ['stage-persona', Persona], ['stage-hq', Hq]])
    ctx.loader.internal = { version: 'v2', async import(specifier: string) { if (!modules.has(specifier)) throw Error(`unexpected module ${specifier}`); return modules.get(specifier) } } as never
    await ctx.loader.create({ name: 'cordis:include', config: { path: configPath } })
    await ctx.loader.await()
    const agent = await ctx.agentLoop.create(SessionId('runtime-stage-fixture'), { provider: 'mock', model: 'mock' })
    await agent.ctx.plugin(Persona, persona)
    agent.session.append('agent-preset/selected', { agentPreset: 'hivemind-hq' })
    const original = createUserMessage({ source: { kind: 'hivemind-runtime-event', eventId: 'gmail-current', action: 'wake', form: 'notice', summary: 'Current deployment alert' }, content: [{ type: 'text', text: 'The release-readiness evidence has changed; inspect the current deployment alert.' }] })
    agent.send(original, 'next-turn', true)
    await vi.waitFor(() => { const failures = agent.session.snapshotEvents().filter(event => event.type === 'turn/end' && event.data.reason.kind === 'error'); expect(failures).toEqual([]); expect(adapter.requests, JSON.stringify(agent.session.snapshotEvents().map(event => ({ type:event.type,data:event.type==='turn/end'?event.data:{} })))).toHaveLength(1) })
    await vi.waitFor(() => expect(agent.status).toBe('idle'))
    const first = JSON.stringify(adapter.requests[0])
    expect(first).toContain('Company signal:')
    expect(first).toContain('our company')
    expect(first).toContain('Prepare and inspect authorized concrete work')
    expect(first).not.toContain('Current Nightly report:')
    expect(agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === original.id)).toBe(true)
    expect(boardReads).toBe(1)
    agent.send(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }), 'next-turn', true)
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(2))
    await vi.waitFor(() => expect(agent.status).toBe('idle'))
    expect(boardReads).toBe(1)
    expect(ctx.tools.get('hivemind_hq_rest')).toBeDefined()
    await ctx.fiber.dispose()
    expect(ctx.get('tools')).toBeUndefined()
  } finally { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }) }
}, 30_000)
