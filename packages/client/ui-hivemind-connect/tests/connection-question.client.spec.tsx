// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { ConnectionAuthorizationPanel } from '../src/client/ConnectionAuthorizationPanel.tsx'
import {
  connectionPresentationOf, PendingConnectionAuthorization,
} from '../src/client/connection-question.ts'
import { zh } from '../src/client/locales.ts'

const presentation = {
  version: 1,
  appLabel: 'Asana',
  toolkit: 'asana',
  redirectUrl: 'https://connect.example/asana',
  logoUrl: 'https://logos.example/asana.svg',
  connectLabel: 'Connect Asana',
  continueLabel: "I've connected Asana — continue",
} as const

function questions() {
  return [{
    id: 'hivemind-connected-app-authorization:workflow-asana:asana',
    question: 'Connect Asana to continue, then return here.',
    detail: `Authorize in a new tab, then continue this request.\n\n<!-- hivemind-connected-app-authorization:${encodeURIComponent(JSON.stringify(presentation))} -->`,
    options: [
      { label: presentation.connectLabel },
      { label: presentation.continueLabel },
    ],
  }]
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('connection question presentation', () => {
  it('recognizes only a validated app-neutral HIVE connection question', () => {
    expect(connectionPresentationOf(questions())).toMatchObject({ presentation })
    expect(connectionPresentationOf([{ ...questions()[0]!, id: 'ordinary-question' }])).toBeUndefined()
    expect(connectionPresentationOf([{ ...questions()[0]!, detail: '<!-- hivemind-connected-app-authorization:bad -->' }])).toBeUndefined()
  })

  it('renders exactly two actions and continues the suspended waterfall without a user message', async () => {
    const recognized = connectionPresentationOf(questions())!
    const pending = new PendingConnectionAuthorization('session-asana' as SessionId, recognized)
    const t = makeTranslate(zh, commonZh)
    const view = render(<ConnectionAuthorizationPanel matched={pending} t={t} />)

    const link = view.getByRole('link', { name: presentation.connectLabel })
    const continueButton = view.getByRole('button', { name: presentation.continueLabel })
    expect(view.getByText('Asana')).toBeTruthy()
    expect(view.getAllByText(questions()[0]!.question)).toHaveLength(1)
    expect(link.getAttribute('href')).toBe(presentation.redirectUrl)
    expect(view.getAllByRole('link')).toHaveLength(1)
    expect(view.getAllByRole('button')).toHaveLength(2)

    fireEvent.click(link)
    let settled = false
    void pending.result.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    fireEvent.click(continueButton)
    await expect(pending.result).resolves.toEqual({ answers: [{
      id: questions()[0]!.id,
      selected: [presentation.continueLabel],
    }] })
  })

  it('cancels only the suspended authorization turn when the user explicitly cancels', async () => {
    const cancelTurn = vi.fn(async () => {})
    const pending = new PendingConnectionAuthorization(
      'session-asana' as SessionId, connectionPresentationOf(questions())!, undefined, cancelTurn,
    )
    const view = render(<ConnectionAuthorizationPanel matched={pending} t={makeTranslate(zh, commonZh)} />)
    const result = expect(pending.result).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_CANCELLED' })

    fireEvent.click(view.getByRole('button', { name: '取消此连接请求' }))

    await result
    expect(cancelTurn).toHaveBeenCalledTimes(1)
  })

  it('settles once when exact-session cancellation aborts the question and ignores duplicate clicks', async () => {
    const controller = new AbortController()
    const cancelTurn = vi.fn(async () => { controller.abort(new Error('session cancelled')) })
    const pending = new PendingConnectionAuthorization(
      'session-asana' as SessionId, connectionPresentationOf(questions())!, controller.signal, cancelTurn,
    )
    const result = expect(pending.result).rejects.toMatchObject({ name: 'UserQuestionError', code: 'ASK_CANCELLED' })
    const first = pending.cancel()

    expect(pending.cancel()).toBe(first)
    await first
    await result
    expect(cancelTurn).toHaveBeenCalledTimes(1)
  })
})

it('treats OAuth return as a hint without answering or claiming verified access', async () => {
  let listener: ((event: { data: unknown }) => void) | undefined
  vi.stubGlobal('BroadcastChannel', class {
    addEventListener(_name: string, callback: typeof listener) { listener = callback }
    close() {}
  })
  const pending = new PendingConnectionAuthorization('room' as SessionId, connectionPresentationOf(questions())!)
  const view = render(<ConnectionAuthorizationPanel matched={pending} t={makeTranslate(zh, commonZh)} />)
  let answered = false
  void pending.result.then(() => { answered = true })
  listener?.({ data: { status: 'success' } })
  await Promise.resolve()
  expect(answered).toBe(false)
  expect(view.container.textContent).not.toContain('Asana 已连接')
})
