// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import { RuntimeAwakening } from '../src/client/RuntimeAwakening.tsx'
afterEach(cleanup)
function events(...stages: string[]) {
  const window = { entries: stages.map((stage, index) => ({ type: 'event', event: {
    type: 'hivemind/hq-awakening-checkpoint', seq: index + 1,
    data: { stage, turn: 1, summary: stage, blocked: false, cards: [] },
  } })) } as unknown as SessionEventWindow
  return { getSnapshot: () => window, subscribe: () => () => {} }
}
describe('chronological Runtime evidence', () => {
  it('keeps event order rather than sorting into a prescribed workflow', () => {
    const view = render(<RuntimeAwakening events={events('team', 'company')} turn={1} renderSlot={() => null} />)
    expect([...view.container.querySelectorAll('header strong')].map(item => item.textContent))
      .toEqual(['Getting to know your team', 'Understanding your company'])
  })
  it('renders only its anchored checkpoint and does not repeat the call plan after remembering', () => {
    const renderSlot = vi.fn(() => null)
    const view = render(<RuntimeAwakening events={events('company', 'conversation', 'remembered')} turn={1} checkpointSeq={3} renderSlot={renderSlot} />)
    expect(view.queryByText('Understanding your company')).toBeNull()
    expect(view.getByText('Ready to continue')).toBeTruthy()
    expect(renderSlot).not.toHaveBeenCalled()
  })
})
