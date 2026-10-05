// @vitest-environment jsdom
import { Fragment, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionPendingInteractionSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { HiveSessionProjection } from '../src/client/HiveSessionProjection.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const sid = (id: string) => id as SessionId
const summary = (
  id: string,
  updatedAt: number,
  overrides: Partial<SessionSummary> = {},
): SessionSummary => ({
  id: sid(id), displayTitle: id, running: false, blank: false, updatedAt, ...overrides,
})

function list(...items: SessionSummary[]): SessionListState {
  return {
    ids: items.map(item => item.id),
    byId: Object.fromEntries(items.map(item => [item.id, item])),
    current: sid('five'),
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  }
}

const t = makeTranslate(en, commonEn) as never
const noAttention: SessionPendingInteractionSnapshot = new Map()
const runtime = {} as GlobalStandardProps
const renderSlot = () => null
const SessionProvider = ({ children }: { children: ReactNode }) => <Fragment>{children}</Fragment>
const actions = {
  renameSession: vi.fn(async () => {}),
  forkSession: vi.fn(),
  deleteSession: vi.fn(async () => {}),
}

describe('HIVE native session projection', () => {
  it('keeps every non-empty root session in a five-row scrollport and opens a persisted row', () => {
    const sessions = list(
      summary('one', 1), summary('two', 2), summary('three', 3),
      summary('four', 4), summary('five', 5), summary('six', 6),
      summary('blank', 8, { blank: true }),
      summary('child', 9, { origin: 'subagent' }),
    )
    const openSession = vi.fn()
    render(<HiveSessionProjection
      {...runtime}
      renderSlot={renderSlot}
      SessionProvider={SessionProvider}
      useSessions={selector => selector(sessions)}
      useSessionPendingInteraction={selector => selector(noAttention)}
      createSession={vi.fn()}
      openSession={openSession}
      {...actions}
      t={t}
    />)

    expect(screen.getByText('Recent')).toBeTruthy()
    expect(screen.getAllByRole('treeitem')).toHaveLength(6)
    expect(screen.queryByText('blank')).toBeNull()
    expect(screen.queryByText('child')).toBeNull()
    expect(screen.getByRole('navigation', { name: 'Sessions' }).className).toContain('list')
    fireEvent.click(screen.getAllByRole('treeitem')[2]!)
    expect(openSession).toHaveBeenCalledWith(sid('four'))
  })

  it('uses the native session controller action to create and open a session', async () => {
    const created = sid('created')
    const createSession = vi.fn().mockResolvedValue(created)
    const openSession = vi.fn()
    render(<HiveSessionProjection
      {...runtime}
      renderSlot={renderSlot}
      SessionProvider={SessionProvider}
      useSessions={selector => selector(list())}
      useSessionPendingInteraction={selector => selector(noAttention)}
      createSession={createSession}
      openSession={openSession}
      {...actions}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: 'New Session' }))
    await waitFor(() => { expect(openSession).toHaveBeenCalledWith(created) })
    expect(createSession).toHaveBeenCalledOnce()
  })

  it('exposes native actions for each persisted recent session', () => {
    const sessions = list(summary('share-me', 10))
    const share = vi.fn(async (_data: ShareData) => {})
    Object.defineProperty(navigator, 'share', { configurable: true, value: share })
    render(<HiveSessionProjection
      {...runtime}
      renderSlot={renderSlot}
      SessionProvider={SessionProvider}
      useSessions={selector => selector(sessions)}
      useSessionPendingInteraction={selector => selector(noAttention)}
      createSession={vi.fn()}
      openSession={vi.fn()}
      {...actions}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: /Session actions for/ }))
    expect(screen.getByText('Rename')).toBeTruthy()
    expect(screen.getByText('Fork session')).toBeTruthy()
    expect(screen.getByText('Share session')).toBeTruthy()
    expect(screen.getByText('Delete session permanently')).toBeTruthy()
    fireEvent.click(screen.getByText('Share session'))
    expect(share).toHaveBeenCalledWith(expect.objectContaining({
      title: 'share-me', url: expect.stringContaining('/hivemind/app/overview/session/share-me'),
    }))
    expect(share.mock.calls[0]?.[0]?.url).not.toMatch(/[?#]/)
  })

  it('dispatches permanent deletion from the session overflow menu', async () => {
    const sessions = list(summary('delete-me', 10))
    const deleteSession = vi.fn(async () => {})
    render(<HiveSessionProjection
      {...runtime}
      renderSlot={renderSlot}
      SessionProvider={SessionProvider}
      useSessions={selector => selector(sessions)}
      useSessionPendingInteraction={selector => selector(noAttention)}
      createSession={vi.fn()}
      openSession={vi.fn()}
      {...actions}
      deleteSession={deleteSession}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: /Session actions for/ }))
    fireEvent.click(screen.getByText('Delete session permanently'))
    await waitFor(() => { expect(deleteSession).toHaveBeenCalledTimes(1) })
    expect(deleteSession).toHaveBeenCalledWith(sid('delete-me'))
  })
})


describe('title-first HIVE Recents', () => {
  it.each([
    ['/hivemind/app/overview', 'hivemind-chat'],
  ])('shows titles and full hover timestamps in %s', (path, preset) => {
    const before = window.location.href
    window.history.replaceState(null, '', path)
    const at = new Date('2026-10-01T08:00:00Z').getTime()
    const sessions = list(summary('market-research', at, { displayTitle: 'Market research blueprint', agentPreset: preset }))
    try {
      render(<HiveSessionProjection
        {...runtime} renderSlot={renderSlot} SessionProvider={SessionProvider}
        useSessions={selector => selector(sessions)} useSessionPendingInteraction={selector => selector(noAttention)}
        createSession={vi.fn()} openSession={vi.fn()} {...actions} t={t}
      />)
      const row = screen.getByRole('treeitem')
      expect(row.textContent).toContain('Market research blueprint')
      expect(row.getAttribute('title')).toMatch(/2026/)
      expect(row.getAttribute('title')).toMatch(/GMT|UTC/)
      expect(row.className).toContain('recentRow')
    } finally { window.history.replaceState(null, '', before) }
  })
})

it('does not duplicate agent rooms in a recent-chat list', () => {
  const before = window.location.href
  window.history.replaceState(null, '', '/hivemind/app/employee/harness/session/runtime')
  try {
    const sessions = list(summary('runtime', 1, { agentPreset: 'hivemind-hq' }))
    const view = render(<HiveSessionProjection
      {...runtime} renderSlot={renderSlot} SessionProvider={SessionProvider}
      useSessions={selector => selector(sessions)} useSessionPendingInteraction={selector => selector(noAttention)}
      createSession={vi.fn()} openSession={vi.fn()} {...actions} t={t}
    />)
    expect(view.container.textContent).toBe('')
    expect(screen.queryByRole('treeitem')).toBeNull()
  } finally { window.history.replaceState(null, '', before) }
})
