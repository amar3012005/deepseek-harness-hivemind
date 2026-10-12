import { Context } from '@deepseek-ai/cordis'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Approval from '@deepseek-ai/dsh-user-approval'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { expect, it, vi } from 'vitest'
import { installAdministratorApprovalNotification } from '../src/administrator-messaging.ts'

const principal = { orgId: 'org-1', userId: 'user-1', profile: 'hivemind-chat' as const, variation: 'prod' }

async function fixture(options: { runtime?: boolean; policy?: 'ask' | 'never'; flush?: boolean } = {}) {
  const ctx = new Context()
  await ctx.plugin(Sessions)
  ctx.sessions.registerMessageProjection({ type: 'tool/parked', project: () => new Map() })
  await ctx.plugin(Approval, { policy: options.policy ?? 'ask' })
  const session = ctx.sessions.create(SessionId('approval-email'))
  session.append('agent-preset/selected', { agentPreset: 'hivemind-hq' } as never)
  session.append('hivemind/session-owner', { id: options.runtime === false ? 'employee' : null,
    slug: options.runtime === false ? 'romeo' : 'runtime', name: 'Runtime', role: 'Chief' } as never)
  session.append('turn/start', { turn: 1 })
  session.append('tool/call', { callId: 'request-call', name: 'sensitive_action', arguments: { message: 'private argument' } } as never)
  const agent = { session } as Agent
  ctx.provide('hivemindExecutionScope', { require: () => principal } as never)
  const order: string[] = []
  const flush = vi.spyOn(ctx.sessions, 'flush').mockImplementation(async () => {
    order.push('persist')
    return options.flush !== false
  })
  const send = vi.fn(async (_agent: Agent, _input: Record<string, unknown>, _signal: AbortSignal) => {
    order.push('email')
    return { status: 'accepted' }
  })
  installAdministratorApprovalNotification(ctx, send)
  const execution = {
    callId: 'request-call', rootCallId: 'request-call', name: 'sensitive_action',
    arguments: { message: 'private argument' }, agent, signal: new AbortController().signal,
  } as unknown as ToolExecution
  const preflight = () => ctx.waterfall('tools/pre-execute', execution,
    async () => ({ kind: 'ask' as const, reason: 'Sending the prepared message requires your authorization.' }))
  const request = () => ctx.approval.request({ agent, callId: 'request-call' as never, toolName: 'sensitive_action',
    reason: 'Sending the prepared message requires your authorization.', signal: new AbortController().signal })
  return { ctx, session, agent, execution, order, flush, send, preflight, request }
}

it('persists the exact native approval checkpoint before email and preserves the closed native decision', async () => {
  const f = await fixture()
  let settle!: (outcome: 'allowed-once' | 'rejected') => void
  f.ctx.on('approval/request', () => new Promise((resolve) => { settle = resolve as typeof settle }))
  try {
    await expect(f.preflight()).resolves.toMatchObject({ kind: 'ask' })
    const pending = f.request()
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
    const checkpoint = f.session.snapshotEvents().find(event => event.type === 'hivemind/runtime-native-approval-notification')
    expect(checkpoint?.data).toMatchObject({ callId: 'request-call', rootCallId: 'request-call',
      toolName: 'sensitive_action', status: 'pending', owner: principal })
    expect(String(checkpoint?.data.argumentsDigest)).toMatch(/^[a-f0-9]{64}$/u)
    expect(JSON.stringify(checkpoint?.data)).not.toContain('private argument')
    expect(f.order.slice(0, 2)).toEqual(['persist', 'email'])
    expect(f.send).toHaveBeenCalledExactlyOnceWith(f.agent, {
      message_key: 'request-call-user-request', request_call_id: 'request-call', kind: 'approval',
      subject: 'Approval needed to continue',
      message: 'I need your approval before continuing. Sending the prepared message requires your authorization.',
    }, expect.any(AbortSignal))
    settle('allowed-once')
    await expect(pending).resolves.toBe('allowed-once')
    expect(f.session.snapshotEvents().filter(event => event.type === 'hivemind/runtime-native-approval-notification').at(-1)?.data)
      .toMatchObject({ status: 'allowed-once' })
    expect(f.session.snapshotEvents().filter(event => event.type === 'approval/decided').at(-1)?.data)
      .toMatchObject({ outcome: 'allowed-once' })
  } finally { await f.ctx.fiber.dispose() }
})

it('does not create an approval checkpoint when native policy deterministically rejects before answerers', async () => {
  const f = await fixture({ policy: 'never' })
  try {
    await f.preflight()
    await expect(f.request()).resolves.toBe('rejected')
    expect(f.send).not.toHaveBeenCalled()
    expect(f.session.snapshotEvents().some(event => event.type === 'hivemind/runtime-native-approval-notification')).toBe(false)
  } finally { await f.ctx.fiber.dispose() }
})

it('does not email a non-Runtime approval or an approval whose checkpoint failed to persist', async () => {
  const nonRuntime = await fixture({ runtime: false })
  try {
    await nonRuntime.preflight()
    await expect(nonRuntime.request()).resolves.toBe('unavailable')
    expect(nonRuntime.send).not.toHaveBeenCalled()
    expect(nonRuntime.session.snapshotEvents().some(event => event.type === 'hivemind/runtime-native-approval-notification')).toBe(false)
  } finally { await nonRuntime.ctx.fiber.dispose() }

  const noFlush = await fixture({ flush: false })
  let settle!: (outcome: 'rejected') => void
  noFlush.ctx.on('approval/request', () => new Promise((resolve) => { settle = resolve as typeof settle }))
  try {
    await noFlush.preflight()
    const pending = noFlush.request()
    await vi.waitFor(() => expect(noFlush.flush).toHaveBeenCalledOnce())
    expect(noFlush.send).not.toHaveBeenCalled()
    settle('rejected')
    await expect(pending).resolves.toBe('rejected')
  } finally { await noFlush.ctx.fiber.dispose() }
})

it('contains email transport failure and leaves the native approval outcome authoritative', async () => {
  const f = await fixture()
  const warning = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
  let settle!: (outcome: 'rejected') => void
  f.send.mockRejectedValue(new Error('unknown delivery'))
  f.ctx.on('approval/request', () => new Promise((resolve) => { settle = resolve as typeof settle }))
  try {
    await f.preflight()
    const pending = f.request()
    await vi.waitFor(() => expect(warning).toHaveBeenCalledOnce())
    settle('rejected')
    await expect(pending).resolves.toBe('rejected')
    expect(f.session.snapshotEvents().filter(event => event.type === 'approval/decided').at(-1)?.data)
      .toMatchObject({ outcome: 'rejected' })
  } finally { await f.ctx.fiber.dispose() }
})

it('bounds an email sender that ignores cancellation and never settles', async () => {
  vi.useFakeTimers()
  const f = await fixture()
  const warning = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
  f.send.mockImplementation(() => new Promise(() => {}))
  let settle!: (outcome: 'rejected') => void
  f.ctx.on('approval/request', () => new Promise((resolve) => { settle = resolve as typeof settle }))
  try {
    await f.preflight()
    const pending = f.request()
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.waitFor(() => expect(warning).toHaveBeenCalledOnce())
    expect(f.send).toHaveBeenCalledOnce()
    settle('rejected')
    await expect(pending).resolves.toBe('rejected')
    expect(f.session.snapshotEvents().filter(event => event.type === 'approval/decided').at(-1)?.data)
      .toMatchObject({ outcome: 'rejected' })
  } finally {
    await f.ctx.fiber.dispose()
    vi.useRealTimers()
  }
})

it('notifies once after a durable parked approval is committed, without changing the park result', async () => {
  const f = await fixture()
  const scope = f.ctx.hivemindExecutionScope as unknown as { require(): Record<string, unknown> }
  vi.spyOn(scope, 'require').mockReturnValue({ ...principal,
    authenticatedActor: { orgId: principal.orgId, userId: principal.userId, role: 'admin' },
  })
  const argumentsDigest = 'a'.repeat(64)
  f.session.append('hivemind/runtime-approval-checkpoint', {
    approvalId: 'approval-1', callId: 'request-call', rootCallId: 'request-call',
    toolName: 'sensitive_action', arguments: { message: 'private argument' }, argumentsDigest,
    reason: 'Review this action.', owner: { sessionId: String(f.session.id), ...principal }, state: 'pending',
  } as never)
  f.session.append('tool/parked', {
    turn: 1, step: 1, callId: 'request-call', rootCallId: 'request-call', name: 'sensitive_action',
    approvalId: 'approval-1', argumentsDigest,
  } as never)
  const cancelled = new AbortController()
  cancelled.abort(new Error('The originating turn was cancelled after durable park commit.'))
  const execution = { ...f.execution, turn: 1, step: 1, signal: cancelled.signal } as unknown as ToolExecution
  const committed = { kind: 'committed' as const }
  f.ctx.on('tools/park-commit', async () => committed)
  installAdministratorApprovalNotification(f.ctx, f.send)
  try {
    const next = async () => committed
    const park = { kind: 'park' as const, approvalId: 'approval-1', argumentsDigest }
    await expect(f.ctx.waterfall('tools/park-commit', execution, park, next)).resolves.toEqual(committed)
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
    expect(f.order.slice(0, 2)).toEqual(['persist', 'email'])
    expect(f.send).toHaveBeenCalledExactlyOnceWith(f.agent, {
      message_key: 'request-call-user-request', request_call_id: 'request-call', kind: 'approval',
      subject: 'Approval needed to continue',
      message: 'I need your approval before continuing. Review this action.',
    }, expect.any(AbortSignal))
    expect(f.session.snapshotEvents().filter(event => event.type === 'hivemind/runtime-native-approval-notification'))
      .toHaveLength(1)

    await f.ctx.waterfall('tools/park-commit', execution, park, next)
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.session.snapshotEvents().filter(event => event.type === 'hivemind/runtime-native-approval-notification'))
      .toHaveLength(2)
  } finally { await f.ctx.fiber.dispose() }
})

it('redacts obvious credentials and contact links from the persisted approval reason', async () => {
  const f = await fixture()
  let settle!: (outcome: 'rejected') => void
  f.ctx.on('approval/request', () => new Promise((resolve) => { settle = resolve as typeof settle }))
  try {
    await f.preflight()
    const pending = f.ctx.approval.request({ agent: f.agent, callId: 'request-call' as never,
      toolName: 'sensitive_action', reason: 'Use token=abc123 or visit https://private.example/path; contact owner@example.com',
      signal: new AbortController().signal })
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce())
    const checkpoint = f.session.snapshotEvents().find(event => event.type === 'hivemind/runtime-native-approval-notification')
    expect(checkpoint?.data.reason).toBe('Use [redacted] or visit [link] contact [email]')
    expect(JSON.stringify(checkpoint?.data)).not.toMatch(/abc123|private\.example|owner@example\.com/u)
    expect(f.send.mock.calls[0]?.[1].message).not.toMatch(/abc123|private\.example|owner@example\.com/u)
    settle('rejected')
    await expect(pending).resolves.toBe('rejected')
  } finally { await f.ctx.fiber.dispose() }
})
