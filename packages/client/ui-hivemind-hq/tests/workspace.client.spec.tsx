// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { CompanyWorkspace, localDay } from '../src/client/CompanyWorkspace.tsx'
afterEach(cleanup)
it('shows native completion separately from a delivered wake and preserves receipts', async () => {
  const data = { mode: { enabled: false, revision: 2, changedAt: 1 }, calendar: [],
    tasks: [{ id: 'task-1', revision: 3, title: 'Research insurers', objective: 'Public sources only', status: 'in_progress', owner: 'Ravi', dependencies: [], authority: [], acceptanceCriteria: ['Saved report'], artifactIds: [], sessionId: 'ravi' }],
    wakes: [{ id: 'wake-1', title: 'Research wake', kind: 'at', scheduledAt: new Date().toISOString(), status: 'inactive', deliveredAt: '2026-09-30T10:00:00Z' }] }
  const openSession = vi.fn()
  render(<CompanyWorkspace sessionId={'hq' as SessionId} load={vi.fn().mockResolvedValue({ ok: true, value: data })} plan={vi.fn()} history={vi.fn()} progress={vi.fn().mockResolvedValue({ ok: true, value: { taskId: 'task-1', sessionId: null, todos: [] } })} subscribe={() => () => {}} openSession={openSession} />)
  await screen.findByText('Autonomous mode paused · 1 native assignments')
  fireEvent.click(screen.getByRole('button', { name: 'Daily agenda' }))
  fireEvent.click(screen.getByRole('button', { name: /Research insurers Ravi/ }))
  expect(screen.getByText('No linked saved artifact receipt.')).toBeTruthy()
  expect(screen.getByText('A delivered wake acknowledges inbox delivery, not task completion.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Open employee session' }))
  expect(openSession).toHaveBeenCalledWith('ravi')
})
it('uses local dates across timezone boundaries', () => {
  expect(localDay('2026-09-30T23:30:00Z', 'Europe/Berlin')).toBe('2026-10-01')
})
it('does not create a duplicate planning item after a lost acknowledgement', async () => {
  const empty = { mode: { enabled: false, revision: 0, changedAt: 0 }, tasks: [], wakes: [], calendar: [] }
  const load = vi.fn().mockResolvedValue({ ok: true, value: empty })
  const plan = vi.fn().mockRejectedValue(new Error('ack lost'))
  render(<CompanyWorkspace sessionId={'hq' as SessionId} load={load} plan={plan} history={vi.fn()} progress={vi.fn().mockResolvedValue({ ok: true, value: { taskId: 'task-1', sessionId: null, todos: [] } })} subscribe={() => () => {}} openSession={vi.fn()} />)
  await screen.findByText('Autonomous mode paused · 0 native assignments')
  fireEvent.click(screen.getByText('Add human work'))
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Owner review' } })
  fireEvent.change(screen.getByLabelText('Owner'), { target: { value: 'Amar' } })
  fireEvent.change(screen.getByLabelText('Start'), { target: { value: '2026-10-01T10:00' } })
  fireEvent.change(screen.getByLabelText('End'), { target: { value: '2026-10-01T11:00' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save planned work' }))
  await screen.findByText('Calendar write is unconfirmed. Refresh before creating another entry.')
  expect(screen.getByRole('button', { name: 'Save planned work' }).hasAttribute('disabled')).toBe(true)
  const item = plan.mock.calls[0]?.[1].item
  load.mockResolvedValue({ ok: true, value: { ...empty, calendar: [item] } })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh workspace' }))
  await screen.findByRole('heading', { name: 'Owner review' })
  expect(plan).toHaveBeenCalledTimes(1)
})
