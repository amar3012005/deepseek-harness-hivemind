import { it, expect } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createHash } from 'node:crypto'
import { requireNightlyOccurrence, runtimeSupportReportTool } from '../src/nightly-support.ts'
function actor(preset='hivemind-hq',slug='runtime'):Agent {return { session:{ header:{ agentPreset:preset },snapshotEvents:()=>[{ type:'hivemind/session-owner',data:{ id:slug==='runtime'?null:'employee',slug } }] } } as unknown as Agent}
it('exposes only bounded enumerated diagnostics without arbitrary recipient or private text',()=>{
  const tool=runtimeSupportReportTool(async()=>({})),schema=JSON.stringify(tool.parameters)
  for(const excluded of ['recipient','transcript','memory_text','subject','message','url','token'])expect(Object.hasOwn(tool.parameters,excluded)).toBe(false)
  expect(schema).toContain('additionalProperties');expect(schema).toContain('1000000');expect(schema).toContain('permission_denied');expect(tool.description).toContain('Accepted/queued is not delivered')
})
it('denies employee or missing actor before the Core send callback',async()=>{
  let sends=0;const tool=runtimeSupportReportTool(async()=>{sends++;return{ status:'pending' }})
  const args={ operation:'status' as const,occurrence:'2026-10-09T00:00:00.000Z' }
  for(const agent of [undefined,actor('hivemind-hyperagents','romeo')])await expect(tool.execute(args,{ agent,signal:new AbortController().signal } as never)).rejects.toThrow()
  expect(sends).toBe(0)
  await expect(tool.execute(args,{ agent:actor(),signal:new AbortController().signal } as never)).resolves.toEqual({ status:'pending' });expect(sends).toBe(1)
})

it('rejects arbitrary text and inconsistent/out-of-bounds diagnostics before dispatch',async()=>{
  let sends=0
  const tool=runtimeSupportReportTool(async()=>{sends++;return{}})
  const exec={ agent:actor(),signal:new AbortController().signal } as never
  const valid={ operation:'submit',occurrence:'2026-10-09T00:00:00.000Z',coverage:{ expected:2,inspected:1,missing:1 },issues:[] }
  for(const args of [{ ...valid,message:'private transcript' },{ ...valid,coverage:{ expected:2,inspected:2,missing:1 } },{ ...valid,coverage:{ expected:1001,inspected:1001,missing:0 } },{ operation:'status',occurrence:valid.occurrence,issues:[] }])await expect(tool.execute(args,exec)).rejects.toThrow()
  expect(sends).toBe(0)
})

it('uses the original nightly batch member even when another reminder is first, and rejects invented occurrences',()=>{
  const occurrence='2026-10-09T00:00:00.000Z',first='2026-10-08T23:59:00.000Z',id='session-nightly-test'
  const schedule='schedule-'+createHash('sha256').update(`${id}\0nightly-routine-check-v1`).digest('hex')
  const event={ type:'user/message',data:{ source:{ kind:'schedule',occurrenceAt:first },content:[{ type:'text',text:'reminders_json: '+JSON.stringify([{ schedule_id:'other',occurrence_at:first },{ schedule_id:schedule,occurrence_at:occurrence }]) }] } }
  const agent={ id,session:{ snapshotEvents:()=>[event] } } as unknown as Agent
  expect(()=>requireNightlyOccurrence(agent,occurrence)).not.toThrow()
  expect(()=>requireNightlyOccurrence(agent,'2026-10-09T01:00:00.000Z')).toThrow('saved_nightly_occurrence_required')
  event.data.source.kind='user';expect(()=>requireNightlyOccurrence(agent,occurrence)).toThrow()
})
