// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject } from '../src/client/index.ts'
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
  it('registers above Settings through the sidebar footer slot', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', { register: () => () => {} } as never)
    ctx.provide('sessions', { open: vi.fn() } as never)
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({
      name: 'root',
      children: {
        'sidebar.footer.action': { kind: 'list', scope: 'root' },
        'conversation.session.header.actions': { kind: 'list', scope: 'root' },
      },
    } as never, () => null)

    await ctx.plugin({ inject: [...inject], apply }).await()

    const entry = slots.entries('sidebar.footer.action')[0]
    expect(entry?.component).toBe(HivemindConnect)
    expect(entry?.options.id).toBe('hivemind-connect')
    expect(slots.entries('conversation.session.header.actions')[0]?.options.id).toBe('hivemind-history')
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
