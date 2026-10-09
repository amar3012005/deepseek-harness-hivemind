import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { fullAccessState, setFullAccess, delegatedFullAccess } from '../src/full-access.ts'
const mocks=vi.hoisted(()=>({ root:undefined as unknown,allow:vi.fn(async()=>true) }))
vi.mock('../src/employee-room.ts',()=>({ authenticatedRoot:async()=>mocks.root,allowsEmployeeWork:mocks.allow }))
function setup(actor:unknown=undefined){
  const events:unknown[]=[];let preset='workspace-write',seq=0
  const agent={ id:'session-runtime',session:{ ownEvents:()=>events },runMaintenance:async(fn:(signal:AbortSignal)=>unknown)=>fn(new AbortController().signal) } as unknown as Agent
  mocks.root=agent
  const validate=vi.fn(async()=>{}),flush=vi.fn(async()=>true)
  const ctx={ permissionPresets:{ current:()=>preset,set:(_s:unknown,name:string)=>{preset=name;events.push({ type:'permission/preset',seq:++seq,data:{ preset:name } })} },hivemindExecutionScope:{ require:()=>({ orgId:'organization',authenticatedActor:actor }) },sessionPersistence:{ validateAdministratorRoom:validate },sessions:{ flush } } as unknown as Context
  return { ctx,agent,events,validate,flush }
}
it('persists native preset, restores from its existing projection, and supports disabling',async()=>{
  const f=setup();expect((await setFullAccess(f.ctx,f.agent,{ enabled:true,expectedRevision:0 })).ok).toBe(true)
  expect(fullAccessState(f.ctx,f.agent)).toEqual({ enabled:true,revision:1 })
  expect(f.events).toEqual([{ type:'permission/preset',seq:1,data:{ preset:'danger-full-access' } }])
  expect((await setFullAccess(f.ctx,f.agent,{ enabled:false,expectedRevision:1 })).ok).toBe(true)
  expect(fullAccessState(f.ctx,f.agent).enabled).toBe(false);expect(f.flush).toHaveBeenCalledTimes(2)
})
it('rejects concurrent stale admin selection without changing native state',async()=>{
  const f=setup();await setFullAccess(f.ctx,f.agent,{ enabled:true,expectedRevision:0 })
  expect((await setFullAccess(f.ctx,f.agent,{ enabled:false,expectedRevision:0 })).ok).toBe(false)
  expect(fullAccessState(f.ctx,f.agent).enabled).toBe(true);expect(f.flush).toHaveBeenCalledTimes(1)
})
it('requires fresh Core admin validation even when the Remote has no message Actor',async()=>{
  const f=setup();f.validate.mockRejectedValueOnce(Error('administrator_required'))
  await expect(setFullAccess(f.ctx,f.agent,{ enabled:true,expectedRevision:0 })).rejects.toThrow('administrator_required')
  expect(f.events).toHaveLength(0)
})
it.each([{ orgId:'other',role:'admin' },{ orgId:'organization',role:'member' }])('rejects mismatched or nonadmin actor before writing',async(actor)=>{
  const f=setup(actor);await expect(setFullAccess(f.ctx,f.agent,{ enabled:true,expectedRevision:0 })).rejects.toThrow('runtime_administrator_required');expect(f.events).toHaveLength(0)
})
it('direct human employee work never inherits old Runtime permission',async()=>{
  const f=setup();await setFullAccess(f.ctx,f.agent,{ enabled:true,expectedRevision:0 })
  const employee={ session:{ ownEvents:()=>[{ type:'turn/start',seq:1,data:{ turn:2 } }] } } as unknown as Agent
  expect(await delegatedFullAccess(f.ctx,employee,new AbortController().signal)).toBe(false)
})
it('active attested assignment inherits only while root mode and task remain authorized',async()=>{
  const f=setup();await setFullAccess(f.ctx,f.agent,{ enabled:true,expectedRevision:0 })
  const employee={ session:{ ownEvents:()=>[{ type:'turn/start',seq:1,data:{ turn:2 } },{ type:'hivemind/employee-work-origin',seq:2,data:{ turn:2,rootId:'session-runtime',taskId:'task' } }] } } as unknown as Agent
  expect(await delegatedFullAccess(f.ctx,employee,new AbortController().signal)).toBe(true)
  mocks.allow.mockResolvedValueOnce(false);expect(await delegatedFullAccess(f.ctx,employee,new AbortController().signal)).toBe(false)
  await setFullAccess(f.ctx,f.agent,{ enabled:false,expectedRevision:1 })
  expect(await delegatedFullAccess(f.ctx,employee,new AbortController().signal)).toBe(false)
})
