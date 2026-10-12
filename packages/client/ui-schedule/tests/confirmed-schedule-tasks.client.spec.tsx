// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ScheduleCatalogEntry, ScheduleId } from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CatalogSnapshot } from '../src/client/catalog-source.ts'
import {
  ConfirmedScheduleTasks, type ConfirmedScheduleTasksProps,
} from '../src/client/ConfirmedScheduleTasks.tsx'
import { en } from '../src/client/task-manager-locales.ts'

const SESSION = 'receipt-session' as SessionId
const TASK = 'receipt-task' as ScheduleId

afterEach(cleanup)

describe('confirmed scheduled-work receipt', () => {
  it('resolves the receipt against the native catalog and forwards its employee identity and task binding', () => {
    const task: ScheduleCatalogEntry = {
      id: TASK,
      sessionId: SESSION,
      status: 'active',
      kind: 'at',
      title: 'Send the report',
      prompt: 'Send the report',
      scheduledAt: '2026-10-12T12:00:00.000Z',
    }
    const snapshot: CatalogSnapshot<ScheduleCatalogEntry> = {
      records: [task], status: 'ready', deleting: [], settled: true, readRequest: 1, readSettled: 2,
    }
    const openTaskDetail = vi.fn()
    const avatarOwner = vi.fn()
    const props = {
      sessionId: SESSION,
      ids: [TASK],
      employeeIds: { [TASK]: 'employee-42' },
      useCatalog: <Value,>(selector: (value: CatalogSnapshot<ScheduleCatalogEntry>) => Value) => selector(snapshot),
      onRetry: vi.fn(async () => {}),
      openTaskDetail,
      renderSlot: (_key: 'schedule.task.avatar', owner: { targetSessionId: SessionId; employeeId?: string }) => {
        avatarOwner(owner)
        return <span data-avatar-seat />
      },
      t: makeTranslate(en),
    } as ConfirmedScheduleTasksProps

    render(<ConfirmedScheduleTasks {...props} />)

    expect(screen.getByText('Send the report')).toBeTruthy()
    expect(screen.getByText(/Enabled/)).toBeTruthy()
    expect(document.querySelector('[data-confirmed-schedule-list] [data-avatar-seat]')).toBeTruthy()
    expect(avatarOwner).toHaveBeenCalledWith({ targetSessionId: SESSION, employeeId: 'employee-42' })
    fireEvent.click(screen.getByRole('button', { name: en['card.open'] }))
    expect(openTaskDetail).toHaveBeenCalledWith(SESSION, TASK)
  })
})
