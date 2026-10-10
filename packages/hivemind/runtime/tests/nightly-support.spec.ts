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

it('accepts bounded detailed diagnostics only with the actual native occurrence and rejects credentials before dispatch',async()=>{
  const occurrence='2026-10-09T00:00:00.000Z',id='session-nightly-test';const schedule='schedule-'+createHash('sha256').update(`${id}\0nightly-routine-check-v1`).digest('hex')
  const agent=actor();Object.assign(agent,{ id });agent.session.snapshotEvents=()=>[{ type:'hivemind/session-owner',data:{ id:null,slug:'runtime' } },{ type:'user/message',data:{ source:{ kind:'schedule',occurrenceAt:occurrence },content:[{ type:'text',text:'reminders_json: '+JSON.stringify([{ schedule_id:schedule,occurrence_at:occurrence }]) }] } }] as never
  let sends=0;const tool=runtimeSupportReportTool(async()=>{sends++;return{ status:'accepted' }})
  const details={ functional_area:'marketing',task_context:'Marketing review blocked by schema validation.',impact:'Assigned work cannot advance.',proposed_fix:'Discover a validated identifier.',owner:'hyperagent',agent_index:1,tool:'hivemind_app_get',expected:'A discovered identifier is used.',observed:'Schema validation rejected the malformed identifier.',recovery:'Read-only discovery was retried.',prevention:'Validate the returned identifier before the next call.',evidence:[{ kind:'tool_result',turn:2,sequence:8 }] }
  const input={ operation:'submit',occurrence,coverage:{ expected:2,inspected:2,missing:0 },issues:[{ capability:'crm',code:'invalid_identifier',severity:'high',count:1,cause:'confirmed',details }] }
  const base=agent.session.snapshotEvents()
  const finding={ functional_area:details.functional_area,task_context:details.task_context,
    impact:details.impact,proposed_fix:details.proposed_fix,
    tool:details.tool,expected:details.expected,observed:details.observed,recovery:details.recovery,prevention:details.prevention }
  const request={ type:'hivemind/room-message-queued',seq:7,data:{ id:'request-1',senderId:id,targetId:'employee-room',kind:'question',text:'NIGHTLY_REVIEW_REQUEST='+JSON.stringify({ occurrence,agent_index:1 }) } }
  const reply={ type:'hivemind/room-message-received',seq:8,data:{ id:'reply-1',senderId:'employee-room',targetId:id,kind:'reply',replyTo:'request-1',text:'NIGHTLY_REVIEW_REPLY='+JSON.stringify({ occurrence,findings:[finding] }) } }
  agent.session.snapshotEvents=()=>[...base,request,reply] as never
  await expect(tool.execute(input,{ agent,signal:new AbortController().signal } as never)).resolves.toEqual({ status:'accepted' });expect(sends).toBe(1)
  for(const patch of [{ kind:'update' },{ senderId:'other-room' },{ replyTo:'other-request' },{ text:'Visible chat says it was fixed.' },{ text:'NIGHTLY_REVIEW_REPLY='+JSON.stringify({ occurrence:'2026-10-08T00:00:00.000Z',findings:[finding] }) }]){
    agent.session.snapshotEvents=()=>[...base,request,{ ...reply,data:{ ...reply.data,...patch } }] as never
    await expect(tool.execute(input,{ agent,signal:new AbortController().signal } as never)).rejects.toThrow('saved_correlated_nightly_evidence_required')
  }
  agent.session.snapshotEvents=()=>[...base,{ type:'tool/result',seq:8,data:{} }] as never
  const { agent_index: _index,...ownDetails }=details
  const own={ ...input,issues:[{ ...input.issues[0],details:{ ...ownDetails,owner:'runtime' } }] }
  await expect(tool.execute(own,{ agent,signal:new AbortController().signal } as never)).resolves.toEqual({ status:'accepted' });expect(sends).toBe(2)
  agent.session.snapshotEvents=()=>base
  await expect(tool.execute(own,{ agent,signal:new AbortController().signal } as never)).rejects.toThrow('saved_correlated_nightly_evidence_required')

  await expect(tool.execute({ ...input,issues:[{ ...input.issues[0],details:{ ...details,observed:'Bearer credentialvalue' } }] },{ agent,signal:new AbortController().signal } as never)).rejects.toThrow();expect(sends).toBe(2)
})
