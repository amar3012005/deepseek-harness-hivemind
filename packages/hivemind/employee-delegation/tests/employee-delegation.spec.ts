import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.ts'

describe('hivemind employee delegation', () => {
  it('runs a plan-selected employee panel concurrently and prevents a second panel for the same plan', async () => {
    const tools = new Map<string, ToolDefinition>()
    const events: Array<{ type: string; data: unknown; seq?: number }> = [{
      type: 'hivemind/run-plan', seq: 7, data: {
        runId: 'run-panel', planId: 'plan-panel', revision: 1, playbooks: [{ id: 'global-research', version: '1.0.0' }],
        workstreams: [
          { id: 'research', objective: 'Assess demand.', actor: { kind: 'employee_subagent', employeeId: 'ravi' } },
          { id: 'challenge', objective: 'Challenge risk.', actor: { kind: 'employee_subagent', employeeId: 'marta' } },
        ],
      },
    }]
    let active = 0
    let peak = 0
    let starts = 0
    const parent = {
      options: { maxTokens: 2048 },
      session: {
        id: 'panel-parent',
        append(type: string, data: unknown) { events.push({ type, data }) },
        snapshotEvents() { return events },
      },
    } as unknown as Agent
    const ctx = {
      on() { return () => {} },
      tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {} } },
      hivemindEmployeeDirectory: { async profiles() { return { profiles: [
        { id: 'ravi', name: 'Ravi', persona: 'Research evidence.', role_archetype: 'Researcher' },
        { id: 'marta', name: 'Marta', persona: 'Challenge claims.', role_archetype: 'Risk lead' },
      ] } } },
      hivemindOperatingRuns: {
        startPlanSelectedEmployeeChild(_agent: Agent, employeeId: string) { return { workstreamId: employeeId === 'ravi' ? 'research' : 'challenge' } },
        completeEmployeeChild() {}, failEmployeeChild() {},
      },
      subagents: {
        async start(_provider: string, request: { label: string }) {
          starts += 1
          active += 1
          peak = Math.max(peak, active)
          return {
            id: `child-${starts}`,
            result: new Promise(resolve => setTimeout(() => { active -= 1; resolve({ stopReason: 'completed' as const, output: [{ type: 'text' as const, text: `${request.label} done` }] }) }, 15)),
            async dispose() {},
          }
        },
      },
    }
    apply(ctx as never, { maxPanelAssignments: 4, maxOutputTokens: 1024 })
    const panel = tools.get('hivemind_employee_panel')!
    const assignments = [
      { employee_id: 'ravi', task: 'Assess demand.' },
      { employee_id: 'marta', task: 'Challenge risk.' },
    ]
    await expect(panel.execute({ assignments }, { agent: parent, signal: new AbortController().signal } as never)).resolves.toMatchObject({
      status: 'completed', completed: 2, failed: 0, results: [{ employee: { id: 'ravi' } }, { employee: { id: 'marta' } }],
    })
    expect(peak).toBe(2)
    expect(starts).toBe(2)
    expect(events.filter(event => event.type === 'hivemind/employee-delegation-start')).toHaveLength(2)
    expect(events.filter(event => event.type === 'hivemind/employee-delegation-end')).toHaveLength(2)
    const panelIds = events.filter(event => event.type.includes('employee-delegation')).map(event => (event.data as { panelId?: string }).panelId)
    expect(new Set(panelIds)).toHaveLength(1)
    await expect(panel.execute({ assignments }, { agent: parent, signal: new AbortController().signal } as never)).resolves.toMatchObject({ status: 'already_completed', panel_id: panelIds[0] })
    expect(starts).toBe(2)
  })

  it('rejects an employee panel before child startup when an id is not authenticated', async () => {
    const tools = new Map<string, ToolDefinition>()
    let starts = 0
    const ctx = {
      on() { return () => {} },
      tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {} } },
      hivemindEmployeeDirectory: { async profiles() { return { profiles: [{ id: 'ravi', name: 'Ravi', persona: 'Research.' }] } } },
      subagents: { async start() { starts += 1; throw new Error('must not start') } },
    }
    apply(ctx as never)
    const parent = { options: {}, session: { id: 'parent', append() {}, snapshotEvents() { return [] } } } as unknown as Agent
    await expect(tools.get('hivemind_employee_panel')!.execute({ assignments: [
      { employee_id: 'ravi', task: 'Research.' },
      { employee_id: 'unknown', task: 'Review.' },
    ] }, { agent: parent, signal: new AbortController().signal } as never)).rejects.toThrow('not in the authenticated organization directory')
    expect(starts).toBe(0)
  })

  it('returns partial panel evidence when one native child fails', async () => {
    const tools = new Map<string, ToolDefinition>()
    const events: Array<{ type: string; data: unknown }> = []
    const ctx = {
      on() { return () => {} },
      tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {} } },
      hivemindEmployeeDirectory: { async profiles() { return { profiles: [
        { id: 'ravi', name: 'Ravi', persona: 'Research.' }, { id: 'marta', name: 'Marta', persona: 'Review.' },
      ] } } },
      subagents: { async start(_provider: string, request: { label: string }) {
        if (request.label.startsWith('Marta')) throw new Error('provider unavailable')
        return { id: 'child-ravi', result: Promise.resolve({ stopReason: 'completed' as const, output: [{ type: 'text' as const, text: 'Evidence.' }] }), async dispose() {} }
      } },
    }
    apply(ctx as never)
    const parent = { options: {}, session: { id: 'parent', append(type: string, data: unknown) { events.push({ type, data }) }, snapshotEvents() { return events } } } as unknown as Agent
    await expect(tools.get('hivemind_employee_panel')!.execute({ assignments: [
      { employee_id: 'ravi', task: 'Research.' }, { employee_id: 'marta', task: 'Review.' },
    ] }, { agent: parent, signal: new AbortController().signal } as never)).resolves.toMatchObject({ status: 'partial', completed: 1, failed: 1 })
    expect(events.filter(event => event.type === 'hivemind/employee-delegation-end')).toHaveLength(2)
  })

  it('hands a real employee child to native jobs and returns a pending receipt without holding the tool turn', async () => {
    const tools = new Map<string, ToolDefinition>()
    const events: Array<{ type: string; data: unknown }> = []
    let job: { run(): { cancel(): void; done: Promise<{ status: string; output?: string }> } } | undefined
    const steers: string[] = []
    const parent = {
      options: {},
      session: { id: 'pending-parent', append(type: string, data: unknown) { events.push({ type, data }) }, snapshotEvents() { return events } },
      steer(message: { content: Array<{ text?: string }> }) { steers.push(message.content[0]?.text ?? '') },
    } as unknown as Agent
    const ctx = {
      on() { return () => {} },
      get(key: string) { return key === 'jobs' ? { start(spec: typeof job) { job = spec; return 'hivemind_employee-1' } } : undefined },
      tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {} } },
      hivemindEmployeeDirectory: { async profiles() { return { profiles: [{ id: 'marta', name: 'Marta', persona: 'Review evidence.', role_archetype: 'Risk lead' }] } } },
      hivemindOperatingRuns: { startPlanSelectedEmployeeChild() { return undefined }, completeEmployeeChild() {}, failEmployeeChild() {} },
      subagents: { async start() { return { id: 'child-marta', result: Promise.resolve({ stopReason: 'completed' as const, output: [{ type: 'text' as const, text: 'Independent challenge complete.' }] }), async dispose() {} } } },
    }
    apply(ctx as never, { runInBackground: true })
    const tool = tools.get('hivemind_delegate_employee')!
    const result = await tool.execute({ employee_id: 'marta', task: 'Challenge the recommendation.' }, { agent: parent, signal: new AbortController().signal } as never)

    expect(result).toMatchObject({ status: 'pending', delegation_id: expect.any(String), job_id: 'hivemind_employee-1', employee: { id: 'marta' } })
    expect(events).toEqual([expect.objectContaining({ type: 'hivemind/employee-delegation-start', data: expect.objectContaining({ jobId: 'hivemind_employee-1', executionState: 'pending' }) })])
    if (job === undefined) throw new Error('native job was not registered')
    const outcome = await job.run().done
    expect(outcome).toMatchObject({ status: 'completed', output: 'Independent challenge complete.' })
    expect(events[1]).toMatchObject({ type: 'hivemind/employee-delegation-end', data: { childSessionId: 'child-marta', status: 'completed' } })
    expect(steers).toHaveLength(0)
  })

  it('uses an authenticated employee and freezes a bounded native child request', async () => {
    const tools = new Map<string, ToolDefinition>()
    const events: Array<{ type: string; data: unknown }> = []
    let request: Record<string, unknown> | undefined
    const parent = { options: { provider: 'cloudflare-openrouter', model: 'test-model', maxTokens: 4096 }, session: { id: 'parent-session', append(type: string, data: unknown) { events.push({ type, data }) }, snapshotEvents() { return [{ type: 'hivemind/run-plan', seq: 4, data: { playbooks: [{ id: 'global-research', version: 'v2', reason: 'fit' }] } }] } } } as unknown as Agent
    const ctx = {
      on() { return () => {} },
      tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {} } },
      hivemindEmployeeDirectory: {
        async profiles() {
          return {
            status: 'ready' as const,
            contract: 'hivemind.hyperagent-profiles.v1' as const,
            count: 1,
            profiles: [{ id: 'ravi', name: 'Ravi Patel', status: 'active', persona: 'Research evidence first.', role_archetype: 'Market researcher', active_prompt_version: { version_label: 'v7' } }],
          }
        },
      },
      subagents: {
        async start(provider: string, value: Record<string, unknown>) {
          request = { provider, ...value }
          return {
            id: 'child-ravi',
            localAgent: undefined,
            result: Promise.resolve({ stopReason: 'completed' as const, output: [{ type: 'text' as const, text: 'Evidence handoff.' }] }),
            async dispose() {},
          }
        },
      },
      hivemindOperatingRuns: { startPlanSelectedEmployeeChild() { return undefined }, completeEmployeeChild() {}, failEmployeeChild() {} },
    }
    apply(ctx as never, { provider: 'spawn', maxDepth: 1, maxTaskChars: 1000, maxOutputTokens: 2048, outputPreviewChars: 8, maxDurationMs: 30_000, denyChildTools: ['subagent_fork', 'workflow'] })
    const tool = tools.get('hivemind_delegate_employee')
    if (tool === undefined) throw new Error('delegation tool was not registered')
    const result = await tool.execute({ employee_id: 'ravi', task: 'Find evidence.', outcome: 'Verified evidence handoff.' }, { agent: parent, signal: new AbortController().signal } as never)

    expect(request).toMatchObject({ provider: 'spawn', maxDepth: 1, toolFilter: { deny: ['subagent_fork', 'workflow'] }, agentOptions: { maxTokens: 2048 } })
    expect(String(request?.persona)).toContain('Ravi Patel')
    expect(JSON.stringify(request?.prompt)).toContain('Do not repeat research already being handled by the parent')
    expect(JSON.stringify(request?.prompt)).toContain('do not call operating-context, operating-plan, employee-directory, or playbook discovery again')
    expect(JSON.stringify(request?.prompt)).toContain('at most one bounded parallel hivemind_research_gather call')
    expect(events.map(event => event.type)).toEqual(['hivemind/employee-delegation-start', 'hivemind/employee-delegation-end'])
    expect(events[0]?.data).toMatchObject({
      requestedOutput: 'Verified evidence handoff.',
      acceptanceCriteria: ['Verified evidence handoff.'],
      selectedPlaybooks: [{ id: 'global-research', version: 'v2' }],
      parentRun: { sessionId: 'parent-session', planSeq: 4 },
      budget: { maxOutputTokens: 2048, maxDurationMs: 30_000, maxDepth: 1 },
      modelRoute: { provider: 'cloudflare-openrouter', model: 'test-model', maxTokens: 4096 },
    })
    expect(events[1]?.data).toMatchObject({ status: 'completed', outputChars: 17, outputPreview: 'Evidence' })
    expect(result).toMatchObject({ status: 'completed', child_session_id: 'child-ravi', output_text: 'Evidence handoff.' })
    expect(result).toMatchObject({ employee: { profile_version: 'v7' } })
    expect(result).toMatchObject({ assignment: { review_status: 'unreviewed', playbooks: [{ id: 'global-research', version: 'v2' }] } })
    expect(tool.parameters).toMatchObject({
      type: 'object',
      required: ['employee_id', 'task'],
      properties: { employee_id: { type: 'string' }, task: { type: 'string' }, outcome: { type: 'string' } },
    })
    expect(Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties)).toEqual(['employee_id', 'task', 'outcome'])
  })

  it('allows a draft directory employee because HyperAgents lifecycle status is not an execution gate', async () => {
    const tools = new Map<string, ToolDefinition>()
    const ctx = {
      on() { return () => {} },
      tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {} } },
      hivemindEmployeeDirectory: {
        async profiles() { return { status: 'ready' as const, contract: 'hivemind.hyperagent-profiles.v1' as const, count: 1, profiles: [{ id: 'draft', name: 'Draft', status: 'draft', persona: 'x' }] } },
      },
      subagents: {
        async start() {
          return {
            id: 'child-draft',
            localAgent: undefined,
            result: Promise.resolve({ stopReason: 'completed' as const, output: [{ type: 'text' as const, text: 'Draft handoff.' }] }),
            async dispose() {},
          }
        },
      },
    }
    apply(ctx as never, { provider: 'spawn', maxDepth: 1, maxTaskChars: 1000, denyChildTools: ['subagent_fork'] })
    const tool = tools.get('hivemind_delegate_employee')
    if (tool === undefined) throw new Error('delegation tool was not registered')
    const parent = { options: {}, session: { id: 'draft-parent', append() {}, snapshotEvents() { return [] } } } as unknown as Agent
    await expect(tool.execute({ employee_id: 'draft', task: 'x' }, { agent: parent, signal: new AbortController().signal } as never))
      .resolves.toMatchObject({ status: 'completed', child_session_id: 'child-draft', output_text: 'Draft handoff.' })
  })

  it('records a paired failure when native child startup rejects', async () => {
    const tools = new Map<string, ToolDefinition>()
    const events: Array<{ type: string; data: unknown }> = []
    const ctx = {
      on() { return () => {} },
      tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {} } },
      hivemindEmployeeDirectory: {
        async profiles() { return { status: 'ready' as const, contract: 'hivemind.hyperagent-profiles.v1' as const, count: 1, profiles: [{ id: 'ravi', name: 'Ravi Patel', persona: 'Researcher.' }] } },
      },
      subagents: { async start() { throw new Error('provider unavailable') } },
    }
    apply(ctx as never)
    const tool = tools.get('hivemind_delegate_employee')
    if (tool === undefined) throw new Error('delegation tool was not registered')
    const parent = { options: {}, session: { id: 'failed-parent', append(type: string, data: unknown) { events.push({ type, data }) }, snapshotEvents() { return [] } } } as unknown as Agent

    await expect(tool.execute({ employee_id: 'ravi', task: 'Research.' }, { agent: parent, signal: new AbortController().signal } as never)).rejects.toThrow('provider unavailable')
    expect(events.map(event => event.type)).toEqual(['hivemind/employee-delegation-start', 'hivemind/employee-delegation-end'])
    expect(events[1]?.data).toMatchObject({ status: 'failed', diagnostic: 'provider unavailable' })
    expect((events[0]?.data as { delegationId: string }).delegationId).toBe((events[1]?.data as { delegationId: string }).delegationId)
  })

  it('returns and records a failed receipt when the child ends abnormally', async () => {
    const tools = new Map<string, ToolDefinition>()
    const events: Array<{ type: string; data: unknown }> = []
    const ctx = {
      on() { return () => {} },
      tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {} } },
      hivemindEmployeeDirectory: {
        async profiles() { return { status: 'ready' as const, contract: 'hivemind.hyperagent-profiles.v1' as const, count: 1, profiles: [{ id: 'marta', name: 'Marta Silva', persona: 'Risk reviewer.' }] } },
      },
      subagents: {
        async start() { return { id: 'child-marta', result: Promise.resolve({ stopReason: 'error' as const, diagnostic: 'model transport failed', output: [{ type: 'text' as const, text: 'Partial review.' }] }), async dispose() {} } },
      },
    }
    apply(ctx as never)
    const tool = tools.get('hivemind_delegate_employee')
    if (tool === undefined) throw new Error('delegation tool was not registered')
    const parent = { options: {}, session: { id: 'abnormal-parent', append(type: string, data: unknown) { events.push({ type, data }) }, snapshotEvents() { return [] } } } as unknown as Agent

    await expect(tool.execute({ employee_id: 'marta', task: 'Review claims.' }, { agent: parent, signal: new AbortController().signal } as never)).resolves.toMatchObject({ status: 'failed', stop_reason: 'error', diagnostic: 'model transport failed', output_text: 'Partial review.' })
    expect(events[1]?.data).toMatchObject({ status: 'failed', stopReason: 'error', diagnostic: 'model transport failed', outputChars: 15 })
  })

  it('continues once only to obtain a visible completion and never forces employee participation', () => {
    let stopping: ((payload: { agent: Agent; turn: number }) => void) | undefined
    const steers: string[] = []
    let events: Array<{ type: string; data: unknown }> = [
      { type: 'turn/start', data: { turn: 2 } },
      { type: 'hivemind/run-plan', data: {} },
      { type: 'tool/call', data: {} },
    ]
    const ctx = {
      on(name: string, handler: (payload: { agent: Agent; turn: number }) => void) {
        if (name === 'agent/turn-stopping') stopping = handler
        return () => {}
      },
      tools: { register() { return () => {} } },
    }
    apply(ctx as never)
    const agent = {
      session: { snapshotEvents() { return events } },
      steer(message: { content: Array<{ text?: string }> }) { steers.push(message.content[0]?.text ?? '') },
    } as unknown as Agent

    if (stopping === undefined) throw new Error('turn-stopping handler was not registered')
    stopping({ agent, turn: 2 })
    stopping({ agent, turn: 2 })
    expect(steers).toHaveLength(1)
    expect(steers[0]).toContain('visible final handoff')

    events = [
      { type: 'turn/start', data: { turn: 3 } },
      { type: 'tool/call', data: {} },
      { type: 'hivemind/employee-delegation-start', data: { delegationId: 'pending-1', executionState: 'pending' } },
    ]
    stopping({ agent, turn: 3 })
    stopping({ agent, turn: 3 })
    expect(steers).toHaveLength(1)

    events = [...events, { type: 'hivemind/employee-delegation-end', data: { delegationId: 'pending-1', status: 'completed' } }]
    stopping({ agent, turn: 3 })
    stopping({ agent, turn: 3 })
    expect(steers).toHaveLength(2)
  })

  it('links a plan-selected employee child to its workstream lifecycle', async () => {
    const tools = new Map<string, ToolDefinition>()
    const links: string[] = []
    const parent = { options: {}, session: { id: 'parent', append() {}, snapshotEvents() { return [{ type: 'hivemind/run-plan', seq: 1, data: { planId: 'plan', revision: 1, playbooks: [], workstreams: [{ id: 'review', objective: 'Review.', actor: { kind: 'employee_subagent', employeeId: 'marta' } }] } }] } } } as unknown as Agent
    const ctx = {
      on() { return () => {} }, tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {} } },
      hivemindEmployeeDirectory: { async profiles() { return { profiles: [{ id: 'marta', name: 'Marta', persona: 'Review carefully.' }] } } },
      hivemindOperatingRuns: {
        startPlanSelectedEmployeeChild(_agent: Agent, employeeId: string) { links.push(`start:review:${employeeId}`); return { workstreamId: 'review' } },
        completeEmployeeChild(_agent: Agent, id: string) { links.push(`complete:${id}`) },
        failEmployeeChild() {},
      },
      subagents: { async start() { return { id: 'child', result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'Reviewed.' }] }), async dispose() {} } } },
    }
    apply(ctx as never)
    const tool = tools.get('hivemind_delegate_employee')!
    await tool.execute({ employee_id: 'marta', task: 'Review.' }, { agent: parent, signal: new AbortController().signal } as never)
    expect(links).toEqual(['start:review:marta', 'complete:review'])
  })

  it('refuses to create a child when the active plan selected an inline employee', async () => {
    const tools = new Map<string, ToolDefinition>()
    let starts = 0
    const parent = { options: {}, session: { id: 'parent', append() {}, snapshotEvents() { return [{ type: 'hivemind/run-plan', seq: 1, data: { planId: 'plan', revision: 1, playbooks: [], workstreams: [{ id: 'review', objective: 'Review.', actor: { kind: 'inline_employee', employeeId: 'marta' } }] } }] } } } as unknown as Agent
    apply({
      on() { return () => {} },
      tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {} } },
      hivemindEmployeeDirectory: { async profiles() { return { profiles: [{ id: 'marta', name: 'Marta', persona: 'Review carefully.' }] } } },
      subagents: { async start() { starts += 1; throw new Error('must not start') } },
    } as never)
    await expect(tools.get('hivemind_delegate_employee')!.execute(
      { employee_id: 'marta', task: 'Review.' },
      { agent: parent, signal: new AbortController().signal } as never,
    )).rejects.toThrow('active plan selected inline_employee')
    expect(starts).toBe(0)
  })
})

it('requires reviewed persistent assignments for registry-native employees while preserving legacy delegation', async () => {
  const { requireReviewedEmployeePath } = await import('../src/index.ts')
  expect(() => requireReviewedEmployeePath({ id: 'legacy', status: 'running' })).not.toThrow()
  expect(() => requireReviewedEmployeePath({ id: 'native', status: 'draft', policy_rules: {
    native_lifecycle: { version: 1, phase: 'active', kind: 'durable' },
  } })).toThrow('native_employee_requires_persistent_reviewed_assignment')
  expect(() => requireReviewedEmployeePath({ id: 'expired', status: 'draft', policy_rules: {
    native_lifecycle: { version: 1, phase: 'active', kind: 'temporary', expires_at: 'invalid' },
  } })).toThrow('employee_not_available_for_work')
})
