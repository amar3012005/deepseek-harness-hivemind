// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { ComposioConnectionCard } from '../src/client/ComposioConnectionCard.tsx'
import { zh } from '../src/client/locales.ts'
afterEach(cleanup)
it('keeps technical details optional without duplicate app stages or historical authorization actions', () => {
  const inspect = vi.fn()
  const inputActions = { setDraft: vi.fn(), submit: vi.fn() }
  const view = render(<ComposioConnectionCard {...({ inspect, inputActions, t: makeTranslate(zh, commonZh),
    block: { content: [{ type: 'text', text: JSON.stringify({ status: 'connection_required', app_label: 'Slack',
      redirect_url: 'https://connect.example', operations: [{ tool: 'COMPOSIO_SEARCH_TOOLS' }] }) }] },
  } as unknown as Parameters<typeof ComposioConnectionCard>[0])} />)
  expect(view.container.querySelector('a')).toBeNull()
  expect(view.container.textContent).not.toContain('COMPOSIO_')
  fireEvent.click(view.getByRole('button'))
  expect(inspect).toHaveBeenCalledOnce()
  expect(inputActions.setDraft).not.toHaveBeenCalled()
  expect(inputActions.submit).not.toHaveBeenCalled()
})
