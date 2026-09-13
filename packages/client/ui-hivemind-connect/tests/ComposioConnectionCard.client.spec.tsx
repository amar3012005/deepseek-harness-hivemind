// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { ComposioConnectionCard } from '../src/client/ComposioConnectionCard.tsx'
import { PendingConnectionAuthorization } from '../src/client/connection-question.ts'
import { zh } from '../src/client/locales.ts'

type CardProps = Parameters<typeof ComposioConnectionCard>[0]
const t: CardProps['t'] = makeTranslate(zh, commonZh)
const sessionId = 'session-composio-card' as SessionId

function props(pending?: PendingConnectionAuthorization): Pick<CardProps,
  'sessionId' | 'useSessionPendingInteraction'> {
  const values = new Map(pending === undefined ? [] : [[sessionId, pending]])
  return {
    sessionId,
    useSessionPendingInteraction: selector => selector(values),
  }
}

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
  it('renders pending connection evidence without claiming completion', () => {
    const pending = { ...block(), content: [{ type: 'text' as const, text: JSON.stringify({ status: 'connection_pending', toolkit: 'slack' }) }] }
    const view = render(<ComposioConnectionCard {...({ ...props(), block: pending, inspect: vi.fn(), t } as unknown as CardProps)} />)
    expect(view.container.textContent).toContain('等待连接')
    expect(view.container.textContent).not.toContain('连接应用任务已完成')
    expect(view.container.querySelector('a')).toBeNull()
  })

  it('shows the requested app logo while a connected-app call is running', () => {
    const running = {
      seq: 2, time: 2_000, callId: 'call-running-linkedin',
      argsRaw: JSON.stringify({
        action: 'search',
        queries: [{ app: 'LinkedIn', use_case: 'Get my profile.' }],
        session: { generate_id: true },
      }),
    }
    const view = render(<ComposioConnectionCard {...({
      ...props(), block: running, inspect: vi.fn(), t,
    } as unknown as CardProps)} />)

    expect(view.container.querySelector('img[src="https://logos.composio.dev/api/linkedin"]')).not.toBeNull()
  })

  it('shows a small app logo beside every provider operation', () => {
    const completed = { ...block(), content: [{ type: 'text' as const, text: JSON.stringify({
      status: 'ready',
      results: [{ toolkits: ['linkedin'], primary_tool_slugs: ['LINKEDIN_GET_MY_INFO'] }],
      operations: [
        { tool: 'COMPOSIO_SEARCH_TOOLS', status: 'completed' },
        { tool: 'LINKEDIN_GET_MY_INFO', status: 'completed' },
      ],
    }) }] }
    const view = render(<ComposioConnectionCard {...({
      ...props(), block: completed, inspect: vi.fn(), t,
    } as unknown as CardProps)} />)

    expect(view.container.querySelectorAll('img[src="https://logos.composio.dev/api/linkedin"]')).toHaveLength(3)
    expect(view.container.textContent).toContain('LINKEDIN_GET_MY_INFO→ completed')
  })

  it('does not show an old authorization URL after active connection verification', () => {
    const active = { ...block(), content: [{ type: 'text' as const, text: JSON.stringify({
      status: 'ready', toolkit: 'slack', app_label: 'Slack', logo_url: 'https://logos.example/slack.svg',
      connected_toolkits: ['slack'], redirect_url: 'https://connect.example/old',
    }) }] }
    const view = render(<ComposioConnectionCard {...({ ...props(), block: active, inspect: vi.fn(), t } as unknown as CardProps)} />)
    expect(view.container.textContent).toContain('连接应用任务已完成')
    expect(view.container.textContent).toContain('Slack 已连接')
    expect(view.container.textContent).toContain('连接已验证。正在继续此请求。')
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe('https://logos.example/slack.svg')
    expect(view.container.querySelector('a')).toBeNull()
  })

  it('replays the underlying Composio progress before the connection action', () => {
    const inspect = vi.fn()
    const inputActions = { setDraft: vi.fn(), submit: vi.fn() }
    const view = render(<ComposioConnectionCard {...({
      ...props(), block: block(),
      callId: 'call-connected-task',
      toolName: 'hivemind_connected_task',
      openFile: vi.fn(),
      inspect,
      inputActions,
      t,
    } as unknown as CardProps)} />)

    expect(view.container.textContent).toContain('COMPOSIO_SEARCH_TOOLS→ completed')
    expect(view.container.textContent).toContain('COMPOSIO_MANAGE_CONNECTIONS→ completed')
    expect(view.container.textContent).toContain('Connect Gmail to continue, then return here.')
    expect(view.container.querySelector('a')?.getAttribute('href')).toBe('https://connect.example/gmail')
    fireEvent.click(view.getByRole('button', { name: '查看连接应用工具的输入和输出' }))
    expect(inspect).toHaveBeenCalledOnce()
    fireEvent.click(view.getByRole('button', { name: '我已连接 Gmail — 继续' }))
    expect(inputActions.setDraft).toHaveBeenCalledWith('我已连接 Gmail — 继续')
    return Promise.resolve().then(() => { expect(inputActions.submit).toHaveBeenCalledOnce() })
  })

  it('renders the live authorization inline in the running tool row', () => {
    const presentation = {
      version: 1 as const, appLabel: 'Asana', toolkit: 'asana',
      redirectUrl: 'https://connect.example/asana', logoUrl: 'https://logos.example/asana.svg',
      connectLabel: 'Connect Asana', continueLabel: "I've connected Asana — continue",
    }
    const question = {
      id: 'hivemind-connected-app-authorization:workflow-asana:asana',
      question: 'Connect Asana to continue, then return here.',
      detail: 'Authorize in a new tab.',
      options: [{ label: presentation.connectLabel }, { label: presentation.continueLabel }],
    }
    const pending = new PendingConnectionAuthorization(sessionId, { question, presentation })
    const running = {
      seq: 2, time: 2_000, callId: 'call-running',
      call: { name: 'hivemind_connected_task', argsRaw: '{}' },
    }
    const view = render(<ComposioConnectionCard {...({
      ...props(pending), block: running, inspect: vi.fn(), t,
    } as unknown as CardProps)} />)

    expect(view.getByRole('link', { name: 'Connect Asana' })).toBeTruthy()
    expect(view.getByRole('button', { name: "I've connected Asana — continue" })).toBeTruthy()
    expect(view.getByRole('button', { name: '关闭并停止本轮' })).toBeTruthy()
    expect(view.getAllByRole('link')).toHaveLength(1)
    expect(view.getAllByRole('button')).toHaveLength(3)
  })

  it('renders user cancellation as a neutral durable receipt', () => {
    const cancelled = {
      ...block(),
      isError: true,
      content: [{ type: 'text' as const, text: 'Error: the user cancelled connected-app authorization' }],
    }
    const view = render(<ComposioConnectionCard {...({
      ...props(), block: cancelled, inspect: vi.fn(), t,
    } as unknown as CardProps)} />)

    expect(view.container.textContent).toContain('连接请求已取消')
    expect(view.container.textContent).not.toContain('Error:')
    expect(view.container.textContent).not.toContain('连接应用任务失败')
  })
})
