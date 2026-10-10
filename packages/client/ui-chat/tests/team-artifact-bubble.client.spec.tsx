// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ContextInjectionRow } from '../src/client/chat/ContextInjectionRow.tsx'
import { en } from '../src/client/locale.ts'

afterEach(cleanup)
const t = makeTranslate(en)
const file = { attachmentId: 'sha256:receipt' as never, name: 'café-brief.pdf', bytes: 1024 }
const props = {
  source: { kind: 'hivemind-agent-message' } as never,
  provenance: { role: 'inject', label: 'Team' } as const,
  form: null,
  t,
}

describe('incoming teammate artifact bubble', () => {
  it('renders the exact sender identity beside a reply without repeating its name in prose', () => {
    const avatar = vi.fn(() => <span data-testid="sender-avatar" />)
    const view = render(<ContextInjectionRow {...props} avatar={avatar} content={[
      { type: 'text', text: JSON.stringify({ senderName: 'Ravi', senderEmployee: 'ravi-id', text: 'Ravi: Chief, the brief is ready.' }) },
    ]} />)
    expect(avatar).toHaveBeenCalledWith({ employeeId: 'ravi-id', name: 'Ravi' })
    expect(view.getByTestId('sender-avatar')).toBeTruthy()
    expect(view.getByText('Chief, the brief is ready.')).toBeTruthy()
    expect(view.getAllByText('Ravi')).toHaveLength(1)
  })

  it('shows the authorized file outside closed work details and opens its exact receipt', () => {
    const openArtifact = vi.fn()
    const view = render(<ContextInjectionRow {...props} openArtifact={openArtifact} content={[
      { type: 'text', text: JSON.stringify({ senderName: 'Ravi', text: 'Chief, the brief is ready.', artifacts: [{ artifactId: 'saved-brief', file }] }) },
      { type: 'file', attachment: file },
    ]} />)
    const button = view.getByRole('button', { name: 'Open café-brief.pdf in Preview' })
    expect(button.closest('details')).toBeNull()
    expect(view.container.querySelector('details')?.open).toBe(false)
    expect(view.getByText('Agent message')).toBeTruthy()
    expect(view.container.querySelector('details')?.textContent).toContain('saved-brief')
    fireEvent.click(button)
    expect(openArtifact).toHaveBeenCalledWith('saved-brief')
  })

  it('does not infer an artifact URL or workspace path from a filename', () => {
    const openArtifact = vi.fn()
    const view = render(<ContextInjectionRow {...props} openArtifact={openArtifact} content={[
      { type: 'text', text: JSON.stringify({ senderName: 'Ravi', text: 'Here is the file.' }) },
      { type: 'file', attachment: file },
    ]} />)
    const button = view.getByRole('button', { name: 'Open café-brief.pdf in Preview' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(openArtifact).not.toHaveBeenCalled()
  })
})

it('shows a validated native assignment naturally while keeping its entire payload in Agent message', () => {
  const text = 'HQ_EMPLOYEE_ASSIGNMENT={"rootId":"root-room","taskId":"task-1"}\n'
    + JSON.stringify({ expectedOutcome: 'Research the launch audience', objective: 'Exact detailed objective', acceptanceCriteria: ['Saved evidence'] })
    + '\nLong internal operating guidance.'
  const source = { kind: 'hivemind-agent-message', messageId: 'notice-1', senderId: 'root-room' } as never
  const view = render(<ContextInjectionRow {...props} source={source} content={[{ type: 'text', text: JSON.stringify({
    id: 'notice-1', senderId: 'root-room', senderEmployee: 'runtime', senderName: 'Runtime', kind: 'question', taskId: 'task-1', text,
  }) }]} />)
  const bubble = view.getByRole('article', { name: 'Message from Runtime' })
  expect(bubble.querySelector('p')?.textContent).toBe('I’ve assigned you this work: Research the launch audience')
  const details = bubble.querySelector('details')!
  expect(details.open).toBe(false)
  expect(details.textContent).toContain('HQ_EMPLOYEE_ASSIGNMENT=')
  expect(details.textContent).toContain('Long internal operating guidance.')
  expect(details.textContent).toContain('Exact detailed objective')
})

it('shows an explicit brief summary while preserving every detailed finding in the closed disclosure', () => {
  const text = 'NIGHTLY_REVIEW_REPLY={"findings":[{"observed":"Exact failed tool receipt"}]}\n' + 'Detailed context and evidence.\n'.repeat(20)
  const view = render(<ContextInjectionRow {...props} content={[{ type: 'text', text: JSON.stringify({ senderName: 'Ravi', summary: 'I’ve sent Runtime today’s findings.', text }) }]} />)
  const bubble = view.getByRole('article', { name: 'Message from Ravi' })
  expect(bubble.querySelector('p')?.textContent).toBe('I’ve sent Runtime today’s findings.')
  expect(bubble.querySelector('details')?.open).toBe(false)
  expect(bubble.querySelector('details')?.textContent).toContain('Exact failed tool receipt')
  expect(bubble.querySelector('details')?.textContent).toContain('Detailed context and evidence.')
  fireEvent.click(view.getByText('Agent message'))
  expect(bubble.querySelector('details')?.open).toBe(true)
})
it('keeps old long messages inspectable without inventing a successful outcome', () => {
  document.documentElement.dataset.dshMode = 'hivemind-chat'
  try {
    const text = 'A detailed unresolved blocker.\n'.repeat(20)
    const view = render(<ContextInjectionRow {...props} content={[{ type: 'text', text: JSON.stringify({ senderName: 'Ravi', summary: 'invalid\nsummary', text }) }]} />)
    const bubble = view.getByRole('article', { name: 'Message from Ravi' })
    expect(bubble.querySelector('p')?.textContent).toBe('A team update is available. Open the message details to read it.')
    expect(bubble.querySelector('details')?.textContent).toContain(JSON.stringify(text).slice(1, -1))
  } finally { delete document.documentElement.dataset.dshMode }
})
