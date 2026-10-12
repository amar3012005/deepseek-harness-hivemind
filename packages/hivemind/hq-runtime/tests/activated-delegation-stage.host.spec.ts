/** Real native Team tools create, contract, assignment, employee activation and HQ rest handoff. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import TeamService from '@deepseek-ai/dsh-experimental-agent-team'
import * as TeamTools from '@deepseek-ai/dsh-experimental-tool-agent-team'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Skills from '@deepseek-ai/dsh-skill'
import ExecutionScope from '@deepseek-ai/dsh-hivemind-execution-scope'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import Schedule from '@deepseek-ai/dsh-schedule'
import * as Persona from '@deepseek-ai/dsh-persona'
import * as Hq from '../src/index.ts'
import { HqControl } from '../src/control.ts'
import { TestSessionQuery } from '../../../experimental/agent-team/tests/test-session-query.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { expect, it, vi } from 'vitest'

it('creates and assigns through native tools, activates one persistent employee room, then satisfies HQ Schedule rest guard', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hq-activated-delegation-'))
  const ctx = new Context()
  let employee: Awaited<ReturnType<Context['agentLoop']['create']>> | undefined
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
    await ctx.plugin(TeamTools)
    await ctx.plugin(Skills)
    await ctx.plugin(ExecutionScope)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: join(dir, 'schedule') })
    await ctx.plugin(StorageDomain, { backend: 'json' })

    const runtimeAdapter = new MockAdapter([
      toolCallResponse('task-create', 'team_task_create', {
        subject: 'Prepare a concise evidence review', description: 'Review the supplied deployment evidence and return findings.',
      }),
      toolCallResponse('task-contract', 'hivemind_hq_contract', {
        action: 'attach', task_id: 'task-1', due_at: '2035-01-01T00:00:00Z',
        acceptance_criteria: ['Cite the inspected evidence', 'State unresolved gaps'],
      }),
      toolCallResponse('task-assign', 'hivemind_hq_contract', { action: 'assign', task_id: 'task-1', employee_id: 'employee-analyst' }),
      textResponse('The task is assigned to the persistent analyst room.'),
      toolCallResponse('rest-handoff', 'hivemind_hq_rest', {
        handoff_id: 'delegation-review-rest', wake_at: '2034-01-01T00:00:00Z',
        summary: 'The analyst is working on the saved evidence review.', next_steps: ['Review the employee result when it arrives.'], blockers: [],
      }),
      textResponse('The handoff and review wake are saved.'),
    ])
    const employeeAdapter = new MockAdapter(['hang'])
    ctx.llm.registerAdapter(['mock'], runtimeAdapter)
    ctx.llm.registerAdapter(['employee-fixture'], employeeAdapter)

    const employeeProfile = { id: 'employee-analyst', slug: 'analyst', name: 'Analyst', role_archetype: 'Research analyst', persona: 'Careful, evidence-led analyst.' }
    const ownership = { claim: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
    const rooms = {
      async resolvePersistentEmployeeRoom(id: string, _profile: unknown, _signal: AbortSignal) {
        if (id !== employeeProfile.id) throw new Error('fixture_employee_not_found')
        if (!employee) employee = await ctx.agentLoop.create(SessionId('persistent-employee-analyst'), { provider: 'employee-fixture', model: 'fixture' })
        return employee
      },
      async resolveAgent(id: SessionId) {
        const agent = ctx.agents.get(id)
        return agent ? { agent } : { error: new Error('fixture_room_not_found') }
      },
      async deliverAgentMessage(caller: Agent, input: { key: string; target: string; kind: 'question' | 'update'; text: string; taskId: string }) {
        const target = employee
        if (!target || input.target !== employeeProfile.id) throw new Error('fixture_employee_room_missing')
        target.send(createUserMessage({ source: { kind: 'hivemind-agent-message', form: 'relay', messageId: input.key,
          senderId: SessionId(caller.id), senderSessionId: SessionId(caller.id) } as never,
        content: [{ type: 'text', text: JSON.stringify({ text: input.text }) }] }), 'next-turn', true)
        return { messageId: input.key, targetSessionId: target.id }
      },
    }
    ctx.provide('agentPresets', { serviceFor: (_agent: unknown, name: string & keyof Context) => ctx.get(name), composedPreset: () => undefined } as never)
    ctx.provide('permissionPresets', { current: () => 'default', set: async () => undefined } as never)
    ctx.provide('hivemindEmployeeDirectory', { profiles: async () => ({ profiles: [employeeProfile] }) } as never)
    ctx.provide('hivemindHqOwnership', ownership as never)
    ctx.provide('sessionController', rooms as never)
    await ctx.plugin(Schedule)
    await ctx.plugin(Hq)
    await ctx.plugin({ name: 'hq-control-fixture', inject: HqControl.inject, apply(scope: Context) { new HqControl(scope) } })
    ctx.tools.register(defineTool({ name: 'hivemind_research_answer', description: 'Fixture-owned search boundary.', parameters: {},
      output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [] },
      async execute() { throw new Error('unexpected_fixture_research') },
    }))

    const root = await ctx.agentLoop.create(SessionId('activated-hq-delegation'), { provider: 'mock', model: 'fixture' })
    await root.ctx.plugin(Persona, { prefix: 'You are Runtime, a scoped company Chief of Staff fixture.' })
    root.session.append('agent-preset/selected', { agentPreset: 'hivemind-hq' })
    expect(ctx.agentTeams.tryMembership(root)?.role).toBe('lead')
    const hq = ctx.get('hivemindHq')!
    expect(hq.mode(root)).toMatchObject({ enabled: false, revision: 0 })
    const enabled = await hq.setMode(root, { enabled: true, expectedRevision: 0 })
    expect(enabled.ok).toBe(true)
    expect(hq.mode(root)).toMatchObject({ enabled: true, revision: 1 })

    root.send(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Delegate an evidence review to the analyst.' }] }), 'next-turn', true)
    await vi.waitFor(() => expect(root.status).toBe('idle'))
    await vi.waitFor(() => expect(employeeAdapter.requests).toHaveLength(1))

    const task = ctx.agentTeams.getTask(root, 'task-1' as never)
    expect(task).toMatchObject({ subject: 'Prepare a concise evidence review', status: 'in_progress', ownerName: 'analyst' })
    expect(root.session.ownEvents().filter(event => event.type === 'hivemind/hq-task-contract' && event.data.taskId === task.id)).toHaveLength(1)
    const nativeCalls = root.session.ownEvents().flatMap(event => event.type === 'tool/call' ? [event.data.name] : [])
    expect(nativeCalls).toEqual(expect.arrayContaining(['team_task_create', 'hivemind_hq_contract']))
    expect(root.session.ownEvents().some(event => event.type === 'tool/result' && event.data.message.isError)).toBe(false)
    const assignment = root.session.ownEvents().findLast(event => event.type === 'hivemind/hq-employee-assignment' && event.data.taskId === task.id)
    expect(assignment?.type === 'hivemind/hq-employee-assignment' ? assignment.data.employeeId : undefined).toBe(employeeProfile.id)
    expect(root.session.ownEvents().some(event => event.type === 'hivemind/room-message-received')).toBe(false)
    expect(ctx.agentTeams.listMembers(root).some(member => member.id === employee!.id && member.ownership === 'persistent')).toBe(true)
    expect(employee!.session.ownEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'hivemind-agent-message')).toBe(true)
    expect(employeeAdapter.requests[0]?.messages.map(message => JSON.stringify(message)).join('\n')).toContain('Review the supplied deployment evidence')
    expect(employeeAdapter.requests).toHaveLength(1)
    expect(employee!.status).toBe('running')
    expect(runtimeAdapter.requests.some(request => JSON.stringify(request.messages).includes('Before this active Runtime turn finishes, commit a handoff and a justified future wake'))).toBe(true)
    expect(root.session.ownEvents().some(event => event.type === 'hivemind/hq-rest-confirmed' && event.data.handoffId === 'delegation-review-rest')).toBe(true)
    const schedule = await ctx.schedule.catalog()
    expect(schedule.some(entry => entry.sessionId === root.id && entry.title === 'HQ task deadline: Prepare a concise evidence review')).toBe(true)
    expect(schedule.some(entry => entry.sessionId === root.id && entry.title === 'Runtime rest: delegation-review-rest' && entry.status === 'active')).toBe(true)
    expect(schedule.some(entry => entry.sessionId === root.id && entry.title === 'HQ startup review' && entry.status === 'active')).toBe(true)
  } finally {
    employee?.cancel({ kind: 'parent' }, { keepInbox: true })
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}, 30_000)
