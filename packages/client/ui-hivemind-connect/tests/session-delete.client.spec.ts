// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupHivemindSessionDeletion } from '../src/session-delete.ts'

afterEach(() => {
  delete window.__HIVEMIND_DELETE_SESSION__
  vi.restoreAllMocks()
})

describe('HIVE permanent session deletion bridge', () => {
  it('deletes the exact authenticated session and restores the previous bridge', async () => {
    const previous = vi.fn(async () => {})
    window.__HIVEMIND_DELETE_SESSION__ = previous
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ deleted: true }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
    const dispose = setupHivemindSessionDeletion(fetchImpl)

    await window.__HIVEMIND_DELETE_SESSION__?.('session-123')
    expect(fetchImpl).toHaveBeenCalledWith('/v1/harness-chat/sessions/session-123', {
      method: 'DELETE', credentials: 'include', headers: { accept: 'application/json' },
    })

    dispose()
    expect(window.__HIVEMIND_DELETE_SESSION__).toBe(previous)
  })

  it('does not silently archive when the server rejects deletion', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'Session not found' }), {
      status: 404, headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
    setupHivemindSessionDeletion(fetchImpl)

    await expect(window.__HIVEMIND_DELETE_SESSION__?.('session-missing')).rejects.toThrow('Session not found')
  })
})
