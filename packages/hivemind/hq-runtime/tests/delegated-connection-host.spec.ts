import { describe,it,expect } from 'vitest'
import { createHash,createHmac } from 'node:crypto'
import { authorizeConnectionCompletion } from '../src/delegated-connection-host.ts'
const secret='s'.repeat(32),now=100000
const payload={ orgId:'11111111-1111-4111-8111-111111111111',userId:'22222222-2222-4222-8222-222222222222',employeeId:'33333333-3333-4333-8333-333333333333',rootId:'chief',blockerId:'blocker',workflowSessionId:'upon' }
function token(overrides:Record<string,unknown>={}){const encode=(v:unknown)=>Buffer.from(JSON.stringify(v)).toString('base64url');const input=`${encode({ alg:'HS256',typ:'JWT' })}.${encode({ iss:'hivemind-control-plane',aud:'hivemind-delegated-connection',sub:payload.userId,org_id:payload.orgId,body_sha256:createHash('sha256').update(JSON.stringify(payload)).digest('hex'),iat:100,exp:130,...overrides })}`;return `Bearer ${input}.${createHmac('sha256',secret).update(input).digest('base64url')}`}
describe('provider completion callback scope',()=>{
  it('accepts exact short-lived purpose-bound signed correlation',()=>{expect(authorizeConnectionCompletion(token(),secret,payload,now)).toBe(true)})
  it('rejects wrong owner, audience, workflow, root and browser grant flags',()=>{
    for(const change of [{ sub:payload.orgId },{ aud:'hivemind-employee-lifecycle' },{ aud:'hivemind-runtime-attention' }])expect(authorizeConnectionCompletion(token(change),secret,payload,now)).toBe(false)
    for(const change of [{ workflowSessionId:'other' },{ rootId:'other' },{ approved:true }])expect(authorizeConnectionCompletion(token(),secret,{ ...payload,...change },now)).toBe(false)
  })
  it('rejects expired and overlong signatures',()=>{expect(authorizeConnectionCompletion(token({ exp:100 }),secret,payload,now)).toBe(false);expect(authorizeConnectionCompletion(token({ exp:131 }),secret,payload,now)).toBe(false)})
})
