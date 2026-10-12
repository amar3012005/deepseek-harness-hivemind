/** File-backed Loader, native AgentLoop/Teams/Session/Tools/Persona and model request.
 * External model and persisted company directory/control reads are fixture-owned. */
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
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
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import * as Persona from '@deepseek-ai/dsh-persona'
import * as Hq from '../src/index.ts'
import { companyAwakeningSkill } from '../../runtime/src/awakening-guidance.ts'
import { submissionReviewSkill } from '../../runtime/src/review-guidance.ts'
import { nightlyRoutineSkill } from '../../runtime/src/nightly-routine-guidance.ts'
import ExecutionScope from '@deepseek-ai/dsh-hivemind-execution-scope'
import { TestSessionQuery } from '../../../experimental/agent-team/tests/test-session-query.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { dump } from 'js-yaml'
import { expect, it, vi } from 'vitest'
import Skills from '@deepseek-ai/dsh-skill'

it('admits current stage before the first model request, saves full history and skips social board reads through real Loader', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-stage-loader-'))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: join(dir, 'sessions') })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  let boardReads = 0
  await ctx.plugin(TeamService)
  const teamService = ctx.agentTeams
  await ctx.plugin(Skills)
  await ctx.plugin(ExecutionScope)
  ctx.provide('agentPresets', { serviceFor: (_agent: unknown, name: string & keyof Context) => ctx.get(name), composedPreset: () => undefined } as never)
  const scheduledWakes: { id: string; sessionId: string; title: string; prompt: string; scheduledAt: string; status: string }[] = []
  ctx.provide('schedule', { catalog: async () => scheduledWakes, ensure: async (sessionId: string, key: string, request: { title: string; prompt: string; at?: string; after_seconds?: number }) => {
    const wake = { id: `schedule-${createHash('sha256').update(`${sessionId}\0${key}`).digest('hex')}`, sessionId, title: request.title, prompt: request.prompt,
      scheduledAt: request.at ?? new Date(Date.now() + (request.after_seconds ?? 1) * 1000).toISOString(), status: 'active' }
    scheduledWakes.push(wake)
    return wake
  } } as never)
  ctx.provide('sessionController', {} as never)
  ctx.provide('hivemindEmployeeDirectory', { profiles: async () => ({ profiles: [] }) } as never)
  let hqEnabled = true
  ctx.provide('hivemindHq', { mode: () => ({ enabled: hqEnabled, revision: 0 }), setMode: async (_agent: unknown, request: { enabled: boolean }) => {
    hqEnabled = request.enabled
    return { ok: true }
  }, workspace: async (agent: Parameters<Context['agentTeams']['listTasks']>[0]) => {
    boardReads++
    return { mode: { enabled: hqEnabled, revision: 0, changedAt: 0 }, tasks: ctx.agentTeams.listTasks(agent), calendar: [], wakes: [] }
  } } as never)
  const calls = new Map<string, number>()
  const adapter = new MockAdapter(Array.from({ length: 80 }, () => (options) => {
    const id = String(options.sessionId ?? 'unknown')
    const call = (calls.get(id) ?? 0) + 1
    calls.set(id, call)
    if (call === 2) return toolCallResponse(`rest-${id}`, 'hivemind_hq_rest', {
      handoff_id: `fixture-${id}`, wake_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      summary: 'Fixture handoff for an authorized lifecycle test.', next_steps: ['Resume the verified fixture stage.'], blockers: [],
    })
    return textResponse(`Scripted model response ${id} ${call}.`)
  }))
  const dependencies = { name: 'stage-fixture', async apply(scope: Context) {
    scope.get('llm')!.registerAdapter(['mock'], adapter)
    for (const skill of [companyAwakeningSkill, submissionReviewSkill, nightlyRoutineSkill])
      scope.get('skills')!.register(skill)
    scope.get('tools')!.register(defineTool({ name: 'hivemind_research_answer', description: 'External search fixture; never called.', parameters: {}, output: { schema:{ type:'object',properties:{},additionalProperties:false },render:()=>[] }, execute: async () => { throw Error('unexpected external search') } }))
    scope.get('tools')!.register(defineTool({ name: 'fixture_employee_result', description: 'Fixture-owned external employee delivery.', parameters: {},
      output: { schema: { type:'object',properties:{},additionalProperties:true },render: (_args,result) => [{ type:'text',text:JSON.stringify(result) }] },
      execute: async (_args,execution) => {
        const agent = execution.agent!
        agent.session.append('hivemind/room-message-received', { id:'current-result',senderId:'employee-room',senderName:'Analyst',
          senderEmployee:'analyst',targetId:agent.id,kind:'update',text:'The submitted evidence is ready for review.',taskId:'task-1',artifactIds:[],hops:0 } as never)
        agent.send(createUserMessage({ source:{ kind:'hivemind-agent-message',form:'relay',messageId:'current-result',senderId:SessionId('employee-room'),senderSessionId:SessionId('employee-room') },
          content:[{ type:'text',text:'The submitted evidence is ready for review.' }] }), 'next-step', true)
        return { status:'delivered' }
      },
    }))
    scope.get('tools')!.register(defineTool({ name: 'fixture_inspection', description: 'Fixture-owned evidence inspection.', parameters: {},
      output: { schema: { type:'object',properties:{},additionalProperties:true },render: (_args,result) => [{ type:'text',text:JSON.stringify(result) }] },
      execute: async () => ({ status:'inspected' }),
    }))
  } }
  try {
    const persona: Persona.Config = { prefix: 'You are a helpful test Runtime.' }
    const configPath = join(dir, 'cordis.yml')
    await writeFile(configPath, dump([{ name: 'stage-fixture' }, { name: 'stage-hq' }]))
    ctx.baseUrl = pathToFileURL(dir).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([['stage-fixture', dependencies], ['stage-persona', Persona], ['stage-hq', Hq]])
    ctx.loader.internal = { version: 'v2', async import(specifier: string) { if (!modules.has(specifier)) throw Error(`unexpected module ${specifier}`); return modules.get(specifier) } } as never
    await ctx.loader.create({ name: 'cordis:include', config: { path: configPath } })
    await ctx.loader.await()
    const loadedPlugins = [...ctx.loader.entries()]
    expect(loadedPlugins.filter(entry => entry.options.name === 'stage-hq').map(entry => entry.fiber !== undefined)).toEqual([true])
    expect(loadedPlugins.filter(entry => entry.options.name === 'stage-fixture').map(entry => entry.fiber !== undefined)).toEqual([true])
    const agent = await ctx.agentLoop.create(SessionId('runtime-stage-fixture'), { provider: 'mock', model: 'mock' })
    await agent.ctx.plugin(Persona, persona)
    agent.session.append('agent-preset/selected', { agentPreset: 'hivemind-hq' })
    const membership = teamService?.tryMembership(agent)
    expect(membership?.role).toBe('lead')
    expect(membership?.root.id).toBe(agent.id)
    const assembled = await agent.ctx.systemPrompt.assemble({ scope: agent })
    expect(assembled.sections.some(section => section.name === 'hivemind-hq-runtime-policy'
      && section.text.includes('You are Runtime, the persistent AI Chief of Staff'))).toBe(true)
    expect(assembled.contexts.some(context => context.name === 'hivemind-hq-runtime-policy')).toBe(false)
    const original = createUserMessage({ source: { kind: 'hivemind-runtime-event', eventId: 'gmail-current', action: 'wake', form: 'notice', summary: 'Current deployment alert' }, content: [{ type: 'text', text: 'The release-readiness evidence has changed; inspect the current deployment alert.' }] })
    agent.send(original, 'next-turn', true)
    await vi.waitFor(() => { const failures = agent.session.snapshotEvents().filter(event => event.type === 'turn/end' && event.data.reason.kind === 'error'); expect(failures).toEqual([]); expect(adapter.requests, JSON.stringify(agent.session.snapshotEvents().map(event => ({ type:event.type,data:event.type==='turn/end'?event.data:{} })))).toHaveLength(3) })
    await vi.waitFor(() => expect(agent.status).toBe('idle'))
    const first = JSON.stringify(adapter.requests[0])
    expect(first).toContain('Inspect the admitted event')
    expect(first).toContain('runtime-attention-signal')
    expect(first).toContain('You are Runtime, the persistent AI Chief of Staff')
    expect(first).not.toContain(nightlyRoutineSkill.content.slice(0, 100))
    expect(agent.session.snapshotEvents().some(event => event.type === 'user/message'
      && event.data.source.kind === 'hivemind-hq-stage-skill'
      && event.data.source.skillName === 'runtime-attention-signal')).toBe(true)
    expect(agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === original.id)).toBe(true)
    expect(boardReads).toBe(2)
    const blockers = await ctx.get('hivemindExecutionScope')!.run({ orgId:'fixture-org',userId:'fixture-owner',
      profile:'hivemind-chat',variation:'hivemind-hq' }, () => ctx.get('tools')!.execute({
      name:'hivemind_hq_blocker',arguments:{ action:'list' },callId:ToolCallId('scoped-blocker-list'),
      agent,signal:new AbortController().signal,
    }))
    expect(blockers.isError, JSON.stringify(blockers.content)).toBe(false)
    expect(JSON.stringify(blockers.content)).toContain('blockers')
    const lifecycleCases = [
      { name: 'scheduled-wake', skill: 'runtime-scheduled-wake', source: { kind: 'schedule', deliveryKey: 'fixture-schedule-delivery' } },
      { name: 'delegation', skill: 'runtime-delegation', event: ['hivemind/employee-delegation-start', { delegationId: 'delegation-case', parentRun: { sessionId: 'placeholder' } }] },
      { name: 'agent-result-review', skill: 'runtime-submission-review', source: { kind: 'subagent-settled', agentId: 'employee-case' } },
      { name: 'approval-or-blocker-resume', skill: 'runtime-approval-blocker-resume', events: [
        ['approval/asked', { id: 'approval-case', callId: 'call-case', toolName: 'fixture_inspection' }],
        ['tool/call', { callId: 'call-case', name: 'fixture_inspection' }],
        ['approval/decided', { id: 'approval-case', outcome: 'allowed-once' }],
      ] },
      { name: 'rest-sleep', skill: 'runtime-rest-and-sleep', event: ['hivemind/hq-rest-confirmed', { handoffId: 'rest-case' }] },
      { name: 'voice-call-reconciliation', skill: 'runtime-voice-call-reconciliation',
        source: { kind: 'hivemind-live-voice', plugin: 'hivemind-live-voice', form: 'recall', voiceCallId: 'voice-case', authenticatedActor: { userId: 'owner', orgId: 'fixture-org', role: 'admin' } },
        event: ['hivemind/voice-call-ended', { callId: 'voice-case', authenticatedActor: { userId: 'owner', orgId: 'fixture-org', role: 'admin' } }] },
      { name: 'awakening', skill: 'runtime-company-awakening', source: { kind: 'user' } },
      { name: 'nightly-reconciliation', skill: 'hivemind-nightly-routine-check', source: { kind: 'schedule' } },
    ] as const
    for (const [index, stage] of lifecycleCases.entries()) {
      const sessionId = `runtime-stage-${stage.name}`
      const stagedAgent = await ctx.agentLoop.create(SessionId(sessionId), { provider: 'mock', model: 'mock' })
      await stagedAgent.ctx.plugin(Persona, persona)
      stagedAgent.session.append('agent-preset/selected', { agentPreset: 'hivemind-hq' })
      const events = 'events' in stage ? stage.events : 'event' in stage ? [stage.event] : []
      const source = 'source' in stage && stage.source ? stage.source : { kind: 'user' }
      if (stage.name === 'nightly-reconciliation') {
        const scheduleId = `schedule-${createHash('sha256').update(`${sessionId}\0nightly-routine-check-v1`).digest('hex')}`
        const occurrence = '2026-10-11T18:00:00.000Z'
        stagedAgent.send(createUserMessage({ source: source as never,
          content: [{ type: 'text', text: `Nightly report\nreminders_json: ${JSON.stringify([{ schedule_id: scheduleId, occurrence_at: occurrence }])}` }] }), 'next-turn', true)
      } else {
        const text = stage.name === 'awakening' ? 'Wake up, Chief!' : `Continue the verified ${stage.name} work.`
        stagedAgent.send(createUserMessage({ source: source as never, content: [{ type: 'text', text }] }), 'next-turn', true)
      }
      if (events.length) {
        await vi.waitFor(() => expect(stagedAgent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(true))
        for (const [type, data] of events) {
          const payload = type === 'hivemind/employee-delegation-start'
            ? { ...(data as object), parentRun: { sessionId: stagedAgent.id } } : data
          const appendFixtureEvent = stagedAgent.session.append.bind(stagedAgent.session) as (
            eventType: string, eventData: unknown,
          ) => unknown
          appendFixtureEvent(type, payload)
        }
      }
      const requestIndex = 3 + index * 3
      await vi.waitFor(() => {
        const failures = stagedAgent.session.snapshotEvents().filter(event => event.type === 'turn/end' && event.data.reason.kind === 'error')
        expect(failures, `${stage.name}: ${JSON.stringify(failures)}`).toEqual([])
        expect(adapter.requests).toHaveLength(requestIndex + (stage.name === 'nightly-reconciliation' ? 1 : 3))
      })
      await vi.waitFor(() => expect(stagedAgent.status).toBe('idle'))
      expect(JSON.stringify(adapter.requests[requestIndex])).toContain(stage.skill)
      expect(JSON.stringify(adapter.requests[requestIndex])).toContain('You are Runtime, the persistent AI Chief of Staff')
      expect(stagedAgent.session.snapshotEvents().some(event => event.type === 'user/message'
        && event.data.source.kind === 'hivemind-hq-stage-skill' && event.data.source.skillName === stage.skill)).toBe(true)
    }
    agent.send(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }), 'next-turn', true)
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(3 + 7 * 3 + 1 + 1))
    await vi.waitFor(() => expect(agent.status).toBe('idle'))
    expect(boardReads).toBeGreaterThanOrEqual(2)
    const socialStart = agent.session.snapshotEvents().findLast(event => event.type === 'turn/start')!.seq
    expect(agent.session.snapshotEvents().some(event => event.seq > socialStart && event.type === 'user/message'
      && event.data.source.kind === 'hivemind-hq-stage-skill')).toBe(false)
    expect(ctx.tools.get('hivemind_hq_rest')).toBeDefined()
    await ctx.fiber.dispose()
    expect(ctx.get('tools')).toBeUndefined()
  } finally { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }) }
}, 30_000)
