// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

it('initializes HQ and installs human controls without waiting for the calendar navigator', async () => {
  const ctx = new Context()
  const start = vi.fn().mockResolvedValue({ ok: true, value: { sessionId: 'hq' } })
  const slots = { inject: vi.fn(), register: vi.fn() }
  const remote = { hivemindHq: { start }, $mount: vi.fn().mockResolvedValue(async () => {}) }
  ctx.provide('remote', remote as never)
  ctx.provide('remote.hivemindHq', remote.hivemindHq as never)
  ctx.provide('sessions', {} as never)
  ctx.provide('slots', slots as never)
  ctx.provide('locale', { register: () => () => {} } as never)
  expect(inject).not.toContain('uiWorkspace')
  expect(inject).not.toContain('layout')
  const dispose = await apply(ctx)
  try {
    expect(start).toHaveBeenCalledOnce()
    expect(slots.inject).toHaveBeenCalledWith('conversation.session.header.actions', expect.any(Function))
    expect(slots.inject).not.toHaveBeenCalledWith('main', expect.any(Function))
  } finally { await dispose() }
})

it('mounts the shared calendar using native navigation without a directory-picker service', async () => {
  const ctx = new Context()
  const start = vi.fn().mockResolvedValue({ ok: true, value: { sessionId: 'hq' } })
  const slots = { inject: vi.fn(), register: vi.fn() }
  const remote = { hivemindHq: { start }, $mount: vi.fn().mockResolvedValue(async () => {}) }
  ctx.provide('remote', remote as never)
  ctx.provide('remote.hivemindHq', remote.hivemindHq as never)
  ctx.provide('sessions', {} as never)
  ctx.provide('slots', slots as never)
  ctx.provide('locale', { register: () => () => {} } as never)
  ctx.provide('layout', {} as never)
  const dispose = await apply(ctx)
  try {
    expect(start).toHaveBeenCalledOnce()
    expect(slots.inject).toHaveBeenCalledWith('main', expect.any(Function))
    expect(slots.inject).toHaveBeenCalledWith('sidebar.panellist', expect.any(Function))
  } finally { await dispose() }
})
