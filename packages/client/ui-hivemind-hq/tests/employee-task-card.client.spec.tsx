// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { RuntimeTaskCard } from '../src/client/RuntimeTaskCard.tsx'
import { employeeTaskCard } from '../src/client/employee-task-card.ts'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ConversationViewNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
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
it('updates one calendar card per task across statuses and prepended history', () => {
  const assembler = new ConversationNodeAssembler({
    entries: () => [employeeTaskCard], fallbackEntry: () => undefined,
  }, { entries: () => [{ target: 'chat', create: () => ({
    empty: [] as readonly ConversationViewNode[],
    replace: ({ nodes }: { nodes: readonly ConversationViewNode[] }) => nodes,
    apply: ({ upserts }: { upserts: readonly ConversationViewNode[] }) => upserts,
  }) }] })
  assembler.activateTarget('chat')
  const receipt = (seq: number, status: string, id = task.id) => ({ type: 'event', event: {
    seq, time: 1_700_000_000_000 + seq, type: 'hivemind/employee-task-snapshot',
    data: { rootSessionId: 'runtime', employeeId: 'ravi-id', employeeName: 'Ravi Patel',
      task: { ...task, id, status, revision: seq }, calendar: null, sourceSequence: seq },
  } })
  assembler.replaceWindow([receipt(42, 'pending'), receipt(43, 'in_progress')] as never, true)
  assembler.flush()
  const initial = assembler.snapshot('chat') as readonly ConversationViewNode[]
  expect(initial).toHaveLength(1)
  expect(initial[0]).toMatchObject({ anchorSeq: 42, data: { task: { status: 'in_progress' } } })
  assembler.prepend([receipt(41, 'pending')] as never, false)
  expect(() => assembler.flush()).not.toThrow()
  expect(assembler.snapshot('chat')).toEqual([expect.objectContaining({ key: initial[0]?.key,
    anchorSeq: 41, data: expect.objectContaining({ task: expect.objectContaining({ status: 'in_progress' }) }) })])
  assembler.append(receipt(44, 'completed') as never)
  assembler.append(receipt(45, 'pending', 'another-task') as never)
  assembler.flush()
  const updated = assembler.snapshot('chat') as readonly ConversationViewNode[]
  expect(updated).toHaveLength(2)
  expect(updated).toContainEqual(expect.objectContaining({ key: initial[0]?.key,
    data: expect.objectContaining({ task: expect.objectContaining({ status: 'completed' }) }) }))
})
