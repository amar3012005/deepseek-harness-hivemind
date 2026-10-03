import { expect, it } from 'vitest'
import { savedOperatingEvidence } from '../src/review-operating-evidence.ts'
import { reviewFingerprint } from '../src/review.ts'
import type { LedgerEvent } from '../src/ledger.ts'
const identity = { sessionId: 'employee-room', employeeId: 'ravi-id', taskId: 'task-1', artifactIds: ['artifact'] }
function fixture(task = 'task-1', slug = 'ravi') {
  const summary = `Learning for ${task}: keep menu vegetarian.`
  const events = [
    { type: 'hivemind/session-owner', data: { id: 'ravi-id', slug: 'ravi' } },
    { type: 'tool/call', data: { callId: 'save', name: 'hyperagents_memory', arguments: JSON.stringify({ action: 'save', kind: 'learning', summary }) } },
    { type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'save', content: [{ type: 'text', text: JSON.stringify({ ok: true, memory: { id: '6fc29a1d-87b1-4623-90d8-923bc07bac22', kind: 'learning', status: 'recorded', agentSlug: slug, summary } }) }] }] } } },
  ] as LedgerEvent[]
  const inbox = [{ type: 'hivemind/room-message-received', data: { id: 'reply', senderId: 'employee-room', taskId: 'task-1', kind: 'update', artifactIds: ['artifact'], text: 'Chief, here is the brief.' } }] as LedgerEvent[]
  return { events, inbox }
}
it('includes verified typed memory and exact artifact reply in fingerprinted review input', () => {
  const f=fixture(), evidence=savedOperatingEvidence(f.events,f.inbox,identity)
  expect(evidence.memories).toHaveLength(1)
  expect(evidence.replies).toHaveLength(1)
  expect(evidence.memories[0]?.agentSlug).toBe('ravi')
  expect(reviewFingerprint({ documents:[],operatingEvidence:evidence })).not.toBe(reviewFingerprint({ documents:[],operatingEvidence:[] }))
})
it('does not accept missing receipts, wrong author, task-10 or another sender', () => {
  const f=fixture()
  expect(savedOperatingEvidence(f.events.slice(0,2),[],identity).memories).toEqual([])
  expect(savedOperatingEvidence(fixture('task-1','elena').events,[],identity).memories).toEqual([])
  expect(savedOperatingEvidence(fixture('task-10').events,[],identity).memories).toEqual([])
  expect(savedOperatingEvidence(f.events,f.inbox,{ ...identity,sessionId:'other-room' }).replies).toEqual([])
  expect(savedOperatingEvidence(f.events,f.inbox,{ ...identity,employeeId:'elena-id' })).toEqual({ memories:[],replies:[] })
})
