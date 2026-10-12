// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { HiveSessionProjection } from '../src/client/HiveSessionProjection.tsx'

afterEach(() => {
  cleanup()
  window.history.replaceState({}, '', '/')
})

const ordinaryId = 'ordinary-session' as SessionId
const agentId = 'hyperagent-session' as SessionId
const secondOrdinaryId = 'second-ordinary-session' as SessionId
const archivedId = 'archived-session' as SessionId
const subagentId = 'subagent-session' as SessionId

function summary(id: SessionId, preset?: string, overrides: Record<string, unknown> = {}): SessionSummary {
  return {
    id,
    displayTitle: id,
    title: id,
    cwd: '/tmp',
    running: false,
    retainedBy: { mainView: 0 },
    blank: false,
    updatedAt: 1_760_000_000_000,
    ...(preset === undefined ? {} : { projectionValues: { agentPreset: preset } }),
    ...overrides,
  } as SessionSummary
}

function mount(path = '/hivemind/app/overview') {
  window.history.replaceState({}, '', path)
  const ordinary = summary(ordinaryId)
  const hyperagent = summary(agentId, 'hivemind-hyperagents')
  const secondOrdinary = summary(secondOrdinaryId)
  const archived = summary(archivedId)
  const subagent = summary(subagentId, undefined, { origin: 'subagent' })
  const state: SessionListState = {
    ids: [ordinaryId, agentId, archivedId, subagentId, secondOrdinaryId],
    byId: {
      [ordinaryId]: ordinary, [agentId]: hyperagent, [archivedId]: archived,
      [subagentId]: subagent, [secondOrdinaryId]: secondOrdinary,
    },
    phase: 'ready',
    projectionsBySession: {},
  }
  const workspaceState: WorkspaceSnapshot = {
    items: [],
    archivedSessionIds: [archivedId],
    pinnedSessionIds: [secondOrdinaryId],
    state: 'idle',
    phase: 'ready',
    error: null,
  }
  const actions = {
    createSession: vi.fn(),
    openSession: vi.fn(),
    renameSession: vi.fn(async () => {}),
    forkSession: vi.fn(async () => 'forked' as SessionId),
    archiveSession: vi.fn(async () => {}),
  }
  const t = (key: string, values?: { name?: string }) => ({
    'section.sessions': 'Recents',
    'session.new': 'New chat',
    'empty.none': 'No chats',
    'session.untitled': 'Untitled',
    'actions.session.aria': `Actions for ${values?.name ?? ''}`,
    'rename': 'Rename',
    'menu.archiveSession': 'Archive',
    'rename.session.title': 'Rename chat',
    'cancel': 'Cancel',
    'field.sessionName': 'Chat name',
  } as Record<string, unknown>)[key] as string
  const view = render(<HiveSessionProjection
    useResource={(() => ({ status: 'none', value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']}
    usePanelInfo={selector => selector({ activePanelId: null })}
    useSessionStatus={selector => selector(new Map())}
    useSessionRetainInfo={() => undefined}
    useSessions={<S,>(selector: (value: SessionListState) => S) => selector(state)}
    useWorkspaces={<S,>(selector: (value: WorkspaceSnapshot) => S) => selector(workspaceState)}
    {...actions}
    t={t as never}
  />)
  return { ...view, actions }
}

describe('HIVE native Session projection', () => {
  it('filters archived and subagent rows, and orders pinned sessions first', () => {
    const { container } = mount()
    const rows = [...container.querySelectorAll<HTMLElement>('[data-session-owner-preset]')]
    expect(rows.map(row => row.querySelector('span')?.textContent)).toEqual(['second-ordinary-session', 'ordinary-session'])
    expect(rows[0]?.dataset.sessionOwnerPreset).toBe('default')
  })

  it('routes employee Recents to Hyperagent sessions only', () => {
    const { container } = mount('/hivemind/app/employee/harness')
    expect([...container.querySelectorAll<HTMLElement>('[data-session-owner-preset]')]
      .map(row => row.querySelector('span')?.textContent)).toEqual(['hyperagent-session'])
  })

  it('wires create, open, rename, fork and archive actions to native session operations', async () => {
    const { actions } = mount()
    const share = vi.fn(async () => {})
    Object.defineProperty(navigator, 'share', { configurable: true, value: share })
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    expect(actions.createSession).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByText('ordinary-session').closest('button')!)
    expect(actions.openSession).toHaveBeenCalledWith(ordinaryId)

    const row = screen.getByText('ordinary-session').closest('[data-session-owner-preset]') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Actions for ordinary-session' }))
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    expect(share).toHaveBeenCalledWith(expect.objectContaining({
      title: 'ordinary-session',
      url: expect.stringContaining('/hivemind/app/overview/session/ordinary-session'),
    }))

    fireEvent.click(within(row).getByRole('button', { name: 'Actions for ordinary-session' }))
    fireEvent.click(screen.getByRole('button', { name: 'Fork' }))
    expect(actions.forkSession).toHaveBeenCalledWith(ordinaryId)

    fireEvent.click(within(row).getByRole('button', { name: 'Actions for ordinary-session' }))
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    expect(actions.archiveSession).toHaveBeenCalledWith(ordinaryId)

    fireEvent.click(within(row).getByRole('button', { name: 'Actions for ordinary-session' }))
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Chat name' }), { target: { value: 'Renamed chat' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await waitFor(() => expect(actions.renameSession).toHaveBeenCalledWith(ordinaryId, 'Renamed chat'))
  })
})
