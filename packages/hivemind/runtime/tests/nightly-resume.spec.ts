import { it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { currentNightlyOccurrence } from '../src/nightly-routine-guidance.ts'
it('resumes only a correlated saved reply to the original scheduled review',()=>{
  const id='session-nightly',occurrence='2026-10-11T00:00:00.000Z'
  const schedule='schedule-'+createHash('sha256').update(`${id}\0nightly-routine-check-v1`).digest('hex')
  const events=[{ seq:1,type:'user/message',data:{ source:{ kind:'schedule',deliveryKey:'fixture-delivery',deliveryKeys:['fixture-delivery'] },content:[{ type:'text',text:'reminders_json: '+JSON.stringify([{ schedule_id:schedule,occurrence_at:occurrence }]) }] } },{ seq:2,type:'hivemind/room-message-queued',data:{ id:'request',senderId:id,kind:'question',targetId:'employee',text:'NIGHTLY_REVIEW_REQUEST='+JSON.stringify({ occurrence,agent_index:1 }) } },{ seq:3,type:'turn/end',data:{} },{ seq:4,type:'hivemind/room-message-received',data:{ id:'reply',kind:'reply',targetId:id,senderId:'employee',replyTo:'request' } },{ seq:5,type:'user/message',data:{ source:{ kind:'hivemind-agent-message',messageId:'reply' },content:[] } }]
  const agent={ id,session:{ snapshotEvents:()=>events } } as unknown as Agent
  expect(currentNightlyOccurrence(agent)).toBe(occurrence)
  Object.assign(events[3]!.data,{ senderId:'other' });expect(currentNightlyOccurrence(agent)).toBeUndefined()
  Object.assign(events[3]!.data,{ senderId:'employee' });Object.assign(events[0]!.data,{ source:{ kind:'user' } });expect(currentNightlyOccurrence(agent)).toBeUndefined()
})

it('keeps all active roster members in request phase and stops waiting instead of polling', async () => {
  const { nightlyReviewPhase } = await import('../src/nightly-routine-guidance.ts')
  const occurrence = '2026-10-11T04:00:00.000Z'
  const roster = [{ id: 'a', name: 'A', index: 1 }, { id: 'b', name: 'B', index: 2 }]
  const request = (index: number) => ({ type: 'hivemind/room-message-queued', data: { id: `request-${index}`, text: `NIGHTLY_REVIEW_REQUEST=${JSON.stringify({ occurrence, agent_index: index })}` } })
  expect(nightlyReviewPhase([request(1)], occurrence, roster)).toContain('"id":"b"')
  expect(nightlyReviewPhase([request(1), request(2)], occurrence, roster)).toContain('End this model turn now')
  const replies = [1, 2].map(index => ({ type: 'hivemind/room-message-received', data: { kind: 'reply', replyTo: `request-${index}` } }))
  expect(nightlyReviewPhase([request(1), request(2), ...replies], occurrence, roster)).toContain('all 2 requested employee replies are saved')
})
