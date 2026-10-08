import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.ts'

function setup(options: { maxSearchResults?: number } = {}) {
  const tools = new Map<string, ToolDefinition>()
  const events: Array<{ type: string; data: unknown }> = []
  const injections: unknown[] = []
  const listeners = new Map<string, (...args: never[]) => unknown>()
  const agent = {
    session: {
      append(type: string, data: unknown) {
        events.push({ type, data })
      },
      snapshotEvents() {
        return events
      },
    },
    inject(message: unknown) {
      injections.push(message)
    },
  } as unknown as Agent
  const hivemindMemory = {
    async context() {
      return { company: { name: 'Singulance' } }
    },
    async recall() {
      return { results: [{ title: 'Sovereign AI positioning', content: 'GDPR-native operating layer.' }] }
    },
    async profiles() {
      return { profiles: [{ id: 'marta', name: 'Marta Silva', role_archetype: 'Risk and quality lead' }] }
    },
  }
  apply(
    {
      tools: {
        register(tool: ToolDefinition) {
          tools.set(tool.name, tool)
          return () => {}
        },
      },
      hivemindMemory,
      on(name: string, listener: (...args: never[]) => unknown) {
        listeners.set(name, listener)
        return () => {}
      },
    } as never,
    { maxSearchResults: 5, maxSelectedPlaybooks: 4, maxObjectiveChars: 2_000, maxOperatingEmployees: 4, ...options },
  )
  const operatingContextTool = tools.get('hivemind_operating_context')
  const tool = tools.get('hivemind_playbooks')
  const planTool = tools.get('hivemind_operating_plan')
  if (tool === undefined) throw new Error('playbook tool was not registered')
  if (planTool === undefined) throw new Error('operating plan tool was not registered')
  if (operatingContextTool === undefined) throw new Error('operating context tool was not registered')
  return { tool, planTool, operatingContextTool, agent, events, injections, listeners }
}

describe('hivemind playbooks', () => {
  it('keeps the standing core tools when the agent-local registry starts with only a local utility', async () => {
    const tools = new Map<string, ToolDefinition>()
    const listeners = new Map<string, (...args: unknown[]) => unknown>()
    const localTools = new Map<string, ToolDefinition>([
      ['inspect_image', { name: 'inspect_image' } as ToolDefinition],
    ])
    const agent = {
      session: {
        append() {},
        snapshotEvents() { return [] },
      },
      ctx: {
        tools: {
          // Agent-local tools are not the standing preset registry. This is
          // the exact fresh-session shape that previously made request one
          // advertise only inspect_image after the lease had retained the
          // HIVE operating core.
          schemas() { return [...localTools.values()] },
          restrict() { return () => {} },
        },
      },
    } as unknown as Agent
    apply(
      {
        tools: {
          register(tool: ToolDefinition) {
            tools.set(tool.name, tool)
            return () => {}
          },
        },
        hivemindMemory: {},
        on(name: string, listener: (...args: unknown[]) => unknown) {
          listeners.set(name, listener)
          return () => {}
        },
      } as never,
      { progressiveToolDisclosure: true },
    )
    const assembly = {
      sections: [], contexts: [], variables: {},
      tools: [...tools.values()].map(tool => ({ name: tool.name, description: '', inputSchema: { type: 'object' } })),
    }
    const projected = (await listeners.get('system-prompt/assemble')!(
      assembly,
      { agent, scope: agent },
      async () => assembly,
    )) as typeof assembly

    expect(projected.tools.map(tool => tool.name).sort()).toEqual([
      'hivemind_capabilities',
      'hivemind_operating_context',
      'hivemind_operating_plan',
    ])
    expect(projected.tools.map(tool => tool.name)).not.toContain('inspect_image')
  })

  it.each([true,false])('keeps cold-installed Runtime memory visible with Team coordination %s', async (nativeTeamCoordination) => {
    const tools = new Map<string, ToolDefinition>()
    const listeners = new Map<string, (...args: unknown[]) => unknown>()
    const events: Array<{ type: string; data: unknown }> = [{
      type: 'hivemind/run-plan', data: { planId: 'old-inline', revision: 1,
        workstreams: [{ id: 'review', actor: { kind: 'inline_employee', employeeId: 'marta' } }] },
    }]
    const scopeLocal = new Set(['team_task_list', 'team_task_get', 'team_task_create', 'team_task_update',
      'spawn_teammate', 'list_agents', 'send_message', 'wait_agent', 'interrupt_agent',
      'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete', 'runtime_user_agenda', 'runtime_uncertainties'])
    let allow: Set<string> | undefined
    const agent = { session: { append(type: string, data: unknown) { events.push({ type, data }) }, snapshotEvents() { return events } },
      ctx: { tools: { schemas() { return [...tools.values()].filter(tool => !allow || allow.has(tool.name) || scopeLocal.has(tool.name)) },
        restrict(filter: { allow: string[] }) {
          if (filter.allow.some(name => scopeLocal.has(name))) throw new Error('unknown global Team tool')
          allow = new Set(filter.allow); return () => { allow = undefined }
        },
      } } } as unknown as Agent
    apply({ tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {} } },
      hivemindMemory: {},
      on(name: string, listener: (...args: unknown[]) => unknown) { listeners.set(name, listener); return () => {} },
    } as never,
    { progressiveToolDisclosure: true, nativeTeamCoordination, employeeSubagentPlanning: true })
    const coordination = ['hivemind_hq_contract', 'hivemind_hq_blocker', 'hivemind_hq_rest', 'hivemind_administrator_message', 'team_task_list', 'team_task_get', 'team_task_create', 'team_task_update', 'spawn_teammate', 'list_agents', 'send_message', 'wait_agent', 'interrupt_agent',
      'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete', 'runtime_user_agenda', 'runtime_uncertainties']
    for (const name of coordination) tools.set(name, { name } as ToolDefinition)
    const assembly = { sections: [], contexts: [], variables: {}, tools: [...tools.values()].map(tool => ({ name: tool.name, description: '', inputSchema: { type: 'object' } })) }
    const projected = await listeners.get('system-prompt/assemble')!(assembly, { agent, scope: agent }, async () => assembly) as typeof assembly
    expect(projected.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(nativeTeamCoordination ? coordination : ['runtime_user_agenda','runtime_uncertainties']))
    const receipt = await tools.get('hivemind_capabilities')!.execute({ operation: 'lease', capabilities: ['employees'] }, { agent, signal: new AbortController().signal } as never) as { visibleTools: string[]; suppressed_capabilities?: string[] }
    expect(projected.tools.some(tool=>tool.name==='hivemind_hq_blocker')).toBe(nativeTeamCoordination)
    expect(receipt.visibleTools.includes('hivemind_hq_blocker')).toBe(nativeTeamCoordination)
    if(nativeTeamCoordination) expect(receipt.suppressed_capabilities).toBeUndefined()
    else expect(receipt.suppressed_capabilities).toEqual(['employees'])
    expect(receipt.visibleTools).toEqual(expect.arrayContaining(nativeTeamCoordination ? coordination : ['runtime_user_agenda','runtime_uncertainties']))
  })

  it('projects a compact initial tool surface and progressively restores native tools by lease', async () => {
    const tools = new Map<string, ToolDefinition>()
    const events: Array<{ type: string; data: unknown }> = []
    const listeners = new Map<string, (...args: unknown[]) => unknown>()
    let allow: Set<string> | undefined
    const scopeLocalTools = new Set<string>()
    const agent = {
      session: {
        append(type: string, data: unknown) {
          events.push({ type, data })
        },
        snapshotEvents() {
          return events
        },
      },
      ctx: {
        tools: {
          schemas() {
            return [...tools.values()].filter(
              tool => allow === undefined || allow.has(tool.name) || scopeLocalTools.has(tool.name),
            )
          },
          restrict(filter: { allow: string[] }) {
            if (filter.allow.some(name => scopeLocalTools.has(name)))
              throw new Error('tools.restrict() names unknown global tools')
            allow = new Set(filter.allow)
            return () => {
              allow = undefined
            }
          },
        },
      },
    } as unknown as Agent
    apply(
      {
        tools: {
          register(tool: ToolDefinition) {
            tools.set(tool.name, tool)
            return () => {}
          },
        },
        hivemindMemory: {},
        on(name: string, listener: (...args: unknown[]) => unknown) {
          listeners.set(name, listener)
          return () => {}
        },
      } as never,
      { progressiveToolDisclosure: true },
    )
    for (const name of [
      'ask_user_question',
      'bash',
      'read',
      'hivemind_meta',
      'hivemind_research_gather',
      'hivemind_research_answer',
      'hivemind_research_request',
      'web_fetch',
      'hivemind_browser_capture',
      'hivemind_browser_discover',
      'hivemind_skills',
      'hivemind_artifact_render',
      'hivemind_employee_panel',
      'hivemind_delegate_employee',
      'hivemind_workstream',
      'schedule_create',
      'schedule_list',
      'schedule_update',
      'schedule_delete',
    ])
      tools.set(name, { name } as ToolDefinition)
    for (const name of ['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete'])
      scopeLocalTools.add(name)
    const assembly = {
      sections: [
        { name: 'harness:source', text: 'checkout instructions' },
        { name: 'app:web-surface', text: 'web GUI instructions' },
        { name: 'tool:subagent_fork', text: 'background child guidance' },
      ],
      contexts: [],
      variables: {},
      tools: [...tools.values()].map(tool => ({ name: tool.name, description: '', inputSchema: { type: 'object' } })),
    }
    const projected = (await listeners.get('system-prompt/assemble')!(
      assembly,
      { agent, scope: agent },
      async () => assembly,
    )) as typeof assembly
    expect(projected.tools.map(tool => tool.name).sort()).toEqual([
      'ask_user_question',
      'hivemind_browser_capture',
      'hivemind_capabilities',
      'hivemind_meta',
      'hivemind_operating_context',
      'hivemind_operating_plan',
      'hivemind_research_answer',
    ])
    expect(projected.sections).toEqual([])
    expect(
      agent.ctx.tools
        .schemas()
        .map(tool => tool.name)
        .sort(),
    ).toEqual(['ask_user_question', 'hivemind_browser_capture', 'hivemind_capabilities', 'hivemind_meta', 'hivemind_operating_context', 'hivemind_operating_plan', 'hivemind_research_answer', 'schedule_create', 'schedule_delete', 'schedule_list', 'schedule_update'])
    events.push({
      type: 'hivemind/operating-context',
      data: { runId: 'run-1', objective: 'Assess risk.', employeeCandidates: [], retrieval: {} },
    })
    const afterOrientation = (await listeners.get('system-prompt/assemble')!(
      assembly,
      { agent, scope: agent },
      async () => assembly,
    )) as typeof assembly
    expect(afterOrientation.tools.map(tool => tool.name)).toContain('hivemind_meta')
    expect(afterOrientation.tools.map(tool => tool.name)).not.toContain('hivemind_operating_context')
    expect(afterOrientation.tools.map(tool => tool.name)).toContain('hivemind_capabilities')
    expect(afterOrientation.tools.map(tool => tool.name)).not.toContain('ask_user_question')
    expect(agent.ctx.tools.schemas().map(tool => tool.name)).not.toContain('hivemind_operating_context')
    expect(agent.ctx.tools.schemas().map(tool => tool.name)).toContain('hivemind_capabilities')
    expect(agent.ctx.tools.schemas().map(tool => tool.name)).not.toContain('ask_user_question')
    const capabilityTool = tools.get('hivemind_capabilities')!
    const result = (await capabilityTool.execute({ operation: 'lease', capabilities: ['workspace', 'research'] }, {
      agent,
      signal: new AbortController().signal,
    } as never)) as { visibleTools: string[] }
    expect(result.visibleTools).toEqual(
      expect.arrayContaining(['bash', 'read', 'hivemind_research_gather', 'hivemind_research_request']),
    )
    expect(agent.ctx.tools.schemas().map(tool => tool.name)).toEqual(
      expect.arrayContaining(['bash', 'read', 'hivemind_research_gather', 'hivemind_research_request']),
    )
    const scheduled = (await capabilityTool.execute({ operation: 'lease', capabilities: ['automation'] }, {
      agent,
      signal: new AbortController().signal,
    } as never)) as { visibleTools: string[] }
    expect(scheduled.visibleTools).toEqual(expect.arrayContaining([
      'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
    ]))
    expect(agent.ctx.tools.schemas().map(tool => tool.name)).toEqual(expect.arrayContaining([
      'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
    ]))
    const afterWorkspaceLease = (await listeners.get('system-prompt/assemble')!(
      assembly,
      { agent, scope: agent },
      async () => assembly,
    )) as typeof assembly
    expect(afterWorkspaceLease.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
    ]))
    expect(afterWorkspaceLease.sections.map(section => section.name)).toEqual(
      expect.arrayContaining(['harness:source', 'app:web-surface']),
    )
    await capabilityTool.execute({ operation: 'lease', capabilities: ['browser'] }, {
      agent,
      signal: new AbortController().signal,
    } as never)
    events.push({
      type: 'hivemind/browser-capability-lease',
      data: {
        expiresAt: Date.now() + 60_000,
        tools: [
          {
            name: 'mcp__singulance_browser__browser_navigate',
            description: 'Navigate a browser page.',
            parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
          },
          {
            name: 'mcp__singulance_browser__browser_snapshot',
            description: 'Read the rendered page title.',
            parameters: { type: 'object', properties: {} },
          },
        ],
      },
    })
    // Direct MCP tools live in the agent-local registry after discovery; the
    // standing assembly deliberately does not know their names yet. The
    // durable lease receipt restores their official schemas without expanding
    // the whole MCP catalog.
    const browserAssembly = assembly
    const afterBrowserDiscovery = (await listeners.get('system-prompt/assemble')!(
      browserAssembly,
      { agent, scope: agent },
      async () => browserAssembly,
    )) as typeof browserAssembly
    expect(afterBrowserDiscovery.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'mcp__singulance_browser__browser_navigate',
      'mcp__singulance_browser__browser_snapshot',
    ]))
    expect(afterBrowserDiscovery.tools.map(tool => tool.name)).not.toContain('hivemind_browser_discover')
    expect(agent.ctx.tools.schemas().map(tool => tool.name)).not.toContain('hivemind_browser_discover')
    events.push(
      { type: 'hivemind/run-plan', data: { runId: 'run-research', planId: 'plan-research', revision: 1, workstreams: [] } },
      { type: 'hivemind/research-gathered', data: { runId: 'run-research', planId: 'plan-research', gatherId: 'gather-1', status: 'succeeded', objectives: [], sources: [] } },
    )
    const afterGather = (await listeners.get('system-prompt/assemble')!(
      assembly,
      { agent, scope: agent },
      async () => assembly,
    )) as typeof assembly
    expect(afterGather.tools.map(tool => tool.name)).not.toEqual(expect.arrayContaining([
      'hivemind_operating_context', 'hivemind_playbooks', 'hivemind_research_gather', 'hivemind_research_request',
    ]))
    const suppressedLease = (await capabilityTool.execute({ operation: 'lease', capabilities: ['research', 'web'] }, {
      agent,
      signal: new AbortController().signal,
    } as never)) as { visibleTools: string[]; suppressed_tools: string[] }
    expect(suppressedLease.visibleTools).not.toEqual(expect.arrayContaining([
      'hivemind_operating_context', 'hivemind_playbooks', 'hivemind_research_gather',
      'hivemind_research_request', 'hivemind_research_status', 'web_search',
    ]))
    expect(suppressedLease.visibleTools).toContain('web_fetch')
    expect(suppressedLease.suppressed_tools).toContain('hivemind_research_gather')
    expect(agent.ctx.tools.schemas().map(tool => tool.name)).not.toContain('hivemind_operating_context')
    events.push({ type: 'hivemind/evidence-gap-recorded', data: { runId: 'run-research', planId: 'plan-research', workstreamId: 'evidence', summary: 'Missing regulator source.' } })
    const afterGapLease = (await capabilityTool.execute({ operation: 'lease', capabilities: ['research'] }, {
      agent,
      signal: new AbortController().signal,
    } as never)) as { visibleTools: string[] }
    expect(afterGapLease.visibleTools).toEqual(expect.arrayContaining([
      'hivemind_research_gather', 'hivemind_research_request',
    ]))
    const artifactResult = (await capabilityTool.execute({ operation: 'lease', capabilities: ['artifact'] }, {
      agent,
      signal: new AbortController().signal,
    } as never)) as { visibleTools: string[]; recommended_skills: string[] }
    expect(artifactResult.visibleTools).toContain('hivemind_artifact_render')
    expect(artifactResult.recommended_skills).toEqual(['hivemind-artifact-production', 'hivemind-document-design'])
    expect(agent.ctx.tools.schemas().map(tool => tool.name)).toContain('hivemind_artifact_render')
    const priorEvents = events.splice(0) // simulate a separate bounded turn
    events.push({ type: 'hivemind/artifact-created', data: { artifactId: 'pdf-1', title: 'One-page PDF' } })
    const afterArtifact = (await listeners.get('system-prompt/assemble')!(
      assembly, { agent, scope: agent }, async () => assembly,
    )) as typeof assembly
    expect(afterArtifact.tools.map(tool => tool.name)).toContain('hivemind_artifact_render')
    expect(agent.ctx.tools.schemas().map(tool => tool.name)).toContain('hivemind_artifact_render')
    events.splice(0, events.length, ...priorEvents)
    const skillsResult = (await capabilityTool.execute({ operation: 'lease', capabilities: ['skills'] }, {
      agent,
      signal: new AbortController().signal,
    } as never)) as { visibleTools: string[] }
    expect(skillsResult.visibleTools).toContain('hivemind_skills')
    expect(agent.ctx.tools.schemas().map(tool => tool.name)).toContain('hivemind_skills')
    const memoryResult = (await capabilityTool.execute({ operation: 'lease', capabilities: ['memory'] }, {
      agent,
      signal: new AbortController().signal,
    } as never)) as { visibleTools: string[] }
    expect(memoryResult.visibleTools).toContain('hivemind_meta')
    events.push({
      type: 'hivemind/run-plan',
      data: {
        runId: 'run-inline',
        planId: 'plan-inline',
        revision: 1,
        objective: 'Run inline employee work.',
        approach: 'Use the selected employee.',
        playbooks: [],
        workstreams: [{ id: 'inline-work', objective: 'Run inline work.', actor: { kind: 'inline_employee', employeeId: 'marta' } }],
      },
    })
    const employeeResult = (await capabilityTool.execute({ operation: 'lease', capabilities: ['employees'] }, {
      agent,
      signal: new AbortController().signal,
    } as never)) as { visibleTools: string[]; suppressed_capabilities: string[]; plan_fidelity: string }
    expect(employeeResult.suppressed_capabilities).toEqual(['employees'])
    expect(employeeResult.visibleTools).not.toEqual(
      expect.arrayContaining(['hivemind_delegate_employee', 'hivemind_employee_panel']),
    )
    expect(employeeResult.plan_fidelity).toContain('inline_employee')
    const resetResult = (await capabilityTool.execute({ operation: 'reset' }, {
      agent,
      signal: new AbortController().signal,
    } as never)) as { visibleTools: string[]; retained_capabilities: string[] }
    expect(resetResult.retained_capabilities).toEqual(['orchestration'])
    expect(resetResult.visibleTools).toContain('hivemind_workstream')
    expect(events.map(event => event.type)).toEqual([
      'hivemind/capability-lease',
      'hivemind/request-assembly-budget',
      'hivemind/operating-context',
      'hivemind/request-assembly-budget',
      'hivemind/capability-lease',
      'hivemind/capability-lease',
      'hivemind/request-assembly-budget',
      'hivemind/capability-lease',
      'hivemind/browser-capability-lease',
      'hivemind/request-assembly-budget',
      'hivemind/run-plan',
      'hivemind/research-gathered',
      'hivemind/request-assembly-budget',
      'hivemind/capability-lease',
      'hivemind/evidence-gap-recorded',
      'hivemind/capability-lease',
      'hivemind/capability-lease',
      'hivemind/capability-lease',
      'hivemind/capability-lease',
      'hivemind/run-plan',
      'hivemind/capability-lease',
      'hivemind/capability-lease',
    ])
  })

  it('keeps discovery executable after orientation and exposes apps only after a native lease', async () => {
    const tools = new Map<string, ToolDefinition>()
    const events: Array<{ type: string; data: unknown }> = []
    const listeners = new Map<string, (...args: unknown[]) => unknown>()
    let allow: Set<string> | undefined
    const agent = {
      session: { append(type: string, data: unknown) { events.push({ type, data }) }, snapshotEvents() { return events } },
      ctx: { tools: {
        schemas() { return [...tools.values()].filter(tool => allow === undefined || allow.has(tool.name)) },
        restrict(filter: { allow: string[] }) { allow = new Set(filter.allow); return () => { allow = undefined } },
      } },
    } as unknown as Agent
    apply({
      tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {} } },
      hivemindMemory: {},
      on(name: string, listener: (...args: unknown[]) => unknown) { listeners.set(name, listener); return () => {} },
    } as never, { progressiveToolDisclosure: true })
    for (const name of ['hivemind_app_list', 'hivemind_app_get', 'hivemind_generate']) tools.set(name, { name } as ToolDefinition)
    const assembly = { sections: [], contexts: [], variables: {}, tools: [...tools.values()].map(tool => ({ name: tool.name, description: '', inputSchema: { type: 'object' } })) }
    const assemble = async () => await listeners.get('system-prompt/assemble')!(assembly, { agent, scope: agent }, async () => assembly) as typeof assembly
    await assemble()
    events.push({ type: 'hivemind/operating-context', data: { runId: 'oriented-only' } })
    const oriented = await assemble()
    expect(oriented.tools.map(tool => tool.name)).toContain('hivemind_capabilities')
    expect(agent.ctx.tools.schemas().map(tool => tool.name)).toContain('hivemind_capabilities')
    expect(oriented.tools.map(tool => tool.name)).not.toContain('hivemind_app_list')
    expect(agent.ctx.tools.schemas().map(tool => tool.name)).not.toContain('hivemind_generate')
    await tools.get('hivemind_capabilities')!.execute({ operation: 'lease', capabilities: ['apps'] }, { agent, signal: new AbortController().signal } as never)
    const leased = await assemble()
    expect(leased.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['hivemind_capabilities', 'hivemind_app_list', 'hivemind_app_get']))
    expect(agent.ctx.tools.schemas().map(tool => tool.name)).not.toContain('hivemind_generate')
  })

  it('temporarily closes orchestration after every planned workstream is terminal', async () => {
    const tools = new Map<string, ToolDefinition>()
    const events: Array<{ type: string; data: unknown }> = []
    const listeners = new Map<string, (...args: unknown[]) => unknown>()
    let allow: Set<string> | undefined
    const agent = {
      session: {
        append(type: string, data: unknown) { events.push({ type, data }) },
        snapshotEvents() { return events },
      },
      ctx: {
        tools: {
          schemas() { return [...tools.values()].filter(tool => allow === undefined || allow.has(tool.name)) },
          restrict(filter: { allow: string[] }) {
            allow = new Set(filter.allow)
            return () => { allow = undefined }
          },
        },
      },
    } as unknown as Agent
    apply({
      tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {} } },
      hivemindMemory: {},
      on(name: string, listener: (...args: unknown[]) => unknown) { listeners.set(name, listener); return () => {} },
    } as never, { progressiveToolDisclosure: true })
    for (const name of ['hivemind_workstream', 'hivemind_research_gather', 'web_search', 'workflow', 'todo_write'])
      tools.set(name, { name } as ToolDefinition)
    const assembly = {
      sections: [
        { name: 'tool:web_search', text: 'Search again.' },
        { name: 'tool:hivemind_research_gather', text: 'Gather again.' },
      ],
      contexts: [],
      variables: {},
      tools: [...tools.values()].map(tool => ({ name: tool.name, description: '', inputSchema: { type: 'object' } })),
    }
    await listeners.get('system-prompt/assemble')!(assembly, { agent, scope: agent }, async () => assembly)
    events.push(
      {
        type: 'hivemind/run-plan',
        data: {
          runId: 'run-terminal', planId: 'plan-terminal', revision: 1,
          workstreams: [{ id: 'evidence', objective: 'Gather one evidence set.', actor: { kind: 'main' } }],
        },
      },
      {
        type: 'hivemind/workstream-completed',
        data: { runId: 'run-terminal', planId: 'plan-terminal', workstreamId: 'evidence', summary: 'done' },
      },
    )
    await tools.get('hivemind_capabilities')!.execute({ operation: 'lease', capabilities: ['orchestration'] }, {
      agent,
      signal: new AbortController().signal,
    } as never)
    const projected = (await listeners.get('system-prompt/assemble')!(
      assembly,
      { agent, scope: agent },
      async () => assembly,
    )) as typeof assembly
    expect(projected.tools.map(tool => tool.name)).toContain('hivemind_workstream')
    expect(projected.tools.map(tool => tool.name)).toContain('hivemind_capabilities')
    expect(agent.ctx.tools.schemas().map(tool => tool.name)).toContain('hivemind_capabilities')
    expect(projected.tools.map(tool => tool.name)).not.toEqual(expect.arrayContaining([
      'hivemind_operating_plan',
      'hivemind_research_gather', 'web_search', 'workflow', 'todo_write',
    ]))
    expect(projected.sections).toEqual([])
    expect(agent.ctx.tools.schemas().map(tool => tool.name)).not.toEqual(expect.arrayContaining([
      'hivemind_workstream', 'hivemind_research_gather', 'web_search',
    ]))
  })

  it('does not retain generic child-agent guidance in the inline-employee preset', async () => {
    const tools = new Map<string, ToolDefinition>()
    const listeners = new Map<string, (...args: unknown[]) => unknown>()
    const agent = {
      session: { append() {}, snapshotEvents() { return [] } },
      ctx: { tools: { schemas() { return [...tools.values()] }, restrict() { return () => {} } } },
    } as unknown as Agent
    apply({
      tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {} } },
      hivemindMemory: {},
      on(name: string, listener: (...args: unknown[]) => unknown) { listeners.set(name, listener); return () => {} },
    } as never, { progressiveToolDisclosure: true, employeeSubagentPlanning: false })
    tools.set('subagent_fork', { name: 'subagent_fork' } as ToolDefinition)
    const assembly = {
      sections: [{ name: 'tool:subagent_fork', text: 'Use subagent in the background by default.' }],
      contexts: [], variables: {},
      tools: [...tools.values()].map(tool => ({ name: tool.name, description: '', inputSchema: { type: 'object' } })),
    }
    const projected = (await listeners.get('system-prompt/assemble')!(assembly, { agent, scope: agent }, async () => assembly)) as typeof assembly
    expect(projected.sections.map(section => section.name)).not.toContain('tool:subagent_fork')
  })

  it('recommends the exact Brand DNA skill only when artifact and visual lanes meet', async () => {
    const tools = new Map<string, ToolDefinition>()
    const agent = {
      session: {
        append() {},
        snapshotEvents() {
          return []
        },
      },
      ctx: {
        tools: {
          schemas() {
            return [...tools.values()]
          },
          restrict() {
            return () => {}
          },
        },
      },
    } as unknown as Agent
    apply(
      {
        tools: {
          register(tool: ToolDefinition) {
            tools.set(tool.name, tool)
            return () => {}
          },
        },
        hivemindMemory: {},
        on() {
          return () => {}
        },
      } as never,
      { progressiveToolDisclosure: true },
    )
    for (const name of ['hivemind_skills', 'hivemind_artifact_render', 'inspect_image'])
      tools.set(name, { name } as ToolDefinition)
    const result = (await tools
      .get('hivemind_capabilities')!
      .execute({ operation: 'lease', capabilities: ['skills', 'artifact', 'visual'] }, {
        agent,
        signal: new AbortController().signal,
      } as never)) as { recommended_skills: string[] }
    expect(result.recommended_skills).toEqual(['hivemind-artifact-production', 'hivemind-document-design', 'hivemind-brand-dna'])
  })

  it('records exact fixed request attribution without changing the assembled request', async () => {
    const { agent, events, listeners } = setup()
    const listener = listeners.get('system-prompt/assemble') as unknown as (
      assembly: unknown,
      context: unknown,
      next: () => Promise<unknown>,
    ) => Promise<unknown>
    const assembly = {
      sections: [{ name: 'native', text: 'system text' }],
      contexts: [{ name: 'company', text: 'company context' }],
      tools: [{ name: 'alpha', description: 'first', inputSchema: { type: 'object' } }],
      variables: {},
    }
    await expect(listener(assembly, { agent, scope: agent }, async () => assembly)).resolves.toBe(assembly)
    expect(events.at(-1)).toEqual({
      type: 'hivemind/request-assembly-budget',
      data: expect.objectContaining({
        requestIndex: 1,
        systemChars: expect.any(Number),
        contextChars: expect.any(Number),
        toolSchemaChars: JSON.stringify(assembly.tools[0]).length,
        toolCount: 1,
        historyChars: 2,
        historyMessageCount: 0,
        tools: [{ name: 'alpha', chars: JSON.stringify(assembly.tools[0]).length }],
      }),
    })
  })

  it('caps only configured preset model requests while preserving lower explicit effort', async () => {
    let requestListener: ((_payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) | undefined
    const tools = new Map<string, ToolDefinition>()
    apply(
      {
        tools: {
          register(tool: ToolDefinition) {
            tools.set(tool.name, tool)
            return () => {}
          },
        },
        hivemindMemory: {},
        on(name: string, listener: typeof requestListener) {
          if (name === 'agent/request') requestListener = listener
          return () => {}
        },
      } as never,
      { reasoningCaps: [{ provider: 'cloudflare-openrouter', model: '@cf/zai-org/glm-5.3-flash', effort: 'off' }] },
    )
    expect(requestListener).toBeDefined()
    await expect(
      requestListener!({}, async () => ({ provider: 'cloudflare-openrouter', model: '@cf/zai-org/glm-5.3-flash' })),
    ).resolves.toMatchObject({ reasoningEffort: 'off' })
    await expect(
      requestListener!({}, async () => ({
        provider: 'cloudflare-openrouter',
        model: '@cf/zai-org/glm-5.3-flash',
        reasoningEffort: 'off',
      })),
    ).resolves.toMatchObject({ reasoningEffort: 'off' })
    await expect(
      requestListener!({}, async () => ({ provider: 'other', model: 'other', reasoningEffort: 'high' })),
    ).resolves.toMatchObject({ reasoningEffort: 'high' })
  })

  it('keeps the matching finance method and its doctrine in a compact candidate window', async () => {
    const { operatingContextTool, agent } = setup({ maxSearchResults: 3 })
    const result = await operatingContextTool.execute({ objective: 'Prepare a Finance and Legal review with hypothetical cash receipts, expenses, a spreadsheet and payment approvals.' }, {
      agent, signal: new AbortController().signal,
    } as never) as Record<string, unknown>
    expect(result.playbookCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'global-legal-finance' }),
      expect.objectContaining({ id: 'finance-legal-review', fieldMethod: 'finance-legal-review', guidanceTool: 'hivemind_field_step', capabilityLane: 'orchestration' }),
    ]))
  })

  it('prepares and durably records bounded operating context from one natural objective', async () => {
    const { operatingContextTool, agent, events, injections } = setup()
    const result = (await operatingContextTool.execute({ objective: 'Validate European demand for sovereign AI.' }, {
      agent,
      signal: new AbortController().signal,
    } as never)) as Record<string, unknown>
    expect(result).toMatchObject({
      status: 'ready',
      objective: 'Validate European demand for sovereign AI.',
      companyContext: { company: { name: 'Singulance' } },
      internalEvidence: { results: [expect.objectContaining({ title: 'Sovereign AI positioning' })] },
      playbookCandidates: expect.arrayContaining([
        expect.objectContaining({ id: 'global-research' }),
        expect.objectContaining({ id: 'eu-sovereign-ai-demand' }),
      ]),
      employeeCandidates: [{ id: 'marta', name: 'Marta Silva', role: 'Risk and quality lead' }],
      retrieval: {
        companyContext: 'ready',
        internalRecall: 'ready',
        employeeDirectory: 'ready',
        additionalRecallNeeded: false,
        externalEvidenceLikelyNeeded: false,
      },
    })
    const globalIds = new Set(result.recommendedGlobalPlaybooks as string[])
    const candidates = result.playbookCandidates as Array<Record<string, unknown>>
    expect(globalIds).toContain('global-research')
    expect(result.compatibleLocalPlaybooks).toContain('eu-sovereign-ai-demand')
    expect(
      candidates
        .filter(candidate => candidate.kind === 'local')
        .every(candidate => (candidate.parentGlobalIds as string[]).some(id => globalIds.has(id))),
    ).toBe(true)
    expect(events).toEqual([
      {
        type: 'hivemind/operating-context',
        data: expect.objectContaining({ objective: 'Validate European demand for sovereign AI.' }),
      },
    ])
    expect(injections).toHaveLength(1)
    expect(JSON.stringify(injections[0])).toContain('## Company-work orientation complete')
    expect(JSON.stringify(injections[0])).toContain('call hivemind_operating_plan once before searching')
    expect(JSON.stringify(injections[0])).toContain('Native Harness tools remain available')
  })

  it('returns a run identity, compact employee capabilities, and applicable method bodies before planning', async () => {
    const { operatingContextTool, agent, events } = setup()
    const result = (await operatingContextTool.execute(
      { objective: 'Research current regulatory risk and independently challenge the market recommendation.' },
      { agent, signal: new AbortController().signal } as never,
    )) as Record<string, unknown>
    expect(result).toMatchObject({
      runId: expect.any(String),
      capabilityGuidance: expect.arrayContaining([
        'current external evidence may be needed',
        'an independent employee review may help',
      ]),
      likelyNeeds: expect.arrayContaining([
        'current external evidence may be needed',
        'an independent employee review may help',
      ]),
      employeeCandidates: [
        expect.objectContaining({ id: 'marta', capabilities: expect.arrayContaining(['Risk and quality lead']) }),
      ],
    })
    expect(
      (result.playbookCandidates as Array<Record<string, unknown>>).every(
        playbook => typeof playbook.content === 'string',
      ),
    ).toBe(true)
    expect(events[0]).toMatchObject({ type: 'hivemind/operating-context', data: { runId: result.runId } })
  })

  it('guides branded artifacts toward progressive Brand DNA recovery without forcing a workflow', async () => {
    const { operatingContextTool, agent } = setup()
    const result = (await operatingContextTool.execute(
      { objective: 'Create an externally facing branded PDF report.' },
      { agent, signal: new AbortController().signal } as never,
    )) as Record<string, unknown>
    expect(result.capabilityGuidance).toEqual(
      expect.arrayContaining([expect.stringContaining('stored Brand DNA or recover it from the official website')]),
    )
  })

  it('keeps operating evidence compact while preserving citations and titles', async () => {
    const tools = new Map<string, ToolDefinition>()
    const events: Array<{ type: string; data: unknown }> = []
    const agent = {
      session: {
        append(type: string, data: unknown) {
          events.push({ type, data })
        },
        snapshotEvents() {
          return events
        },
      },
    } as unknown as Agent
    const hivemindMemory = {
      async context() {
        return { company: { name: 'Singulance' } }
      },
      async recall() {
        return {
          status: 'ready',
          operation: 'recall',
          result: {
            results: [
              { id: 'm1', citation_id: 'memory:m1', title: 'Evidence', content: 'x'.repeat(500) },
              { id: 'm2', title: 'Second', content: 'y'.repeat(500) },
            ],
          },
        }
      },
      async profiles() {
        return { profiles: [] }
      },
    }
    apply(
      {
        tools: {
          register(tool: ToolDefinition) {
            tools.set(tool.name, tool)
            return () => {}
          },
        },
        hivemindMemory,
        on() {
          return () => {}
        },
      } as never,
      { maxOperatingEvidenceItems: 1, maxOperatingEvidenceChars: 40 },
    )
    const result = (await tools
      .get('hivemind_operating_context')!
      .execute({ objective: 'Assess company evidence.' }, {
        agent,
        signal: new AbortController().signal,
      } as never)) as { internalEvidence: { results: Array<Record<string, unknown>> } }
    expect(result.internalEvidence.results).toEqual([
      { id: 'm1', citation_id: 'memory:m1', title: 'Evidence', content: 'x'.repeat(40) },
    ])
  })

  it('declares retrieval coverage so the model does not repeat context, recall, or profile calls', async () => {
    const { operatingContextTool, agent } = setup()
    const result = (await operatingContextTool.execute({ objective: 'Assess current regulatory risk.' }, {
      agent,
      signal: new AbortController().signal,
    } as never)) as Record<string, unknown>
    expect(result.retrieval).toMatchObject({
      companyContext: 'ready',
      internalRecall: 'ready',
      employeeDirectory: 'ready',
      additionalRecallNeeded: false,
      externalEvidenceLikelyNeeded: true,
    })
    expect(result.next).toContain('Do not repeat covered HIVE retrieval')
  })

  it('keeps native execution unrestricted while allowing an optional durable plan receipt', async () => {
    const { operatingContextTool, planTool, agent, events, listeners } = setup()
    expect(listeners.has('tools/pre-execute')).toBe(false)
    expect(listeners.has('agent/turn-stopping')).toBe(false)
    await operatingContextTool.execute(
      { objective: 'Decide whether Singulance should target German banks first and challenge regulatory risk.' },
      { agent, signal: new AbortController().signal } as never,
    )

    const result = (await planTool.execute(
      {
        objective: 'Decide whether German banks should be the first market.',
        approach: 'Synthesize company evidence, then run one independent internal challenge.',
        playbook_ids: ['global-research', 'global-legal-finance', 'eu-sovereign-ai-demand'],
      },
      { agent, signal: new AbortController().signal } as never,
    )) as Record<string, unknown>
    expect(result).toMatchObject({
      status: 'recorded',
      plan: {
        playbooks: expect.arrayContaining([
          expect.objectContaining({ id: 'global-research' }),
          expect.objectContaining({ id: 'global-legal-finance' }),
          expect.objectContaining({ id: 'eu-sovereign-ai-demand' }),
        ]),
      },
    })
    expect(events.map(event => event.type)).toEqual([
      'hivemind/operating-context',
      'hivemind/playbooks-loaded',
      'hivemind/run-plan',
      'todo/write',
    ])
    expect(events.at(-1)).toEqual({
      type: 'todo/write',
      data: {
        todos: [{
          content: '[execute_outcome] Synthesize company evidence, then run one independent internal challenge.',
          status: 'in_progress',
        }],
      },
    })
  })

  it('uses a compact entity-preserving query for the operating-context recall', async () => {
    const tools = new Map<string, ToolDefinition>()
    const agent = {
      session: {
        append() {},
        snapshotEvents() {
          return []
        },
      },
    } as unknown as Agent
    let recallRequest: { query: string; mode?: string } | undefined
    const hivemindMemory = {
      async context() {
        return { company: { name: 'Singulance' } }
      },
      async recall(request: { query: string; mode?: string }) {
        recallRequest = request
        return { status: 'ready', operation: 'recall', result: { results: [] } }
      },
      async profiles() {
        return { profiles: [] }
      },
    }
    apply({
      tools: {
        register(tool: ToolDefinition) {
          tools.set(tool.name, tool)
          return () => {}
        },
      },
      hivemindMemory,
      on() {
        return () => {}
      },
    } as never)
    await tools.get('hivemind_operating_context')!.execute(
      {
        objective:
          'Prepare a decision-ready recommendation for whether Singulance should target German banks first. Include regulatory and adoption risks.',
      },
      { agent, signal: new AbortController().signal } as never,
    )
    expect(recallRequest).toMatchObject({
      query: 'Singulance target German banks regulatory adoption risks',
      mode: 'auto',
    })
  })

  it('discovers compact global and local candidates without returning bodies', async () => {
    const { tool, agent } = setup()
    const result = (await tool.execute(
      {
        operation: 'search',
        query: 'Find and qualify hospital prospects for cold email outreach',
        domains: ['research', 'sales'],
        limit: 5,
      },
      { agent, signal: new AbortController().signal } as never,
    )) as { candidates: Array<Record<string, unknown>>; recommended_plan: Record<string, unknown> }
    expect(result.candidates.map(candidate => candidate.id)).toContain('prospect-discovery')
    expect(result.candidates.map(candidate => candidate.id)).toContain('global-outreach')
    expect(result.candidates.every(candidate => candidate.content === undefined)).toBe(true)
    expect(result.recommended_plan).toMatchObject({
      next_operation: 'load',
      playbook_ids: expect.arrayContaining(['global-outreach', 'prospect-discovery']),
    })
  })

  it('returns no method rather than inventing a global doctrine when wording has no catalog overlap', async () => {
    const { tool, agent } = setup()
    const result = (await tool.execute({ operation: 'brief', query: 'Reconcile lunar inventory nomenclature' }, {
      agent,
      signal: new AbortController().signal,
    } as never)) as {
      operation: string
      candidates: Array<Record<string, unknown>>
      recommended_plan: { playbook_ids: string[]; instruction: string }
    }
    expect(result.operation).toBe('search')
    expect(result.candidates).toEqual([])
    expect(result.recommended_plan).toEqual({
      playbook_ids: [],
      next_operation: 'load',
      instruction:
        'No catalog method matched. Continue with native Harness reasoning; do not invent or load a playbook.',
    })
  })

  it('discovers the investor deck method for a multidisciplinary fundraising artifact', async () => {
    const { tool, agent } = setup()
    const result = (await tool.execute(
      {
        operation: 'search',
        query: 'Gather compliance and market evidence and produce an investor pitch deck',
        domains: ['fundraising', 'research', 'compliance', 'finance', 'creative'],
        limit: 5,
      },
      { agent, signal: new AbortController().signal } as never,
    )) as { candidates: Array<Record<string, unknown>> }
    expect(result.candidates.map(candidate => candidate.id)).toContain('investor-evidence-deck')
  })

  it('finds the local European sovereign-AI demand method alongside the global research doctrine', async () => {
    const { tool, agent } = setup()
    const result = (await tool.execute(
      {
        operation: 'search',
        query: 'Validate European demand for sovereign AI and product prioritization',
        domains: ['research', 'strategy', 'market', 'compliance'],
        limit: 5,
      },
      { agent, signal: new AbortController().signal } as never,
    )) as { candidates: Array<Record<string, unknown>> }
    expect(result.candidates.map(candidate => candidate.id)).toContain('eu-sovereign-ai-demand')
    expect(result.candidates.map(candidate => candidate.id)).toContain('global-research')
  })

  it('loads only explicitly selected playbook bodies', async () => {
    const { tool, agent } = setup()
    const result = (await tool.execute(
      { operation: 'load', playbook_ids: ['global-research', 'competitor-research'] },
      { agent, signal: new AbortController().signal } as never,
    )) as { playbooks: Array<Record<string, unknown>> }
    expect(result.playbooks).toHaveLength(2)
    expect(result.playbooks.every(playbook => typeof playbook.content === 'string')).toBe(true)
  })

  it('loads a compatible global doctrine when a weak model selects only a local method', async () => {
    const { tool, agent, events } = setup()
    const result = (await tool.execute({ operation: 'load', playbook_ids: ['eu-sovereign-ai-demand'] }, {
      agent,
      signal: new AbortController().signal,
    } as never)) as { playbooks: Array<Record<string, unknown>> }
    expect(result.playbooks.map(playbook => playbook.id)).toEqual(['global-research', 'eu-sovereign-ai-demand'])
    expect(events).toEqual([
      {
        type: 'hivemind/playbooks-loaded',
        data: {
          playbooks: [
            { id: 'global-research', version: '1.0.0' },
            { id: 'eu-sovereign-ai-demand', version: '1.0.0' },
          ],
        },
      },
    ])
  })

  it('records a simple plan from methods already made visible to the model', async () => {
    const { operatingContextTool, tool, planTool, agent, events } = setup()
    const context = (await operatingContextTool.execute({ objective: 'Assess European sovereign AI demand.' }, {
      agent,
      signal: new AbortController().signal,
    } as never)) as { runId: string }
    await tool.execute({ operation: 'load', playbook_ids: ['eu-sovereign-ai-demand'] }, {
      agent,
      signal: new AbortController().signal,
    } as never)
    const result = (await planTool.execute(
      {
        objective: 'Assess European sovereign AI demand.',
        approach: 'Use the selected research method and return a decision-ready recommendation.',
      },
      { agent, signal: new AbortController().signal } as never,
    )) as { plan: { runId: string; playbooks: Array<{ id: string }> } }
    expect(result.plan.runId).toBe(context.runId)
    expect(result.plan.playbooks.map(playbook => playbook.id)).toEqual(['global-research', 'eu-sovereign-ai-demand'])
    expect(Object.keys((planTool.parameters as { properties: Record<string, unknown> }).properties)).toEqual([
      'objective',
      'approach',
      'playbook_ids',
      'workstreams',
    ])
    expect(events.findLast(event => event.type === 'hivemind/run-plan')).toMatchObject({
      type: 'hivemind/run-plan',
      data: { runId: context.runId },
    })
    expect(events.at(-1)).toMatchObject({ type: 'todo/write' })
  })

  it('records an adaptive plan without inventing a playbook when no method fits', async () => {
    const { operatingContextTool, planTool, agent, events } = setup()
    const context = (await operatingContextTool.execute({ objective: 'Reconcile lunar inventory nomenclature.' }, {
      agent,
      signal: new AbortController().signal,
    } as never)) as { runId: string; recommendedGlobalPlaybooks: string[]; playbookCandidates: unknown[] }
    expect(context).toMatchObject({ recommendedGlobalPlaybooks: [], playbookCandidates: [] })
    const result = (await planTool.execute(
      {
        objective: 'Resolve a novel company task.',
        approach: 'Use native Harness reasoning and the available company context.',
      },
      { agent, signal: new AbortController().signal } as never,
    )) as { plan: { runId: string; playbooks: unknown[] } }
    expect(result.plan).toMatchObject({ runId: context.runId, playbooks: [] })
    expect(events.findLast(event => event.type === 'hivemind/run-plan')).toMatchObject({
      type: 'hivemind/run-plan',
      data: { runId: context.runId, playbooks: [] },
    })
  })

  it('records selected versions and reasons as one task-local session event', async () => {
    const { tool, agent, events } = setup()
    await tool.execute({ operation: 'load', playbook_ids: ['global-research', 'prospect-discovery'] }, {
      agent,
      signal: new AbortController().signal,
    } as never)
    await tool.execute(
      {
        operation: 'record_plan',
        playbook_ids: ['global-research', 'prospect-discovery'],
        objective: 'Find qualified hospital prospects.',
        approach: 'Research, qualify, then report before outreach.',
        reason: 'Evidence-led candidate discovery before outreach.',
      },
      { agent, signal: new AbortController().signal } as never,
    )
    expect(events).toEqual([
      {
        type: 'hivemind/playbooks-loaded',
        data: {
          playbooks: [
            { id: 'global-research', version: '1.0.0' },
            { id: 'prospect-discovery', version: '1.0.0' },
          ],
        },
      },
      {
        type: 'hivemind/run-plan',
        data: expect.objectContaining({
          objective: 'Find qualified hospital prospects.',
          playbooks: [
            { id: 'global-research', version: '1.0.0', reason: 'Evidence-led candidate discovery before outreach.' },
            { id: 'prospect-discovery', version: '1.0.0', reason: 'Evidence-led candidate discovery before outreach.' },
          ],
        }),
      },
      {
        type: 'todo/write',
        data: { todos: [{ content: 'Complete and deliver the requested outcome', status: 'in_progress' }] },
      },
    ])
  })

  it('records safe receipt defaults when only selected playbooks are supplied', async () => {
    const { tool, agent, events } = setup()
    await tool.execute({ operation: 'load', playbook_ids: ['global-research'] }, {
      agent,
      signal: new AbortController().signal,
    } as never)
    await tool.execute({ operation: 'record_plan', playbook_ids: ['global-research'] }, {
      agent,
      signal: new AbortController().signal,
    } as never)
    expect(events.findLast(event => event.type === 'hivemind/run-plan')).toEqual({
      type: 'hivemind/run-plan',
      data: expect.objectContaining({
        objective: 'Operating run with the selected playbooks.',
        playbooks: [
          {
            id: 'global-research',
            version: '1.0.0',
            reason: 'Selected as the applicable operating method for this run.',
          },
        ],
      }),
    })
  })

  it('rejects unknown and duplicate playbook selections', async () => {
    const { tool, agent } = setup()
    await expect(
      tool.execute({ operation: 'load', playbook_ids: [] }, { agent, signal: new AbortController().signal } as never),
    ).rejects.toThrow('playbook_ids must contain 1 to 4 items')
    await expect(
      tool.execute({ operation: 'load', playbook_ids: ['unknown'] }, {
        agent,
        signal: new AbortController().signal,
      } as never),
    ).rejects.toThrow('unknown playbook')
    await expect(
      tool.execute({ operation: 'load', playbook_ids: ['global-research', 'global-research'] }, {
        agent,
        signal: new AbortController().signal,
      } as never),
    ).rejects.toThrow('must be unique')
  })

  it('atomically loads and records selected methods when a provider skips an explicit load call', async () => {
    const { tool, agent, events } = setup()
    const result = (await tool.execute({ operation: 'record_plan', playbook_ids: ['global-research'] }, {
      agent,
      signal: new AbortController().signal,
    } as never)) as { loaded_playbooks: Array<Record<string, unknown>> }
    expect(result.loaded_playbooks).toEqual([
      expect.objectContaining({ id: 'global-research', content: expect.any(String) }),
    ])
    expect(events).toEqual([
      {
        type: 'hivemind/run-plan',
        data: expect.objectContaining({
          playbooks: [
            {
              id: 'global-research',
              version: '1.0.0',
              reason: 'Selected as the applicable operating method for this run.',
            },
          ],
        }),
      },
      {
        type: 'todo/write',
        data: { todos: [{ content: 'Complete and deliver the requested outcome', status: 'in_progress' }] },
      },
    ])
  })

  it('records actor choices in the plan and revises that same plan durably', async () => {
    const { operatingContextTool, tool, agent, events } = setup()
    await operatingContextTool.execute({ objective: 'Assess the market.' }, {
      agent,
      signal: new AbortController().signal,
    } as never)
    const first = (await tool.execute(
      {
        operation: 'record_plan',
        playbook_ids: ['global-research'],
        objective: 'Assess the market.',
        workstreams: [
          { id: 'analysis', objective: 'Synthesize the evidence.', actor_kind: 'main' },
          { id: 'review', objective: 'Challenge the claims.', actor_kind: 'inline_employee', employee_id: 'marta' },
        ],
      },
      { agent, signal: new AbortController().signal } as never,
    )) as { plan: { planId: string } }
    await tool.execute(
      {
        operation: 'revise_plan',
        plan_id: first.plan.planId,
        revision_reason: 'Independent execution is now warranted.',
        playbook_ids: ['global-research'],
        objective: 'Assess the market.',
        workstreams: [
          {
            id: 'review',
            objective: 'Independently challenge the claims.',
            actor_kind: 'employee_subagent',
            employee_id: 'marta',
          },
        ],
      },
      { agent, signal: new AbortController().signal } as never,
    )
    expect(events).toHaveLength(6)
    expect(events[1]).toMatchObject({
      type: 'hivemind/playbooks-loaded',
      data: { playbooks: [{ id: 'global-research' }] },
    })
    expect(events[2]).toMatchObject({
      type: 'hivemind/run-plan',
      data: {
        revision: 1,
        workstreams: [{ actor: { kind: 'main' } }, { actor: { kind: 'inline_employee', employeeId: 'marta' } }],
      },
    })
    expect(events[3]).toMatchObject({ type: 'todo/write' })
    expect(events[4]).toMatchObject({
      type: 'hivemind/run-plan-revised',
      data: {
        planId: first.plan.planId,
        revision: 2,
        revisionReason: 'Independent execution is now warranted.',
        workstreams: [{ actor: { kind: 'employee_subagent', employeeId: 'marta' } }],
      },
    })
    expect(events[5]).toMatchObject({
      type: 'todo/write',
      data: { todos: [{ content: '[review] Independently challenge the claims.', status: 'in_progress' }] },
    })
  })

  it('requires authenticated employee actors to come from the current operating-context receipt', async () => {
    const { operatingContextTool, tool, agent } = setup()
    await expect(
      tool.execute(
        {
          operation: 'record_plan',
          playbook_ids: ['global-research'],
          workstreams: [{ id: 'review', objective: 'Review.', actor_kind: 'inline_employee', employee_id: 'marta' }],
        },
        { agent, signal: new AbortController().signal } as never,
      ),
    ).rejects.toThrow('retrieve operating context')
    await operatingContextTool.execute({ objective: 'Assess the market.' }, {
      agent,
      signal: new AbortController().signal,
    } as never)
    await expect(
      tool.execute(
        {
          operation: 'record_plan',
          playbook_ids: ['global-research'],
          workstreams: [
            { id: 'review', objective: 'Review.', actor_kind: 'employee_subagent', employee_id: 'invented' },
          ],
        },
        { agent, signal: new AbortController().signal } as never,
      ),
    ).rejects.toThrow('was not returned by the current operating context')
  })

  it('offers a two-field plan surface and derives methods from the current loaded receipt', async () => {
    const { operatingContextTool, tool, planTool, agent, events } = setup()
    await operatingContextTool.execute({ objective: 'Assess the market.' }, {
      agent,
      signal: new AbortController().signal,
    } as never)
    await tool.execute({ operation: 'load', playbook_ids: ['global-research'] }, {
      agent,
      signal: new AbortController().signal,
    } as never)
    await planTool.execute(
      {
        objective: 'Assess the market.',
        approach: 'Research and independently challenge the recommendation.',
      },
      { agent, signal: new AbortController().signal } as never,
    )
    expect(events.findLast(event => event.type === 'hivemind/run-plan')).toEqual({
      type: 'hivemind/run-plan',
      data: expect.objectContaining({
        objective: 'Assess the market.',
        playbooks: [expect.objectContaining({ id: 'global-research' })],
        workstreams: [{
          id: 'execute_outcome',
          objective: 'Research and independently challenge the recommendation.',
          actor: { kind: 'main' },
        }],
      }),
    })
  })

  it('keeps an unfinished operating plan idempotent so its receipts stay attached', async () => {
    const { operatingContextTool, planTool, agent, events } = setup()
    await operatingContextTool.execute({ objective: 'Compare two insurance segments.' }, {
      agent,
      signal: new AbortController().signal,
    } as never)
    const first = (await planTool.execute({
      objective: 'Compare two insurance segments.',
      approach: 'Gather evidence, then challenge the recommendation.',
      playbook_ids: ['global-research'],
      workstreams: [
        { id: 'evidence', objective: 'Gather current evidence.', actor_kind: 'main' },
        { id: 'challenge', objective: 'Challenge the recommendation.', actor_kind: 'inline_employee', employee_id: 'marta' },
      ],
    }, { agent, signal: new AbortController().signal } as never)) as { plan: { planId: string } }
    events.push({
      type: 'hivemind/research-receipt',
      data: { planId: first.plan.planId, jobId: 'research-1', evidenceState: 'ready' },
    })

    const repeated = (await planTool.execute({
      objective: 'Compare two insurance segments.',
      approach: 'Use the gathered evidence and finish the challenge.',
      playbook_ids: ['global-research'],
    }, { agent, signal: new AbortController().signal } as never)) as {
      status: string
      operation: string
      plan: { planId: string }
    }

    expect(repeated).toMatchObject({
      status: 'already_active',
      operation: 'continue_plan',
      plan: { planId: first.plan.planId },
    })
    expect(events.filter(event => event.type === 'hivemind/run-plan')).toHaveLength(1)
    expect(events.filter(event => event.type === 'todo/write')).toHaveLength(1)
    expect(events.find(event => event.type === 'hivemind/research-receipt')).toMatchObject({
      data: { planId: first.plan.planId },
    })
  })

  it('resolves an exact returned employee display name to its authenticated id', async () => {
    const { operatingContextTool, planTool, agent, events } = setup()
    await operatingContextTool.execute({ objective: 'Challenge a market recommendation.' }, {
      agent,
      signal: new AbortController().signal,
    } as never)
    await planTool.execute({
      objective: 'Challenge a market recommendation.',
      approach: 'Use the risk lead inline.',
      workstreams: [{
        id: 'challenge',
        objective: 'Challenge the recommendation.',
        actor_kind: 'inline_employee',
        employee_id: 'Marta Silva',
      }],
    }, { agent, signal: new AbortController().signal } as never)
    expect(events.findLast(event => event.type === 'hivemind/run-plan')).toEqual({
      type: 'hivemind/run-plan',
      data: expect.objectContaining({
        workstreams: [{
          id: 'challenge',
          objective: 'Challenge the recommendation.',
          actor: { kind: 'inline_employee', employeeId: 'marta' },
        }],
      }),
    })
  })

  it('derives a stable workstream id when a natural plan omits it', async () => {
    const { operatingContextTool, planTool, agent, events } = setup()
    await operatingContextTool.execute({ objective: 'Assess the market.' }, {
      agent,
      signal: new AbortController().signal,
    } as never)
    await planTool.execute({
      objective: 'Assess the market.',
      approach: 'Use one inline market perspective.',
      workstreams: [{
        objective: 'Interpret the market evidence and frame the risk challenge.',
        actor_kind: 'inline_employee',
        employee_id: 'marta',
      }],
    }, { agent, signal: new AbortController().signal } as never)
    expect(events.findLast(event => event.type === 'hivemind/run-plan')).toEqual({
      type: 'hivemind/run-plan',
      data: expect.objectContaining({
        workstreams: [expect.objectContaining({
          id: 'interpret_the_market_evidence_and_frame_the_risk_challenge',
          objective: 'Interpret the market evidence and frame the risk challenge.',
        })],
      }),
    })
  })

  it('records model-selected employee workstreams and reveals their native execution tools', async () => {
    const tools = new Map<string, ToolDefinition>()
    const events: Array<{ type: string; data: unknown }> = []
    const listeners = new Map<string, (...args: unknown[]) => unknown>()
    let allow: Set<string> | undefined
    const agent = {
      session: {
        append(type: string, data: unknown) {
          events.push({ type, data })
        },
        snapshotEvents() {
          return events
        },
      },
      ctx: {
        tools: {
          schemas() {
            return [...tools.values()].filter(tool => allow === undefined || allow.has(tool.name))
          },
          restrict(filter: { allow: string[] }) {
            allow = new Set(filter.allow)
            return () => {
              allow = undefined
            }
          },
        },
      },
    } as unknown as Agent
    const hivemindMemory = {
      async context() {
        return { company: { name: 'Singulance' } }
      },
      async recall() {
        return { results: [{ title: 'Bank evidence', content: 'Regulated German banking market.' }] }
      },
      async profiles() {
        return { profiles: [{ id: 'marta', name: 'Marta Silva', role_archetype: 'Risk lead' }] }
      },
    }
    apply(
      {
        tools: {
          register(tool: ToolDefinition) {
            tools.set(tool.name, tool)
            return () => {}
          },
        },
        hivemindMemory,
        on(name: string, listener: (...args: unknown[]) => unknown) {
          listeners.set(name, listener)
          return () => {}
        },
      } as never,
      { progressiveToolDisclosure: true },
    )
    for (const name of ['hivemind_meta', 'hivemind_delegate_employee', 'hivemind_workstream', 'workflow', 'create_goal'])
      tools.set(name, { name } as ToolDefinition)
    const assembly = {
      sections: [],
      contexts: [],
      variables: {},
      tools: [...tools.values()].map(tool => ({ name: tool.name, description: '', inputSchema: { type: 'object' } })),
    }
    await listeners.get('system-prompt/assemble')!(assembly, { agent, scope: agent }, async () => assembly)
    const context = (await tools
      .get('hivemind_operating_context')!
      .execute({ objective: 'Challenge German banking risk.' }, {
        agent,
        signal: new AbortController().signal,
      } as never)) as { playbookCandidates: Array<{ id: string }> }
    const selected = context.playbookCandidates
      .map(item => item.id)
      .filter(id => id === 'global-research' || id === 'global-legal-finance' || id === 'eu-sovereign-ai-demand')
    const result = (await tools.get('hivemind_operating_plan')!.execute(
      {
        objective: 'Decide whether to target German banks.',
        approach: 'Research, then obtain an independent risk challenge.',
        playbook_ids: selected,
        workstreams: [
          {
            id: 'challenge',
            objective: 'Challenge regulatory and adoption risk.',
            actor_kind: 'employee_subagent',
            employee_id: 'marta',
          },
        ],
      },
      { agent, signal: new AbortController().signal } as never,
    )) as { plan: { workstreams: unknown[] }; capability_lease: { visibleTools: string[] }; next_actions: unknown[] }
    expect(result.plan.workstreams).toEqual([
      expect.objectContaining({ id: 'challenge', actor: { kind: 'employee_subagent', employeeId: 'marta' } }),
    ])
    expect(result.capability_lease.visibleTools).toEqual(
      expect.arrayContaining(['hivemind_delegate_employee', 'hivemind_workstream']),
    )
    expect(result.capability_lease.visibleTools).not.toEqual(
      expect.arrayContaining(['workflow', 'create_goal']),
    )
    expect(result.next_actions).toEqual([
      expect.objectContaining({ workstream_id: 'challenge', tool: 'hivemind_delegate_employee', employee_id: 'marta' }),
    ])
    expect(events.map(event => event.type)).toEqual(
      expect.arrayContaining([
        'hivemind/operating-context',
        'hivemind/playbooks-loaded',
        'hivemind/run-plan',
        'hivemind/capability-lease',
      ]),
    )
  })

  it('returns inline employee execution as structured operating-context guidance', async () => {
    const { operatingContextTool, agent } = setup()
    const result = (await operatingContextTool.execute(
      { objective: 'Compare two markets using an authenticated employee perspective.' },
      { agent, signal: new AbortController().signal } as never,
    )) as Record<string, unknown>
    expect(result.employeeExecution).toEqual({
      defaultActorKind: 'inline_employee',
      tool: 'hivemind_workstream',
      childAgents: 'optional_escalation',
    })
    expect(result.next).toContain('employeeExecution default')
  })

  it('keeps compressed-preset employee assignments inline without removing native Harness actors', async () => {
    const tools = new Map<string, ToolDefinition>()
    const events: Array<{ type: string; data: unknown }> = []
    const agent = {
      session: {
        append(type: string, data: unknown) {
          events.push({ type, data })
        },
        snapshotEvents() {
          return events
        },
      },
      ctx: {
        tools: {
          schemas() {
            return [...tools.values()]
          },
          restrict() {
            return () => {}
          },
        },
      },
    } as unknown as Agent
    apply(
      {
        tools: {
          register(tool: ToolDefinition) {
            tools.set(tool.name, tool)
            return () => {}
          },
        },
        hivemindMemory: {
          async context() {
            return { company: { name: 'Singulance' } }
          },
          async recall() {
            return { results: [] }
          },
          async profiles() {
            return { profiles: [{ id: 'marta', name: 'Marta Silva', role_archetype: 'Risk lead' }] }
          },
        },
        on() {
          return () => {}
        },
      } as never,
      { progressiveToolDisclosure: true, employeeSubagentPlanning: false },
    )
    const operatingContext = (await tools
      .get('hivemind_operating_context')!
      .execute({ objective: 'Assess positioning risk.' }, {
        agent,
        signal: new AbortController().signal,
      } as never)) as Record<string, unknown>
    expect(operatingContext.employeeExecution).toEqual({
      defaultActorKind: 'inline_employee',
      tool: 'hivemind_workstream',
      childAgents: 'disabled_for_preset',
    })
    const planTool = tools.get('hivemind_operating_plan')!
    const planProperties = (planTool.parameters as {
      properties: {
        workstreams: { items: { properties: { actor_kind: { enum: string[] }; approval_required: { type: string } } } }
      }
    }).properties
    expect(planProperties.workstreams.items.properties.actor_kind.enum).toEqual([
      'main',
      'inline_employee',
      'dynamic_subagent',
      'workflow',
    ])
    expect(planProperties.workstreams.items.properties.approval_required.type).toBe('boolean')
    await expect(
      planTool.execute(
        {
          objective: 'Assess positioning risk.',
          approach: 'Use the authenticated risk employee.',
          workstreams: [
            { id: 'risk', objective: 'Challenge the claim.', actor_kind: 'employee_subagent', employee_id: 'marta' },
          ],
        },
        { agent, signal: new AbortController().signal } as never,
      ),
    ).rejects.toThrow('must be one of')
    const result = (await planTool.execute(
      {
        objective: 'Assess positioning risk.',
        approach: 'Use the authenticated risk employee.',
        workstreams: [
          {
            id: 'risk',
            objective: 'Challenge the claim.',
            actor_kind: 'inline_employee',
            employee_id: 'marta',
            approval_required: true,
          },
        ],
      },
      { agent, signal: new AbortController().signal } as never,
    )) as { plan: { workstreams: unknown[] }; next_actions: unknown[] }
    expect(result.plan.workstreams).toEqual([
      expect.objectContaining({
        id: 'risk',
        actor: { kind: 'inline_employee', employeeId: 'marta' },
        approvalRequired: true,
      }),
    ])
    expect(result.next_actions).toEqual([
      expect.objectContaining({
        workstream_id: 'risk',
        tool: 'hivemind_workstream',
        action: 'start',
        employee_id: 'marta',
        approval_required: true,
      }),
    ])
    expect(events.findLast(event => event.type === 'todo/write')).toEqual({
      type: 'todo/write',
      data: { todos: [{ content: '[risk] Challenge the claim.', status: 'in_progress' }] },
    })
  })

  it('reuses the operating context bound to an active plan instead of restarting orientation', async () => {
    const tools = new Map<string, ToolDefinition>()
    const events: Array<{ type: string; data: unknown }> = []
    let retrievalCalls = 0
    const agent = {
      session: {
        append(type: string, data: unknown) {
          events.push({ type, data })
        },
        snapshotEvents() {
          return events
        },
      },
      ctx: {
        tools: {
          schemas() {
            return [...tools.values()]
          },
          restrict() {
            return () => {}
          },
        },
      },
    } as unknown as Agent
    apply(
      {
        tools: {
          register(tool: ToolDefinition) {
            tools.set(tool.name, tool)
            return () => {}
          },
        },
        hivemindMemory: {
          async context() {
            retrievalCalls += 1
            return { company: { name: 'Singulance' } }
          },
          async recall() {
            retrievalCalls += 1
            return { results: [] }
          },
          async profiles() {
            retrievalCalls += 1
            return { profiles: [] }
          },
        },
        on() {
          return () => {}
        },
      } as never,
      { employeeSubagentPlanning: false },
    )
    const execution = { agent, signal: new AbortController().signal } as never
    await tools
      .get('hivemind_operating_context')!
      .execute({ objective: 'Assess German insurance positioning.' }, execution)
    const plan = (await tools.get('hivemind_operating_plan')!.execute(
      {
        objective: 'Assess German insurance positioning.',
        approach: 'Use current company evidence.',
        workstreams: [{ id: 'market', objective: 'Assess market fit.', actor_kind: 'dynamic_subagent' }],
      },
      execution,
    )) as { plan: { workstreams: unknown[] } }
    expect(plan.plan.workstreams).toEqual([
      expect.objectContaining({ id: 'market', actor: { kind: 'main' } }),
    ])

    const repeated = (await tools
      .get('hivemind_operating_context')!
      .execute({ objective: 'Assess German insurance positioning.' }, execution)) as Record<string, unknown>

    expect(repeated.status).toBe('already_ready')
    expect(repeated.active_plan).toEqual(expect.objectContaining({ revision: 1 }))
    expect(repeated.next).toContain('Continue the existing operating plan')
    expect(repeated).not.toHaveProperty('companyContext')
    expect(repeated).not.toHaveProperty('internalEvidence')
    expect(retrievalCalls).toBe(3)
    expect(events.filter(event => event.type === 'hivemind/operating-context')).toHaveLength(1)
  })

  it('collapses multiple employee child workstreams into one concurrent panel action', async () => {
    const tools = new Map<string, ToolDefinition>()
    const events: Array<{ type: string; data: unknown }> = []
    const agent = {
      session: {
        append(type: string, data: unknown) {
          events.push({ type, data })
        },
        snapshotEvents() {
          return events
        },
      },
      ctx: {
        tools: {
          schemas() {
            return [...tools.values()]
          },
          restrict() {
            return () => {}
          },
        },
      },
    } as unknown as Agent
    apply(
      {
        tools: {
          register(tool: ToolDefinition) {
            tools.set(tool.name, tool)
            return () => {}
          },
        },
        hivemindMemory: {
          async context() {
            return { company: { name: 'Singulance' } }
          },
          async recall() {
            return { results: [] }
          },
          async profiles() {
            return {
              profiles: [
                { id: 'ravi', name: 'Ravi Patel', role_archetype: 'Researcher' },
                { id: 'marta', name: 'Marta Silva', role_archetype: 'Risk lead' },
              ],
            }
          },
        },
        on() {
          return () => {}
        },
      } as never,
      { progressiveToolDisclosure: true },
    )
    for (const name of ['hivemind_employee_panel', 'hivemind_delegate_employee', 'hivemind_workstream'])
      tools.set(name, { name } as ToolDefinition)
    await tools
      .get('hivemind_operating_context')!
      .execute({ objective: 'Assess a market and challenge the result.' }, {
        agent,
        signal: new AbortController().signal,
      } as never)
    const result = (await tools.get('hivemind_operating_plan')!.execute(
      {
        objective: 'Assess a market and challenge the result.',
        approach: 'Run independent specialist work concurrently.',
        playbook_ids: ['global-research'],
        workstreams: [
          {
            id: 'research',
            objective: 'Assess demand.',
            outcome: 'Evidence handoff.',
            actor_kind: 'employee_subagent',
            employee_id: 'ravi',
          },
          {
            id: 'challenge',
            objective: 'Challenge adoption risk.',
            outcome: 'Risk handoff.',
            actor_kind: 'employee_subagent',
            employee_id: 'marta',
          },
        ],
      },
      { agent, signal: new AbortController().signal } as never,
    )) as { capability_lease: { visibleTools: string[] }; next_actions: unknown[] }
    expect(result.capability_lease.visibleTools).toContain('hivemind_employee_panel')
    expect(result.next_actions).toEqual([
      {
        tool: 'hivemind_employee_panel',
        assignments: [
          { workstream_id: 'research', employee_id: 'ravi', task: 'Assess demand.', outcome: 'Evidence handoff.' },
          {
            workstream_id: 'challenge',
            employee_id: 'marta',
            task: 'Challenge adoption risk.',
            outcome: 'Risk handoff.',
          },
        ],
      },
    ])
  })

  it('rejects incomplete actor choices and stale plan revisions', async () => {
    const { tool, agent } = setup()
    await expect(
      tool.execute(
        {
          operation: 'record_plan',
          playbook_ids: ['global-research'],
          workstreams: [{ id: 'review', objective: 'Review.', actor_kind: 'inline_employee' }],
        },
        { agent, signal: new AbortController().signal } as never,
      ),
    ).rejects.toThrow('requires employee_id')
    await expect(
      tool.execute(
        { operation: 'revise_plan', plan_id: 'stale', revision_reason: 'Change.', playbook_ids: ['global-research'] },
        { agent, signal: new AbortController().signal } as never,
      ),
    ).rejects.toThrow('not the current operating plan')
  })
})
