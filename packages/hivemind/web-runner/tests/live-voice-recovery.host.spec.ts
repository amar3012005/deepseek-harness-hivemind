import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { expect, it, vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { ReactLoopInbox } from '../../../core/agent-loop/src/inbox.ts'
import { persistVoiceCall } from '../src/live-voice.ts'

const actor = { userId: 'owner', orgId: 'fixture-org', role: 'admin' as const, name: 'Fixture Owner' }
const receipt = { callId: 'actual-call', provider: 'grok' as const, authenticatedActor: actor,
  initialCheckIn: false, interrupted: false, hadUserSpeech: true, transcript: 'Confirmed fixture priorities.' }

async function fixture(seed?: readonly SessionEvent[]) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(AgentRegistry)
  const loop = await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter([textResponse('Reviewed saved call.')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const { agent } = await ctx.agents.create({ sessionId: SessionId('call-recovery'),
    agentOptions: { provider: 'mock', model: 'mock' }, ...(seed ? { seed } : {}) })
  const flush = vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(true)
  const barrier = Promise.withResolvers<undefined>()
  const maintenance = agent.runMaintenance(() => barrier.promise)
  const finish = async () => { barrier.resolve(undefined); await maintenance; await loop.dispose() }
  const inserted = () => agent.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced'
    && event.data.inserted.some(message => message.source.kind === 'plugin' && message.source.voiceCallId === receipt.callId))
  return { ctx, loop, agent, adapter, flush, barrier, maintenance, finish, inserted }
}

it('recovers a saved receipt after the receipt-to-enqueue crash window and never replays completed work', async () => {
  const original = await fixture()
  original.agent.session.append('hivemind/voice-call-ended', receipt)
  const saved = original.agent.session.snapshotEvents()
  await original.finish()
  const f = await fixture(saved)
  try {
    await Promise.all([persistVoiceCall(f.ctx, f.agent, receipt, 'Original context'), persistVoiceCall(f.ctx, f.agent, receipt, 'Retry context')])
    expect(f.inserted()).toHaveLength(1)
    expect(f.agent.inbox.nextTurn[0]?.source).toMatchObject({ voiceCallId: receipt.callId, authenticatedActor: actor })
    expect(f.agent.session.snapshotEvents().filter(event => event.type === 'hivemind/voice-call-ended')).toHaveLength(1)
    f.barrier.resolve(undefined); await f.maintenance
    await vi.waitFor(() => expect(f.adapter.requests).toHaveLength(1))
    await vi.waitFor(() => expect(f.agent.status).toBe('idle'))
    await persistVoiceCall(f.ctx, f.agent, receipt, 'Retry after completion')
    expect(f.inserted()).toHaveLength(1)
    expect(f.adapter.requests).toHaveLength(1)
  } finally { await f.finish() }
})

it('retains one queued identity when the post-enqueue flush fails, including after native projection restoration', async () => {
  const original = await fixture()
  try {
    original.flush.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('storage interrupted'))
    await expect(persistVoiceCall(original.ctx, original.agent, receipt, 'Saved call')).rejects.toThrow('storage interrupted')
    expect(original.inserted()).toHaveLength(1)
    const restored = await fixture(original.agent.session.snapshotEvents())
    try {
      expect(restored.agent.inbox.nextTurn).toHaveLength(1)
      await persistVoiceCall(restored.ctx, restored.agent, receipt, 'Retry after restart')
      expect(restored.inserted()).toHaveLength(1)
      expect(restored.agent.inbox.nextTurn).toHaveLength(1)
      // Preserve native queued state; this helper must not invent a second wake input.
      restored.agent.inbox.clear()
    } finally { await restored.finish() }
    original.agent.inbox.clear()
  } finally { await original.finish() }
})

it('does not replay input claimed before user-message admission or explicitly canceled input', async () => {
  const f = await fixture()
  try {
    await persistVoiceCall(f.ctx, f.agent, receipt, 'Saved call')
    const inbox = f.agent.inbox
    if (!(inbox instanceof ReactLoopInbox)) throw new Error('Expected native ReactLoopInbox')
    const claimed = inbox.claim('next-turn', 1)
    expect(claimed).toHaveLength(1)
    expect(f.agent.inbox.nextTurn).toHaveLength(0)
    await persistVoiceCall(f.ctx, f.agent, receipt, 'Retry while claimed')
    expect(f.inserted()).toHaveLength(1)
    expect(f.agent.inbox.nextTurn).toHaveLength(0)
    const another = { ...receipt, callId: 'canceled-call' }
    await persistVoiceCall(f.ctx, f.agent, another, 'Canceled context')
    f.agent.inbox.clear()
    await persistVoiceCall(f.ctx, f.agent, another, 'Canceled retry')
    expect(f.agent.inbox.nextTurn).toHaveLength(0)
    expect(f.adapter.requests).toHaveLength(0)
  } finally { await f.finish() }
})

it('fails before enqueue when the receipt flush has no durability listener, then recovers on retry', async () => {
  const f = await fixture()
  try {
    f.flush.mockResolvedValueOnce(false)
    await expect(persistVoiceCall(f.ctx, f.agent, receipt, 'Saved call')).rejects.toThrow('voice_handoff_persistence_required')
    expect(f.inserted()).toHaveLength(0)
    await persistVoiceCall(f.ctx, f.agent, receipt, 'Retry')
    expect(f.inserted()).toHaveLength(1)
    expect(f.agent.session.snapshotEvents().filter(event => event.type === 'hivemind/voice-call-ended')).toHaveLength(1)
    f.agent.inbox.clear()
  } finally { await f.finish() }
})

it('pins the original receipt, actor and provider across retries', async () => {
  const f = await fixture()
  try {
    f.agent.session.append('hivemind/voice-call-ended', receipt)
    await expect(persistVoiceCall(f.ctx, f.agent, { ...receipt, authenticatedActor: { ...actor, userId: 'another-owner' } }, 'Wrong caller')).rejects.toThrow('voice_receipt_identity_conflict')
    await expect(persistVoiceCall(f.ctx, f.agent, { ...receipt, provider: 'codex' }, 'Wrong provider')).rejects.toThrow('voice_receipt_identity_conflict')
    await persistVoiceCall(f.ctx, f.agent, { ...receipt, transcript: 'Changed retry payload' }, 'Retry')
    const message = f.agent.inbox.nextTurn[0]
    expect(message?.source).toMatchObject({ authenticatedActor: actor, voiceCallId: receipt.callId })
    expect(JSON.stringify(message?.content)).toContain(receipt.transcript)
    expect(JSON.stringify(message?.content)).not.toContain('Changed retry payload')
    f.agent.inbox.clear()
  } finally { await f.finish() }
})
