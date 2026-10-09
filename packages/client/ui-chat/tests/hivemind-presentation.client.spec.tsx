// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ContextInjectionRow } from '../src/client/chat/ContextInjectionRow.tsx'
import { TurnErrorNodeView, UserMessageNodeView } from '../src/client/chat/MessageItem.tsx'
import { hivemindFailureText, questionAnswerPresentation } from '../src/client/chat/hivemind-presentation.ts'
import { en } from '../src/client/locale.ts'

const t = makeTranslate(en)
const source = { kind: 'user', questionAnswerSubmission: true, authenticatedActor: {
  name: 'Amar', userId: 'private-user', orgId: 'private-org', role: 'owner',
} }
const content = [{ type: 'text', text: 'Authenticated question respondent: {"userId":"private-user"}. Internal control instructions.\n'
  + JSON.stringify([{ id: 'responsibilities', question: 'Which responsibilities should Monny own?', selected: ['Market research'], custom: 'Weekly reports' }]) }]
afterEach(() => { cleanup(); delete document.documentElement.dataset.dshMode; window.history.replaceState(null, '', '/') })

describe('HIVEMIND private technical details', () => {
  it('projects authenticated answers without changing stored content or provenance', () => {
    const original = JSON.stringify({ content, source })
    expect(questionAnswerPresentation(content, source)).toBe('Amar answered\n\nWhich responsibilities should Monny own?\nMarket research, Weekly reports')
    expect(JSON.stringify({ content, source })).toBe(original)
    expect(questionAnswerPresentation(content, { kind: 'user' })).toBeUndefined()
  })
  it('never leaks an incomplete authenticated answer envelope', () => {
    expect(questionAnswerPresentation([{ type: 'text', text: 'Internal malformed payload' }], source)).toBe('Amar answered')
    expect(questionAnswerPresentation([{ type: 'text', text: '\n[{"question":"x","selected":[3]}]' }], source)).toBe('Amar answered')
  })
  it('renders useful human answers but no identifiers or control instructions in employee chat', () => {
    document.documentElement.dataset.dshMode = 'hivemind-chat'
    const view = render(<UserMessageNodeView {...{
      node: { data: { content, source, time: 0 } }, renderMessageImages: () => null, t,
    } as never} />)
    expect(view.container.textContent).toContain('Market research, Weekly reports')
    expect(view.container.textContent).toContain('Amar answered')
    expect(view.container.textContent).not.toMatch(/private-user|private-org|Authenticated question|control instructions/)
  })
  it('hides raw provider failures even inside expanded work details', () => {
    document.documentElement.dataset.dshMode = 'hivemind-chat'
    window.history.replaceState(null, '', '/hivemind/app/employee/harness/session/test')
    const view = render(<TurnErrorNodeView {...{ node: { data: {
      message: '400: {"metadata":{"request_id":"private-request","raw":"duplicate tool_result"}}', code: 'UNKNOWN', seq: 1,
    } }, t } as never} />)
    expect(view.container.textContent).toContain('Your conversation is saved. Please try again.')
    expect(view.container.textContent).not.toMatch(/private-request|metadata|tool_result|UNKNOWN/)
    expect(hivemindFailureText('AUTH')).not.toMatch(/key|token|AUTH/)
  })
  it('retains native diagnostic rendering outside the HIVEMIND product', () => {
    const view = render(<TurnErrorNodeView {...{ node: { data: { message: 'native diagnostics', code: 'UNKNOWN', seq: 1 } }, t } as never} />)
    expect(view.container.textContent).toContain('native diagnostics')
    expect(view.container.textContent).toContain('UNKNOWN')
  })
  it('does not offer the internal team-message JSON disclosure in HIVEMIND', () => {
    document.documentElement.dataset.dshMode = 'hivemind-chat'
    const view = render(<ContextInjectionRow source={{ kind: 'hivemind-agent-message' } as never}
      provenance={{ role: 'inject', label: 'Team' }} form={null} t={t} content={[{
        type: 'text', text: JSON.stringify({ senderName: 'Runtime', text: 'Welcome to the team.', id: 'private-message-id' }),
      }]} />)
    expect(view.container.textContent).toContain('Welcome to the team.')
    expect(view.container.querySelector('details')).toBeNull()
    expect(view.container.textContent).not.toContain('private-message-id')
  })
})

it('constrains desktop assistant and reasoning flex items before their unbroken preview text', () => {
  const css = (file: string) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/client/chat', file), 'utf8')
  expect(css('AssistantMarkdown.module.css')).toMatch(/\.root\s*\{[^}]*flex: 1 1 0%;[^}]*min-width: 0;[^}]*max-width: 100%;/s)
  expect(css('ReasoningRow.module.css')).toMatch(/\.root\s*\{[^}]*min-width: 0;[^}]*max-width: 100%;/s)
  expect(css('AssistantMarkdown.module.css')).toContain('overflow-wrap: anywhere;')
})
