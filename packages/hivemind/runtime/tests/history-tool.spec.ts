import { expect, it, vi } from 'vitest'
import { installHistoryTool } from '../src/history-tool.ts'

it('reads only the owning session and pages the full original event within the complete output budget', async () => {
  let tool: { execute: (args: unknown, execution: unknown) => Promise<string> } | undefined
  const original = { seq: 17, data: { text: '\\"\n'.repeat(20_000) } }
  const readEvent = vi.fn(async (_request: unknown) => ({ target: original }))
  installHistoryTool({
    effect: (f: () => unknown) => f(),
    tools: { register: (value: NonNullable<typeof tool>) => { tool = value } },
    get: () => ({ readEvent }),
  } as never, 2000)
  if (!tool) throw new Error('tool missing')
  const execution = { agent: { session: { id: 'own-room' } }, signal: new AbortController().signal }
  let offset = 0, joined = ''
  do {
    const output = await tool.execute({ sequence: 17, offset }, execution)
    expect(output.length).toBeLessThanOrEqual(2000)
    const value = JSON.parse(output)
    joined += value.text
    offset = value.next_offset
  } while (offset !== null)
  expect(joined).toBe(JSON.stringify(original))
  expect(readEvent.mock.calls[0]?.[0]).toEqual({ sessionId: 'own-room', seq: 17, before: 0, after: 0 })
})
