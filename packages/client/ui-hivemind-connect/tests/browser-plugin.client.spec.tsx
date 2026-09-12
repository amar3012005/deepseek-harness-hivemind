// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, inject } from '../src/client/index.ts'
import { PendingConnectionAuthorization } from '../src/client/connection-question.ts'
import { ConnectionAuthorizationPanel } from '../src/client/ConnectionAuthorizationPanel.tsx'
import { HivemindConnect } from '../src/client/HivemindConnect.tsx'
import { setupEmbedMessaging } from '../src/client/embed.ts'

const nativeParent = window.parent

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Object.defineProperty(window, 'parent', { configurable: true, value: nativeParent })
  delete window.__HIVEMIND_EMBED_CONFIG__
})

describe('HIVE-MIND connection UI', () => {
  it('activates before the generic question fallback without waiting on optional conversation services', () => {
    expect(inject).toEqual(['sessions', 'remote', 'uiSession', 'slots', 'locale'])
  })

  it('claims a connection question as a native pending interaction and returns into the same waterfall', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({
      name: 'root',
      children: {
        'conversation.composer': { kind: 'chain', scope: 'session' },
        'conversation.hero.brand.mark': { kind: 'single', scope: 'root' },
        'tool.call.toolview': { kind: 'keyed', scope: 'session' },
      },
    } as never, () => null)
    ctx.provide('locale', { register: () => () => {} } as never)
    const SESSION_SCOPE = Symbol('connection-session-scope')
    const sessionId = 'session-connection' as SessionId
    const owner = ctx.extend({ [SESSION_SCOPE]: sessionId })
    ctx.provide('sessions', {
      scopeOf: (candidate: Context) => (candidate as Context & { [SESSION_SCOPE]?: SessionId })[SESSION_SCOPE],
      list: { getSnapshot: () => ({ current: sessionId, ids: [sessionId], phase: 'ready' }), subscribe: () => () => {} },
    } as never)
    ctx.provide('conversation', {} as never)
    ctx.provide('uiConversation', { configureWorkspaceRequirement: () => () => {} } as never)
    const pending = new Map<PendingConnectionAuthorization, () => Promise<void>>()
    ctx.provide('uiSession', {
      registerPendingInteraction: () => (
        value: PendingConnectionAuthorization,
        delegate: () => Promise<void>,
      ) => {
        pending.set(value, delegate)
        return () => { pending.delete(value) }
      },
    } as never)
    type Listener = (this: Context, request: {
      questions: Array<{ id: string; question: string; detail: string; options: Array<{ label: string }> }>
      signal?: AbortSignal
    }, next: () => Promise<{ answers: never[] }>) => Promise<unknown>
    let listener: Listener | undefined
    ctx.provide('remote', { $on: (_event: string, value: Listener) => { listener = value; return () => { listener = undefined } } } as never)

    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(listener).toBeDefined()
    const payload = encodeURIComponent(JSON.stringify({
      version: 1, appLabel: 'Asana', toolkit: 'asana',
      redirectUrl: 'https://connect.example/asana', logoUrl: 'https://logos.example/asana.svg',
      connectLabel: 'Connect Asana', continueLabel: "I've connected Asana — continue",
    }))
    const request = { questions: [{
      id: 'hivemind-connected-app-authorization:workflow-asana:asana',
      question: 'Connect Asana to continue, then return here.',
      detail: `Authorize in a new tab.\n\n<!-- hivemind-connected-app-authorization:${payload} -->`,
      options: [{ label: 'Connect Asana' }, { label: "I've connected Asana — continue" }],
    }] }
    const next = vi.fn(async () => ({ answers: [] as never[] }))
    const result = listener!.call(owner, request, next)
    await Promise.resolve()

    const current = [...pending.keys()][0]
    expect(current).toBeInstanceOf(PendingConnectionAuthorization)
    const entry = slots.entries('conversation.composer').find(item => item.component === ConnectionAuthorizationPanel)
    expect(entry).toBeDefined()
    expect((entry?.select as (value: { pendingInteraction: unknown }) => unknown)({ pendingInteraction: current })).toBe(current)
    await current!.continue()
    await expect(result).resolves.toEqual({ answers: [{
      id: request.questions[0]!.id,
      selected: ["I've connected Asana — continue"],
    }] })
    expect(next).not.toHaveBeenCalled()
    expect(pending.size).toBe(0)
    await fiber.dispose()
  })

  it('keeps session projection ownership in the native workspace plugin', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', { register: () => () => {} } as never)
    ctx.provide('sessions', {
      open: vi.fn(),
      create: vi.fn(async () => 'session-1'),
      list: {
        getSnapshot: () => ({ current: 'session-1', ids: ['session-1'], phase: 'ready' }),
        subscribe: () => () => {},
      },
    } as never)
    ctx.provide('uiConversation', { configureWorkspaceRequirement: () => () => {} } as never)
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({
      name: 'root',
      children: {
        'sidebar.footer.action': { kind: 'list', scope: 'root' },
        'conversation.session.header.actions': { kind: 'list', scope: 'root' },
        'shell.sessionRail': { kind: 'single', scope: 'root' },
      },
    } as never, () => null)

    await ctx.plugin({ inject: [...inject], apply }).await()

    expect(slots.entries('sidebar.footer.action')).toHaveLength(0)
    expect(slots.entries('shell.sessionRail')).toHaveLength(0)
    expect(slots.entries('conversation.session.header.actions')).toHaveLength(0)
  })

  it('shows the authenticated email after live status verification', async () => {
    render(<HivemindConnect
      {...({} as PropsRuntime<'sidebar.footer.action'>)}
      wide
      t={key => key}
      readStatus={async () => ({ status: 'connected', userEmail: 'amar@example.com' })}
      start={async () => ({ status: 'connecting' })}
      disconnect={async () => ({ status: 'disconnected' })}
    />)

    await waitFor(() => { expect(screen.getByText('amar@example.com')).toBeTruthy() })
    expect(screen.getByText('connected')).toBeTruthy()
  })

  it('accepts one bootstrap only from the configured parent origin', async () => {
    const postMessage = vi.fn()
    const parent = { postMessage } as unknown as WindowProxy
    Object.defineProperty(window, 'parent', { configurable: true, value: parent })
    window.__HIVEMIND_EMBED_CONFIG__ = { version: 1, parentOrigins: ['https://app.example'] }
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes.fill(1) })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const dispose = setupEmbedMessaging()

    expect(postMessage).toHaveBeenCalledWith({
      version: 1, type: 'hivemind:harness-ready.v1', request_id: expect.any(String),
    }, 'https://app.example')
    window.dispatchEvent(new MessageEvent('message', {
      source: parent, origin: 'https://evil.example',
      data: { version: 1, type: 'hivemind:harness-bootstrap.v1', request_id: 'bad', ticket: 'ticket' },
    }))
    window.dispatchEvent(new MessageEvent('message', {
      source: parent, origin: 'https://app.example',
      data: { version: 1, type: 'hivemind:harness-bootstrap.v1', request_id: 'request-1', ticket: 'ticket' },
    }))
    window.dispatchEvent(new MessageEvent('message', {
      source: parent, origin: 'https://app.example',
      data: { version: 1, type: 'hivemind:harness-bootstrap.v1', request_id: 'request-2', ticket: 'replay' },
    }))
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1) })
    expect(fetchMock).toHaveBeenCalledWith('/api/hivemind/embed/exchange', expect.objectContaining({
      credentials: 'include', body: JSON.stringify({ ticket: 'ticket', request_id: 'request-1' }),
    }))
    await waitFor(() => { expect(postMessage).toHaveBeenCalledWith({
      version: 1, type: 'hivemind:harness-connected.v1', request_id: 'request-1',
    }, 'https://app.example') })
    dispose()
  })
})
