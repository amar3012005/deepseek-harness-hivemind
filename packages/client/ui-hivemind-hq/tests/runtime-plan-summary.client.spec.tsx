// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { RuntimePlanSummary, FinalRuntimePlanSummary } from '../src/client/RuntimePlanSummary.tsx'
import { en } from '../src/client/locales.ts'
import type { SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
afterEach(cleanup)
const snapshot = { entries: [{ type: 'event', event: {
  type: 'hivemind/hq-awakening-checkpoint', data: { turn: 1, stage: 'conversation', blocked: false, cards: [] },
} }] } as unknown as SessionEventWindow
const events = { getSnapshot: () => snapshot, subscribe: () => () => {} }
const empty = { mode: { enabled: true, revision: 1, changedAt: 1 }, tasks: [], calendar: [], wakes: [] }
it('keeps the call invitation without claiming a plan or schedule when no tasks were saved', async () => {
  const load = vi.fn().mockResolvedValue({ ok: true, value: empty })
  const view = render(<RuntimePlanSummary sessionId={'runtime' as never} turn={1} events={events}
    load={load} cancel={vi.fn()} t={key => en[key]} />)
  await vi.waitFor(() => expect(view.queryByRole('status')).toBeNull())
  expect(view.getByRole('button', { name: 'Start Call' })).toBeTruthy()
  expect(view.queryByRole('heading')).toBeNull()
  expect(view.queryByText(/saved schedule|saved assignments|built the initial/)).toBeNull()
})
it('shows saved assignments only when records contain scheduled tasks', async () => {
  const task = { id: 'task-1', revision: 1, title: 'Research', objective: 'Brief', status: 'pending', owner: 'Ravi',
    nextWakeAt: '2026-10-04T10:00:00Z', dueAt: '2026-10-04T11:00:00Z', dependencies: [], authority: [], acceptanceCriteria: [], artifactIds: [] }
  const load = vi.fn().mockResolvedValue({ ok: true, value: { ...empty, tasks: [task] } })
  const view = render(<RuntimePlanSummary sessionId={'runtime' as never} turn={1} events={events}
    load={load} cancel={vi.fn()} t={key => en[key]} />)
  expect(await view.findByRole('heading', { name: 'Assigned work' })).toBeTruthy()
  expect(view.getByText('Research')).toBeTruthy()
  expect(view.getByText(/^Due /)).toBeTruthy()
  expect(view.getByRole('button', { name: 'Cancel' })).toBeTruthy()
  expect(view.getByRole('button', { name: 'Start Call' })).toBeTruthy()
  expect(view.queryByText(/built the initial strategic plan/)).toBeNull()
})

it('does not show a final invitation while the awakening turn is running', () => {
  const load = vi.fn().mockResolvedValue({ ok: true, value: empty })
  const view = render(<FinalRuntimePlanSummary sessionId={'runtime' as never}
    turn={{ turn: 1, end: undefined } as never} events={events} load={load} cancel={vi.fn()} t={key => en[key]} />)
  expect(view.queryByRole('button', { name: 'Start Call' })).toBeNull()
  expect(load).not.toHaveBeenCalled()
})
it('ordinary completed turns without an invitation remain unchanged', () => {
  const ordinary = { entries: [] } as unknown as SessionEventWindow
  const load = vi.fn()
  const view = render(<FinalRuntimePlanSummary sessionId={'runtime' as never} turn={{ turn: 1, end: {} } as never}
    events={{ getSnapshot: () => ordinary, subscribe: () => () => {} }} load={load} cancel={vi.fn()} t={key => en[key]} />)
  expect(view.queryByRole('button', { name: 'Start Call' })).toBeNull()
  expect(load).not.toHaveBeenCalled()
})

it('shows the final call after completion, with saved assignment start, window, due time and native cancel', async () => {
  const task = { id: 'task-1', revision: 7, title: 'Write the brief', objective: 'Brief', status: 'pending', owner: 'Ravi',
    dueAt: '2026-10-04T11:00:00Z', dependencies: [], authority: [], acceptanceCriteria: [], artifactIds: [] }
  const calendar = [{ id: 'assignment', revision: 1, kind: 'assignment', taskId: task.id, title: task.title, owner: 'Ravi',
    startsAt: '2026-10-04T10:00:00Z', endsAt: '2026-10-04T10:30:00Z', resolved: false }]
  const load = vi.fn().mockResolvedValue({ ok: true, value: { ...empty, tasks: [task], calendar } })
  const view = render(<FinalRuntimePlanSummary sessionId={'runtime' as never} turn={{ turn: 1, end: {} } as never}
    events={events} load={load} cancel={vi.fn()} t={key => en[key]} />)
  expect(await view.findByText('Write the brief')).toBeTruthy()
  expect(view.getByText(/Scheduled/)).toBeTruthy()
  expect(view.getByText(/^Starts /)).toBeTruthy()
  expect(view.getByText(/^Work window ends /)).toBeTruthy()
  expect(view.getByText(/^Due /)).toBeTruthy()
  expect(view.getByRole('button', { name: 'Cancel' })).toBeTruthy()
  expect(view.getByRole('button', { name: 'Start Call' })).toBeTruthy()
  expect(view.container.textContent?.indexOf('Due ')).toBeLessThan(view.container.textContent?.indexOf(en['call.title']) ?? 0)
})

it('shows actual saved assignments on an ordinary scheduling turn without a call invitation', async () => {
  const scheduleSnapshot = { entries: [
    { type: 'event', event: { type: 'turn/start', data: { turn: 2 } } },
    { type: 'event', event: { type: 'hivemind/hq-calendar-item', data: { kind: 'assignment' } } },
  ] } as unknown as SessionEventWindow
  const scheduleEvents = { getSnapshot: () => scheduleSnapshot, subscribe: () => () => {} }
  const load = vi.fn().mockResolvedValue({ ok: true, value: { ...empty, tasks: [{
    id: 'task-1', title: 'Launch brief', owner: 'ravi', status: 'pending', revision: 1,
    nextWakeAt: '2026-10-04T12:00:00Z', dueAt: '2026-10-04T12:05:00Z',
  }] } })
  const view = render(<RuntimePlanSummary sessionId={'runtime' as never} turn={2}
    events={scheduleEvents} load={load} cancel={vi.fn()} t={key => en[key]} />)
  await vi.waitFor(() => expect(view.getByText('Launch brief')).toBeTruthy())
  expect(view.getByRole('button', { name: 'Cancel' })).toBeTruthy()
  expect(view.queryByRole('button', { name: 'Start Call' })).toBeNull()
})

it('shows receipt-backed completed status separately from the call invitation', async () => {
  const load = vi.fn().mockResolvedValue({ ok: true, value: { ...empty, tasks: [{
    id: 'task-1', title: 'Reviewed brief', owner: 'ravi', status: 'completed', revision: 3,
    nextWakeAt: '2026-10-04T12:00:00Z', dueAt: '2026-10-04T12:05:00Z',
  }] } })
  const reviewed = { entries: [...snapshot.entries,
    { type: 'event', event: { type: 'turn/start', data: { turn: 1 } } },
    { type: 'event', event: { type: 'hivemind/hq-task-review', data: { taskId: 'task-1' } } },
  ] } as unknown as SessionEventWindow
  const view = render(<RuntimePlanSummary sessionId={'runtime' as never} turn={1}
    events={{ getSnapshot: () => reviewed, subscribe: () => () => {} }} load={load} cancel={vi.fn()} t={key => en[key]} />)
  await view.findByRole('heading', { name: 'Completed work' })
  expect(view.getByText('Completed')).toBeTruthy()
  expect(view.queryByRole('button', { name: 'Cancel' })).toBeNull()
  expect(view.queryByText(/^Starts /)).toBeNull()
  expect(view.getByText('Past schedule')).toBeTruthy()
  expect(view.getByRole('button', { name: 'Start Call' }).closest('[aria-label="Assigned work"]')).toBeNull()
})

it('keeps one current summary and omits acknowledged completed work on a later invitation', async () => {
  const updated = { entries: [...snapshot.entries,
    { type: 'event', event: { type: 'hivemind/hq-awakening-checkpoint',
      data: { turn: 2, stage: 'conversation', blocked: false, cards: [] } } },
  ] } as unknown as SessionEventWindow
  const shared = { getSnapshot: () => updated, subscribe: () => () => {} }
  const load = vi.fn().mockResolvedValue({ ok: true, value: { ...empty, tasks: [{
    id: 'task-1', title: 'Old completed café', status: 'completed', nextWakeAt: '2026-10-04T12:00:00Z',
  }] } })
  const props = { sessionId: 'runtime' as never, events: shared, load, cancel: vi.fn(), t: (key: keyof typeof en) => en[key] }
  const view = render(<><RuntimePlanSummary {...props} turn={1} /><RuntimePlanSummary {...props} turn={2} /></>)
  await vi.waitFor(() => expect(view.queryByRole('status')).toBeNull())
  expect(view.queryByText('Old completed café')).toBeNull()
  expect(view.getAllByRole('button', { name: 'Start Call' })).toHaveLength(1)
})

it('labels active native work as in progress rather than scheduled', async () => {
  const load = vi.fn().mockResolvedValue({ ok: true, value: { ...empty, tasks: [{
    id: 'task-1', title: 'Active brief', owner: 'ravi', status: 'in_progress', revision: 2,
    nextWakeAt: '2026-10-04T12:00:00Z',
  }] } })
  const view = render(<RuntimePlanSummary sessionId={'runtime' as never} turn={1}
    events={events} load={load} cancel={vi.fn()} t={key => en[key]} />)
  expect(await view.findByText(/In progress/)).toBeTruthy()
  expect(view.queryByText(/Scheduled/)).toBeNull()
  expect(view.queryByRole('button', { name: 'Cancel' })).toBeNull()
})
