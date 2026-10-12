import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { installExternalRoomPersistence, openExternalEmployeeRoom } from '../src/external-room.ts'

describe('Open Dot proxy room persistence ownership', () => {
  it('keeps the write handle alive for later status/message receipts and closes it at host teardown', async () => {
    const stored: SessionEvent[] = []
    const writer = {
      access: 'write' as const,
      header: undefined as unknown as SessionHeader,
      read: vi.fn(async () => ({ events: [...stored], inheritedEventCount: SessionLogOffset(0) })),
      append: vi.fn(async (events: readonly SessionEvent[]) => { stored.push(...events) }),
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    }
    const live = new Map<string, Session>()
    let teardown: (() => Promise<void>) | undefined
    const ctx = {
      effect: (create: () => () => Promise<void>) => { teardown = create() },
      sessionPersistence: { create: async (created: SessionHeader) => { writer.header = created; return writer }, open: async () => writer },
      sessions: {
        get: (sessionId: SessionId) => live.get(String(sessionId)),
        enter: (session: Session) => { live.set(String(session.id), session); return () => { live.delete(String(session.id)) } },
        flush: async (session: Session) => { await writer.append(session.snapshotEvents()); return true },
        announce: vi.fn(),
      },
    } as unknown as Context
    installExternalRoomPersistence(ctx)
    const room = await openExternalEmployeeRoom(ctx, {
      organizationId: 'org-1', userId: 'user-1', employeeId: 'employee-1', dotId: 'dot-1', name: 'Ravi', role: 'Research',
    })
    expect(writer.close).not.toHaveBeenCalled()
    room.session.append('hivemind/open-dot-runtime-status-observed', {
      dispatchMessageId: 'dispatch-1', rootSessionId: 'session-runtime', observedAt: new Date(1).toISOString(),
      state: 'running', jobResult: null, outputs: [], attachments: [],
    })
    await ctx.sessions.flush(room.session)
    expect(writer.append).toHaveBeenCalledTimes(2)
    expect(writer.append.mock.calls[1]?.[0].at(-1)?.type).toBe('hivemind/open-dot-runtime-status-observed')
    await teardown?.()
    expect(writer.close).toHaveBeenCalledOnce()
    expect(live.has(String(room.id))).toBe(false)
  })
})
