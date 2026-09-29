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
  it('waits for the right sidebar surface before opening Preview', async () => {
    window.history.replaceState({}, '', '/hivemind/app/employee/harness/session/new')
    const ensurePreview = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
    const useSessions = (select: (state: unknown) => unknown) => select({
      byId: { 'session-new': { projectionValues: { agentPreset: 'hivemind-hyperagents' } } },
    })
    const props = {
      sessionId: 'session-new',
      useSessions,
      useEmployeeEvents: () => null,
      swapPanel: vi.fn(),
      ensurePreview,
      t: (key: string) => key,
    }
    render(<HyperagentPanelToggle {...(props as unknown as Parameters<typeof HyperagentPanelToggle>[0])} />)
    await waitFor(() => expect(ensurePreview).toHaveBeenCalledTimes(2))
    expect(document.querySelector('[class*="environmentDock"]')).not.toBeNull()
  })
})
