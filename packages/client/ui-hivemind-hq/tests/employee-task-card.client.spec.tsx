// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { RuntimeTaskCard } from '../src/client/RuntimeTaskCard.tsx'
import { employeeTaskCard } from '../src/client/employee-task-card.ts'
import type { HqWorkspaceTask } from '@deepseek-ai/dsh-hivemind-hq-runtime/client'
afterEach(cleanup)
const task = { id: 'internal-task-1', revision: 1, title: 'Buyer evidence brief', owner: 'ravi-id',
  objective: 'Investigate', status: 'pending', dependencies: [], authority: [], acceptanceCriteria: [], artifactIds: [],
  dueAt: '2026-10-05T10:05:00Z' } satisfies HqWorkspaceTask
it('uses the same task card for exact employee assignment and authoritative completed update', () => {
  const view = render(<RuntimeTaskCard task={task} employeeName="Ravi Patel" avatar={<span>Ravi logo</span>}
    startsAt="2026-10-05T10:00:00Z" endsAt="2026-10-05T10:04:00Z" />)
  expect(view.getByText(/Scheduled/)).toBeTruthy()
  expect(view.getByText(/^Starts /)).toBeTruthy()
  expect(view.queryByRole('button', { name: 'Cancel' })).toBeNull()
  expect(view.queryByText('internal-task-1')).toBeNull()
  view.rerender(<RuntimeTaskCard task={{ ...task, revision: 3, status: 'completed' }} employeeName="Ravi Patel"
    startsAt="2026-10-05T10:00:00Z" endsAt="2026-10-05T10:04:00Z" />)
  expect(view.getByText('Completed')).toBeTruthy()
  expect(view.getByText('✓')).toBeTruthy()
  expect(view.queryByText(/^Starts /)).toBeNull()
})
it('projects only the authorized snapshot event at its actual receipt position', () => {
  const event = { type: 'hivemind/employee-task-snapshot', seq: 42, data: {
    employeeId: 'ravi-id', employeeName: 'Ravi Patel', task, calendar: null,
  } }
  expect(employeeTaskCard.match(event as never)).toEqual({ id: '42', role: 'start' })
  expect(employeeTaskCard.match({ type: 'user/message', seq: 43, data: {} } as never)).toBeNull()
  const node = employeeTaskCard.buildViewNode?.({ key: 'employee-task:42', id: '42',
    start: { event: { seq: 42 }, location: { kind: 'session' } }, state: { snapshot: event.data, visible: true, seen: {} },
  } as never)
  expect(node).toMatchObject({ anchorSeq: 42, visibility: 'visible', processDisclosure: 'independent', data: event.data })
})

it('deduplicates internal revisions per task while retaining actual status transitions', () => {
  let previous: unknown
  const reader = { previous: () => previous === undefined ? undefined : { state: previous } }
  const project = (status: string, revision: number, artifactIds: string[]) => {
    const snapshot = { rootSessionId: 'runtime', employeeId: 'ravi-id', employeeName: 'Ravi Patel',
      task: { ...task, status, revision, artifactIds }, calendar: null, sourceSequence: revision }
    const state = employeeTaskCard.start({} as never, { event: { data: snapshot } } as never, reader as never)
    previous = state
    return employeeTaskCard.buildViewNode?.({ key: `card:${revision}`, id: String(revision),
      start: { event: { seq: revision }, location: { kind: 'session' } }, state,
    } as never)
  }
  expect(project('pending', 1, [])).not.toBeNull()
  expect(project('in_progress', 2, [])).not.toBeNull()
  expect(project('in_progress', 3, ['pdf'])).toBeNull()
  expect(project('in_progress', 4, ['pdf', 'html'])).toBeNull()
  expect(project('completed', 5, ['pdf', 'html'])).toMatchObject({ anchorSeq: 5, data: { task: { status: 'completed' } } })
  expect(project('completed', 6, ['pdf', 'html'])).toBeNull()
})
