import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { awakeningContext } from '../src/awakening.ts'

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
