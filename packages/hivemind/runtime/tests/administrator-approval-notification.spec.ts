import { Context } from '@deepseek-ai/cordis'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { expect, it, vi } from 'vitest'
import { installAdministratorApprovalNotification } from '../src/administrator-messaging.ts'

async function fixture(options: { runtime?: boolean; preset?: string; outcome?: string; call?: boolean; flush?: boolean } = {}) {
  const ctx = new Context()
  await ctx.plugin(Sessions)
  const session = ctx.sessions.create(SessionId('approval-email'))
  session.append('agent-preset/selected', { agentPreset: options.preset ?? 'hivemind-hq' } as never)
  session.append('hivemind/session-owner', { id: options.runtime === false ? 'employee' : null, slug: options.runtime === false ? 'romeo' : 'runtime', name: 'Runtime', role: 'Chief' } as never)
  session.append('turn/start', { turn: 1 })
  if (options.call !== false) session.append('tool/call', { callId: 'request-call', name: 'sensitive_action', arguments: '{}' } as never)
  session.append('approval/asked' as never, { id: 'approval-id', callId: 'request-call', toolName: 'sensitive_action', reason: 'Sending the prepared message requires your authorization.' } as never)
  session.append('approval/decided' as never, { id: 'approval-id', outcome: options.outcome ?? 'pending' } as never)
  const agent = { session } as Agent
  const order: string[] = []
  const flush = vi.spyOn(ctx.sessions, 'flush').mockImplementation(async () => { order.push('persist'); return options.flush !== false })
  const send = vi.fn(async (_agent: Agent, _input: Record<string, unknown>, _signal: AbortSignal) => { order.push('email'); return { status: 'accepted' } })
  installAdministratorApprovalNotification(ctx, send)
  const stop = () => ctx.serial('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
  return { ctx, session, agent, order, flush, send, stop }
}

it('flushes the exact saved approval before one email and leaves native permission pending', async () => {
  const f = await fixture()
  try {
    const before = f.session.snapshotEvents()
    await f.stop()
    await f.stop()
    expect(f.order).toEqual(['persist', 'email'])
    expect(f.send).toHaveBeenCalledExactlyOnceWith(f.agent, {
      message_key: 'request-call-user-request', request_call_id: 'request-call', kind: 'approval',
      subject: 'Approval needed to continue', message: 'I need your approval before continuing. Sending the prepared message requires your authorization.',
    }, expect.any(AbortSignal))
    expect(f.session.snapshotEvents()).toEqual(before)
  } finally { await f.ctx.fiber.dispose() }
})

it.each([
  { runtime: false }, { preset: 'hivemind-hyperagents' }, { call: false }, { flush: false },
  { outcome: 'allowed-once' }, { outcome: 'rejected' }, { outcome: 'unavailable' }, { outcome: 'cancelled' },
])('does not email outside a genuine persisted Runtime approval: %j', async (options) => {
  const f = await fixture(options)
  try { await f.stop(); expect(f.send).not.toHaveBeenCalled() } finally { await f.ctx.fiber.dispose() }
})

it.each(['disabled', 'not_sent', 'unknown'])('does not retry a server %s receipt or alter the pending request', async (status) => {
  const f = await fixture()
  f.send.mockResolvedValue({ status })
  try {
    await f.stop(); await f.stop()
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.session.snapshotEvents().at(-1)?.data).toMatchObject({ outcome: 'pending' })
  } finally { await f.ctx.fiber.dispose() }
})

it('contains transport failure without another email attempt or blocking turn completion', async () => {
  const f = await fixture()
  f.send.mockRejectedValue(new Error('unknown delivery'))
  const warning = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
  try {
    await expect(f.stop()).resolves.toBeUndefined(); await f.stop()
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(warning).toHaveBeenCalledOnce()
  } finally { await f.ctx.fiber.dispose() }
})

it('notifies an actual native parked approval without invoking or waiting for an answerer', async () => {
  const { default: Approval } = await import('../../../interaction/user-approval/src/index.ts')
  const f = await fixture({ outcome: 'rejected' })
  try {
    await f.ctx.plugin(Approval, { park: true, policy: 'ask' })
    const answerer = vi.fn(async () => 'allowed-once' as const)
    f.ctx.on('approval/request', answerer)
    const outcome = await f.ctx.approval.request({ agent: f.agent, callId: 'request-call', toolName: 'sensitive_action', reason: 'Sending the prepared message requires your authorization.', signal: new AbortController().signal } as never)
    expect(outcome).toBe('pending')
    expect(answerer).not.toHaveBeenCalled()
    await f.stop()
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.session.snapshotEvents().at(-1)?.data).toMatchObject({ outcome: 'pending' })
  } finally { await f.ctx.fiber.dispose() }
})

it('reconciles a restored owner using identical request identity and content', async () => {
  const f = await fixture()
  try {
    await f.stop()
    const restored = { session: f.session } as Agent
    await f.ctx.serial('agent/turn-stopping', { agent: restored, turn: 1, signal: new AbortController().signal })
    expect(f.send).toHaveBeenCalledTimes(2)
    expect(f.send.mock.calls[0]?.[1]).toEqual(f.send.mock.calls[1]?.[1])
  } finally { await f.ctx.fiber.dispose() }
})

it('ignores old or aborted approval stopping callbacks', async () => {
  const f = await fixture()
  try {
    const aborted = new AbortController(); aborted.abort()
    await f.ctx.serial('agent/turn-stopping', { agent: f.agent, turn: 1, signal: aborted.signal })
    await f.ctx.serial('agent/turn-stopping', { agent: f.agent, turn: 2, signal: new AbortController().signal })
    expect(f.send).not.toHaveBeenCalled()
  } finally { await f.ctx.fiber.dispose() }
})
