// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { HyperagentPanelToggle } from '../src/client/HyperagentEmployee.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.history.replaceState({}, '', '/')
})

describe('HyperAgents Preview mount', () => {
  it('waits for the right sidebar surface before closing Preview in a new session', async () => {
    window.history.replaceState({}, '', '/hivemind/app/employee/harness/session/new')
    const closePreview = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
    const useSessions = (select: (state: unknown) => unknown) => select({
      byId: { 'session-new': { blank: true, projectionValues: { agentPreset: 'hivemind-hyperagents' } } },
    })
    const props = {
      sessionId: 'session-new',
      useSessions,
      useEmployeeEvents: () => null,
      swapPanel: vi.fn(),
      closePreview,
      t: (key: string) => key,
    }
    render(<HyperagentPanelToggle {...(props as unknown as Parameters<typeof HyperagentPanelToggle>[0])} />)
    await waitFor(() => expect(closePreview).toHaveBeenCalledTimes(2))
    // Without a mounted conversation boundary the card cannot be positioned,
    // but its integrated environment control must remain available.
    expect(document.querySelector('[aria-label="employee.environment"]')).not.toBeNull()
  })
})
