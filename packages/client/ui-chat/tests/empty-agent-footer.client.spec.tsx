// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { TurnTailNodeView } from '../src/client/chat/TurnTailNodeView.tsx'

afterEach(cleanup)
it('preserves saved agent footer controls after a failed turn with no final answer', () => {
  window.history.replaceState(null, '', '/hivemind/app/employee/harness/session/test')
  const snapshot = { locations: { getTurn: () => ['tail'] }, timeline: { turnOrder: [2] } }
  const props = {
    node: { key: 'tail', data: { turn: 2, seq: 10, closing: null },
      location: { kind: 'turn', turn: { turn: 2, end: { data: { reason: { kind: 'failed' } } } } } },
    useChat: (select: (value: typeof snapshot) => unknown) => select(snapshot),
    renderSlotChain: () => null,
    renderSlot: (name: string) => name === 'conversation.chat.turnFooter' ? <button>Start Call</button> : null,
    t: (key: string) => key, openFile: vi.fn(), forkAt: vi.fn(),
  }
  const view = render(<TurnTailNodeView {...props as unknown as ComponentProps<typeof TurnTailNodeView>} />)
  expect(view.getByRole('button', { name: 'Start Call' })).toBeTruthy()
  window.history.replaceState(null, '', '/')
})
