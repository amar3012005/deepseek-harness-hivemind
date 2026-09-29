import { expect, it, vi } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { registerFieldMethods } from '../src/field-methods.ts'

it('loads only the chosen stage as a replaceable native snapshot without executing a workflow', async () => {
  let tool: ToolDefinition | undefined
  registerFieldMethods({ tools: { register(value: ToolDefinition) { tool = value } } } as never)
  if (!tool) throw new Error('Field tool not registered')
  const inject = vi.fn()
  const execution = { agent: { inject }, signal: new AbortController().signal } as never
  const listing = await tool.execute({ method: 'campaign-launch' }, execution)
  expect(listing).toMatchObject({ workflow_ref: 'native:workflow', stages: expect.arrayContaining(['brand', 'review']) })
  expect(inject).not.toHaveBeenCalled()
  await tool.execute({ method: 'campaign-launch', stage: 'brand' }, execution)
  await tool.execute({ method: 'campaign-launch', stage: 'review' }, execution)
  expect(inject).toHaveBeenCalledTimes(2)
  for (const [message] of inject.mock.calls) {
    expect(message).toMatchObject({ source: { form: 'snapshot', sections: [{ name: 'hivemind:field-stage' }] } })
  }
  await expect(tool.execute({ method: 'campaign-launch', stage: 'invented' }, execution)).rejects.toThrow('Available stages')
  expect(inject).toHaveBeenCalledTimes(2)
})
