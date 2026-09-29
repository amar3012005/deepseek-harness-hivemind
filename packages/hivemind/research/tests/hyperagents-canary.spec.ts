import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply as applyDelegation } from '../../employee-delegation/src/index.ts'
import { apply as applyPlaybooks } from '../../playbooks/src/index.ts'
import { apply as applyResearch } from '../src/index.ts'

/**
 * Composition canary for HyperAgents: research remains provider-neutral, and
 * the parent may use its receipt to decide whether a real employee subagent is
 * useful. No planner is hard-coded here; this only proves the native Cordis
 * tools, receipts, and child-session boundary compose in one preset.
 */
describe('HyperAgents research-to-employee composition', () => {
  it('keeps the research receipt before a bounded employee handoff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hivemind-hyperagents-canary-'))
    const authorityPath = join(root, 'icarus.json')
    await writeFile(authorityPath, JSON.stringify({ hivemind: { connected: true, token: 'canary-token', apiUrl: 'http://127.0.0.1:8787' } }), { mode: 0o600 })
    const tools = new Map<string, ToolDefinition>()
    const events: Array<{ type: string; data: unknown }> = []
    let employeeJob: { run(): { cancel(): void; done: Promise<{ status: string; output?: string }> } } | undefined
    const ctx = {
      on() { return () => {} },
      get(key: string) {
        return key === 'jobs'
          ? { start(spec: typeof employeeJob) { employeeJob = spec; return 'hivemind_employee-1' } }
          : undefined
      },
      tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {} } },
      hivemindExecutionScope: { require() { return { userId: 'user-1', orgId: 'org-1', profile: 'hyperagents' as const, variation: 'canary' } } },
      hivemindEmployeeDirectory: {
        async profiles() {
          return { status: 'ready' as const, contract: 'hivemind.hyperagent-profiles.v1' as const, count: 1, profiles: [{ id: 'researcher', name: 'Researcher', slug: 'researcher', role_archetype: 'Evidence analyst', persona: 'Gather and qualify independent evidence.', status: 'active' }] }
        },
      },
      hivemindMemory: {
        async context() { return { company: { name: 'Singulance' } } },
        async recall() { return { status: 'ready', results: [{ id: 'memory-1', title: 'Sovereign AI positioning', content: 'GDPR-native AI operating layer.' }] } },
        async profiles() { return { profiles: [{ id: 'researcher', name: 'Researcher', role_archetype: 'Evidence analyst' }] } },
      },
      subagents: {
        async start(_provider: string, _value: Record<string, unknown>) {
          return { id: 'child-researcher', result: Promise.resolve({ stopReason: 'completed' as const, output: [{ type: 'text' as const, text: 'Qualified evidence handoff.' }] }), async dispose() {} }
        },
      },
    }
    const parent = { options: { provider: 'test-provider', model: 'test-model' }, session: { id: 'canary-parent', append(type: string, data: unknown) { events.push({ type, data }) }, snapshotEvents() { return events.map((event, index) => ({ ...event, seq: index + 1 })) } } } as unknown as Agent
    applyResearch(ctx as never, { icarusConfigPath: authorityPath, maxResults: 3, maxUrls: 2 })
    applyDelegation(ctx as never, { provider: 'spawn', maxDepth: 1, maxTaskChars: 1000, runInBackground: true })
    applyPlaybooks(ctx as never, { maxSearchResults: 5, maxSelectedPlaybooks: 4 })
    const operatingContext = tools.get('hivemind_operating_context')
    const playbooks = tools.get('hivemind_playbooks')
    const plan = tools.get('hivemind_operating_plan')
    const request = tools.get('hivemind_research_request')
    const status = tools.get('hivemind_research_status')
    const delegate = tools.get('hivemind_delegate_employee')
    if (operatingContext === undefined || playbooks === undefined || plan === undefined || request === undefined || status === undefined || delegate === undefined) throw new Error('HyperAgents tools were not registered')

    const objective = 'Validate European demand for sovereign AI and independently challenge the risks.'
    const discovered = await operatingContext.execute(
      { objective }, { agent: parent, signal: new AbortController().signal } as never,
    ) as { runId: string; recommendedGlobalPlaybooks: string[]; compatibleLocalPlaybooks: string[] }
    expect(discovered).toMatchObject({ recommendedGlobalPlaybooks: expect.arrayContaining(['global-research']), compatibleLocalPlaybooks: expect.arrayContaining(['eu-sovereign-ai-demand']) })
    await playbooks.execute({ operation: 'load', playbook_ids: ['global-research', 'eu-sovereign-ai-demand'] }, { agent: parent, signal: new AbortController().signal } as never)
    await plan.execute({ objective, approach: 'Gather current evidence, then obtain an independent employee challenge.' }, { agent: parent, signal: new AbortController().signal } as never)

    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ job_id: 'research-canary', status: 'queued' }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'research-canary', status: 'succeeded', runtime_used: 'tavily', results: [{ title: 'Official evidence', url: 'https://example.test/evidence', snippet: 'Verified source.' }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)

    const started = await request.execute({ objective: 'Find current evidence.', research_type: 'focused_fact', limit: 1, wait_for_result: false }, { agent: parent, signal: new AbortController().signal } as never) as { research: { jobId: string } }
    const receipt = await status.execute(
      { job_id: started.research.jobId }, { agent: parent, signal: new AbortController().signal } as never,
    ) as { receipt: { evidenceState: string; sources: Array<{ url: string }> } }
    expect(receipt.receipt).toMatchObject({ evidenceState: 'ready', sources: [{ url: 'https://example.test/evidence' }] })

    const handoff = await delegate.execute({ employee_id: 'researcher', task: 'Qualify the cited evidence.' }, { agent: parent, signal: new AbortController().signal } as never)
    expect(handoff).toMatchObject({ status: 'pending', job_id: 'hivemind_employee-1', employee: { id: 'researcher' } })
    if (employeeJob === undefined) throw new Error('employee delegation did not create a native job')
    await expect(employeeJob.run().done).resolves.toMatchObject({ status: 'completed', output: 'Qualified evidence handoff.' })
    expect(events.map(event => event.type)).toEqual([
      'hivemind/operating-context',
      'hivemind/playbooks-loaded',
      'hivemind/run-plan',
      'todo/write',
      'hivemind/research-requested',
      'hivemind/research-receipt',
      'hivemind/employee-delegation-start',
      'hivemind/employee-delegation-end',
    ])
  })
})
