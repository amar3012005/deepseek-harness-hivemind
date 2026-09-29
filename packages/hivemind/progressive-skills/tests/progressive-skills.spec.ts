import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.ts'

function setup() {
  const tools = new Map<string, ToolDefinition>()
  const summaries = [
    { name: 'presentation-design', description: 'Build and inspect investor presentations', invocation: { modelInvocable: true, userInvocable: true } },
    { name: 'private-command', description: 'Human only', invocation: { modelInvocable: false, userInvocable: true } },
  ]
  const ctx = {
    tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {} } },
    skills: {
      async snapshot() { return { complete: true, skills: summaries } },
      async get(name: string) { return name === 'presentation-design' ? { ...summaries[0], content: 'Create the deck and inspect every slide.', source: 'test', provider: 'test' } : undefined },
    },
  }
  apply(ctx as never, { maxSearchResults: 5, maxQueryChars: 1000 })
  const tool = tools.get('hivemind_skills')
  if (tool === undefined) throw new Error('progressive skill tool was not registered')
  const agent = { session: { header: { cwd: '/workspace' } } } as unknown as Agent
  return { tool, agent }
}

describe('hivemind progressive skills', () => {
  it('returns compact model-invocable candidates and loads one exact body', async () => {
    const { tool, agent } = setup()
    const execution = { agent, signal: new AbortController().signal } as never
    await expect(tool.execute({ operation: 'search', query: 'create an investor presentation', limit: 5 }, execution)).resolves.toMatchObject({ candidates: [{ name: 'presentation-design' }] })
    await expect(tool.execute({ operation: 'load', name: 'presentation-design' }, execution)).resolves.toMatchObject({ skill: { name: 'presentation-design', content: 'Create the deck and inspect every slide.' } })
  })

  it('rejects unavailable and non-model skills', async () => {
    const { tool, agent } = setup()
    const execution = { agent, signal: new AbortController().signal } as never
    await expect(tool.execute({ operation: 'load', name: 'private-command' }, execution)).rejects.toThrow('unavailable skill')
  })
})
