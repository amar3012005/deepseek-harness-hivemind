// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ConfirmedScheduleList } from '../src/client/ConfirmedScheduleList.tsx'
import { en } from '../src/client/task-manager-locales.ts'
import type { ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule/client'
import type { CatalogInjected, CatalogSnapshot } from '../src/client/catalog-source.ts'
afterEach(cleanup)
describe('native confirmed scheduled work list', () => {
  it('joins saved identities to native catalog and opens the recipient’s existing detail', async () => {
    const task = { id: 'timer-1', kind: 'at', title: 'Ravi’s brief', prompt: 'Research', scheduledAt: '2026-10-03T20:40:00Z', sessionId: 'ravi-room', status: 'active' } as ScheduleCatalogEntry
    let value: CatalogSnapshot<ScheduleCatalogEntry> = { records: [task], status: 'ready', deleting: [], settled: true, readRequest: 1, readSettled: 1 }
    const listeners = new Set<() => void>()
    const source = {
      hooks: { catalog: {
        getSnapshot: () => value,
        subscribe: (listener: () => void) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      } },
      onRetry: async () => {
        value = { ...value, readRequest: 2, readSettled: 2 }
        listeners.forEach(listener => listener())
      },
    } as CatalogInjected<ScheduleCatalogEntry>
    const open = vi.fn(); const avatar = vi.fn(() => <span>Ravi logo</span>)
    const view = render(<ConfirmedScheduleList ids={['timer-1' as never, 'unconfirmed' as never]} source={source} open={open} avatar={avatar} t={makeTranslate(en)} />)
    await waitFor(() => { expect(view.getByText('Ravi’s brief')).toBeTruthy() })
    expect(avatar).toHaveBeenCalledWith('ravi-room')
    expect(view.getByText(/Enabled/)).toBeTruthy()
    expect(view.queryByText('unconfirmed')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Open' }))
    expect(open).toHaveBeenCalledWith(task)
  })
})
