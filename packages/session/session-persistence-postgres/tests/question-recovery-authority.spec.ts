import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import ExecutionScope from '@deepseek-ai/dsh-hivemind-execution-scope'
import { Pool } from 'pg'
import { expect,it } from 'vitest'
import { PostgresSessionPersistence } from '../src/index.ts'
it('requires fresh database administrator proof and canonical top-level Runtime even when shared mode is disabled',async()=>{
  const ctx=new Context(),scope=new ExecutionScope(ctx),id=SessionId('canonical')
  const owner='54f5568b-4d6a-4ae1-9a33-48cb2909d59b',admin='64f5568b-4d6a-4ae1-9a33-48cb2909d59b'
  const principal={ orgId:'67503d34-97e9-49a8-8c52-8ee30cc7603e',userId:admin,profile:'hivemind-chat' as const,variation:'harness' }
  let authorized=true,preset='hivemind-hq',canonical:string=id,parent:string|undefined
  const sql:string[]=[]
  const query=async(text:string,values:unknown[]=[])=>{
    sql.push(text)
    if(text.includes('organization_agent_storage_scope')){expect(values).toEqual([principal.orgId,admin]);return { rows:authorized?[{ storage_user_id:owner }]:[] }}
    if(text.includes('FROM harness_sessions')){expect(values).toEqual([principal.orgId,owner,id]);return { rows:[{ header:{ id,agentPreset:preset,parentSession:parent } }] }}
    if(text.includes('FROM harness_company_hq'))return { rows:[{ session_id:canonical }] }
    return { rows:[] }
  }
  const pool={ connect:async()=>({ query,release:()=>{} }) } as unknown as Pool
  const store=new PostgresSessionPersistence(ctx,{ connectionStringEnv:'FIXTURE',schema:'hivemind',leaseTtlMs:30000,maxConnections:3,sharedOrganizationAgents:false },pool)
  await scope.run(principal,()=>store.validateAdministratorRoom(id))
  authorized=false
  await expect(scope.run(principal,()=>store.validateAdministratorRoom(id))).rejects.toThrow('organization_agent_admin_required')
  authorized=true;preset='hivemind-hyperagents'
  await expect(scope.run(principal,()=>store.validateAdministratorRoom(id))).rejects.toThrow('administrator_room_required')
  preset='hivemind-hq';parent='parent'
  await expect(scope.run(principal,()=>store.validateAdministratorRoom(id))).rejects.toThrow('administrator_room_required')
  parent=undefined;canonical='different'
  await expect(scope.run(principal,()=>store.validateAdministratorRoom(id))).rejects.toThrow('canonical_runtime_required')
  expect(sql.some(text=>/INSERT|UPDATE|DELETE/.test(text))).toBe(false)
  await ctx.fiber.dispose()
})
