// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, act } from '@testing-library/react'
import { RuntimeTour, type RuntimeTourProps } from '../src/client/RuntimeTour.tsx'
import type { HqTourState } from '@deepseek-ai/dsh-hivemind-hq-runtime/client'
afterEach(cleanup)
function fixture(initial: Partial<HqTourState> = {}) {
  let state: HqTourState = { version: 1, step: 0, presentation: 'active', revision: 0, awakening: 'sleeping',
    running: false, canResume: false, wakeRequestId: null, ...initial }
  let notify = () => {}
  const props: RuntimeTourProps = {
    sessionId: 'room' as never, load: vi.fn<RuntimeTourProps['load']>(async () => ({ ok: true, value: state })),
    checkpoint: vi.fn<RuntimeTourProps['checkpoint']>(async (_, request) => {
      state = { ...state, ...request, revision: state.revision + 1 }
      return { ok: true, value: { ok: true, value: state } }
    }),
    wake: vi.fn<RuntimeTourProps['wake']>(async () => {
      state = { ...state, awakening: 'accepted', wakeRequestId: 'stable-id' }
      return { ok: true, value: { state, requestId: 'stable-id', dispatched: true } }
    }),
    resume: vi.fn<RuntimeTourProps['resume']>(async () => ({ ok: true, value: { state, requestId: 'resume', dispatched: false } })),
    subscribe: (_, callback) => { notify = callback; return () => {} },
  }
  return { props, update: (value: Partial<HqTourState>) => { state = { ...state, ...value }; notify() } }
}
describe('Runtime native first-entry walkthrough', () => {
  it('checkpoints five steps, keeps finished banner, and wakes only on explicit click', async () => {
    const f = fixture(), view = render(<RuntimeTour {...f.props} />)
    await view.findByText('Meet Runtime.')
    for (let step = 1; step <= 4; step++) {
      fireEvent.click(view.getByRole('button', { name: /Next/ }))
      await waitFor(() => expect(view.getByLabelText(`Step ${step + 1} of 5`)).toBeTruthy())
    }
    fireEvent.click(view.getByRole('button', { name: 'Finish tour' }))
    await view.findByText('Bring Runtime to life.')
    expect(f.props.wake).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: 'Wake me up' }))
    await view.findByText('Runtime is awakening.')
    expect(f.props.wake).toHaveBeenCalledTimes(1)
    expect(view.getByText('Your wake request is saved. Waiting for Runtime to begin.')).toBeTruthy()
    act(() => f.update({ awakening: 'awakened' }))
    await waitFor(() => expect(view.queryByLabelText('Meet Runtime')).toBeNull())
  })
  it('dismisses but retains entry, resumes saved step after revisit, never auto-awakens', async () => {
    const f = fixture({ step: 2 }), view = render(<RuntimeTour {...f.props} />)
    await view.findByText('Specialists, working together.')
    fireEvent.click(view.getByRole('button', { name: 'Later' }))
    await view.findByRole('button', { name: 'Continue tour' })
    view.unmount()
    const revisited = render(<RuntimeTour {...f.props} />)
    await revisited.findByRole('button', { name: 'Continue tour' })
    fireEvent.click(revisited.getByRole('button', { name: 'Continue tour' }))
    await revisited.findByText('Specialists, working together.')
    expect(f.props.wake).not.toHaveBeenCalled()
  })
  it('leaves a retry button after failed send and exposes continuation after failed admitted turn', async () => {
    const f = fixture({ presentation: 'completed', step: 4 })
    vi.mocked(f.props.wake).mockRejectedValueOnce(new Error('offline'))
    const view = render(<RuntimeTour {...f.props} />)
    fireEvent.click(await view.findByRole('button', { name: 'Wake me up' }))
    await view.findByRole('alert')
    expect((view.getByRole('button', { name: 'Wake me up' }) as HTMLButtonElement).disabled).toBe(false)
    act(() => f.update({ awakening: 'exploring', canResume: true }))
    fireEvent.click(await view.findByRole('button', { name: 'Continue awakening' }))
    await waitFor(() => expect(f.props.resume).toHaveBeenCalledTimes(1))
  })
  it('keeps an actionable status retry without wake controls for unknown state; hides confirmed awakened', async () => {
    const f = fixture({ awakening: 'awakened' }), view = render(<RuntimeTour {...f.props} />)
    await waitFor(() => expect(f.props.load).toHaveBeenCalled())
    expect(view.queryByRole('button')).toBeNull()
    view.unmount()
    const g = fixture(); vi.mocked(g.props.load).mockRejectedValue(new Error('offline'))
    const unknown = render(<RuntimeTour {...g.props} />)
    await unknown.findByRole('button', { name: 'Try again' })
    expect(unknown.queryByRole('button', { name: 'Wake me up' })).toBeNull()
    vi.mocked(g.props.load).mockResolvedValueOnce({ ok: true, value: { version: 1, step: 0, presentation: 'active', revision: 0, awakening: 'sleeping', running: false, canResume: false, wakeRequestId: null } })
    fireEvent.click(unknown.getByRole('button', { name: 'Try again' }))
    await unknown.findByText('Your company, with a chief of staff')
  })
})
