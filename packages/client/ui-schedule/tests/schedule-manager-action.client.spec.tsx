// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScheduleManagerAction, type ScheduleManagerActionProps } from '../src/client/ScheduleManagerAction.tsx'

afterEach(() => {
  cleanup()
  window.history.replaceState({}, '', '/')
})

describe('embedded HyperAgents task manager entry', () => {
  it('opens the retained manager from the OS Harness route, even with no tasks', () => {
    window.history.replaceState({}, '', '/hivemind/app/employee/harness/session/session-1')
    const onOpen = vi.fn()
    render(<ScheduleManagerAction {...({ title: 'Automation tasks', onOpen } as ScheduleManagerActionProps)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Automation tasks' }))
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('does not expose the manager in HIVE chat', () => {
    window.history.replaceState({}, '', '/hivemind/app/overview/session/session-1')
    render(<ScheduleManagerAction {...({ title: 'Automation tasks', onOpen: vi.fn() } as ScheduleManagerActionProps)} />)
    expect(screen.queryByRole('button', { name: 'Automation tasks' })).toBeNull()
  })
})
