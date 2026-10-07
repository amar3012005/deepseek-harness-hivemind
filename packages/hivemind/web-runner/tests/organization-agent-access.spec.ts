import { expect, it } from 'vitest'
import { resolveOrganizationAgentAccess, currentTurnActor,referencedSessionIds } from '../src/organization-agent-access.ts'
const orgId='67503d34-97e9-49a8-8c52-8ee30cc7603e', userId='64f5568b-4d6a-4ae1-9a33-48cb2909d59b'
const proof = { contract:'hivemind.organization-agent-access.v1', access:'read-write',
  actor:{ org_id:orgId,user_id:userId,role:'admin',name:'Second admin',authority:'authenticated-profile' },
  agent:{ org_id:orgId,runtime_session_id:'session-canonical',storage_user_id:'54f5568b-4d6a-4ae1-9a33-48cb2909d59b' } }
const request = (value: unknown, status=200) => resolveOrganizationAgentAccess('https://core.test','fixture',{ orgId,userId },new AbortController().signal,
  (async (_url,options) => { expect(options?.redirect).toBe('error'); return new Response(JSON.stringify(value),{ status }) }))
it('keeps the human actor distinct from the organization agent storage principal',async()=>{
  const result=await request(proof)
  expect(result.actor.userId).toBe(userId); expect(result.agent.storageUserId).not.toBe(userId)
  expect(Object.isFrozen(result.actor)).toBe(true)
})
it('rejects cross-user, cross-org, nonadmin, malformed and missing proofs',async()=>{
  for(const value of [{}, { ...proof,actor:{ ...proof.actor,user_id:proof.agent.storage_user_id } },
    { ...proof,actor:{ ...proof.actor,org_id:proof.agent.storage_user_id } },
    { ...proof,actor:{ ...proof.actor,role:'member' } }, { ...proof,agent:{ ...proof.agent,runtime_session_id:'other' } },
    { ...proof,agent:{ ...proof.agent,storage_user_id:'browser-input' } }]) {
    await expect(request(value)).rejects.toThrow('organization_agent_access_invalid')
  }
})
it('does not positively cache a revoked membership',async()=>{
  await request(proof)
  await expect(request({ error:'denied' },403)).rejects.toThrow('organization_agent_access_denied')
})
it('bounds returned data',async()=>{
  await expect(request({ ...proof,padding:'x'.repeat(4096) })).rejects.toThrow('organization_agent_access_invalid')
})

it('keeps active admin A separate from a queued admin B and retains A across continuation steps',()=>{
  const a={ userId:proof.agent.storage_user_id,orgId,name:'A',role:'owner' }
  const b={ userId,orgId,name:'B',role:'admin' }
  // B is queued in persisted history; only A belongs to the current admitted batch.
  expect(currentTurnActor([{ source:{ kind:'user',authenticatedActor:a } }],b)).toEqual(a)
  expect(currentTurnActor([],a)).toEqual(a)
})
it('uses a scheduled author rather than the last unrelated chat admin',()=>{
  const a={ userId:proof.agent.storage_user_id,orgId,name:'A',role:'owner' }
  const b={ userId,orgId,name:'B',role:'admin' }
  expect(currentTurnActor([{ source:{ kind:'schedule',authenticatedActor:a } }],b)).toEqual(a)
  expect(currentTurnActor([{ source:{ kind:'schedule' } }],b)).toBeUndefined()
})

it('includes workspace-file scope in session authorization before live-header reads',()=>{
  expect([...referencedSessionIds([{ workspaceFileScopeId:'session-private' }, { sessionId:'session-team' }])]).toEqual(['session-private','session-team'])
})
