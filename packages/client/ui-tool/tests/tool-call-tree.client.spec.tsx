// @vitest-environment jsdom
/** ToolCallTree-owned root/subcall markers and selection projection. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { ToolCallOwnerProps, ToolImagesOwnerProps, ToolTreeProps } from '../src/client/contract/slots.ts'
import { ToolCallTree } from '../src/client/tool/ToolCallTree.tsx'
import { zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'

afterEach(cleanup)

const t: ToolTreeProps['t'] = makeTranslate(zh, commonZh)

const root = (callId: string, call: ToolResultNode['call']): ToolResultNode => ({
  kind: 'tool-result', seq: 3, time: 3_000, callId, call, callTime: 2_000,
  content: [], isError: false, subCalls: [],
})

function props(
  block: ToolResultNode,
  selectedCallId?: string,
  home?: string,
  owners?: ToolCallOwnerProps[],
  inlineImages?: ToolImagesOwnerProps[],
): ToolTreeProps {
  const snapshot = {} as SessionSnapshot
  const useSession = ((selector: (value: SessionSnapshot) => unknown) => selector(snapshot)) as ToolTreeProps['useSession']
  const renderSlot = ((key: string, owner: ToolCallOwnerProps | ToolImagesOwnerProps, options?: { fallback?: React.ReactNode }) => {
    if (key === 'tool.call.inline-images') inlineImages?.push(owner as ToolImagesOwnerProps)
    else owners?.push(owner as ToolCallOwnerProps)
    return options?.fallback ?? null
  }) as unknown as ToolTreeProps['renderSlot']
  return {
    useSession,
    renderSlot,
    node: {
      key: `tool:${block.callId}`,
      kind: 'tool-call',
      id: block.callId,
      target: 'chat',
      anchorSeq: block.seq,
      location: { kind: 'session' },
      visibility: 'visible',
      data: { root: block },
    },
    selectedCallId,
    openFile: vi.fn(),
    inspectCall: vi.fn(),
    forkAt: vi.fn(),
    loadImage: vi.fn(() => Promise.reject(new Error('not used'))),
    fileMentions: vi.fn(),
    useHostInfo: ((selector: (info: { home: string | undefined }) => unknown) => selector({ home })) as ToolTreeProps['useHostInfo'],
    t,
  } as unknown as ToolTreeProps
}

describe('ToolCallTree', () => {
  it('owns the root marker and the generic fallback for a window-truncated call', () => {
    const block = root('w1', null)
    const view = render(<ToolCallTree {...props(block, 'w1')} />)
    const row = view.container.querySelector('[data-chat-call-id="w1"]')
    expect(row?.getAttribute('data-chat-anchor-key')).toBe('call:w1')
    expect(view.container.querySelector('[data-variant="others"]')).not.toBeNull()
    expect(view.getByText('w1')).toBeTruthy()
  })

  it('abbreviates a POSIX home path in the generic tool summary', () => {
    const block = root('w1', { name: 'read', argsRaw: '{"path":"/h/docs/a.ts"}' })
    const view = render(<ToolCallTree {...props(block, 'w1', '/h')} />)
    expect(view.getByText('~/docs/a.ts')).toBeTruthy()
  })

  it('renders durable images returned by an arbitrary tool through the inline media slot', () => {
    const image = {
      attachmentId: 'opaque-browser-capture' as never,
      mediaType: 'image/png' as const,
      bytes: 128,
      width: 1280,
      height: 720,
      name: 'capture.png',
    }
    const block = root('capture-1', { name: 'browser_take_screenshot', argsRaw: '{}' })
    block.content = [
      { type: 'text', text: 'Screenshot captured' },
      { type: 'image', attachment: image },
    ] as never
    const images: ToolImagesOwnerProps[] = []

    render(<ToolCallTree {...props(block, undefined, undefined, undefined, images)} />)

    expect(images).toEqual([{
      images: [{ attachment: image }],
      loadImage: expect.any(Function),
      align: 'start',
    }])
  })

  it('does not render inline media for failed or malformed image results', () => {
    const malformed = root('capture-2', { name: 'future_image_generator', argsRaw: '{}' })
    malformed.content = [{ type: 'image', attachment: { mediaType: 'image/png' } }] as never
    const images: ToolImagesOwnerProps[] = []
    render(<ToolCallTree {...props(malformed, undefined, undefined, undefined, images)} />)
    expect(images).toHaveLength(0)

    const failed = root('capture-3', { name: 'future_image_generator', argsRaw: '{}' })
    failed.content = [{
      type: 'image',
      attachment: {
        attachmentId: 'opaque', mediaType: 'image/png', bytes: 1, width: 1, height: 1,
      },
    }] as never
    failed.isError = true
    render(<ToolCallTree {...props(failed, undefined, undefined, undefined, images)} />)
    expect(images).toHaveLength(0)
  })
})
