import { expect, it } from 'vitest'
import { resolveOrganizationAgentAccess, currentTurnActor,referencedSessionIds,admittedVoiceCallRef,admittedUserConfirmationRef,authenticatedInitiatorMessage,withAuthenticatedInitiator } from '../src/organization-agent-access.ts'
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

it('binds queued B call reconciliation to B and exact call despite A chat and later B call',()=>{
  const b={ userId,orgId,name:'B',role:'admin' as const }
  const a={ ...b,userId:proof.agent.storage_user_id,name:'A',role:'owner' as const }
  const messages=[{ source:{ kind:'plugin',plugin:'hivemind-live-voice',authenticatedActor:b,voiceCallId:'b-first' } }]
  const events=[{ type:'hivemind/voice-call-ended',data:{ callId:'b-first',authenticatedActor:b,hadUserSpeech:true } },
    { type:'user/message',data:{ source:{ kind:'user',authenticatedActor:a } } },
    { type:'hivemind/voice-call-ended',data:{ callId:'b-later',authenticatedActor:b,hadUserSpeech:true } }]
  expect(currentTurnActor(messages,a)).toEqual(b)
  expect(admittedVoiceCallRef(messages,events,b)).toBe('call:b-first')
  expect(admittedVoiceCallRef(messages,events,a)).toBeUndefined()
})

it('authorizes native Remote Agent envelopes even when the Agent is already warm',()=>{
  expect([...referencedSessionIds({ agentId:'session-canonical' })]).toEqual(['session-canonical'])
})

it('resolves exact admitted witness after native append, ignoring later same or different admin messages',()=>{
  const a={ userId,orgId,name:'A',role:'admin' as const }
  const b={ ...a,userId:proof.agent.storage_user_id,name:'B' }
  expect(admittedUserConfirmationRef([],'a-first',a)).toBeUndefined()
  const events=[{ type:'user/message',seq:14,data:{ id:'a-first',source:{ kind:'user',authenticatedActor:a } } },
    { type:'user/message',seq:20,data:{ id:'b-later',source:{ kind:'user',authenticatedActor:b } } },
    { type:'user/message',seq:30,data:{ id:'a-later',source:{ kind:'user',authenticatedActor:a } } }]
  expect(admittedUserConfirmationRef(events,'a-first',a)).toBe('event:14')
  expect(admittedUserConfirmationRef(events,'a-first',b)).toBeUndefined()
  expect(admittedUserConfirmationRef(events,'missing',a)).toBeUndefined()
})

it('renders the current authenticated actor independently of shared room storage and queued senders',()=>{
  const a={ userId,orgId,role:'admin' as const,name:'Synthetic Beatrice' }
  const later={ ...a,userId:'54f5568b-4d6a-4ae1-9a33-48cb2909d59b',name:'Later admin' }
  const message=authenticatedInitiatorMessage(a)
  expect(message.source).toMatchObject({ authenticatedActor:a,kind:'plugin' })
  expect(message.content).toEqual([{ type:'text',text:expect.stringContaining('Synthetic Beatrice') }])
  expect(JSON.stringify(message)).not.toContain(later.name)
})

it('binds admitted decision context to B and refreshes a later A without duplicating continuation context',()=>{
  const b={ userId,orgId,role:'admin' as const,name:'Beatrice' }
  const a={ ...b,userId:'54f5568b-4d6a-4ae1-9a33-48cb2909d59b',name:'Amar' }
  const rejected={ kind:'reject' as const }
  expect(withAuthenticatedInitiator(rejected,b,true)).toBe(rejected)
  const initial={ kind:'enter' as const,messages:[] }
  const admittedB=withAuthenticatedInitiator(initial,b,true)
  expect(JSON.stringify(admittedB)).toContain('Beatrice')
  expect(withAuthenticatedInitiator(admittedB,a,false)).toBe(admittedB)
  const admittedA=withAuthenticatedInitiator(admittedB,a,true)
  expect(JSON.stringify(admittedA)).toContain('Amar')
  expect(JSON.stringify(admittedA)).not.toContain('Beatrice')
})
