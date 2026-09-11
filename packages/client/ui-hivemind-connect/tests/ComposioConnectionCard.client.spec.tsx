// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { ComposioConnectionCard } from '../src/client/ComposioConnectionCard.tsx'
import { zh } from '../src/client/locales.ts'

type CardProps = Parameters<typeof ComposioConnectionCard>[0]
const t: CardProps['t'] = makeTranslate(zh, commonZh)

afterEach(cleanup)

function block(): ToolResultNode {
  return {
    kind: 'tool-result',
    seq: 3,
    time: 3_000,
    callId: 'call-connected-task',
    call: { name: 'hivemind_connected_task', argsRaw: '{}' },
    callTime: 2_000,
    content: [{
      type: 'text',
      text: JSON.stringify({
        status: 'connection_required',
        toolkit: 'gmail',
        app_label: 'Gmail',
        prompt: 'Connect Gmail to continue, then return here.',
        redirect_url: 'https://connect.example/gmail',
        operations: [
          { tool: 'COMPOSIO_SEARCH_TOOLS', status: 'completed' },
          { tool: 'COMPOSIO_MANAGE_CONNECTIONS', status: 'completed' },
        ],
      }),
    }],
    isError: false,
    subCalls: [],
  }
}

describe('ComposioConnectionCard', () => {
  it('replays the underlying Composio progress before the connection action', () => {
    const view = render(<ComposioConnectionCard {...({
      block: block(),
      callId: 'call-connected-task',
      toolName: 'hivemind_connected_task',
      openFile: vi.fn(),
      t,
    } as unknown as CardProps)} />)

    expect(view.container.textContent).toContain('COMPOSIO_SEARCH_TOOLS→ completed')
    expect(view.container.textContent).toContain('COMPOSIO_MANAGE_CONNECTIONS→ completed')
    expect(view.container.textContent).toContain('Connect Gmail to continue, then return here.')
    expect(view.container.querySelector('a')?.getAttribute('href')).toBe('https://connect.example/gmail')
  })
})
