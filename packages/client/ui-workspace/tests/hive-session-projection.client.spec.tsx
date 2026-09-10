// @vitest-environment jsdom
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

describe('HIVE native session projection', () => {
  it('shows the five newest non-empty root sessions and opens a persisted row', () => {
    const sessions = list(
      summary('one', 1), summary('two', 2), summary('three', 3),
      summary('four', 4), summary('five', 5), summary('six', 6),
      summary('blank', 8, { blank: true }),
      summary('child', 9, { origin: 'subagent' }),
    )
    const openSession = vi.fn()
    render(<HiveSessionProjection
      {...runtime}
      useSessions={selector => selector(sessions)}
      useSessionPendingInteraction={selector => selector(noAttention)}
      createSession={vi.fn()}
      openSession={openSession}
      t={t}
    />)

    expect(screen.getByText('Recent')).toBeTruthy()
    expect(screen.getAllByRole('treeitem').map(row => row.textContent)).toEqual([
      expect.stringContaining('six'), expect.stringContaining('five'),
      expect.stringContaining('four'), expect.stringContaining('three'),
      expect.stringContaining('two'),
    ])
    expect(screen.queryByText('one')).toBeNull()
    expect(screen.queryByText('blank')).toBeNull()
    expect(screen.queryByText('child')).toBeNull()
    fireEvent.click(screen.getByText('four'))
    expect(openSession).toHaveBeenCalledWith(sid('four'))
  })

  it('uses the native session controller action to create and open a session', async () => {
    const created = sid('created')
    const createSession = vi.fn().mockResolvedValue(created)
    const openSession = vi.fn()
    render(<HiveSessionProjection
      {...runtime}
      useSessions={selector => selector(list())}
      useSessionPendingInteraction={selector => selector(noAttention)}
      createSession={createSession}
      openSession={openSession}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: 'New Session' }))
    await waitFor(() => { expect(openSession).toHaveBeenCalledWith(created) })
    expect(createSession).toHaveBeenCalledOnce()
  })
})
