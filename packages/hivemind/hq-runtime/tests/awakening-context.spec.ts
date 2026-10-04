import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { awakeningContext, installAwakening } from '../src/awakening.ts'

vi.mock('../src/rest.ts', () => ({ isHqLead: () => true }))

it('keeps an unfinished awakening briefing compact and points to native loaded guidance', async () => {
  const events = [
    { type: 'hivemind/hq-awakening-start', data: { version: 1, turn: 1 } },
    { type: 'hivemind/hq-awakening-checkpoint', data: { stage: 'company', blocked: false, summary: 'Known company' } },
  ]
  const agent = { session: { snapshotEvents: () => events } } as unknown as Agent
  const briefing = await awakeningContext({} as Context, agent, 2, [])
  expect(briefing).toContain('runtime-company-awakening')
  expect(briefing).toContain('Current unfinished checkpoint: evidence')
  expect(briefing).toContain('Known company')
  expect(briefing).not.toContain('parallel_search')
  expect(briefing).not.toContain('3–5')
  expect(briefing.length).toBeLessThan(1000)
})

it('does not reinsert awakening guidance after its conversation checkpoint', async () => {
  const events = [
    { type: 'hivemind/hq-awakening-start', data: { version: 1, turn: 1 } },
    { type: 'hivemind/hq-awakening-checkpoint', data: { stage: 'conversation', blocked: false } },
  ]
  const agent = { session: { snapshotEvents: () => events } } as unknown as Agent
  expect(await awakeningContext({} as Context, agent, 2, [])).toBe('')
})


it.each([
  ['conversation', undefined, undefined, true],
  ['conversation', 'artifact-id', undefined, false],
  ['conversation', undefined, '/api/image.png', false],
  ['company', undefined, undefined, false],
  ['strategy', undefined, undefined, false],
])('allows receipt-free invitations only without references (%s, %s, %s)', async (stage, reference, image, allowed) => {
  const register = vi.fn<(tool: ToolDefinition) => void>()
  const ctx = { effect: (callback: () => unknown) => callback(),
    tools: { register }, sessions: { flush: async () => true } } as unknown as Context
  installAwakening(ctx)
  const tool = register.mock.calls[0]?.[0]
  if (!tool) throw new Error('tool missing')
  const agent = { session: { snapshotEvents: () => [{ type: 'hivemind/hq-awakening-start', data: {} }], append: vi.fn() } }
  const result = tool.execute({ stage, summary: 'Please call when ready.', evidence_refs: [], ...(reference ? { reference } : {}), ...(image ? { image } : {}) }, { agent } as never)
  if (allowed) await expect(result).resolves.toMatchObject({ status: 'checkpoint_saved' })
  else await expect(result).rejects.toThrow('hq_awakening_receipt_required')
})


it.each(['conversation', 'company', 'strategy'])('only a plain invitation is admitted outside awakening (%s)', async (stage) => {
  const register = vi.fn<(tool: ToolDefinition) => void>()
  installAwakening({ effect: (callback: () => unknown) => callback(), tools: { register },
    sessions: { flush: async () => true } } as unknown as Context)
  const agent = { session: { snapshotEvents: () => [], append: vi.fn() } }
  const tool = register.mock.calls[0]?.[0]
  if (!tool) throw new Error('tool missing')
  const result = tool.execute({ stage, summary: 'Please call when ready.', evidence_refs: [] }, { agent } as never)
  if (stage === 'conversation') await expect(result).resolves.toMatchObject({ status: 'checkpoint_saved' })
  else await expect(result).rejects.toThrow('hq_awakening_not_started')
})
