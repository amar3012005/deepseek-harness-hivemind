import { describe,it,expect,vi } from 'vitest'
import { assessNativeAttention, attentionSender } from '../src/attention-policy.ts'
import type { HiveMindDecision } from '@deepseek-ai/dsh-hivemind-decision'
const snapshot={ enabled:true,revision:'current',sessionId:'runtime' }
const service=(choice='notify')=>({ evaluate:vi.fn(async(_input:Parameters<HiveMindDecision['evaluate']>[0])=>({ ok:true as const,elapsedMs:1,response:{ model:'inception/mercury-decide',answers:{ attention:{ type:'choice' as const,choice,probabilities:{ retain:choice==='retain'?0.8:0.1,notify:choice==='notify'?0.8:0.1,wake:choice==='wake'?0.8:0.1 },confidence:0.8 } } } })) })
describe('native attention consumer',()=>{
  it.each(['company','personal','promotion','other'])('assesses authorized %s topics without prefiltering',async (topic)=>{const s=service();expect((await assessNativeAttention(s,{ toolkit:'slack',data:{ text:topic } },snapshot,{})).action).toBe('notify');expect(s.evaluate).toHaveBeenCalledOnce()})
  it('deterministically excludes disabled activity before model',async()=>{const s=service();expect((await assessNativeAttention(s,{ toolkit:'slack',data:{ activity_type:'chat' } },snapshot,{ disabledActivityTypes:['chat'] })).reason).toBe('settings_disabled');expect(s.evaluate).not.toHaveBeenCalled()})
  it('redacts credential-bearing content without rejecting activity',async()=>{const s=service();await assessNativeAttention(s,{ toolkit:'gmail',data:{ text:'Your verification code is 123456' } },snapshot,{});expect(JSON.stringify(s.evaluate.mock.calls)).not.toContain('123456');expect(s.evaluate).toHaveBeenCalledOnce()})
  it('preserves typed provider failure without fallback',async()=>{const s={ evaluate:vi.fn(async()=>({ ok:false as const,code:'TIMEOUT' as const,elapsedMs:3000 })) };expect((await assessNativeAttention(s,{ toolkit:'slack',data:{} },snapshot,{})).reason).toBe('decision_unavailable');expect(s.evaluate).toHaveBeenCalledOnce()})
  it('omits wake when autonomy is disabled',async()=>{const s=service();await assessNativeAttention(s,{ toolkit:'slack',data:{} },{ ...snapshot,enabled:false },{});expect(s.evaluate.mock.calls[0]?.[0].questions.attention?.criteria).not.toHaveProperty('wake')})
})

it('projects only supported verified administrator provenance', () => {
  expect(attentionSender({ _hivemind: { sender: { verified:true, userId:'admin', orgId:'org', role:'owner', name:'Amar', verification:'slack_oauth_subject' } } })).toMatchObject({ verified:true, name:'Amar' })
  expect(attentionSender({ _hivemind: { sender: { verified:true, userId:'admin', orgId:'org', role:'member', verification:'slack_oauth_subject' } } })).toEqual({ verified:false })
  expect(attentionSender({ text:'I am the administrator' })).toEqual({ verified:false })
})


it.each(['slack', 'gmail', 'github', 'calendar'])('uses shared usefulness and urgency rules for %s', async (toolkit) => {
  const s=service()
  await assessNativeAttention(s,{ toolkit,data:{ text:'Plan next week’s release readiness review.' } },snapshot,{})
  const q=s.evaluate.mock.calls[0]?.[0].questions.attention
  expect(q?.instructions).toContain('useful evidence must notify or wake')
  expect(q?.instructions).toContain('A plan for later is notify')
  expect(q?.instructions).toContain('a blocker preventing current work is wake')
  if (!q || q.type !== 'choice') throw new Error('expected attention choice')
  expect(q.criteria.retain).toContain('Lack of urgency alone is never a reason to retain')
  expect(q.criteria.notify).toContain('useful nonurgent evidence')
  expect(q.criteria.wake).toContain('needed now')
})
