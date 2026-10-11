import { describe, it, expect } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { approvalFingerprint, acceptedParkedApproval } from '../src/parked.ts'
const fake = (events: unknown[]) => ({ snapshotEvents:()=>events }) as unknown as Session
const call = (callId:string,args:unknown) => ({ type:'tool/call',data:{ callId,name:'write',arguments:JSON.stringify(args) } })
const seed = () => {
  const initial=call('old',{ file:'one' }), fingerprint=approvalFingerprint(fake([initial]),'old','write')!
  return [initial,{ type:'approval/asked',data:{ id:'request',callId:'old',toolName:'write',fingerprint } },{ type:'approval/decided',data:{ id:'request',outcome:'pending' } },{ type:'user/message',data:{ source:{ kind:'user-question-reply',callId:'old',outcome:'answered',questionAnswerSubmission:true,authenticatedActor:{ userId:'owner' } },content:[{ type:'text',text:JSON.stringify({ answers:[{ id:'approval',selected:['Allow once'] }] }) }] } },call('new',{ file:'one' })].map((event,seq)=>({ ...event,seq }))
}
describe('saved approval exact action',()=>{
  it('allows only the identical call after authenticated answer',()=>{const events=seed();expect(acceptedParkedApproval(fake(events),'new','write',approvalFingerprint(fake(events),'new','write')!)).toBe('request')})
  it('never allows changed action',()=>{const events=seed();Object.assign(events[4]!.data,{ arguments:JSON.stringify({ file:'other' }) });expect(acceptedParkedApproval(fake(events),'new','write',approvalFingerprint(fake(events),'new','write')!)).toBeUndefined()})
  it('never consumes one human answer twice',()=>{const events=seed();events.splice(4,0,{ type:'approval/consumed',data:{ id:'request',callId:'used' },seq:3.5 } as unknown as ReturnType<typeof seed>[number]);expect(acceptedParkedApproval(fake(events),'new','write',approvalFingerprint(fake(events),'new','write')!)).toBeUndefined()})
  it('does not accept natural language or unauthenticated answers',()=>{const events=seed();Object.assign(events[3]!.data, { source:{ kind:'user-question-reply',callId:'old',outcome:'answered',questionAnswerSubmission:true,authenticatedActor:null } });expect(acceptedParkedApproval(fake(events),'new','write',approvalFingerprint(fake(events),'new','write')!)).toBeUndefined()})
})
