// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AssistantMarkdown } from '../src/client/chat/AssistantMarkdown.tsx'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  MarkdownText: ({ text }: { text: string }) => <div data-md>{text}</div>,
  JsonBlock: () => null,
}))

beforeEach(() => {
  document.documentElement.dataset.dshMode = 'hivemind-chat'
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
})

afterEach(() => {
  cleanup()
  delete document.documentElement.dataset.dshMode
  vi.useRealTimers()
})

const props = { renderMessageImages: () => null, t: ((key: string) => key) as never }

function visibleLength(container: HTMLElement): number {
  return container.querySelector('[data-md]')?.textContent?.length ?? 0
}

it('shows each streamed delta within a frame or two and the full text on completion', () => {
  const delta = 6
  const text = (count: number) => 'x'.repeat(count * delta)
  const view = render(<AssistantMarkdown {...props} streaming blocks={[{ kind: 'text', text: text(1) }]} />)
  let previous = visibleLength(view.container)
  for (let count = 2; count <= 40; count++) {
    view.rerender(<AssistantMarkdown {...props} streaming blocks={[{ kind: 'text', text: text(count) }]} />)
    act(() => { vi.advanceTimersByTime(30) })
    const visible = visibleLength(view.container)
    // Progressive: every delta advances the display, and it trails the network by at most two deltas.
    expect(visible).toBeGreaterThan(previous)
    expect(count * delta - visible).toBeLessThanOrEqual(2 * delta)
    previous = visible
  }
  view.rerender(<AssistantMarkdown {...props} streaming={false} blocks={[{ kind: 'text', text: text(41) }]} />)
  expect(visibleLength(view.container)).toBe(41 * delta)
})
