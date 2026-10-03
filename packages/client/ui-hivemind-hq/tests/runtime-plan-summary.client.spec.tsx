// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { RuntimePlanSummary } from '../src/client/RuntimePlanSummary.tsx'
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
    nextWakeAt: '2026-10-04T10:00:00Z', dependencies: [], authority: [], acceptanceCriteria: [], artifactIds: [] }
  const load = vi.fn().mockResolvedValue({ ok: true, value: { ...empty, tasks: [task] } })
  const view = render(<RuntimePlanSummary sessionId={'runtime' as never} turn={1} events={events}
    load={load} cancel={vi.fn()} t={key => en[key]} />)
  expect(await view.findByRole('heading', { name: 'Scheduled work' })).toBeTruthy()
  expect(view.getByText('Research')).toBeTruthy()
  expect(view.getByRole('button', { name: 'Start Call' })).toBeTruthy()
  expect(view.queryByText(/built the initial strategic plan/)).toBeNull()
})
