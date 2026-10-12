// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScheduleManagerAction, type ScheduleManagerActionProps } from '../src/client/ScheduleManagerAction.tsx'

afterEach(() => {
  cleanup()
  window.history.replaceState({}, '', '/')
})

describe('embedded Harness task manager entry', () => {
  it('opens the retained manager from the OS Harness route, even with no tasks', () => {
    window.history.replaceState({}, '', '/hivemind/app/employee/harness/session/session-1')
    const onOpen = vi.fn()
    render(<ScheduleManagerAction {...({ title: 'Automation tasks', onOpen } as ScheduleManagerActionProps)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Automation tasks' }))
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('opens the retained manager in HIVE chat', () => {
    window.history.replaceState({}, '', '/hivemind/app/overview/session/session-1')
    const onOpen = vi.fn()
    render(<ScheduleManagerAction {...({ title: 'Automation tasks', onOpen } as ScheduleManagerActionProps)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Automation tasks' }))
    expect(onOpen).toHaveBeenCalledOnce()
  })
})
