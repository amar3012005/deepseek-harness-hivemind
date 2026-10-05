// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { en } from '../src/client/locale.ts'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { TurnNavigator } from '../src/client/chat/TurnNavigator.tsx'
import type { TurnRailItem } from '../src/client/chat/turn-rail-items.ts'

afterEach(() => { cleanup(); window.history.replaceState({}, '', '/') })
it('jumps to an unloaded day through the existing native navigation callback', () => {
  window.history.replaceState({}, '', '/hivemind/app/employee/harness/session/history')
  const items: TurnRailItem[] = [
    { turn: 1, time: new Date(2026, 9, 5, 10).getTime(), prompt: '', response: '', anchor: { kind: 'unloaded', seq: SessionSeq(0) } },
    { turn: 2, time: new Date(2026, 9, 6, 10).getTime(), prompt: '', response: '', anchor: { kind: 'loaded', key: 'today' } },
  ]
  const onNavigate = vi.fn()
  const t = ((key: keyof typeof en) => en[key]) as Parameters<typeof TurnNavigator>[0]['t']
  const view = render(<TurnNavigator items={items} activeTurn={2} busyTurn={null} onNavigate={onNavigate} t={t} />)
  const selector = view.getByRole('combobox', { name: 'Jump to day' })
  fireEvent.change(selector, { target: { value: '2026-10-5' } })
  expect(onNavigate).toHaveBeenCalledWith(items[0])
  expect(view.getByRole('navigation')).toBeTruthy()
})
it('keeps the Brain history presentation unchanged', () => {
  window.history.replaceState({}, '', '/hivemind/app/overview/session/history')
  const t = ((key: keyof typeof en) => en[key]) as Parameters<typeof TurnNavigator>[0]['t']
  const items: TurnRailItem[] = [1, 2].map(turn => ({ turn, time: Date.now(), prompt: '', response: '', anchor: { kind: 'loaded', key: String(turn) } }))
  const view = render(<TurnNavigator items={items} activeTurn={2} busyTurn={null} onNavigate={vi.fn()} t={t} />)
  expect(view.queryByRole('combobox', { name: 'Jump to day' })).toBeNull()
})
