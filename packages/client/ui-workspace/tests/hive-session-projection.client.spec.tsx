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

function mount(path = '/hivemind/app/overview', pending = false) {
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
    'menu.shareSession': 'Share',
    'menu.fork': 'Fork',
    'delete.session': 'Delete',
    'status.waitingAnswer': 'Waiting for answer',
    'menu.archiveSession': 'Archive',
    'rename.session.title': 'Rename chat',
    'cancel': 'Cancel',
    'field.sessionName': 'Chat name',
  } as Record<string, unknown>)[key] as string
  const view = render(<HiveSessionProjection
    useResource={(() => ({ status: 'none', value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']}
    usePanelInfo={selector => selector({ activePanelId: null })}
    useSessionStatus={selector => selector(new Map(pending ? [[ordinaryId, { pendingInteraction: { kind: 'question' } } as never]] : []))}
    useSessionRetainInfo={() => undefined}
    useSessions={<S,>(selector: (value: SessionListState) => S) => selector(state)}
    useWorkspaces={<S,>(selector: (value: WorkspaceSnapshot) => S) => selector(workspaceState)}
    renderSlot={(() => null) as never}
    {...actions}
    t={t as never}
  />)
  return { ...view, actions }
}

describe('HIVE native Session projection', () => {
  it('filters archived and subagent rows, and orders pinned sessions first', () => {
    const { container } = mount()
    const rows = [...container.querySelectorAll<HTMLElement>('[role=treeitem]')]
    expect(rows.map(row => row.querySelector('span[class*=title]')?.textContent)).toEqual(['second-ordinary-session', 'ordinary-session'])
  })

  it('routes employee Recents to Hyperagent sessions only', () => {
    const { container } = mount('/hivemind/app/employee/harness')
    expect([...container.querySelectorAll<HTMLElement>('[role=treeitem]')]
      .map(row => row.querySelector('span[class*=title]')?.textContent)).toEqual(['Run Time'])
  })

  it('portals employee Recents into the existing host sidebar seat', () => {
    const rail = document.createElement('aside')
    rail.dataset.productSidebar = 'os'
    rail.append(document.createElement('div'))
    document.body.append(rail)
    const view = mount('/hivemind/app/employee/harness')
    expect(view.container.querySelector('[role=treeitem]')).toBeNull()
    expect(within(rail).getByText('Run Time')).toBeTruthy()
    view.unmount()
    rail.remove()
  })

  it('renders the legacy pending dot from native session status', () => {
    mount('/hivemind/app/overview', true)
    expect(screen.getByText('Waiting for answer')).toBeTruthy()
  })

  it('reuses the existing external delete bridge when available', async () => {
    const remove = vi.fn(async () => {})
    Object.defineProperty(window, '__HIVEMIND_DELETE_SESSION__', { configurable: true, value: remove })
    const { actions } = mount()
    const row = screen.getByText('ordinary-session').closest('[role=treeitem]') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Actions for ordinary-session' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    await waitFor(() => expect(remove).toHaveBeenCalledWith(ordinaryId))
    await waitFor(() => expect(actions.archiveSession).toHaveBeenCalledWith(ordinaryId))
    Reflect.deleteProperty(window, '__HIVEMIND_DELETE_SESSION__')
  })

  it('wires create, open, rename, fork and archive actions to native session operations', async () => {
    const { actions } = mount()
    const share = vi.fn(async () => {})
    Object.defineProperty(navigator, 'share', { configurable: true, value: share })
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    expect(actions.createSession).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByText('ordinary-session').closest('[role=treeitem]')!)
    expect(actions.openSession).toHaveBeenCalledWith(ordinaryId)

    const row = screen.getByText('ordinary-session').closest('[role=treeitem]') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Actions for ordinary-session' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Share' }))
    expect(share).toHaveBeenCalledWith(expect.objectContaining({
      title: 'ordinary-session',
      url: expect.stringContaining('/hivemind/app/overview/session/ordinary-session'),
    }))

    fireEvent.click(within(row).getByRole('button', { name: 'Actions for ordinary-session' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fork' }))
    expect(actions.forkSession).toHaveBeenCalledWith(ordinaryId)

    fireEvent.click(within(row).getByRole('button', { name: 'Actions for ordinary-session' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }))
    expect(actions.archiveSession).toHaveBeenCalledWith(ordinaryId)

    fireEvent.click(within(row).getByRole('button', { name: 'Actions for ordinary-session' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Chat name' }), { target: { value: 'Renamed chat' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await waitFor(() => expect(actions.renameSession).toHaveBeenCalledWith(ordinaryId, 'Renamed chat'))
  })
})
