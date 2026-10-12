/** Native Schedule wake, saved artifact review, employee continuation and quiet completion mechanism proof. */
import { mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
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
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Skills from '@deepseek-ai/dsh-skill'
import ExecutionScope from '@deepseek-ai/dsh-hivemind-execution-scope'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import Schedule from '@deepseek-ai/dsh-schedule'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { ApiSessionAgentController } from '../../../api/session-controller/src/agent.ts'
import { RoomMessaging } from '../../../api/session-controller/src/room-messaging.ts'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import * as Persona from '@deepseek-ai/dsh-persona'
import { GenerationRegistry, registerGenerationTools } from '../../artifact-renderer/src/generation.ts'
import { installAgentMessaging } from '../../runtime/src/agent-messaging.ts'
import { installSubmissionReviewGuidance } from '../../runtime/src/review-guidance.ts'
import * as Hq from '../src/index.ts'
import { HqControl } from '../src/control.ts'
import { TestSessionQuery } from '../../../experimental/agent-team/tests/test-session-query.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { expect, it, vi } from 'vitest'

it('saved artifact review and one continuation follow the exact due rest Schedule delivery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hq-activated-delegation-'))
  const ctx = new Context()
  let employee: Awaited<ReturnType<Context['agentLoop']['create']>> | undefined
  let runtimeRoot: Awaited<ReturnType<Context['agentLoop']['create']>> | undefined
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
    installSubmissionReviewGuidance(ctx)
    await ctx.plugin(ExecutionScope)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: join(dir, 'schedule') })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(TypertRegistry)

    const exactRestDeliveryKeys: string[] = []
    const runtimeResponse = (_options: GenerateOptions): StreamChunk[] => {
      const events = runtimeRoot?.session.ownEvents() ?? []
      const calls = events.flatMap(event => event.type === 'tool/call' ? [
        { seq: event.seq, name: event.data.name, args: JSON.parse(event.data.arguments) as Record<string, unknown> },
      ] : [])
      const called = (name: string, action?: string) => calls.some(call =>
        call.name === name && (action === undefined || call.args.action === action))
      if (!called('team_task_create')) return toolCallResponse('task-create', 'team_task_create', {
        subject: 'Prepare a concise evidence review', description: 'Review the supplied deployment evidence: the evidence states “deployment validation completed successfully”. Cite that statement and return any unresolved gaps.',
      })
      if (!called('hivemind_hq_contract', 'attach')) return toolCallResponse('task-contract', 'hivemind_hq_contract', {
        action: 'attach', task_id: 'task-1', due_at: '2035-01-01T00:00:00Z',
        acceptance_criteria: ['Cite the inspected evidence', 'State unresolved gaps'],
      })
      if (!called('hivemind_hq_contract', 'assign')) return toolCallResponse('task-assign', 'hivemind_hq_contract', { action: 'assign', task_id: 'task-1', employee_id: 'employee-analyst' })
      const firstArtifact = employee?.session.ownEvents().some(event => event.type === 'hivemind/generation-created') === true
      if (!firstArtifact && !called('wait_agent')) return toolCallResponse('wait-first-result', 'wait_agent', { timeout_ms: 10_000 })
      const restConfirmed = events.some(event => event.type === 'hivemind/hq-rest-confirmed' && event.data.handoffId === 'delegation-review-rest')
      if (!restConfirmed && !called('hivemind_hq_rest')) return toolCallResponse('rest-handoff', 'hivemind_hq_rest', {
        handoff_id: 'delegation-review-rest', wake_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
        summary: 'The analyst has saved an initial evidence review.', next_steps: ['Review the analyst result after the scheduled wake.'], blockers: [],
      })
      const scheduledWakeConsumed = exactRestDeliveryKeys.length > 0 && events.some(event => event.type === 'user/message'
        && (event.data as unknown as { source: { kind: string; deliveryKey?: string } }).source.kind === 'schedule'
        && exactRestDeliveryKeys.includes((event.data as unknown as { source: { kind: string; deliveryKey?: string } }).source.deliveryKey ?? ''))
      if (!scheduledWakeConsumed) return textResponse('The evidence review is saved; I will review it after the committed Schedule wake.')

      const employeeEvents = employee?.session.ownEvents() ?? []
      const latestArtifactId = employeeEvents.findLast(event => event.type === 'hivemind/generation-created')?.data.artifactId
      if (typeof latestArtifactId !== 'string') return textResponse('The scheduled review found no saved employee artifact to inspect.')
      const links = events.findLast(event => event.type === 'hivemind/hq-task-artifacts' && event.data.taskId === 'task-1')
      if (!links || !(links.data as unknown as { artifactIds: string[] }).artifactIds.includes(latestArtifactId)) {
        return toolCallResponse('review-link-current', 'hivemind_hq_contract', {
          action: 'artifacts', task_id: 'task-1', producer: 'analyst', artifact_ids: [latestArtifactId],
        })
      }
      const latestLinkSeq = links.seq
      const inspectionCall = events.findLast(event => event.type === 'tool/call' && event.data.name === 'hivemind_hq_contract'
        && JSON.parse((event.data as unknown as { arguments: string }).arguments).action === 'inspect' && event.seq > latestLinkSeq)
      if (!inspectionCall) return toolCallResponse('review-inspect-current', 'hivemind_hq_contract', { action: 'inspect', task_id: 'task-1' })
      const inspectionResult = events.findLast(event => event.type === 'tool/result'
        && (event.data as unknown as { message: { source: { kind: string; callId?: string } } }).message.source.kind === 'tool'
        && (event.data as unknown as { message: { source: { kind: string; callId?: string } } }).message.source.callId
          === (inspectionCall.data as unknown as { callId: string }).callId)
      const inspectionText = inspectionResult?.type === 'tool/result'
        ? inspectionResult.data.message.content.find(block => block.type === 'text')?.text : undefined
      const inspection = inspectionText ? JSON.parse(inspectionText) as { task_revision?: number; evidence_hash?: string } : undefined
      if (!inspection?.evidence_hash || !Number.isSafeInteger(inspection.task_revision)) return textResponse('I am waiting for the native inspection receipt before deciding.')

      const review = events.findLast((event) => {
        if (event.type !== 'hivemind/hq-task-review') return false
        const data = event.data as unknown as {
          taskId: string
          taskRevision: number
          inputHash: string
          artifactIds: string[]
        }
        return data.taskId === 'task-1'
          && data.taskRevision === inspection.task_revision
          && data.inputHash === inspection.evidence_hash
          && data.artifactIds.includes(latestArtifactId)
      })
      if (!review) {
        const initialArtifact = employeeEvents.filter(event => event.type === 'hivemind/generation-created')[0]?.data.artifactId
        const decision = latestArtifactId === initialArtifact ? 'needs_changes' : 'accepted'
        const rationale = decision === 'needs_changes'
          ? 'The saved review omits the unresolved gaps required by the contract.'
          : 'The revised artifact cites the supplied evidence statement and identifies the missing underlying deployment source as an unresolved gap.'
        return toolCallResponse(`review-${decision}`, 'hivemind_hq_contract', {
          action: 'decide', task_id: 'task-1', decision, task_revision: inspection.task_revision,
          evidence_hash: inspection.evidence_hash, rationale,
        })
      }
      if ((review.data as unknown as { status: string }).status === 'needs_changes' && !events.some(event => event.type === 'tool/call'
        && (event.data as unknown as { name: string; arguments: string }).name === 'hivemind_agent_message'
        && JSON.parse((event.data as unknown as { arguments: string }).arguments).message_key === 'review-correction-1')) {
        return toolCallResponse('review-continuation', 'hivemind_agent_message', {
          recipient: 'employee-analyst', kind: 'question', request_reply: true, message_key: 'review-correction-1', task_id: 'task-1',
          message: 'Please continue the same task. Add the exact supplied evidence statement and a concise unresolved-gaps section to the saved review, then report the result.',
          summary: 'Please add the missing evidence citation and unresolved-gaps section.',
        })
      }
      const correctionCall = calls.find(call => call.name === 'hivemind_agent_message'
        && call.args.message_key === 'review-correction-1')
      const initialArtifactId = employeeEvents.find(event => event.type === 'hivemind/generation-created')?.data.artifactId
      const correctionRestConfirmed = events.some(event => event.type === 'hivemind/hq-rest-confirmed'
        && event.data.handoffId === 'delegation-review-correction-rest')
      if ((review.data as unknown as { status: string }).status === 'needs_changes'
        && correctionCall && latestArtifactId === initialArtifactId && !correctionRestConfirmed) {
        return toolCallResponse('rest-after-correction', 'hivemind_hq_rest', {
          handoff_id: 'delegation-review-correction-rest', wake_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
          summary: 'The analyst is revising the evidence review against Runtime’s requested correction.',
          next_steps: ['Inspect the corrected artifact, decide against the saved criteria, and complete the same task if it passes.'], blockers: [],
        })
      }
      if ((review.data as unknown as { status: string }).status === 'needs_changes') return textResponse('I requested the specific correction; the analyst is continuing the same task.')

      if (ctx.agentTeams.getTask(runtimeRoot!, 'task-1' as never).status !== 'completed'
        && !calls.some(call => call.name === 'team_task_update' && call.args.action === 'complete')) {
        return toolCallResponse('review-complete-task', 'team_task_update', {
          task_id: 'task-1', expected_revision: inspection.task_revision, action: 'complete',
        })
      }
      return textResponse('The revised evidence review is accepted, the task is complete, and no additional ready task needs action.')
    }
    const runtimeAdapter = new MockAdapter(Array.from({ length: 24 }, () => runtimeResponse))
    const employeeAdapter = new MockAdapter([
      toolCallResponse('employee-first-artifact', 'hivemind_generate', { format: 'web', title: 'Evidence review', content: '<!doctype html><h1>Evidence review</h1><p>Evidence was checked.</p>' }),
      () => toolCallResponse('employee-first-report', 'hivemind_agent_message', { recipient: 'runtime', kind: 'update', message_key: 'employee-result-1', task_id: 'task-1', artifact_ids: [String(employee?.session.ownEvents().findLast(e => e.type === 'hivemind/generation-created')?.data.artifactId)], message: 'I saved the evidence review; unresolved gaps are not listed yet.', summary: 'The first evidence review is saved.' }),
      textResponse('The evidence review is saved; unresolved gaps are not yet listed.'),
      toolCallResponse('employee-revised-artifact', 'hivemind_generate', { format: 'web', title: 'Evidence review revised', content: '<!doctype html><h1>Evidence review</h1><p>Supplied evidence states: deployment validation completed successfully.</p><h2>Unresolved gaps</h2><p>The underlying deployment report was not supplied, so its environment and validation details remain unverified.</p>' }),
      () => toolCallResponse('employee-revised-report', 'hivemind_agent_message', { recipient: 'runtime', kind: 'update', message_key: 'employee-result-2', task_id: 'task-1', artifact_ids: [String(employee?.session.ownEvents().findLast(e => e.type === 'hivemind/generation-created')?.data.artifactId)], message: 'I cited the supplied deployment evidence statement, documented the missing underlying report as an unresolved gap, and saved the revised review.', summary: 'The revised review is saved.' }),
      textResponse('I cited the supplied deployment evidence statement, documented the missing underlying report as an unresolved gap, and saved the revised review.'),
    ])
    ctx.llm.registerAdapter(['mock'], runtimeAdapter)
    ctx.llm.registerAdapter(['employee-fixture'], employeeAdapter)

    const employeeProfile = { id: 'employee-analyst', slug: 'analyst', name: 'Analyst', role_archetype: 'Research analyst', persona: 'Careful, evidence-led analyst.' }
    const ownership = { claim: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
    const nativeSessionAgentResolver = new ApiSessionAgentController(ctx)
    const generatedFiles: string[] = []
    const generationRegistry = new GenerationRegistry()
    generationRegistry.register({ id: 'scripted-artifact-fixture', format: 'web', instructions: 'Deterministic fixture generator; this is not a live provider.', async generate(request) {
      generatedFiles.push(request.content)
      return { data: new TextEncoder().encode(request.content), extension: 'html', mediaType: 'text/html' }
    } })
    await ctx.plugin(LocalAttachmentStore, { dshHome: join(dir, 'attachments') })
    installAgentMessaging(ctx)
    async function ensureEmployee() {
      if (!employee) {
        employee = await ctx.agentLoop.create(SessionId('persistent-employee-analyst'), { provider: 'employee-fixture', model: 'fixture' })
        employee.session.append('agent-preset/selected', { agentPreset: 'hivemind-hyperagents' })
        employee.session.append('hivemind/session-owner', { id: employeeProfile.id, slug: employeeProfile.slug, name: employeeProfile.name, role: employeeProfile.role_archetype })
        const employeeToolContext = new Proxy(employee.ctx, { get(target, property, receiver) {
          if (property === 'attachments') return ctx.attachments
          return Reflect.get(target, property, receiver)
        } }) as Context
        registerGenerationTools(employeeToolContext, generationRegistry, 'artifacts', 20_000)
        installAgentMessaging(employee.ctx)
      }
      return employee
    }
    const rooms = {
      async resolvePersistentEmployeeRoom(id: string, _profile: unknown, _signal: AbortSignal) {
        if (id !== employeeProfile.id) throw new Error('fixture_employee_not_found')
        return ensureEmployee()
      },
      async resolveAgent(id: SessionId) {
        return nativeSessionAgentResolver.resolveAgent(id)
      },
      async deliverAgentMessage(caller: Agent, input: { key: string; target: string; targetProfile?: { id: string; name: string; role: string }; kind: 'question' | 'reply' | 'update'; text: string; summary?: string; taskId?: string; replyTo?: string; artifactIds?: string[] }, signal: AbortSignal) {
        const targetProfile = input.target === 'runtime' ? undefined : input.targetProfile ?? {
          id: employeeProfile.id, name: employeeProfile.name, role: employeeProfile.role_archetype,
        }
        const result = await nativeRoomMessaging.send(caller, {
          key: input.key, target: input.target, ...(targetProfile === undefined ? {} : { targetProfile }),
          kind: input.kind, text: input.text, ...(input.summary === undefined ? {} : { summary: input.summary }),
          ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
          ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
          ...(input.artifactIds === undefined ? {} : { artifactIds: input.artifactIds }),
        }, signal)
        return result as unknown as Record<string, import('@deepseek-ai/dsh-util-values').JsonValue>
      },
    }
    const nativeRoomMessaging = new RoomMessaging(ctx, async (key, profile) => {
      if (key === 'runtime') {
        if (!runtimeRoot) throw new Error('fixture_runtime_room_not_ready')
        return runtimeRoot!
      }
      if (key !== employeeProfile.id) throw new Error('fixture_employee_not_found')
      if (!profile) throw new Error('fixture_employee_profile_required')
      return ensureEmployee()
    })
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
    // Scripted model turns prove mechanism only; the fixture generator and the
    // provider used for this test are deterministic and do not represent live providers.

    runtimeRoot = await ctx.agentLoop.create(SessionId('activated-hq-delegation'), { provider: 'mock', model: 'fixture' })
    const activeRuntimeRoot = runtimeRoot
    installAgentMessaging(activeRuntimeRoot.ctx)
    await activeRuntimeRoot.ctx.plugin(Persona, { prefix: 'You are Runtime, a scoped company Chief of Staff fixture.' })
    activeRuntimeRoot.session.append('agent-preset/selected', { agentPreset: 'hivemind-hq' })
    expect(ctx.agentTeams.tryMembership(activeRuntimeRoot)?.role).toBe('lead')
    const hq = ctx.get('hivemindHq')!
    expect(hq.mode(activeRuntimeRoot)).toMatchObject({ enabled: false, revision: 0 })
    const enabled = await hq.setMode(activeRuntimeRoot, { enabled: true, expectedRevision: 0 })
    expect(enabled.ok).toBe(true)
    expect(hq.mode(activeRuntimeRoot)).toMatchObject({ enabled: true, revision: 1 })

    activeRuntimeRoot.send(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Delegate an evidence review to the analyst.' }] }), 'next-turn', true)
    await vi.waitFor(() => expect(activeRuntimeRoot.status).toBe('idle'), { timeout: 20_000 })
    await vi.waitFor(() => expect(employeeAdapter.requests).toHaveLength(3), { timeout: 20_000 })
    expect(employee?.session.ownEvents().filter(event => event.type === 'hivemind/generation-created')).toHaveLength(1)
    expect(runtimeAdapter.requests.length).toBeGreaterThan(1)

    const rest = (await ctx.schedule.catalog()).find(entry => entry.sessionId === activeRuntimeRoot.id && entry.title === 'Runtime rest: delegation-review-rest' && entry.status === 'active')
    expect(rest).toBeDefined()
    const exactRestDeliveryKey = createHash('sha256').update(`${rest!.id}:${rest!.scheduledAt}`).digest('hex')
    exactRestDeliveryKeys.push(exactRestDeliveryKey)
    const requestsBeforeWake = runtimeAdapter.requests.length
    const firstClock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(rest!.scheduledAt))
    try {
      ctx.schedule.reconsiderDelivery()
      await vi.waitFor(() => expect(activeRuntimeRoot.session.ownEvents().some(event => event.type === 'user/message'
        && event.data.source.kind === 'schedule' && event.data.source.deliveryKey === exactRestDeliveryKey)).toBe(true), { timeout: 10_000 })
    } finally { firstClock.mockRestore() }
    await vi.waitFor(() => expect(runtimeAdapter.requests.length).toBeGreaterThan(requestsBeforeWake), { timeout: 10_000 })
    await vi.waitFor(() => expect(activeRuntimeRoot.status).toBe('idle'), { timeout: 10_000 })
    await vi.waitFor(() => expect(employeeAdapter.requests).toHaveLength(6), { timeout: 10_000 })

    // The correction handoff commits its own native Schedule wake. Advance the
    // fixture clock to that exact persisted occurrence so Runtime reviews the
    // revised employee result through normal delivery and inbox restoration.
    const correctionRest = (await ctx.schedule.catalog()).find(entry => entry.sessionId === activeRuntimeRoot.id
      && entry.title === 'Runtime rest: delegation-review-correction-rest' && entry.status === 'active')
    expect(correctionRest).toBeDefined()
    const exactCorrectionDeliveryKey = createHash('sha256')
      .update(`${correctionRest!.id}:${correctionRest!.scheduledAt}`).digest('hex')
    exactRestDeliveryKeys.push(exactCorrectionDeliveryKey)
    const requestsBeforeCorrectionWake = runtimeAdapter.requests.length
    const correctionClock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(correctionRest!.scheduledAt))
    try {
      ctx.schedule.reconsiderDelivery()
      await vi.waitFor(() => expect(activeRuntimeRoot.session.ownEvents().some(event => event.type === 'user/message'
        && event.data.source.kind === 'schedule' && event.data.source.deliveryKey === exactCorrectionDeliveryKey)).toBe(true), { timeout: 10_000 })
    } finally { correctionClock.mockRestore() }
    await vi.waitFor(() => expect(runtimeAdapter.requests.length).toBeGreaterThan(requestsBeforeCorrectionWake), { timeout: 10_000 })
    await vi.waitFor(() => expect(activeRuntimeRoot.status).toBe('idle'), { timeout: 10_000 })

    const task = ctx.agentTeams.getTask(activeRuntimeRoot, 'task-1' as never)
    expect(task, JSON.stringify({ task, runtimeRequests: runtimeAdapter.requests.map((request, index) => ({
      index,
      messages: request.messages.slice(-4).map(message => ({
        role: message.role, content: JSON.stringify(message.content).slice(0, 1_000),
      })),
    })),
    runtimeCalls: activeRuntimeRoot.session.ownEvents().filter(event => event.type === 'tool/call').map(event => ({ name: event.data.name, args: event.data.arguments })),
    runtimeErrors: activeRuntimeRoot.session.ownEvents().flatMap(event => event.type === 'tool/result' && event.data.message.isError
      ? [event.data.message.content] : []),
    runtimeToolResults: activeRuntimeRoot.session.ownEvents().flatMap(event => event.type === 'tool/result'
      ? [{ callId: event.data.message.source.kind === 'tool' ? event.data.message.source.callId : '', content: event.data.message.content }] : []).slice(-6),
    turnEnds: activeRuntimeRoot.session.ownEvents().flatMap(event => event.type === 'turn/end' ? [{ turn: event.data.turn, reason: event.data.reason.kind }] : []),
    })).toMatchObject({ subject: 'Prepare a concise evidence review', status: 'completed', ownerName: 'analyst' })
    expect(activeRuntimeRoot.session.ownEvents().filter(event => event.type === 'hivemind/hq-task-contract' && event.data.taskId === task.id)).toHaveLength(1)
    const nativeCalls = activeRuntimeRoot.session.ownEvents().flatMap(event => event.type === 'tool/call' ? [event.data.name] : [])
    expect(nativeCalls).toEqual(expect.arrayContaining(['team_task_create', 'hivemind_hq_contract']))
    const contractActions = activeRuntimeRoot.session.ownEvents().flatMap(event => event.type === 'tool/call' && event.data.name === 'hivemind_hq_contract'
      ? [JSON.parse(event.data.arguments).action as string] : [])
    expect(contractActions.filter(action => action === 'inspect')).toHaveLength(2)
    expect(contractActions.filter(action => action === 'decide')).toHaveLength(2)
    expect(activeRuntimeRoot.session.ownEvents().some(event => event.type === 'tool/result' && event.data.message.isError)).toBe(false)
    const assignment = activeRuntimeRoot.session.ownEvents().findLast(event => event.type === 'hivemind/hq-employee-assignment' && event.data.taskId === task.id)
    expect(assignment?.type === 'hivemind/hq-employee-assignment' ? assignment.data.employeeId : undefined).toBe(employeeProfile.id)
    expect(activeRuntimeRoot.session.ownEvents().some(event => event.type === 'hivemind/room-message-received')).toBe(true)
    expect(ctx.agentTeams.listMembers(activeRuntimeRoot).some(member => member.id === employee!.id && member.ownership === 'persistent')).toBe(true)
    expect(employee!.session.ownEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'hivemind-agent-message')).toBe(true)
    expect(employee!.session.ownEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'hivemind-agent-message'
      && event.data.content.some(block => block.type === 'text' && block.text.includes('Add the exact supplied evidence statement')))).toBe(true)
    expect(employeeAdapter.requests[0]?.messages.map(message => JSON.stringify(message)).join('\n')).toContain('Review the supplied deployment evidence')
    expect(employeeAdapter.requests).toHaveLength(6)
    expect(employee!.status).toBe('idle')
    expect(runtimeAdapter.requests.some(request => JSON.stringify(request.messages).includes('Before this active Runtime turn finishes, commit a handoff and a justified future wake'))).toBe(true)
    expect(activeRuntimeRoot.session.ownEvents().filter(event => event.type === 'hivemind/hq-task-artifacts' && event.data.taskId === task.id).at(-1)?.type).toBe('hivemind/hq-task-artifacts')
    expect(activeRuntimeRoot.session.ownEvents().some(event => event.type === 'hivemind/hq-task-review' && event.data.taskId === task.id && event.data.status === 'needs_changes')).toBe(true)
    expect(activeRuntimeRoot.session.ownEvents().some(event => event.type === 'hivemind/hq-task-review' && event.data.taskId === task.id && event.data.status === 'accepted')).toBe(true)
    expect(activeRuntimeRoot.session.ownEvents().some(event => event.type === 'tool/call' && event.data.name === 'team_task_update' && JSON.parse(event.data.arguments).action === 'complete')).toBe(true)
    await activeRuntimeRoot.whenIdle()
    expect(activeRuntimeRoot.status).toBe('idle')
    const completionCall = activeRuntimeRoot.session.ownEvents().findLast(event => event.type === 'tool/call'
      && event.data.name === 'team_task_update' && JSON.parse(event.data.arguments).action === 'complete')
    expect(completionCall?.type).toBe('tool/call')
    const completionResult = completionCall?.type === 'tool/call'
      ? activeRuntimeRoot.session.ownEvents().find(event => event.type === 'tool/result' && event.data.message.source.kind === 'tool'
        && event.data.message.source.callId === completionCall.data.callId)
      : undefined
    expect(completionResult?.type === 'tool/result' && completionResult.data.message.isError).toBe(false)
    expect(activeRuntimeRoot.session.ownEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)
    const exactWakes = activeRuntimeRoot.session.ownEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'schedule'
      && exactRestDeliveryKeys.includes(event.data.source.deliveryKey ?? ''))
    expect(exactWakes).toHaveLength(2)
    expect(employee!.session.ownEvents().filter(event => event.type === 'hivemind/generation-created')).toHaveLength(2)
    expect(generatedFiles[1]).toContain('Unresolved gaps')
    expect(generatedFiles[1]).toContain('deployment validation completed successfully')
    expect(generatedFiles[1]).toContain('underlying deployment report')
    expect(activeRuntimeRoot.session.ownEvents().some(event => event.type === 'hivemind/hq-rest-confirmed' && event.data.handoffId === 'delegation-review-rest')).toBe(true)
    const schedule = await ctx.schedule.catalog()
    expect(schedule.some(entry => entry.sessionId === activeRuntimeRoot.id && entry.title === 'HQ task deadline: Prepare a concise evidence review')).toBe(true)
    expect(schedule.some(entry => entry.sessionId === activeRuntimeRoot.id && entry.title === 'Runtime rest: delegation-review-rest' && entry.status === 'inactive')).toBe(true)
    expect(schedule.some(entry => entry.sessionId === activeRuntimeRoot.id && entry.title === 'HQ startup review')).toBe(true)
    const restReceipt = await ctx.schedule.history({ id: rest!.id, sessionId: activeRuntimeRoot.id, limit: 10 })
    expect(restReceipt).toMatchObject({ id: rest!.id })
    expect('records' in restReceipt && restReceipt.records.some(record => record.scheduledAt === rest!.scheduledAt)).toBe(true)
    const settledRuntimeRequests = runtimeAdapter.requests.length
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(runtimeAdapter.requests).toHaveLength(settledRuntimeRequests)
  } finally {
    employee?.cancel({ kind: 'parent' }, { keepInbox: true })
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
    vi.useRealTimers()
  }
}, 30_000)
