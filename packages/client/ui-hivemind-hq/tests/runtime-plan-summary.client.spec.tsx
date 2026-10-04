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
  expect(await view.findByRole('heading', { name: 'Scheduled work' })).toBeTruthy()
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
  expect(view.getByText(/^Starts /)).toBeTruthy()
  expect(view.getByText(/^Work window ends /)).toBeTruthy()
  expect(view.getByText(/^Due /)).toBeTruthy()
  expect(view.getByRole('button', { name: 'Cancel' })).toBeTruthy()
  expect(view.getByRole('button', { name: 'Start Call' })).toBeTruthy()
  expect(view.container.textContent?.indexOf('Due ')).toBeLessThan(view.container.textContent?.indexOf(en['call.title']) ?? 0)
})
