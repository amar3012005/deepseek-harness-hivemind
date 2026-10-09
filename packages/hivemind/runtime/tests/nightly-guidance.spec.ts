import { it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { currentNightlyOccurrence, installNightlyRoutineGuidance } from '../src/nightly-routine-guidance.ts'
const occurrence='2026-10-09T18:16:54.867Z'
function fixture(kind='schedule', preset='hivemind-hq') {
  const id='session-nightly-fixture'
  const schedule='schedule-'+createHash('sha256').update(`${id}\0nightly-routine-check-v1`).digest('hex')
  const events=[{ type:'hivemind/session-owner',seq:1,data:{ id:null,slug:'runtime' } },{ type:'turn/end',seq:2,data:{} },
    { type:'user/message',seq:3,data:{ source:{ kind,occurrenceAt:occurrence },content:[{ type:'text',text:'reminders_json: '+JSON.stringify([{ schedule_id:schedule,occurrence_at:occurrence }]) }] } }] as unknown as SessionEvent[]
  const agent={ id,session:{ header:{ agentPreset:preset },snapshotEvents:()=>events } } as unknown as Agent
  return { agent,events }
}
it('recognizes only fresh authentic canonical schedule input',()=>{
  const f=fixture();expect(currentNightlyOccurrence(f.agent)).toBe(occurrence)
  f.events.push({ type:'turn/end',seq:4,data:{} });expect(currentNightlyOccurrence(f.agent)).toBeUndefined()
  expect(currentNightlyOccurrence(fixture('user').agent)).toBeUndefined()
})
it('rejects malformed, different-schedule and unanchored batches',()=>{
  for (const text of ['reminders_json: broken','reminders_json: '+JSON.stringify([{ schedule_id:'other',occurrence_at:occurrence }]),'reminders_json: '+JSON.stringify([{ schedule_id:'schedule-'+createHash('sha256').update('session-nightly-fixture\0nightly-routine-check-v1').digest('hex'),occurrence_at:'2026-10-09T00:00:00.000Z' }])]) {
    const f=fixture();const event=f.events[2]!;if(event.type==='user/message'&&event.data.content[0]?.type==='text')event.data.content[0].text=text;expect(currentNightlyOccurrence(f.agent)).toBeUndefined()
  }
})
it('loads canonical review body once per active turn without replacing the actual request',async()=>{
  type Handler = (input: { agent: Agent; turn: number }, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>
  let handler: Handler
  const ctx={
    inject:(_deps:string[],fn:(scope:Context)=>void)=>fn(ctx), effect:(fn:()=>unknown)=>fn(),
    skills:{ register:()=>()=>{} }, on:(_name:string,fn:Handler)=>{handler=fn;return ()=>{}},
  } as unknown as Context
  installNightlyRoutineGuidance(ctx)
  const f=fixture(), decision={ kind:'enter' as const,messages:[createUserMessage({ source:{ kind:'user' },content:[] })] }
  const call=(agent=f.agent,turn=2)=>handler({ agent,turn },async()=>decision)
  const result=await call()
  if(result.kind==='reject')throw Error('unexpected reject')
  expect(result.messages[0]).toBe(decision.messages[0])
  expect(JSON.stringify(result.messages.at(-1)?.content)).toContain(occurrence)
  expect(JSON.stringify(result.messages.at(-1)?.content)).toContain('runtime_support_report')
  expect(await call()).toBe(decision)
  expect(await call(fixture('user').agent)).toBe(decision)
  expect(await call(fixture('schedule','hivemind-hyperagents').agent)).toBe(decision)
  f.events.push({ type:'turn/end',seq:4,data:{} });expect(await call(f.agent,3)).toBe(decision)
})
