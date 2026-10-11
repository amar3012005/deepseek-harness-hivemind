import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import ApprovalService from '../src/index.ts'
import { approvalFingerprint, acceptedParkedApproval } from '../src/parked.ts'

interface Event { type: string; data: Record<string, unknown>; seq: number }
const fake = (events: Event[]) => ({ snapshotEvents: () => events }) as unknown as Session
const call = (callId: string, args = { file: 'one' }) => ({ type: 'tool/call', data: { callId, name: 'write', arguments: JSON.stringify(args) } })
function seed(selected = 'Allow once'): Event[] {
  const initial = { ...call('old'), seq: 0 }
  const fingerprint = approvalFingerprint(fake([initial]), 'old', 'write')!
  return [initial,
    { type: 'approval/asked', data: { id: 'request', callId: 'old', toolName: 'write', fingerprint } },
    { type: 'approval/decided', data: { id: 'request', outcome: 'pending' } },
    { type: 'user/message', data: { source: { kind: 'user-question-reply', callId: 'old', outcome: 'answered', questionAnswerSubmission: true, authenticatedActor: { userId: 'owner' } }, content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'approval', selected: [selected] }] }) }] } },
    call('new'),
  ].map((event, seq) => ({ ...event, seq }))
}
const decision = (events: Event[]) => acceptedParkedApproval(fake(events), 'new', 'write', approvalFingerprint(fake(events), 'new', 'write')!)

describe('saved approval exact action', () => {
  it('allows only the identical call after authenticated answer', () => {
    expect(decision(seed())).toEqual({ id: 'request', outcome: 'allowed-once', consumed: false })
  })
  it('never allows changed action', () => {
    const events = seed(); Object.assign(events[4]!.data, { arguments: JSON.stringify({ file: 'other' }) })
    expect(decision(events)).toBeUndefined()
  })
  it('never consumes one permission grant twice', () => {
    const events = seed(); events.splice(4, 0, { type: 'approval/consumed', data: { id: 'request', callId: 'used' }, seq: 3.5 })
    expect(decision(events)).toBeUndefined()
  })
  it('restores an exact rejection from the durable log without treating it as permission', () => {
    const restored: Event[] = JSON.parse(JSON.stringify(seed('Reject')))
    expect(decision(restored)).toEqual({ id: 'request', outcome: 'rejected', consumed: false })
  })
  it('retains rejection for unchanged duplicate retries without consuming it twice', () => {
    const events = seed('Reject'); events.splice(4, 0, { type: 'approval/consumed', data: { id: 'request', callId: 'used' }, seq: 3.5 })
    expect(decision(events)).toEqual({ id: 'request', outcome: 'rejected', consumed: true })
  })
  it.each(['Deny', 'yes', 'Allow always', ''])('never interprets unknown option %j as a decision', (selected) => {
    expect(decision(seed(selected))).toBeUndefined()
  })
  it('opens a fresh approval only after a new authenticated direct human instruction', () => {
    const events = seed('Reject')
    events.splice(4, 0, { type: 'user/message', seq: 3.5, data: { source: { kind: 'user', authenticatedActor: { userId: 'owner', orgId: 'organization' } }, content: [{ type: 'text', text: 'Please request this action again.' }] } })
    expect(decision(events)).toBeUndefined()
  })
  it.each(['agent-message', 'plugin', 'webhook', 'user-question-reply'])('never resets rejection from %s delivery', (kind) => {
    const events = seed('Reject')
    events.splice(4, 0, { type: 'user/message', seq: 3.5, data: { source: { kind, authenticatedActor: { userId: 'owner', orgId: 'organization' } }, content: [{ type: 'text', text: 'Continue.' }] } })
    expect(decision(events)?.outcome).toBe('rejected')
  })
  it('never resets rejection from an unauthenticated user-shaped message', () => {
    const events = seed('Reject')
    events.splice(4, 0, { type: 'user/message', seq: 3.5, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue.' }] } })
    expect(decision(events)?.outcome).toBe('rejected')
  })
  it('does not accept unauthenticated answers', () => {
    const events = seed('Reject'); Object.assign(events[3]!.data, { source: { kind: 'user-question-reply', callId: 'old', outcome: 'answered', questionAnswerSubmission: true, authenticatedActor: null } })
    expect(decision(events)).toBeUndefined()
  })
  it('does not accept an answer for another request', () => {
    const events = seed('Reject'); (events[3]!.data['source'] as Record<string, unknown>)['callId'] = 'foreign'
    expect(decision(events)).toBeUndefined()
  })
})

it('native service denies restored rejection, audits it once, and never creates a repeated pending question', async () => {
  const ctx = new Context()
  await ctx.plugin(ApprovalService, { park: true, policy: 'ask' })
  const events: Event[] = JSON.parse(JSON.stringify(seed('Reject')))
  events.splice(4, 0, { type: 'turn/start', data: { turn: 2 }, seq: 3.5 })
  const appended: Event[] = []
  const session = {
    get seq() { return events.length },
    snapshotEvents: () => events,
    eventAt: (seq: number) => events[seq],
    append(type: string, data: Record<string, unknown>) {
      const event = { type, data, seq: events.length }; events.push(event); appended.push(event); return event
    },
  } as unknown as Session
  const agent = { session } as Agent
  let providerCalls = 0
  for (const id of ['new', 'retry']) {
    if (id === 'retry') session.append('tool/call', call(id).data as never)
    const outcome = await ctx.approval.request({ agent, toolName: 'write', callId: ToolCallId(id) })
    if (outcome === 'allowed-once') providerCalls++
    expect(outcome).toBe('rejected')
  }
  expect(providerCalls).toBe(0)
  expect(appended.filter(event => event.type === 'approval/consumed')).toHaveLength(1)
  expect(appended.filter(event => event.type === 'approval/decided').map(event => event.data['outcome'])).toEqual(['rejected', 'rejected'])
  expect(appended.filter(event => event.type === 'approval/asked').every(event => !event.data['questions'])).toBe(true)
  expect(appended.some(event => event.type === 'approval/decided' && event.data['outcome'] === 'pending')).toBe(false)
  events.push({ type: 'user/message', seq: events.length, data: { source: { kind: 'user', authenticatedActor: { userId: 'owner', orgId: 'organization' } }, content: [{ type: 'text', text: 'Please request this action again.' }] } })
  session.append('tool/call', call('fresh').data as never)
  expect(await ctx.approval.request({ agent, toolName: 'write', callId: ToolCallId('fresh') })).toBe('pending')
  expect(appended.filter(event => event.type === 'approval/consumed')).toHaveLength(1)
  expect(appended.at(-1)?.data['outcome']).toBe('pending')
})
