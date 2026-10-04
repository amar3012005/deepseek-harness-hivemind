// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
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
      .toEqual(['Getting to know our team', 'Understanding our company'])
  })
  it('renders only its anchored checkpoint and does not repeat the call plan after remembering', () => {
    const renderSlot = vi.fn(() => null)
    const view = render(<RuntimeAwakening events={events('company', 'conversation', 'remembered')} turn={1} checkpointSeq={3} renderSlot={renderSlot} />)
    expect(view.queryByText('Understanding our company')).toBeNull()
    expect(view.getByText('Ready to continue')).toBeTruthy()
    expect(renderSlot).not.toHaveBeenCalled()
  })
})

it('suppresses only unchanged checkpoints, retaining meaningful updates at their own event position', () => {
  const card = { title: 'Ravi', employeeId: 'ravi', detail: 'Full specialist persona with operating instructions.' }
  const snapshot = { entries: [
    { seq: 1, summary: 'Met the employees', cards: [card] },
    { seq: 2, summary: 'Met the employees', cards: [card] },
    { seq: 3, summary: 'Ravi returned a useful finding', cards: [card] },
  ].map(item => ({ type: 'event', event: { type: 'hivemind/hq-awakening-checkpoint', seq: item.seq,
    data: { ...item, stage: 'team', turn: 1, blocked: false } } })) } as unknown as SessionEventWindow
  const source = { getSnapshot: () => snapshot, subscribe: () => () => {} }
  const view = render(<><p>Natural narration before the update</p>
    <RuntimeAwakening events={source} turn={1} checkpointSeq={2} renderSlot={() => null} />
    <p>Natural narration between stages</p>
    <RuntimeAwakening events={source} turn={1} checkpointSeq={3} renderSlot={() => null} /></>)
  expect(view.queryByText('Met the employees')).toBeNull()
  expect(view.getByText('Ravi returned a useful finding')).toBeTruthy()
  expect(view.queryByText(card.detail)).toBeNull()
  expect(view.container.textContent?.indexOf('Natural narration between stages'))
    .toBeLessThan(view.container.textContent?.indexOf('Ravi returned a useful finding') ?? 0)
})
it('keeps human summary visible and full persona behind the native Work details disclosure', () => {
  const detail = 'Detailed employee persona and operating instructions.'
  const snapshot = { entries: [{ type: 'event', event: { type: 'hivemind/hq-awakening-checkpoint', seq: 1,
    data: { stage: 'team', turn: 1, summary: 'I met Ravi and checked his availability.', blocked: false,
      cards: [{ title: 'Ravi', employeeId: 'ravi', detail }] } } }] } as unknown as SessionEventWindow
  const view = render(<RuntimeAwakening events={{ getSnapshot: () => snapshot, subscribe: () => () => {} }}
    turn={1} checkpointSeq={1} renderSlot={() => null} />)
  expect(view.getByText('I met Ravi and checked his availability.')).toBeTruthy()
  expect(view.getByRole('list', { name: 'Your team' })).toBeTruthy()
  expect(view.getAllByText('Ravi').length).toBeGreaterThan(0)
  expect(view.queryByText(detail)).toBeNull()
  fireEvent.click(view.getByRole('button', { name: 'Work details' }))
  expect(view.getByText(detail)).toBeTruthy()
})

it('shows the grounded strategy as an Awakening Plan without invented tasks', () => {
  const snapshot = { entries: [{ type: 'event', event: { type: 'hivemind/hq-awakening-checkpoint', seq: 1,
    data: { stage: 'strategy', turn: 1, summary: 'Review current customer needs before publishing.', blocked: false,
      cards: [{ title: 'Provisional customer priorities', detail: 'Review current customer needs before publishing.' }] } } }] } as unknown as SessionEventWindow
  const view = render(<RuntimeAwakening events={{ getSnapshot: () => snapshot, subscribe: () => () => {} }}
    turn={1} checkpointSeq={1} renderSlot={() => null} />)
  expect(view.getByText('Awakening Plan')).toBeTruthy()
  expect(view.getByText('Provisional customer priorities')).toBeTruthy()
  expect(view.getByText('Review current customer needs before publishing.')).toBeTruthy()
  expect(view.queryByText('Scheduled work')).toBeNull()
})

it('opens an exact saved HTML plan receipt through the shared Preview even when its title matches the summary', () => {
  const snapshot = { entries: [
    { type: 'event', event: { type: 'hivemind/generation-created', seq: 1, data: { artifactId: 'plan-1', mediaType: 'text/html' } } },
    { type: 'event', event: { type: 'hivemind/hq-awakening-checkpoint', seq: 2, data: {
      stage: 'strategy', turn: 1, summary: 'Initial priorities', cards: [{ title: 'Initial priorities', detail: 'Initial priorities', reference: 'plan-1' }], blocked: false,
    } } },
  ] } as unknown as SessionEventWindow
  const openArtifact = vi.fn()
  const view = render(<RuntimeAwakening events={{ getSnapshot: () => snapshot, subscribe: () => () => {} }}
    turn={1} checkpointSeq={2} openArtifact={openArtifact} renderSlot={() => null} />)
  fireEvent.click(view.getByRole('button', { name: 'Open plan' }))
  expect(openArtifact).toHaveBeenCalledExactlyOnceWith('plan-1')
})
