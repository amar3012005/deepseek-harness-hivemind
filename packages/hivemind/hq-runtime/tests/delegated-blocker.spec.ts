import { describe, it, expect, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionSeq, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { DelegatedConnectionRequest } from '@deepseek-ai/dsh-hivemind-connected-apps/src/delegated-blocker.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
const mocks = vi.hoisted(() => ({ allowed: vi.fn(), authenticate: vi.fn(), deliver: vi.fn() }))
vi.mock('../src/employee-room.ts', async original => ({
  referenceFromMessage: (await original<typeof import('../src/employee-room.ts')>()).referenceFromMessage, allowsEmployeeWork: mocks.allowed, authenticatedRoot: mocks.authenticate,
  rooms: () => ({ deliverAgentMessage: mocks.deliver }), employeeWorkPrompt: () => 'same native assignment' }))
vi.mock('../src/rest.ts', () => ({ isHqLead: (_ctx: unknown, agent: { id: string }) => agent.id === 'chief' }))
import { reportDelegatedConnection, notifyDelegatedConnection, resumeDelegatedBlocker, installDelegatedBlockerReporting, delegatedBlockers, checkpointLegacyDelegatedConnection, reportDelegatedHumanInput, unresolvedDelegatedTask, delegatedAnswerCandidates, installDelegatedBlockerTool } from '../src/delegated-blocker.ts'
function must<T>(value: T | undefined): T { if (value === undefined) throw new Error('fixture missing'); return value }
function fixture() {
  mocks.allowed.mockReset().mockResolvedValue(true)
  mocks.authenticate.mockReset()
  mocks.deliver.mockReset().mockResolvedValue({ messageId: 'message-1' })
  const rootEvents: SessionEvent[] = [{ seq: SessionSeq(1), time: 0, type: 'hivemind/hq-employee-assignment', data: { taskId:'task-1', employeeId:'employee',sessionId:'room',memberName:'employee',personaSha256:'digest' } }]
  const employeeEvents: SessionEvent[] = [{ seq: SessionSeq(1), time: 0,type:'turn/start',data:{ turn:1 } }, { seq: SessionSeq(2), time: 0,type:'hivemind/employee-work-origin',data:{ turn:1,rootId:'chief',taskId:'task-1' } }]
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
  const ctx = { hivemindExecutionScope: { require: () => ({ orgId: '22222222-2222-4222-8222-222222222222' }) }, agentTeams: { getTask: () => task }, sessions: { flush: vi.fn(async () => true) },
    schedule: { ensure: vi.fn(async () => ({ id: 'schedule' })) },
    serial: vi.fn(async () => true), effect: (fn: () => unknown) => fn(),
    on: (name: string, fn: Hook) => { hooks.set(name, fn); return () => {} },
  } as unknown as Context
  const input={ execution:{ agent:employee,callId: ToolCallId('call-1'),signal:new AbortController().signal }, workflowSessionId:'upon',routerSessionId:'router',toolkits:['googlesheets'] } as unknown as DelegatedConnectionRequest
  return { ctx,root,employee,rootEvents,employeeEvents,task,input,hooks }
}
describe('Runtime delegated blocker checkpoint',()=>{
  it('saves before delivery, deduplicates reporting and schedules one bounded native check',async()=>{
    const f=fixture();const first=await reportDelegatedConnection(f.ctx,f.input);await reportDelegatedConnection(f.ctx,f.input)
    expect(first?.status).toBe('blocked_reported');expect(delegatedBlockers(f.root)).toHaveLength(1)
    expect(f.employeeEvents.filter(e=>e.type==='hivemind/connected-receipt')).toHaveLength(1)
    expect(mocks.deliver.mock.calls[0]?.[1]?.key).toBe(mocks.deliver.mock.calls[1]?.[1]?.key)
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
    const resumed=must(mocks.deliver.mock.calls[1]?.[1]);expect(resumed.target).toBe('employee');expect(resumed.taskId).toBe('task-1');expect(resumed.text).toContain('Original workflow: upon')
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
    const hook=must(f.hooks.get('tools/pre-execute'));const call={ ...f.input.execution,name:'ask_user_question',arguments:{ questions:[{ id:'q',question:'Which period?' }] } }
    expect((await hook(call,async()=>({ kind:'allow' }))).kind).toBe('deny')
    const b=delegatedBlockers(f.root)[0]!;expect(b.kind).toBe('human_input')
    f.employeeEvents.push({ seq: SessionSeq(99), time: 0,type:'turn/end',data:{ turn:1,reason:{ kind:'completed' } } },{ seq: SessionSeq(100), time: 0,type:'turn/start',data:{ turn:2 } })
    expect(await hook(call,async()=>({ kind:'allow' }))).toEqual({ kind:'allow' })
  })
  it('accepts only actual authenticated saved input and never grants native permission through chat',async()=>{
    const f=fixture();installDelegatedBlockerReporting(f.ctx);const hook=must(f.hooks.get('tools/pre-execute'))
    await hook({ ...f.input.execution,name:'ask_user_question',arguments:{} },async()=>({ kind:'allow' }));const b=delegatedBlockers(f.root)[0]!
    f.rootEvents.push({ seq: SessionSeq(10), time: 0,type:'user/message',surfaceOp:'append',data:createUserMessage({ source:{ kind:'user' },content:[{ type:'text',text:'This year' }] }) })
    await expect(resumeDelegatedBlocker(f.ctx,f.root,b.id,f.input.execution.signal,undefined,undefined,'event:10')).rejects.toThrow('actual_human')
    const answer = f.rootEvents.find(e => e.type === 'user/message')
    if (answer?.type !== 'user/message') throw new Error('answer fixture missing')
    f.rootEvents[f.rootEvents.indexOf(answer)] = {
      ...answer,
      data: createUserMessage({
        source: { kind:'user', authenticatedActor: {
          userId:'11111111-1111-4111-8111-111111111111', orgId:'22222222-2222-4222-8222-222222222222', role:'admin', name:'Amar',
        } },
        content:[{ type:'text', text:'This year' }],
      }),
    }
    expect((await resumeDelegatedBlocker(f.ctx,f.root,b.id,f.input.execution.signal,undefined,undefined,'event:10')).status).toBe('resumed')
    const p=fixture();installDelegatedBlockerReporting(p.ctx);await must(p.hooks.get('tools/pre-execute'))({ ...p.input.execution,name:'write',arguments:{} },async()=>({ kind:'ask',reason:'External write' }))
    expect((await resumeDelegatedBlocker(p.ctx,p.root,delegatedBlockers(p.root)[0]!.id,p.input.execution.signal,undefined,{ answer:'Approved',evidenceRefs:['event:1'] })).status).toBe('requires_native_approval')
    expect(mocks.deliver).toHaveBeenCalledTimes(1)
  })
})

describe('exact legacy waiting-call migration',()=>{
  it('pins the admitted same-turn assignment and saves checkpoint without answering or cancelling',async()=>{
    const f=fixture();f.employeeEvents.pop();f.employeeEvents.push(
      { seq: SessionSeq(2), time: 0,type:'user/message',surfaceOp:'append',data:createUserMessage({ source:{ kind:'hivemind-agent-message',messageId:'assignment',senderId:SessionId('chief'),senderSessionId:SessionId('chief') },content:[{ type:'text',text:JSON.stringify({ text:'HQ_EMPLOYEE_ASSIGNMENT={"rootId":"chief","taskId":"task-1"}' }) }] }) },
      { seq: SessionSeq(3), time: 0,type:'user/message',surfaceOp:'append',data:createUserMessage({ source:{ kind:'user' },content:[{ type:'text',text:'Clarification' }] }) },
      { seq: SessionSeq(4), time: 0,type:'hivemind/composio-session',data:{ version:1,routerSessionId:'router',subject:'hivemind:user',userKey:'user' } },
      { seq: SessionSeq(5), time: 0,type:'tool/call',data:{ turn:1,step:1,name:'hivemind_connected_task',callId: ToolCallId('legacy'),arguments:JSON.stringify({ session:{ id:'upon' } }) } })
    const r=await checkpointLegacyDelegatedConnection(f.ctx,f.employee,f.input.execution.signal,{ callId: ToolCallId('legacy'),workflowSessionId:'upon',routerSessionId:'router',toolkits:['googlesheets'] })
    expect(r.status).toBe('blocked_reported');expect(delegatedBlockers(f.root)[0]?.taskId).toBe('task-1');expect(f.ctx.serial).not.toHaveBeenCalled()
    const count=f.employeeEvents.length
    await checkpointLegacyDelegatedConnection(f.ctx,f.employee,f.input.execution.signal,{ callId: ToolCallId('legacy'),workflowSessionId:'upon',routerSessionId:'router',toolkits:['googlesheets'] })
    expect(f.employeeEvents).toHaveLength(count)
    await expect(checkpointLegacyDelegatedConnection(f.ctx,f.employee,f.input.execution.signal,{ callId: ToolCallId('legacy'),workflowSessionId:'other',routerSessionId:'router',toolkits:['googlesheets'] })).rejects.toThrow('workflow_mismatch')
  })
  it('postrestart migration accepts only exact native user cancellation and unchanged captured assignment', async () => {
    const f=fixture();f.employeeEvents.pop();f.employeeEvents.push(
      { seq: SessionSeq(2), time: 0,type:'user/message',surfaceOp:'append',data:createUserMessage({ source:{ kind:'hivemind-agent-message',messageId:'assignment',senderId:SessionId('chief'),senderSessionId:SessionId('chief') },content:[{ type:'text',text:JSON.stringify({ text:'HQ_EMPLOYEE_ASSIGNMENT={"rootId":"chief","taskId":"task-1"}' }) }] }) },
      { seq: SessionSeq(3), time: 0,type:'hivemind/composio-session',data:{ version:1,routerSessionId:'router',subject:'hivemind:user',userKey:'user' } },
      { seq: SessionSeq(4), time: 0,type:'tool/call',data:{ turn:1,step:1,name:'hivemind_connected_task',callId: ToolCallId('legacy'),arguments:JSON.stringify({ session:{ id:'upon' } }) } },
      { seq: SessionSeq(5), time: 0,type:'turn/end',data:{ turn:1,reason:{ kind:'aborted',reason:{ kind:'user' } } } })
    const input={ callId: ToolCallId('legacy'),workflowSessionId:'upon',routerSessionId:'router',toolkits:['googlesheets'],
      cancelledTurn:1,expectedCallSeq:4,expectedRootId:'chief',expectedTaskId:'task-1',expectedTaskRevision:2 }
    await expect(checkpointLegacyDelegatedConnection(f.ctx,f.employee,f.input.execution.signal,{ ...input,expectedCallSeq:3 })).rejects.toThrow('pending_call_required')
    await expect(checkpointLegacyDelegatedConnection(f.ctx,f.employee,f.input.execution.signal,{ ...input,expectedRootId:'other' })).rejects.toThrow('assignment_mismatch')
    await expect(checkpointLegacyDelegatedConnection(f.ctx,f.employee,f.input.execution.signal,{ ...input,expectedTaskRevision:3 })).rejects.toThrow('revision_changed')
    expect(mocks.deliver).not.toHaveBeenCalled()
    const receipt=await checkpointLegacyDelegatedConnection(f.ctx,f.employee,f.input.execution.signal,input)
    expect(receipt.status).toBe('blocked_reported')
    expect(f.employeeEvents.find(e=>e.type==='hivemind/hq-blocker-recovery-hold')?.data).toMatchObject({ turn:1,callId: ToolCallId('legacy') })
    f.employeeEvents.push({ seq: SessionSeq(99), time: 0,type:'turn/start',data:{ turn:2 } })
    await expect(checkpointLegacyDelegatedConnection(f.ctx,f.employee,f.input.execution.signal,input)).rejects.toThrow('pending_call_required')
  })

  it('refuses finished or new human turns and missing assignment witnesses',async()=>{
    const f=fixture();f.employeeEvents.pop();f.employeeEvents.push({ seq: SessionSeq(3), time: 0,type:'tool/call',data:{ turn:1,step:1,name:'hivemind_connected_task',callId: ToolCallId('legacy'),arguments:JSON.stringify({ session:{ id:'upon' } }) } })
    await expect(checkpointLegacyDelegatedConnection(f.ctx,f.employee,f.input.execution.signal,{ callId: ToolCallId('legacy'),workflowSessionId:'upon',routerSessionId:'router',toolkits:['googlesheets'] })).rejects.toThrow('router_mismatch')
    f.employeeEvents.push({ seq: SessionSeq(4), time: 0,type:'turn/end',data:{ turn:1,reason:{ kind:'completed' } } })
    await expect(checkpointLegacyDelegatedConnection(f.ctx,f.employee,f.input.execution.signal,{ callId: ToolCallId('legacy'),workflowSessionId:'upon',routerSessionId:'router',toolkits:['googlesheets'] })).rejects.toThrow('pending_call_required')
    expect(mocks.deliver).not.toHaveBeenCalled()
  })
})


describe('delayed verified connection admission', () => {
  it('wakes Runtime after the one-time check, preserves task and stable mailbox key', async () => {
    const f=fixture();const saved=(await reportDelegatedConnection(f.ctx,f.input))!
    vi.mocked(f.ctx.serial).mockResolvedValueOnce(false)
    expect((await notifyDelegatedConnection(f.ctx,f.root,saved.blocker_id,'upon',f.input.execution.signal)).status).toBe('waiting')
    expect(mocks.deliver).toHaveBeenCalledTimes(1)
    expect((await notifyDelegatedConnection(f.ctx,f.root,saved.blocker_id,'upon',f.input.execution.signal)).status).toBe('accepted')
    const first=must(mocks.deliver.mock.calls[1]?.[1]);expect(first.target).toBe('runtime');expect(first.taskId).toBe('task-1')
    await notifyDelegatedConnection(f.ctx,f.root,saved.blocker_id,'upon',f.input.execution.signal)
    expect(mocks.deliver.mock.calls[2]?.[1]?.key).toBe(first.key)
    expect(delegatedBlockers(f.root)[0]?.state).toBe('blocked')
    expect(f.employeeEvents.filter(e=>e.type==='hivemind/connected-receipt')).toHaveLength(1)
  })
  it('rejects wrong workflow and changed assignments before provider checks',async()=>{
    const f=fixture();const saved=(await reportDelegatedConnection(f.ctx,f.input))!
    await expect(notifyDelegatedConnection(f.ctx,f.root,saved.blocker_id,'other',f.input.execution.signal)).rejects.toThrow('witness_required')
    f.task.revision++
    await expect(notifyDelegatedConnection(f.ctx,f.root,saved.blocker_id,'upon',f.input.execution.signal)).rejects.toThrow('assignment_changed')
    expect(f.ctx.serial).not.toHaveBeenCalled()
  })
})

describe('explicit employee human-input checkpoints', () => {
  it('saves exact task and human-input only, with stable-key retry deduplication', async () => {
    const f=fixture(), signal=f.input.execution.signal
    const first=await reportDelegatedHumanInput(f.ctx,f.employee,signal,{ callId:'report-1',blockerKey:'reference-code',question:'What exact reference code did you choose?' })
    const second=await reportDelegatedHumanInput(f.ctx,f.employee,signal,{ callId:'report-2',blockerKey:'reference-code',question:'What exact reference code did you choose?' })
    expect(second.blocker_id).toBe(first.blocker_id)
    expect(delegatedBlockers(f.root)).toHaveLength(1)
    expect(delegatedBlockers(f.root)[0]).toMatchObject({ kind:'human_input',taskId:'task-1',employeeSessionId:'room',callId:'report-1',state:'blocked' })
    expect(f.employeeEvents.filter(e=>e.type==='hivemind/connected-receipt')).toHaveLength(1)
    expect(f.ctx.schedule.ensure).not.toHaveBeenCalled()
    expect(unresolvedDelegatedTask(f.ctx,f.root,'task-1')?.id).toBe(first.blocker_id)
    expect(unresolvedDelegatedTask(f.ctx,f.root,'other-task')).toBeUndefined()
  })
  it('rejects direct human work, wrong assignee, revoked authority and invalid input without a checkpoint', async () => {
    for(const kind of ['direct','ended','revoked','assignee','blank','key']){
      const f=fixture()
      if(kind==='direct')f.employeeEvents.pop()
      if(kind==='ended')f.employeeEvents.push({ seq:SessionSeq(3),time:0,type:'turn/end',data:{ turn:1,reason:{ kind:'completed' } } })
      if(kind==='revoked')mocks.allowed.mockResolvedValue(false)
      if(kind==='assignee')f.task.ownerName='other'
      await expect(reportDelegatedHumanInput(f.ctx,f.employee,f.input.execution.signal,{ callId:'report',blockerKey:kind==='key'?'../invalid':'missing-code',question:kind==='blank'?' ':'What exact code?' })).rejects.toThrow()
      expect(delegatedBlockers(f.root)).toHaveLength(0)
      expect(mocks.deliver).not.toHaveBeenCalled()
    }
  })
  it('does not release completion for a partial artifact or unrelated answer; actual same-task human answer releases it', async () => {
    const f=fixture(), signal=f.input.execution.signal
    const r=await reportDelegatedHumanInput(f.ctx,f.employee,signal,{ callId:'report',blockerKey:'code',question:'Exact code required' })
    f.task.revision=3 // Accepting a draft or another status update cannot resolve missing input.
    expect(unresolvedDelegatedTask(f.ctx,f.root,'task-1')?.id).toBe(r.blocker_id)
    f.task.revision=2
    await expect(resumeDelegatedBlocker(f.ctx,f.root,r.blocker_id,signal,undefined,undefined,'event:10')).rejects.toThrow('actual_human')
    f.rootEvents.push({ seq:SessionSeq(10),time:0,type:'user/message',surfaceOp:'append',data:createUserMessage({ source:{ kind:'user',authenticatedActor:{ userId:'11111111-1111-4111-8111-111111111111',orgId:'22222222-2222-4222-8222-222222222222',role:'admin',name:'Verified Admin' } },content:[{ type:'text',text:'The code is SAMPLE-42.' }] }) })
    await resumeDelegatedBlocker(f.ctx,f.root,r.blocker_id,signal,undefined,undefined,'event:10')
    expect(unresolvedDelegatedTask(f.ctx,f.root,'task-1')).toBeUndefined()
  })
  it('does not borrow a stale blocker after another employee was assigned the task', async () => {
    const f=fixture();await reportDelegatedHumanInput(f.ctx,f.employee,f.input.execution.signal,{ callId:'report',blockerKey:'code',question:'Exact code required' })
    f.rootEvents.push({ seq:SessionSeq(10),time:0,type:'hivemind/hq-employee-assignment',data:{ taskId:'task-1',employeeId:'other',sessionId:'other-room',memberName:'other',personaSha256:'digest' } })
    f.task.ownerName='other'
    expect(unresolvedDelegatedTask(f.ctx,f.root,'task-1')).toBeUndefined()
  })
})

describe('authenticated blocker answer discovery', () => {
  it('filters source, organization, empty and pre-blocker evidence; bounds newest candidates without resuming', async () => {
    const f = fixture()
    const orgId = '22222222-2222-4222-8222-222222222222'
    const actor = { userId: '11111111-1111-4111-8111-111111111111', orgId, role: 'admin', name: 'Amar' }
    const message = (seq: number, text: string, source: unknown = { kind: 'user', authenticatedActor: actor }) => ({
      seq: SessionSeq(seq), time: 0, type: 'user/message', surfaceOp: 'append',
      data: createUserMessage({ source: source as never, content: [{ type: 'text', text }] }),
    }) as SessionEvent
    f.rootEvents.push(message(2, 'old'))
    const receipt = await reportDelegatedHumanInput(f.ctx, f.employee, f.input.execution.signal,
      { callId: 'call-1', blockerKey: 'code', question: 'Project code?' })
    const blocker = must(delegatedBlockers(f.root)[0])
    f.rootEvents.push(message(10, 'plugin', { kind: 'plugin', plugin: 'hivemind-live-voice', authenticatedActor: actor }),
      message(11, 'schedule', { kind: 'schedule', authenticatedActor: actor }), message(12, 'unverified', { kind: 'user' }),
      message(13, 'wrong org', { kind: 'user', authenticatedActor: { ...actor, orgId: '33333333-3333-4333-8333-333333333333' } }),
      message(14, '  '))
    for (let seq = 20; seq < 30; seq++) f.rootEvents.push(message(seq, seq === 29 ? 'x'.repeat(6001) : `answer ${seq}`))
    const candidates = delegatedAnswerCandidates(f.root, blocker, orgId)
    expect(candidates).toHaveLength(8)
    expect(candidates.map(value => value.answer_event_ref)).toEqual([29,28,27,26,25,24,23,22].map(seq => `event:${seq}`))
    expect(candidates[0]).toMatchObject({ candidate_only: true, text_truncated: true, verifiedAuthenticatedActor: actor })
    expect(candidates[0]?.text).toHaveLength(6000)
    expect(delegatedBlockers(f.root)[0]?.state).toBe('blocked')
    await expect(resumeDelegatedBlocker(f.ctx, f.root, receipt.blocker_id, f.input.execution.signal,
      undefined, undefined, 'event:13')).rejects.toThrow('actual_human_answer_required')
    expect(delegatedAnswerCandidates(f.root, { ...blocker, kind: 'permission' }, orgId)).toEqual([])
    expect(delegatedAnswerCandidates(f.root, { ...blocker, state: 'resumed' }, orgId)).toEqual([])
    await expect(resumeDelegatedBlocker(f.ctx, f.root, receipt.blocker_id, f.input.execution.signal,
      undefined, { answer: 'answer', evidenceRefs: ['artifact-uuid'] })).rejects.toThrow('List this blocker')
    expect(delegatedBlockers(f.root)[0]?.state).toBe('blocked')
  })
  it('registered Runtime list exposes exact saved references and a selected actual answer resumes same task', async () => {
    const f = fixture()
    const orgId = '22222222-2222-4222-8222-222222222222'
    let tool: { execute: (args: unknown, execution: unknown) => Promise<unknown> } | undefined
    Object.assign(f.ctx, { tools: { register: (value: typeof tool) => { tool = value; return () => {} } },
      hivemindExecutionScope: { require: () => ({ orgId }) } })
    const receipt = await reportDelegatedHumanInput(f.ctx, f.employee, f.input.execution.signal,
      { callId: 'call-1', blockerKey: 'code', question: 'Project code?' })
    f.rootEvents.push({ seq: SessionSeq(10), time: 0, type: 'user/message', surfaceOp: 'append',
      data: createUserMessage({ source: { kind: 'user', authenticatedActor: {
        userId: '11111111-1111-4111-8111-111111111111', orgId, role: 'admin', name: 'Amar',
      } }, content: [{ type: 'text', text: 'CODE-42' }] }) })
    installDelegatedBlockerTool(f.ctx)
    const execute = must(tool).execute
    const execution = { ...f.input.execution, agent: f.root }
    const listed = await execute({ action: 'list' }, execution) as {
      blockers: { state: string; answer_candidates: { answer_event_ref: string }[] }[]
    }
    const blocker = must(listed.blockers[0])
    const answer = must(blocker.answer_candidates[0])
    expect(answer.answer_event_ref).toBe('event:10')
    expect(blocker.state).toBe('blocked')
    await expect(execute({ action: 'list' }, f.input.execution)).rejects.toThrow('owner_required')
    const resumed = await execute({ action: 'resume', blocker_id: receipt.blocker_id,
      answer_event_ref: answer.answer_event_ref }, execution)
    expect(resumed).toMatchObject({ status: 'resumed', task_id: 'task-1', employee_id: 'employee' })
    expect(mocks.deliver.mock.calls.at(-1)?.[1]?.text).toContain('CODE-42')
  })
})
