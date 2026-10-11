// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ComponentProps } from 'react'
import { ContinuedQuestionDock } from '../src/client/ContinuedQuestionDock.tsx'
import { createQuestionDraftStore } from '../src/client/draft-store.ts'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
type Props = ComponentProps<typeof ContinuedQuestionDock>
const SID = 'one' as SessionId
const question = { callId: 'call-one', state: 'continued', questions: [{ id: 'role', question: 'Which responsibility?', options: [{ label: 'Research' }] }] }
function kit(active: unknown[] = [question], onAnswer: Props['onAnswer'] = vi.fn(async () => true)): Props {
  const store = createQuestionDraftStore().create(SID)
  return {
    sessionId: SID,
    useProjection: () => ({ active, settled: [] }),
    t: (key: keyof typeof en) => en[key] ?? (commonEn as Record<string, string>)[key] ?? key,
    useStore: selector => useSyncExternalStore(listener => store.subscribe(listener), () => selector(store.getSnapshot())),
    actions: store.actions,
    onAnswer,
  } as Props
}
describe('continued question dock', () => {
  it('restores from persisted continued projection without a foreground wait and sends once', async () => {
    const props = kit()
    const first = render(<ContinuedQuestionDock {...props} />)
    expect(screen.getAllByRole('status')[0]?.textContent).toContain('other work can continue')
    first.unmount()
    render(<ContinuedQuestionDock {...kit([question], props.onAnswer)} />)
    fireEvent.click(screen.getByText('Research'))
    fireEvent.click(screen.getByText('Submit'))
    await waitFor(() => { expect(props.onAnswer).toHaveBeenCalledOnce() })
    expect(props.onAnswer).toHaveBeenCalledWith('call-one', { answers: [{ id: 'role', selected: ['Research'] }] })
    await waitFor(() => { expect(screen.getAllByRole('status')[0]?.textContent).toContain('Answer sent') })
    expect(screen.queryByText('Submit')).toBeNull()
  })
  it('does not claim open questions or show resolved questions', () => {
    const view = render(<ContinuedQuestionDock {...kit([{ ...question, state: 'open' }])} />)
    expect(view.container.textContent).toBe('')
    view.rerender(<ContinuedQuestionDock {...kit([])} />)
    expect(view.container.textContent).toBe('')
  })
  it('dismisses locally and remains answerable after reopening or cold restore', () => {
    const props = kit()
    const view = render(<ContinuedQuestionDock {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss all questions' }))
    expect(props.onAnswer).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Answer question'))
    expect(screen.getByText('Which responsibility?')).toBeTruthy()
    view.unmount()
    render(<ContinuedQuestionDock {...kit()} />)
    expect(screen.getByText('Which responsibility?')).toBeTruthy()
  })
  it('hides provider details and permits retry when sending fails', async () => {
    const props = kit([question], vi.fn(async () => { throw new Error('secret raw token SQL stack') }))
    render(<ContinuedQuestionDock {...props} />)
    fireEvent.click(screen.getByText('Research'))
    fireEvent.click(screen.getByText('Submit'))
    await screen.findByText('Could not send your answer. Please try again.')
    expect(document.body.textContent).not.toContain('secret raw')
    expect(screen.getByText('Submit').closest('button')?.disabled).toBe(false)
  })
  it('reports a settled or stale question without pretending the answer was accepted', async () => {
    const props = kit([question], vi.fn(async () => false))
    render(<ContinuedQuestionDock {...props} />)
    fireEvent.click(screen.getByText('Research'))
    fireEvent.click(screen.getByText('Submit'))
    await screen.findByText('This question changed. Refresh and try again.')
    expect(screen.queryByText('Answer sent; waiting for the employee to continue.')).toBeNull()
  })
  it('allows choosing another durable question and disappears after settlement', () => {
    const second = { ...question, callId: 'call-two', questions: [{ id: 'other', question: 'Which deadline?', options: [{ label: 'Tomorrow' }] }] }
    const props = kit([question, second])
    const view = render(<ContinuedQuestionDock {...props} />)
    fireEvent.change(screen.getByLabelText('Choose a pending question'), { target: { value: 'call-two' } })
    expect(screen.getByText('Tomorrow')).toBeTruthy()
    expect(screen.queryByText('Research')).toBeNull()
    view.rerender(<ContinuedQuestionDock {...kit([])} />)
    expect(view.container.textContent).toBe('')
  })
  it('treats an already queued reply as sent after reconnect', async () => {
    const props = kit([question], vi.fn(async () => { throw Object.assign(new Error('queued'), { code: 'REPLY_QUEUED' }) }))
    render(<ContinuedQuestionDock {...props} />)
    fireEvent.click(screen.getByText('Research'))
    fireEvent.click(screen.getByText('Submit'))
    await waitFor(() => { expect(screen.getAllByRole('status')[0]?.textContent).toContain('Answer sent') })
  })
})
