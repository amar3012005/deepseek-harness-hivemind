// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listenForConnectionReturn, setupConnectionCallbackReturn,
} from '../src/client/connection-callback.ts'

class TestBroadcastChannel {
  static readonly channels = new Map<string, Set<TestBroadcastChannel>>()
  readonly listeners = new Set<(event: MessageEvent<unknown>) => void>()

  constructor(readonly name: string) {
    const members = TestBroadcastChannel.channels.get(name) ?? new Set()
    members.add(this)
    TestBroadcastChannel.channels.set(name, members)
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.add(listener)
  }

  postMessage(value: unknown): void {
    for (const member of TestBroadcastChannel.channels.get(this.name) ?? []) {
      if (member === this) continue
      for (const listener of member.listeners) listener(new MessageEvent('message', { data: value }))
    }
  }

  close(): void { TestBroadcastChannel.channels.get(this.name)?.delete(this) }
}

beforeEach(() => {
  TestBroadcastChannel.channels.clear()
  vi.stubGlobal('BroadcastChannel', TestBroadcastChannel)
  window.history.replaceState({}, '', '/hivemind/app/overview/session/session-123')
})

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('connected-app callback continuation', () => {
  it('returns connection success to the original conversation and removes callback parameters', () => {
    const received = vi.fn()
    const stop = listenForConnectionReturn('session-123', received)
    window.history.replaceState({}, '', '/hivemind/app/overview/session/session-123?hivemind_connection=complete&hivemind_session=session-123&status=success&connected_account_id=ca-1')
    const close = vi.spyOn(window, 'close').mockImplementation(() => {})
    setupConnectionCallbackReturn()

    expect(received).toHaveBeenCalledWith({ status: 'success' })
    expect(window.location.search).toBe('')
    expect(close).not.toHaveBeenCalled()
    stop()
  })
})
