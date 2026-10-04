import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import { wakeBriefing } from '../src/wake-briefing.ts'
import type { HqWorkspace } from '../src/types.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
const workspace: HqWorkspace = { mode: { enabled: false, revision: 0, changedAt: 0 }, tasks: [], calendar: [], wakes: [] }
describe('HQ wake briefing', () => {
  it('preserves pause, native wake delivery and task evidence without inferring completion', () => {
    const text = wakeBriefing({ ...workspace, wakes: [{ id: 'wake-1', title: 'Review', kind: 'once', scheduledAt: '2030-01-01', status: 'completed', deliveredAt: '2030-01-01' }] }, [], 'root')
    expect(text).toContain('"enabled":false')
    expect(text).toContain('"deliveredAt":"2030-01-01"')
    expect(text).toContain('do not certify task completion')
    expect(text).toContain('When nothing is due, remain quiet')
  })
  it('includes quiet persistent employee notices with exact artifact references', () => {
    const events = [{ type: 'hivemind/room-message-received', data: { id: 'notice', senderName: 'Ravi', kind: 'update', text: 'Saved report', artifactIds: ['artifact-1'] } }] as unknown as SessionEvent[]
    const text = wakeBriefing(workspace, events, 'root')
    expect(text).toContain('"kind":"update"')
    expect(text).toContain('"artifactIds":["artifact-1"]')
  })
  it('retains only messages addressed to this root and bounds message history', () => {
    const events = Array.from({ length: 20 }, (_, id) => ({ type: 'team/message/queued', data: { message: { id: String(id), targetId: id === 19 ? 'other' : 'root', senderName: 'Ravi', content: [{ type: 'text', text: 'question' }] } } })) as unknown as SessionEvent[]
    const text = wakeBriefing(workspace, events, 'root')
    const result = JSON.parse(text.slice(text.indexOf('{')))
    expect(result.employeeMessages).toHaveLength(12)
    expect(result.employeeMessages.at(-1).id).toBe('18')
  })
})


it('admits one native briefing per turn and rereads on cold restore', async () => {
  let hook: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>
  const workspaceRead = vi.fn(async () => workspace)
  const agent = { id: 'root', ctx: { tools: { restrict: vi.fn(() => () => {}) } }, session: { header: { agentPreset: 'hivemind-hq' }, ownEvents: () => [], snapshotEvents: () => [] } }
  const ctx = {
    effect: (callback: () => unknown) => callback(),
    on: (_name: string, callback: typeof hook) => { hook = callback; return () => {} },
    agentTeams: { guardTaskUpdates: () => () => {}, tryMembership: (subject: unknown) => ({ role: 'lead', root: subject }), membership: (subject: unknown) => ({ role: 'lead', root: subject }) },
    hivemindHq: { workspace: workspaceRead }, sessions: { flush: async () => true }, tools: { register: () => {} },
  } as unknown as Context
  apply(ctx)
  const enter = async () => ({ kind: 'enter', messages: [] })
  expect(JSON.stringify(await hook!({ agent, turn: 1 }, enter))).toContain('HQ current operating briefing')
  expect(JSON.stringify(await hook!({ agent, turn: 1 }, enter))).not.toContain('HQ current operating briefing')
  expect(workspaceRead).toHaveBeenCalledTimes(1)
  await hook!({ agent, turn: 2 }, enter)
  await hook!({ agent: { ...agent }, turn: 2 }, enter)
  expect(workspaceRead).toHaveBeenCalledTimes(3)
})


it('keeps saved human timing notes visible during initial awakening', async () => {
  let hook: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>
  const events = [
    { seq: 0, type: 'hivemind/hq-awakening-start', data: { version: 1, turn: 1 } },
    { seq: 1, type: 'hivemind/hq-rest-note', data: { id: 'test-timing', text: 'Use minute-scale schedules for this test, not tomorrow.', createdAt: '2026-10-04T00:00:00Z' } },
    { seq: 2, type: 'turn/start', data: { turn: 1 } },
  ]
  const agent = { id: 'root', ctx: { tools: { restrict: vi.fn(() => () => {}) } }, session: { header: { agentPreset: 'hivemind-hq' }, ownEvents: () => events, snapshotEvents: () => events } }
  const ctx = {
    effect: (callback: () => unknown) => callback(),
    on: (_name: string, callback: typeof hook) => { hook = callback; return () => {} },
    agentTeams: { guardTaskUpdates: () => () => {}, tryMembership: (subject: unknown) => ({ role: 'lead', root: subject }), membership: (subject: unknown) => ({ role: 'lead', root: subject }) },
    hivemindHq: { workspace: async () => workspace }, sessions: { flush: async () => true }, tools: { register: () => {} },
  } as unknown as Context
  apply(ctx)
  const result = await hook!({ agent, turn: 1 }, async () => ({ kind: 'enter', messages: [] }))
  const text = JSON.stringify(result)
  expect(text).toContain('First awakening is active')
  expect(text).toContain('Use minute-scale schedules for this test, not tomorrow.')
  expect(text).toContain('hq-rest-pending-note-ids')
})
