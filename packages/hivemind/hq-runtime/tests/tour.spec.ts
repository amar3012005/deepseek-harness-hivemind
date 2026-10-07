import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionPromptRequest } from '@deepseek-ai/dsh-api-session-controller/types'
import { checkpointTour, resumeFromTour, tourState, wakeFromTour } from '../src/tour.ts'

function fixture() {
  let events: SessionEvent[] = [], durable: SessionEvent[] = []
  let principal = { orgId: 'org-a', userId: 'user-a' }
  const inbox = { nextTurn: [] as UserMessage[], nextStep: [] as UserMessage[] }
  const append = (type: string, data: unknown) => events.push({ type, data, seq: events.length, time: Date.now() } as SessionEvent)
  const agent = { id: 'runtime-room', status: 'idle', inbox,
    session: { snapshotEvents: () => events, append } } as unknown as Agent
  const flush = vi.fn(async () => { durable = structuredClone(events); return true })
  const prompt = vi.fn(async (request: SessionPromptRequest) => {
    const source = { kind: 'user' as const, rpcId: request.requestId }
    const message = createUserMessage({ source, content: request.content.flatMap(part => part.type === 'text' ? [part] : []) })
    if (inbox.nextTurn.some(item => 'rpcId' in item.source && item.source.rpcId === source.rpcId)
      || events.some(event => event.type === 'user/message' && 'rpcId' in event.data.source && event.data.source.rpcId === source.rpcId)) return { accepted: true }
    inbox.nextTurn.push(message)
    append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
    return { accepted: true }
  })
  const ctx = { hivemindExecutionScope: { require: () => principal }, sessions: { flush },
    sessionController: { prompt } } as unknown as Context
  const finishTurn = () => {
    for (const message of inbox.nextTurn.splice(0)) append('user/message', message)
    append('turn/end', { turn: 1, reason: { kind: 'error' } })
  }
  return { ctx, agent, flush, prompt, append, finishTurn,
    principal: (orgId: string, userId: string) => { principal = { orgId, userId } },
    reload: () => { events = structuredClone(durable) }, get events() { return events } }
}
describe('Runtime first-entry checkpoints and native awakening', () => {
  it('opening and completing the tour never sends a prompt; progress survives reload', async () => {
    const f = fixture()
    expect(tourState(f.ctx, f.agent)).toMatchObject({ step: 0, awakening: 'sleeping', revision: 0 })
    await checkpointTour(f.ctx, f.agent, { step: 2, presentation: 'active', expectedRevision: 0 })
    f.reload()
    expect(tourState(f.ctx, f.agent)).toMatchObject({ step: 2, revision: 1 })
    await checkpointTour(f.ctx, f.agent, { step: 4, presentation: 'completed', expectedRevision: 1 })
    expect(tourState(f.ctx, f.agent)).toMatchObject({ presentation: 'completed', awakening: 'sleeping' })
    expect(f.prompt).not.toHaveBeenCalled()
  })
  it('keeps dismissed entry and isolates progress by authenticated user and company', async () => {
    const f = fixture()
    await checkpointTour(f.ctx, f.agent, { step: 1, presentation: 'dismissed', expectedRevision: 0 })
    f.principal('org-a', 'user-b')
    expect(tourState(f.ctx, f.agent)).toMatchObject({ step: 0, presentation: 'active' })
    f.principal('org-b', 'user-a')
    expect(tourState(f.ctx, f.agent).revision).toBe(0)
    f.principal('org-a', 'user-a')
    expect(tourState(f.ctx, f.agent)).toMatchObject({ step: 1, presentation: 'dismissed' })
  })
  it('reconciles conflicting tabs and validates checkpoint schema', async () => {
    const f = fixture()
    await checkpointTour(f.ctx, f.agent, { step: 1, presentation: 'active', expectedRevision: 0 })
    await expect(checkpointTour(f.ctx, f.agent, { step: 4, presentation: 'completed', expectedRevision: 0 })).resolves.toMatchObject({ ok: false, current: { step: 1 } })
    expect(() => checkpointTour(f.ctx, f.agent, { step: 5, presentation: 'active', expectedRevision: 1 })).toThrow('hq_invalid_tour_checkpoint')
  })
  it('admits the exact command once under concurrent clicks and waits for official checkpoint', async () => {
    const f = fixture()
    await Promise.all([wakeFromTour(f.ctx, f.agent), wakeFromTour(f.ctx, f.agent)])
    expect(f.prompt).toHaveBeenCalledTimes(1)
    expect(f.prompt.mock.calls[0]![0]).toMatchObject({ sessionId: 'runtime-room', content: [{ type: 'text', text: 'Wakeup ! chief' }] })
    expect(tourState(f.ctx, f.agent).awakening).toBe('accepted')
    f.append('hivemind/hq-awakening-start', { version: 1, turn: 1, startedAt: new Date().toISOString() })
    expect(tourState(f.ctx, f.agent).awakening).toBe('exploring')
    f.append('hivemind/hq-awakening-checkpoint', { stage: 'conversation', blocked: false })
    expect(tourState(f.ctx, f.agent).awakening).toBe('awakened')
    await wakeFromTour(f.ctx, f.agent)
    expect(f.prompt).toHaveBeenCalledTimes(1)
  })
  it('reconciles a failed presentation flush with the same checkpoint and no duplicate event', async () => {
    const f = fixture(), request = { step: 2, presentation: 'active' as const, expectedRevision: 0 }
    f.flush.mockResolvedValueOnce(false)
    await expect(checkpointTour(f.ctx, f.agent, request)).rejects.toThrow('not_persisted')
    await expect(checkpointTour(f.ctx, f.agent, request)).resolves.toMatchObject({ ok: true, value: { step: 2, revision: 1 } })
    expect(f.events.filter(event => event.type === 'hivemind/hq-tour')).toHaveLength(1)
    f.reload()
    expect(tourState(f.ctx, f.agent).step).toBe(2)
  })
  it('does not treat a plain invitation or blocked completion as official awakening', () => {
    const f = fixture()
    f.append('hivemind/hq-awakening-checkpoint', { stage: 'conversation', blocked: false })
    expect(tourState(f.ctx, f.agent).awakening).toBe('sleeping')
    f.append('hivemind/hq-awakening-start', { version: 1, turn: 1, startedAt: 'now' })
    expect(tourState(f.ctx, f.agent).awakening).toBe('exploring')
    const g = fixture()
    g.append('hivemind/hq-awakening-start', { version: 1, turn: 1, startedAt: 'now' })
    g.append('hivemind/hq-awakening-checkpoint', { stage: 'remembered', blocked: true })
    expect(tourState(g.ctx, g.agent).awakening).toBe('blocked')
  })
  it('retries rejected admission but reconciles accepted uncertain persistence without duplicating', async () => {
    const f = fixture()
    f.prompt.mockRejectedValueOnce(new Error('model unavailable'))
    await expect(wakeFromTour(f.ctx, f.agent)).rejects.toThrow('model unavailable')
    expect(tourState(f.ctx, f.agent).awakening).toBe('sleeping')
    f.flush.mockResolvedValueOnce(false)
    await expect(wakeFromTour(f.ctx, f.agent)).rejects.toThrow('receipt_not_persisted')
    await expect(wakeFromTour(f.ctx, f.agent)).resolves.toMatchObject({ dispatched: false, state: { awakening: 'accepted' } })
    expect(f.prompt).toHaveBeenCalledTimes(2)
  })
  it('offers explicit native continuation after failed admitted turn without a second wake command', async () => {
    const f = fixture()
    await wakeFromTour(f.ctx, f.agent)
    f.finishTurn()
    expect(tourState(f.ctx, f.agent).canResume).toBe(true)
    await Promise.all([resumeFromTour(f.ctx, f.agent), resumeFromTour(f.ctx, f.agent)])
    expect(f.prompt).toHaveBeenCalledTimes(2)
    const text = f.prompt.mock.calls[1]![0].content.flatMap(part => part.type === 'text' ? [part.text] : []).join('')
    expect(text).toContain('Continue my unfinished first Runtime awakening')
    expect(text).not.toContain('Wakeup ! chief')
    expect(tourState(f.ctx, f.agent).canResume).toBe(false)
  })
})
