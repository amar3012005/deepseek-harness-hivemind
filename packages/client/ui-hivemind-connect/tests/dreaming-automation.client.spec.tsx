// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DreamingAutomation } from '../src/client/DreamingAutomation.tsx'
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const response = (value: unknown) => new Response(JSON.stringify(value))
describe('Dreaming automation projection', () => {
  it('shows the existing next run and durable history without creating another schedule', async () => {
    const request = vi.fn().mockResolvedValue(response({ enabled: true, activity: {
      session: { parentSessionId: 'session-parent', childSessionId: 'session-child', mode: 'continuable' }, cron: '0 2 * * *', timezone: 'Europe/Berlin', nextRunAt: '2030-01-01T01:00:00Z', scheduleState: 'scheduled',
      runs: [{ id: 'run-1', status: 'completed', created_at: '2029-12-31T01:00:00Z', updated_at: '2029-12-31T01:05:00Z', output_ids: ['m1', 'm2'] }],
    } }))
    vi.stubGlobal('fetch', request)
    render(<DreamingAutomation />)
    await screen.findByText(/Europe\/Berlin/)
    expect(screen.getByRole('link', { name: 'Nightly Dreaming' }).getAttribute('href')).toBe('/hivemind/app/overview/session/session-child?dreamingParent=session-parent')
    fireEvent.click(screen.getByRole('button', { name: 'Run history (1)' }))
    expect(screen.getByText(/2 Flashbacks/)).toBeTruthy()
    expect(request.mock.calls[0]![0]).toBe('/hivemind/dreamer/settings?view=activity')
    expect(request.mock.calls[0]![1].method).toBeUndefined()
    expect(screen.getByRole('link', { name: 'Manage in Settings' }).getAttribute('href')).toBe('/hivemind/app/settings')
  })
  it('shows Off and no next run when the feature is disabled', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ enabled: false, activity: { timezone: 'Europe/Berlin', cron: '0 2 * * *', nextRunAt: null, scheduleState: 'off', runs: [] } })))
    render(<DreamingAutomation />)
    await screen.findByText(/Not scheduled/)
    fireEvent.click(screen.getByRole('button', { name: 'Run history (0)' }))
    expect(screen.getByText('No dreaming runs yet.')).toBeTruthy()
  })
  it('reports a failed refresh instead of inventing a scheduled time', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    render(<DreamingAutomation />)
    await screen.findByRole('alert')
    expect(screen.queryByText(/Next run:/)).toBeNull()
  })
})
