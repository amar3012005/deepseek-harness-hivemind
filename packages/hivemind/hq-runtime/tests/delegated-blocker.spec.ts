import { describe, it, expect, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { DelegatedConnectionRequest } from '@deepseek-ai/dsh-hivemind-connected-apps/src/delegated-blocker.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
const mocks = vi.hoisted(() => ({ allowed: vi.fn(), authenticate: vi.fn(), deliver: vi.fn() }))
vi.mock('../src/employee-room.ts', async original => ({
  referenceFromMessage: (await original<typeof import('../src/employee-room.ts')>()).referenceFromMessage, allowsEmployeeWork: mocks.allowed, authenticatedRoot: mocks.authenticate,
  rooms: () => ({ deliverAgentMessage: mocks.deliver }), employeeWorkPrompt: () => 'same native assignment' }))
vi.mock('../src/rest.ts', () => ({ isHqLead: (_ctx: unknown, agent: { id: string }) => agent.id === 'chief' }))
import { reportDelegatedConnection, resumeDelegatedBlocker, installDelegatedBlockerReporting, delegatedBlockers, checkpointLegacyDelegatedConnection } from '../src/delegated-blocker.ts'
function fixture() {
  mocks.allowed.mockReset().mockResolvedValue(true)
  mocks.authenticate.mockReset()
  mocks.deliver.mockReset().mockResolvedValue({ messageId: 'message-1' })
  const rootEvents: SessionEvent[] = [{ seq: 1, type: 'hivemind/hq-employee-assignment', data: { taskId:'task-1', employeeId:'employee',sessionId:'room',memberName:'employee' } }]
  const employeeEvents: SessionEvent[] = [{ seq:1,type:'turn/start',data:{ turn:1 } }, { seq:2,type:'hivemind/employee-work-origin',data:{ turn:1,rootId:'chief',taskId:'task-1' } }]
  const agent = (id: string, events: SessionEvent[]) => ({ id,
    session: { ownEvents: () => events,
      append: (type: string, data: unknown) => events.push({ seq: events.length + 1, type, data } as SessionEvent),
    },
  }) as unknown as Agent
  const root=agent('chief',rootEvents), employee=agent('room',employeeEvents)
  mocks.authenticate.mockImplementation(async (_ctx, id) => id==='chief'?root:employee)
  const task={ ownerName:'employee',revision:2 }
  type Hook = (input: unknown, next: () => Promise<{ kind: string }>) => Promise<{ kind: string }>
  const hooks = new Map<string, Hook>()
  const ctx = { agentTeams: { getTask: () => task }, sessions: { flush: vi.fn(async () => true) },
    schedule: { ensure: vi.fn(async () => ({ id: 'schedule' })) },
    serial: vi.fn(async () => true), effect: (fn: () => unknown) => fn(),
    on: (name: string, fn: Hook) => { hooks.set(name, fn); return () => {} },
  } as unknown as Context
  const input={ execution:{ agent:employee,callId:'call-1',signal:new AbortController().signal }, workflowSessionId:'upon',routerSessionId:'router',toolkits:['googlesheets'] } as unknown as DelegatedConnectionRequest
  return { ctx,root,employee,rootEvents,employeeEvents,task,input,hooks }
}
describe('Runtime delegated blocker checkpoint',()=>{
  it('saves before delivery, deduplicates reporting and schedules one bounded native check',async()=>{
    const f=fixture();const first=await reportDelegatedConnection(f.ctx,f.input);await reportDelegatedConnection(f.ctx,f.input)
    expect(first?.status).toBe('blocked_reported');expect(delegatedBlockers(f.root)).toHaveLength(1)
    expect(f.employeeEvents.filter(e=>e.type==='hivemind/connected-receipt')).toHaveLength(1)
    expect(mocks.deliver.mock.calls[0][1].key).toBe(mocks.deliver.mock.calls[1][1].key)
    expect(f.ctx.schedule.ensure).toHaveBeenCalledWith('chief',expect.stringContaining('-connection-check'),expect.objectContaining({ after_seconds:300 }),f.input.execution.signal)
  })
  it('keeps direct-human connection flow intact',async()=>{
    const f=fixture();f.employeeEvents.pop();expect(await reportDelegatedConnection(f.ctx,f.input)).toBeUndefined()
    expect(mocks.deliver).not.toHaveBeenCalled();expect(f.ctx.schedule.ensure).not.toHaveBeenCalled()
  })
  it('never reports before durable checkpoint persistence',async()=>{
    const f=fixture();vi.mocked(f.ctx.sessions.flush).mockResolvedValue(false)
    await expect(reportDelegatedConnection(f.ctx,f.input)).rejects.toThrow('persistence_required');expect(mocks.deliver).not.toHaveBeenCalled()
  })
  it('requires fresh provider verification and resumes same task/employee once',async()=>{
    const f=fixture();const receipt=(await reportDelegatedConnection(f.ctx,f.input))!
    vi.mocked(f.ctx.serial).mockResolvedValueOnce(false)
    expect((await resumeDelegatedBlocker(f.ctx,f.root,receipt.blocker_id,f.input.execution.signal)).status).toBe('waiting_for_connection')
    expect(mocks.deliver).toHaveBeenCalledTimes(1)
    expect((await resumeDelegatedBlocker(f.ctx,f.root,receipt.blocker_id,f.input.execution.signal)).status).toBe('resumed')
    const resumed=mocks.deliver.mock.calls[1][1];expect(resumed.target).toBe('employee');expect(resumed.taskId).toBe('task-1');expect(resumed.text).toContain('Original workflow: upon')
    await resumeDelegatedBlocker(f.ctx,f.root,receipt.blocker_id,f.input.execution.signal);expect(mocks.deliver).toHaveBeenCalledTimes(2)
  })
  it('rejects revoked, reassigned and revised tasks before any provider request',async()=>{
    for(const change of ['revoked','owner','revision']){const f=fixture();const r=(await reportDelegatedConnection(f.ctx,f.input))!
      if(change==='revoked')mocks.allowed.mockResolvedValue(false);else if(change==='owner')f.task.ownerName='other';else f.task.revision++
      await expect(resumeDelegatedBlocker(f.ctx,f.root,r.blocker_id,f.input.execution.signal)).rejects.toThrow('hq_blocker_assignment');expect(f.ctx.serial).not.toHaveBeenCalled()
    }
  })
  it('routes delegated questions to Runtime but direct human questions remain native',async()=>{
    const f=fixture();installDelegatedBlockerReporting(f.ctx)
    const hook=f.hooks.get('tools/pre-execute');const call={ ...f.input.execution,name:'ask_user_question',arguments:{ questions:[{ id:'q',question:'Which period?' }] } }
    expect((await hook(call,async()=>({ kind:'allow' }))).kind).toBe('deny')
    const b=delegatedBlockers(f.root)[0]!;expect(b.kind).toBe('human_input')
    f.employeeEvents.push({ seq:99,type:'turn/end',data:{ turn:1 } },{ seq:100,type:'turn/start',data:{ turn:2 } })
    expect(await hook(call,async()=>({ kind:'allow' }))).toEqual({ kind:'allow' })
  })
  it('accepts only actual authenticated saved input and never grants native permission through chat',async()=>{
    const f=fixture();installDelegatedBlockerReporting(f.ctx);const hook=f.hooks.get('tools/pre-execute')
    await hook({ ...f.input.execution,name:'ask_user_question',arguments:{} },async()=>({ kind:'allow' }));const b=delegatedBlockers(f.root)[0]!
    f.rootEvents.push({ seq:10,type:'user/message',data:{ source:{ kind:'user' },content:[{ type:'text',text:'This year' }] } })
    await expect(resumeDelegatedBlocker(f.ctx,f.root,b.id,f.input.execution.signal,undefined,undefined,'event:10')).rejects.toThrow('actual_human')
    f.rootEvents[2].data.source.authenticatedActor={ userId:'11111111-1111-4111-8111-111111111111', orgId:'22222222-2222-4222-8222-222222222222', role:'admin', name:'Amar' }
    expect((await resumeDelegatedBlocker(f.ctx,f.root,b.id,f.input.execution.signal,undefined,undefined,'event:10')).status).toBe('resumed')
    const p=fixture();installDelegatedBlockerReporting(p.ctx);await p.hooks.get('tools/pre-execute')({ ...p.input.execution,name:'write',arguments:{} },async()=>({ kind:'ask',reason:'External write' }))
    expect((await resumeDelegatedBlocker(p.ctx,p.root,delegatedBlockers(p.root)[0]!.id,p.input.execution.signal,undefined,{ answer:'Approved',evidenceRefs:['event:1'] })).status).toBe('requires_native_approval')
    expect(mocks.deliver).toHaveBeenCalledTimes(1)
  })
})

describe('exact legacy waiting-call migration',()=>{
  it('pins the admitted same-turn assignment and saves checkpoint without answering or cancelling',async()=>{
    const f=fixture();f.employeeEvents.pop();f.employeeEvents.push(
      { seq:2,type:'user/message',data:{ source:{ kind:'hivemind-agent-message',senderId:'chief' },content:[{ type:'text',text:JSON.stringify({ text:'HQ_EMPLOYEE_ASSIGNMENT={"rootId":"chief","taskId":"task-1"}' }) }] } },
      { seq:3,type:'user/message',data:{ source:{ kind:'user' },content:[{ type:'text',text:'Clarification' }] } },
      { seq:4,type:'hivemind/composio-session',data:{ routerSessionId:'router' } },
      { seq:5,type:'tool/call',data:{ name:'hivemind_connected_task',callId:'legacy',arguments:{ session:{ id:'upon' } } } })
    const r=await checkpointLegacyDelegatedConnection(f.ctx,f.employee,f.input.execution.signal,{ callId:'legacy',workflowSessionId:'upon',routerSessionId:'router',toolkits:['googlesheets'] })
    expect(r.status).toBe('blocked_reported');expect(delegatedBlockers(f.root)[0]?.taskId).toBe('task-1');expect(f.ctx.serial).not.toHaveBeenCalled()
    const count=f.employeeEvents.length
    await checkpointLegacyDelegatedConnection(f.ctx,f.employee,f.input.execution.signal,{ callId:'legacy',workflowSessionId:'upon',routerSessionId:'router',toolkits:['googlesheets'] })
    expect(f.employeeEvents).toHaveLength(count)
    await expect(checkpointLegacyDelegatedConnection(f.ctx,f.employee,f.input.execution.signal,{ callId:'legacy',workflowSessionId:'other',routerSessionId:'router',toolkits:['googlesheets'] })).rejects.toThrow('workflow_mismatch')
  })
  it('refuses finished or new human turns and missing assignment witnesses',async()=>{
    const f=fixture();f.employeeEvents.pop();f.employeeEvents.push({ seq:3,type:'tool/call',data:{ name:'hivemind_connected_task',callId:'legacy',arguments:{ session:{ id:'upon' } } } })
    await expect(checkpointLegacyDelegatedConnection(f.ctx,f.employee,f.input.execution.signal,{ callId:'legacy',workflowSessionId:'upon',routerSessionId:'router',toolkits:['googlesheets'] })).rejects.toThrow('router_mismatch')
    f.employeeEvents.push({ seq:4,type:'turn/end',data:{ turn:1 } })
    await expect(checkpointLegacyDelegatedConnection(f.ctx,f.employee,f.input.execution.signal,{ callId:'legacy',workflowSessionId:'upon',routerSessionId:'router',toolkits:['googlesheets'] })).rejects.toThrow('pending_call_required')
    expect(mocks.deliver).not.toHaveBeenCalled()
  })
})
