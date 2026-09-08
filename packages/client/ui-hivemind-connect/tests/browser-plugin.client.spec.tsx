// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject } from '../src/client/index.ts'
import { HivemindConnect } from '../src/client/HivemindConnect.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('HIVE-MIND connection UI', () => {
  it('registers above Settings through the sidebar footer slot', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', { register: () => () => {} } as never)
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({
      name: 'root',
      children: { 'sidebar.footer.action': { kind: 'list', scope: 'root' } },
    } as never, () => null)

    await ctx.plugin({ inject: [...inject], apply }).await()

    const entry = slots.entries('sidebar.footer.action')[0]
    expect(entry?.component).toBe(HivemindConnect)
    expect(entry?.options.id).toBe('hivemind-connect')
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
})
