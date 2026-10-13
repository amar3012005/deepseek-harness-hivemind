/** File-backed Loader, native AgentLoop/Teams/Session/Tools/Persona and model request.
 * External model and persisted company directory/control reads are fixture-owned. */
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Subagents from '@deepseek-ai/dsh-subagent'
import TeamService from '@deepseek-ai/dsh-experimental-agent-team'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import LocalAttachmentStore from '../../../attachment/attachment-local/src/index.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import * as Persona from '@deepseek-ai/dsh-persona'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { companyAwakeningSkill } from '../../runtime/src/awakening-guidance.ts'
import * as Hq from '../src/index.ts'
import { contextPlugin } from '../../context/src/index.ts'
import { installNightlyRoutineGuidance } from '../../runtime/src/nightly-routine-guidance.ts'
import ExecutionScope from '@deepseek-ai/dsh-hivemind-execution-scope'
import { TestSessionQuery } from '../../../experimental/agent-team/tests/test-session-query.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { load, DEFAULT_SCHEMA, Type, dump } from 'js-yaml'
import { expect, it, vi } from 'vitest'

it('admits current stage before the first model request, saves full history and skips social board reads through real Loader', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-stage-loader-'))
  const ctx = new Context()
  let boardReads = 0
  let parallelReads = false
  let activeReads = 0
  let maxActiveReads = 0
  let releaseReads = () => {}
  const parallelGate = new Promise<void>((resolve) => { releaseReads = resolve })
  const parallelBatch: StreamChunk[] = ['parallel-list-one', 'parallel-list-two'].flatMap((id, index) =>
    toolCallResponse(id, 'hivemind_hq_contract', { action: 'list' })
      .filter(chunk => chunk.type !== 'finish' && chunk.type !== 'usage')
      .map(chunk => 'index' in chunk ? { ...chunk, index } : chunk))
  parallelBatch.push({ type: 'finish', reason: { kind: 'stop' } })
  let awakeningBody: string = companyAwakeningSkill.content
  const adapter = new MockAdapter([textResponse('I will inspect the current deployment evidence.'), textResponse('Hello!'), textResponse('I will continue our authorized preparation.'),
    toolCallResponse('receive-current-result', 'fixture_employee_result', {}),
    toolCallResponse('inspect-current-result', 'fixture_inspection', {}), textResponse('I reviewed the saved contribution.'),
    textResponse('I will request the current daily evidence.'), textResponse('I will reconcile the saved daily reply.'), toolCallResponse('awakening-first-read', 'fixture_inspection', {}),
    toolCallResponse('awakening-second-read', 'fixture_inspection', {}), textResponse('I will orient using the complete awakening method.'),
    textResponse('I will continue the same method.'), textResponse('I will use the updated method.'), parallelBatch, textResponse('I read both saved pages.')])
  const dependencies = { name: 'stage-fixture', async apply(scope: Context) {
    await mountAgentLoopTestDependencies(scope)
    await scope.plugin(LocalAttachmentStore, { dshHome: dir })
    await scope.plugin(ExecutionScope)
    await scope.plugin(SkillRegistry)
    scope.get('skills')!.registerProvider(() => ({ name:'awakening-fixture-provider',
      list:async()=>[{ ...companyAwakeningSkill, provider:'awakening-fixture-provider', rank:1, locator:null }],
      get:async()=>({ ...companyAwakeningSkill,provider:'awakening-fixture-provider',content:awakeningBody }),
    }))
    await scope.plugin(JsonlSessionPersistence, { root: join(dir, 'sessions') })
    await scope.plugin(TestSessionQuery)
    await scope.plugin(AgentLoop, { agents: [] })
    await scope.plugin(Subagents)
    scope.provide('agentPresets', { serviceFor: (_agent: unknown, name: string & keyof Context) => scope.get(name), composedPreset: () => undefined } as never)
    await scope.plugin(TeamService)
    scope.provide('schedule', { catalog: async () => [] } as never)
    scope.provide('sessionController', {} as never)
    scope.provide('hivemindEmployeeDirectory', { profiles: async () => {
      if (parallelReads) {
        activeReads++
        maxActiveReads = Math.max(maxActiveReads, activeReads)
        if (activeReads === 2) releaseReads()
        await parallelGate
        activeReads--
      }
      return { profiles: [] }
    } } as never)
    scope.provide('hivemindHq', { mode: () => ({ enabled: false }), workspace: async (agent: Parameters<Context['agentTeams']['listTasks']>[0]) => {
      boardReads++
      return { mode: { enabled: false, revision: 0, changedAt: 0 }, tasks: scope.get('agentTeams')!.listTasks(agent), calendar: [], wakes: [] }
    } } as never)
    scope.get('llm')!.registerAdapter(['mock'], adapter)
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
    const blockers = await ctx.get('hivemindExecutionScope')!.run({ orgId:'fixture-org',userId:'fixture-owner',
      profile:'hivemind-chat',variation:'hivemind-hq' }, () => ctx.get('tools')!.execute({
      name:'hivemind_hq_blocker',arguments:{ action:'list' },callId:ToolCallId('scoped-blocker-list'),
      agent,signal:new AbortController().signal,
    }))
    expect(blockers.isError, JSON.stringify(blockers.content)).toBe(false)
    expect(JSON.stringify(blockers.content)).toContain('blockers')
    agent.send(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }), 'next-turn', true)
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(2))
    await vi.waitFor(() => expect(agent.status).toBe('idle'))
    expect(boardReads).toBe(1)
    const actor = { userId:'fixture-owner',orgId:'fixture-org',role:'owner',name:'Owner' }
    agent.session.append('hivemind/voice-call-ended', { callId:'saved-admin-call',provider:'codex',
      initialCheckIn:false,interrupted:false,hadUserSpeech:true,transcript:'user: Existing customers first.',authenticatedActor:actor })
    agent.send(createUserMessage({ source:{ kind:'plugin',plugin:'hivemind-live-voice',form:'recall',
      voiceCallId:'saved-admin-call',authenticatedActor:actor },content:[{ type:'text',text:'Reconcile this saved administrator conversation.' }] }), 'next-turn', true)
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(3))
    await vi.waitFor(() => expect(agent.status).toBe('idle'))
    expect(JSON.stringify(adapter.requests[2])).toContain('Administrator call follow-up:')
    expect(JSON.stringify(adapter.requests[2])).toContain('continue already authorized preparation, planning, delegation and review')
    expect(boardReads).toBe(2)
    const turnCount = agent.session.snapshotEvents().filter(event => event.type === 'turn/start').length
    agent.send(createUserMessage({ source:{ kind:'user' },content:[{ type:'text',text:'Review the next returned evidence and continue our internal work.' }] }), 'next-turn', true)
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(6))
    await vi.waitFor(() => expect(agent.status).toBe('idle'))
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(turnCount + 1)
    expect(JSON.stringify(adapter.requests[3])).not.toContain('Employee result or blocker:')
    expect(JSON.stringify(adapter.requests[3])).toContain('do not ask which people when that scope is already clear')
    expect(JSON.stringify(adapter.requests[3])).toContain('batch independent concurrency-safe reads in one step')
    expect(JSON.stringify(adapter.requests[3])).toContain('Choose routine reversible details yourself')
    expect(JSON.stringify(adapter.requests[4])).toContain('Employee result or blocker:')
    expect(JSON.stringify(adapter.requests[4])).toContain('Advance the next eligible dependency after review')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin' && event.data.source.plugin === 'hivemind-hq/stage-guidance')).toHaveLength(1)
    expect(boardReads).toBe(3)
    const occurrenceAt = '2026-10-11T04:25:00Z'
    const scheduleId = 'schedule-' + createHash('sha256').update(`${agent.id}\0nightly-routine-check-v1`).digest('hex')
    agent.send(createUserMessage({ source:{ kind:'schedule',occurrenceAt },content:[{ type:'text',text:'reminders_json: '+JSON.stringify([{ schedule_id:scheduleId,occurrence_at:occurrenceAt }]) }] }), 'next-turn', true)
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(7))
    await vi.waitFor(() => expect(agent.status).toBe('idle'))
    agent.session.append('hivemind/room-message-queued', { id:'daily-request',senderId:agent.id,senderName:'Runtime',senderEmployee:'runtime',
      targetId:SessionId('employee-room'),kind:'question',text:'NIGHTLY_REVIEW_REQUEST='+JSON.stringify({ occurrence:occurrenceAt,agent_index:1 }),artifactIds:[],hops:0 })
    agent.session.append('hivemind/room-message-received', { id:'daily-reply',senderId:SessionId('employee-room'),senderName:'Analyst',senderEmployee:'analyst',
      targetId:agent.id,kind:'reply',replyTo:'daily-request',text:'Saved daily diagnostics.',artifactIds:[],hops:0 })
    agent.send(createUserMessage({ source:{ kind:'hivemind-agent-message',form:'relay',messageId:'daily-reply',senderId:SessionId('employee-room'),senderSessionId:SessionId('employee-room') },
      content:[{ type:'text',text:'Saved daily diagnostics.' }] }), 'next-turn', true)
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(8))
    await vi.waitFor(() => expect(agent.status).toBe('idle'))
    const replyTurnStart = agent.session.snapshotEvents().findLast(event => event.type === 'turn/start')!.seq
    const replyStage = agent.session.snapshotEvents().findLast(event => event.seq > replyTurnStart && event.type === 'user/message'
      && event.data.source.kind === 'plugin' && event.data.source.plugin === 'hivemind-hq/wake-briefing')
    expect(JSON.stringify(replyStage)).toContain('Current Nightly report:')
    expect(JSON.stringify(adapter.requests[7])).toContain('Current Nightly report:')
    expect(JSON.stringify(adapter.requests[7])).toContain('ordinary detailed email')
    expect(boardReads).toBe(5)
    agent.session.append('hivemind/hq-awakening-start', { version:1, turn:7, startedAt:new Date().toISOString() })
    agent.send(createUserMessage({ source:{ kind:'user' },content:[{ type:'text',text:'Orient us using the unfinished awakening.' }] }), 'next-turn', true)
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(11))
    await vi.waitFor(() => expect(agent.status).toBe('idle'))
    expect(JSON.stringify(adapter.requests[8])).toContain(JSON.stringify(companyAwakeningSkill.content).slice(1,-1))
    expect(JSON.stringify(adapter.requests[8])).toContain('Initial orientation:')
    const copies = (request: unknown, body: string) => JSON.stringify(request).split(JSON.stringify(`<skill_content name="runtime-company-awakening">\n${body}\n</skill_content>`).slice(1,-1)).length - 1
    for (const request of adapter.requests.slice(8,11)) expect(copies(request,awakeningBody)).toBe(1)
    agent.send(createUserMessage({ source:{ kind:'user' },content:[{ type:'text',text:'Continue this unfinished orientation.' }] }), 'next-turn', true)
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(12))
    await vi.waitFor(() => expect(agent.status).toBe('idle'))
    expect(copies(adapter.requests[11],awakeningBody)).toBe(1)
    const originalBody=awakeningBody
    awakeningBody += '\nNew current method revision.'
    const before=agent.session.snapshotEvents()
    agent.send(createUserMessage({ source:{ kind:'user' },content:[{ type:'text',text:'Continue with the revised orientation method.' }] }), 'next-turn', true)
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(13))
    await vi.waitFor(() => expect(agent.status).toBe('idle'))
    expect(copies(adapter.requests[12],awakeningBody)).toBe(1)
    expect(copies(adapter.requests[12],originalBody)).toBe(0)
    expect(agent.session.snapshotEvents().slice(0,before.length)).toEqual(before)

    expect(ctx.tools.get('hivemind_hq_rest')).toBeDefined()
    parallelReads = true
    agent.send(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read the current saved task heads together.' }] }), 'next-turn', true)
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(15))
    await vi.waitFor(() => expect(agent.status).toBe('idle'))
    expect(maxActiveReads).toBe(2)
    const parallelResults = agent.session.snapshotEvents().filter(event => event.type === 'tool/result'
      && event.data.message.content.some(block => ['parallel-list-one', 'parallel-list-two'].includes(String(block.toolCallId))))
    expect(parallelResults).toHaveLength(2)
    expect(JSON.stringify(parallelResults)).toContain('next_cursor')
    await ctx.fiber.dispose()
    expect(ctx.get('tools')).toBeUndefined()
  } finally { releaseReads(); await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }) }
}, 30_000)


it('native loop keeps a direct task request current after projection rewrites archived nightly peer receipts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-native-admission-'))
  const ctx = new Context()
  const adapter = new MockAdapter([toolCallResponse('current-read', 'fixture_inspection', {}), textResponse('Reviewed task-24.')])
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalAttachmentStore, { dshHome: dir })
    await ctx.plugin(ExecutionScope)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(JsonlSessionPersistence, { root: join(dir, 'sessions') })
    await ctx.plugin(TestSessionQuery)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(Subagents)
    ctx.provide('agentPresets', { serviceFor: (_agent: unknown, name: string & keyof Context) => ctx.get(name), composedPreset: () => undefined } as never)
    await ctx.plugin(TeamService)
    ctx.provide('schedule', { catalog: async () => [] } as never)
    ctx.provide('sessionController', {} as never)
    ctx.provide('hivemindEmployeeDirectory', { profiles: async () => ({ profiles: [] }) } as never)
    ctx.provide('hivemindHq', { mode: () => ({ enabled: false }), workspace: async (agent: Parameters<Context['agentTeams']['listTasks']>[0]) => ({
      mode: { enabled: false, revision: 0, changedAt: 0 }, tasks: ctx.get('agentTeams')!.listTasks(agent), calendar: [], wakes: [],
    }) } as never)
    await ctx.plugin(Hq)
    installNightlyRoutineGuidance(ctx)
    await ctx.plugin(contextPlugin({ historyTurns: 3, historyMaxChars: 3000, capabilityToolName: 'hivemind_capabilities' }))
    ctx.get('llm')!.registerAdapter(['mock'], adapter)
    ctx.get('tools')!.register(defineTool({ name: 'hivemind_research_answer', description: 'Never called.', parameters: {},
      output: { schema: { type: 'object', properties: {}, additionalProperties: true }, render: () => [] }, execute: async () => ({}) }))
    ctx.get('tools')!.register(defineTool({ name: 'fixture_inspection', description: 'Current task read fixture.', parameters: {},
      output: { schema: { type: 'object', properties: {}, additionalProperties: true }, render: () => [{ type: 'text', text: 'Task-24 evidence.' }] },
      execute: async () => ({ status: 'read' }),
    }))
    const agent = await ctx.agentLoop.create(SessionId('native-admission-fixture'), { provider: 'mock', model: 'mock' })
    agent.session.append('hivemind/session-owner', { id: null, slug: 'runtime' } as never)
    agent.session.append('agent-preset/selected', { agentPreset: 'hivemind-hq' })
    const occurrence = '2026-10-13T00:00:00Z'
    const scheduleId = 'schedule-' + createHash('sha256').update(`${agent.id}\0nightly-routine-check-v1`).digest('hex')
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Prior authorized nightly work.' }] }), { surfaceOp: 'append' })
    agent.session.append('user/message', createUserMessage({ source: { kind: 'schedule', occurrenceAt: occurrence },
      content: [{ type: 'text', text: 'reminders_json: ' + JSON.stringify([{ schedule_id: scheduleId, occurrence_at: occurrence }]) }] }), { surfaceOp: 'append' })
    agent.session.append('hivemind/room-message-queued', { id: 'archived-review', senderId: agent.id, senderName: 'Runtime', senderEmployee: 'runtime',
      targetId: SessionId('nightly-peer'), kind: 'question', text: 'NIGHTLY_REVIEW_REQUEST=' + JSON.stringify({ occurrence }), artifactIds: [], hops: 0 })
    for (let index = 0; index < 12; index++) {
      const id = `archived-reply-${index}`
      agent.session.append('hivemind/room-message-received', { id, senderId: SessionId('nightly-peer'), senderName: 'Analyst', senderEmployee: 'analyst',
        targetId: agent.id, kind: 'reply', replyTo: 'archived-review', text: 'Old nightly evidence', artifactIds: [], hops: 0 })
      agent.session.append('user/message', createUserMessage({ source: { kind: 'hivemind-agent-message', form: 'relay', messageId: id,
        senderId: SessionId('nightly-peer'), senderSessionId: SessionId('nightly-peer') }, content: [{ type: 'text', text: 'Old nightly evidence '.repeat(1000) }] }), { surfaceOp: 'append' })
    }
    agent.session.append('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Prior review saved.' }], source: { kind: 'model', provider: 'mock', model: 'mock' } } } as never, { surfaceOp: 'append' })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const request = 'Resume existing task-24 only. Inspect Mimi’s saved artifact; do not restart nightly review.'
    agent.send(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: request }] }), 'next-turn', true)
    await vi.waitFor(() => expect(adapter.requests, JSON.stringify(agent.session.snapshotEvents().filter(event => event.type === 'turn/end'))).toHaveLength(2))
    await vi.waitFor(() => expect(agent.status).toBe('idle'))
    for (const prepared of adapter.requests) {
      expect(JSON.stringify(prepared)).toContain(request)
      expect(JSON.stringify(prepared)).not.toContain('Current admitted scheduled review: Nightly report')
      expect(JSON.stringify(prepared)).not.toContain('Current Nightly report:')
    }
    expect(agent.session.snapshotEvents().some(event => event.type === 'user/message' && typeof event.surfaceOp === 'object'
      && event.data.source.kind === 'hivemind-agent-message')).toBe(true)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.surfaceOp === 'append'
      && event.data.source.kind === 'hivemind-agent-message')).toHaveLength(12)
  } finally { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }) }
})
