import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply, inject } from '../src/index.ts'
import { THINK_SKILLS } from '../src/think-skills.ts'

function setup(actionToolkit?: { load(agent: Agent, skill: string): Promise<readonly string[]> }) {
  const tools = new Map<string, ToolDefinition>()
  const injections: string[][] = []
  const summaries = [
    { name: 'presentation-design', description: 'Build and inspect investor presentations', invocation: { modelInvocable: true, userInvocable: true } },
    { name: 'private-command', description: 'Human only', invocation: { modelInvocable: false, userInvocable: true } },
  ]
  const ctx = {
    serial: async () => ({ id: 'owner-private-editorial', sha256: 'hash', preview: { attachmentId: 'private-pixels', mediaType: 'image/png', width: 800, height: 600, bytes: 100 } }),
    tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {} } },
    skills: {
      register() { return () => {} },
      async snapshot() { return { complete: true, skills: summaries } },
      async get(name: string) { return name === 'presentation-design' ? { ...summaries[0], content: 'Create the deck and inspect every slide.', source: 'test', provider: 'test' } : undefined },
    },
    inject(deps: string[], callback: (scope: {
      hivemindActionToolkits: typeof actionToolkit
      effect(effect: () => () => void): void
    }) => void) {
      injections.push(deps)
      if (actionToolkit) callback({ hivemindActionToolkits: actionToolkit, effect() {} })
    },
  }
  apply(ctx as never, { maxSearchResults: 5, maxQueryChars: 1000 })
  const tool = tools.get('hivemind_skills')
  if (tool === undefined) throw new Error('progressive skill tool was not registered')
  const agent = { session: { header: { cwd: '/workspace' } } } as unknown as Agent
  return { tool, agent, injections }
}

describe('hivemind progressive skills', () => {
  it('does not make the optional action toolkit a bootstrap dependency', () => {
    expect(inject).toEqual(['tools', 'skills'])
  })

  it('returns actual native reference pixels with design guidance only when Brand DNA is missing', async () => {
    const { tool, agent } = setup()
    const execution = { agent, signal: new AbortController().signal } as never
    const value = await tool.execute({ operation: 'load', name: 'design-artifact', brand_dna_missing: true, design_purpose: 'presentation' }, execution)
    expect(value).toMatchObject({ private_reference_id: 'owner-private-editorial', private_reference_image: { attachmentId: 'private-pixels' } })
    expect(await tool.execute({ operation: 'load', name: 'design-artifact', brand_dna_missing: false }, execution)).not.toHaveProperty('private_reference_image')
  })
  it('returns compact model-invocable candidates and loads one exact body', async () => {
    const { tool, agent, injections } = setup()
    const execution = { agent, signal: new AbortController().signal } as never
    expect(injections).toContainEqual(['hivemindActionToolkits'])
    await expect(tool.execute({ operation: 'search', query: 'create an investor presentation', limit: 5 }, execution)).resolves.toMatchObject({ candidates: expect.arrayContaining([expect.objectContaining({ name: 'presentation-design' })]) })
    await expect(tool.execute({ operation: 'load', name: 'presentation-design' }, execution)).resolves.toMatchObject({ skill: { name: 'presentation-design', content: 'Create the deck and inspect every slide.' } })
  })

  it('rejects unavailable and non-model skills', async () => {
    const { tool, agent } = setup()
    const execution = { agent, signal: new AbortController().signal } as never
    await expect(tool.execute({ operation: 'load', name: 'private-command' }, execution)).rejects.toThrow('unavailable skill')
  })

  it('boots without optional action credentials, keeps ordinary skill loads available, and refuses action skills', async () => {
    const { tool, agent } = setup()
    const execution = { agent, signal: new AbortController().signal } as never

    await expect(tool.execute({ operation: 'load', name: 'design-artifact' }, execution)).resolves.toMatchObject({
      status: 'ready', operation: 'load', skill: { name: 'design-artifact' },
    })
    await expect(tool.execute({ operation: 'load', name: 'parallel-search' }, execution))
      .rejects.toThrow('parallel-search requires the Cloudflare action toolkit, which is unavailable')
  })

  it('loads an action skill only through the mounted provider', async () => {
    const load = vi.fn(async (_agent: Agent, skill: string) => [skill])
    const { tool, agent } = setup({ load })
    const execution = { agent, signal: new AbortController().signal } as never

    await expect(tool.execute({ operation: 'load', name: 'parallel-search' }, execution)).resolves.toMatchObject({
      status: 'ready', operation: 'load', skill: { name: 'parallel-search' },
    })
    expect(load).toHaveBeenCalledWith(agent, 'parallel-search')
  })
})


it('keeps grounded entity search guidance in the existing shared on-demand body', () => {
  const search = THINK_SKILLS.find(skill => skill.name === 'parallel-search')
  expect(search).toBeDefined()
  expect(search?.content).toContain('verified entity context')
  expect(search?.content).toContain('omit unknown details rather than inventing')
  expect(search?.content).toContain('narrow recall query')
  expect(search?.content).toContain('not confirmed absence')
  expect(search?.content).toContain('Verify candidate identity')
  expect(search?.description).not.toContain('verified entity context')
})


it('loads reference-led design methods without an extra internal approval gate', () => {
  const design = THINK_SKILLS.find(skill => skill.name === 'design-artifact')
  expect(design?.content).toContain('User-authorized internal generation is an accepted brief')
  expect(design?.content).toContain('Default unspecified substantial written deliverables to a saved HTML artifact')
  expect(design?.content).toContain('only for an explicit human format request')
  expect(design?.content).toContain('A PDF source attachment or a generic request for a report does not select PDF output')
  expect(design?.content).toContain('references actually viewed')
  expect(design?.content).toContain('without copying the reference brand')
  expect(design?.content).toContain('purposeful large visual or illustration')
  expect(design?.content).toContain('inspect the corrected output')
})
