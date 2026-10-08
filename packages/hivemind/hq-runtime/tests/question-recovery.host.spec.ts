import { afterEach, describe, expect, it } from 'vitest'
import { createHash, createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import * as AskUser from '@deepseek-ai/dsh-tool-ask-user'
import { MockAdapter, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { authorizeQuestionRecovery, savedQuestionRecovery, restoreSavedQuestion, questionRecoveryHash, questionRecoveryToolDenied } from '../src/question-recovery-host.ts'

const contexts:Context[]=[],directories:string[]=[]
afterEach(async()=>{
  for(const ctx of contexts.splice(0))await ctx.fiber.dispose()
  for(const dir of directories.splice(0))await rm(dir,{ recursive:true,force:true })
})
const actor={ userId:'91999e0d-72e5-43bf-bd1f-ec7c285141b4',orgId:'94006e81-21d2-41cd-8d87-7b38ec910ca6',role:'owner',name:'Fictional Owner' }
const args={ questions:[{ id:'missing-input',header:'Your direction',question:'Which exact project code should I use?',multi_select:false }] }
async function harness(root:string,callId:string){
  const ctx=new Context();contexts.push(ctx)
  await ctx.plugin(LlmRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence,{ root });await ctx.plugin(AgentLoop,{ agents:[] })
  await ctx.plugin(UserQuestions);await ctx.plugin(AskUser)
  const adapter=new MockAdapter([toolCallResponse(callId,'ask_user_question',args)])
  ctx.llm.registerAdapter(['mock'],adapter)
  const pending=Promise.withResolvers<{ signal:AbortSignal|undefined;questions:unknown }>()
  ctx.on('user-questions/request',request=>new Promise((_resolve,reject)=>{
    pending.resolve({ signal:request.signal,questions:request.questions })
    request.signal?.addEventListener('abort',()=>reject(Error('question aborted without answer')),{ once:true })
  }))
  return { ctx,adapter,pending:pending.promise }
}
describe('Exact legacy question recovery',()=>{
  it.each(['user','schedule'] as const)('keeps the genuine canceled %s call through cold boot and restores only its exact question',async (kind)=>{
    const source=kind==='schedule'
      ?{ kind:'schedule' as const,deliveryKey:'authentic-schedule',authenticatedActor:actor }:{ kind:'user' as const,authenticatedActor:actor }
    const dir=await mkdtemp(join(tmpdir(),'question-preservation-'));directories.push(dir)
    const first=await harness(dir,'old-question-call'),id=SessionId('question-preservation')
    const agent=await first.ctx.agentLoop.create(id,{ provider:'mock',model:'mock' })
    agent.followup(createUserMessage({ source,content:[{ type:'text',text:'Prepare the label, but ask me for the missing exact project code.' }] }))
    const original=await first.pending
    const call=agent.session.ownEvents().find(event=>event.type==='tool/call'&&event.data.callId==='old-question-call')
    expect(call?.type).toBe('tool/call');if(call?.type!=='tool/call')throw Error('missing call')
    const input={ orgId:actor.orgId,userId:actor.userId,sessionId:id,turn:call.data.turn,callId:call.data.callId,
      callSequence:call.seq,questionSha256:questionRecoveryHash(args) }
    await first.ctx.sessions.flush(agent.session)
    expect(()=>savedQuestionRecovery(agent,input)).toThrow('verified_interrupted_question_required')
    agent.cancel({ kind:'user' },{ keepInbox:true });await agent.whenIdle();await first.ctx.sessions.flush(agent.session)
    expect(original.signal?.aborted).toBe(true)
    expect(savedQuestionRecovery(agent,input).args).toEqual(args)
    expect(()=>savedQuestionRecovery(agent,{ ...input,questionSha256:'a'.repeat(64) })).toThrow('saved_question_hash_mismatch')
    expect(()=>savedQuestionRecovery(agent,{ ...input,userId:'f1bcf02d-4889-4fb8-ba9e-5818b048ab0b' }))
      .toThrow('original_authenticated_actor_required')
    const flushing=Promise.withResolvers<undefined>(),releaseFlush=Promise.withResolvers<undefined>()
    const parked={ sessions:{ flush:async()=>{
      await first.ctx.sessions.flush(agent.session);flushing.resolve(undefined);await releaseFlush.promise;return false
    } },
    sessionPersistence:{ validateAdministratorRoom:async()=>{},
      open:first.ctx.sessionPersistence.open.bind(first.ctx.sessionPersistence) },
    agentPresets:{ serviceFor:()=>({ profiles:async()=>({ status:'ready',profiles:[] }) }) },get:()=>undefined,
    sessionController:{ resolveAgent:async()=>({ agent }) } } as unknown as Context
    const interrupted=restoreSavedQuestion(parked,agent,input)
    await flushing.promise
    await expect(restoreSavedQuestion(parked,agent,input)).rejects.toThrow('already has active work')
    expect(first.adapter.requests).toHaveLength(1)
    releaseFlush.resolve(undefined)
    await expect(interrupted).rejects.toThrow('question_recovery_persistence_required')
    expect(agent.status).toBe('idle');expect(first.adapter.requests).toHaveLength(1)
    expect(agent.inbox.nextStep).toHaveLength(1)
    await first.ctx.fiber.dispose();contexts.splice(contexts.indexOf(first.ctx),1)
    const second=await harness(dir,'new-question-call')
    const loaded=await second.ctx.agentLoop.resume(second.ctx,{ resumeSessionId:id,agentOptions:{ provider:'mock',model:'mock' } })
    expect(loaded.agent.status).toBe('idle');expect(second.adapter.requests).toHaveLength(0)
    // Graceful teardown clears queued context; the durable original call still permits exact retry.
    expect(loaded.agent.inbox.nextStep).toHaveLength(0)
    expect(savedQuestionRecovery(loaded.agent,input).args).toEqual(args)
    const shim={ sessions:second.ctx.sessions,sessionPersistence:{ validateAdministratorRoom:async()=>{},
      open:second.ctx.sessionPersistence.open.bind(second.ctx.sessionPersistence) },
    agentPresets:{ serviceFor:()=>({ profiles:async()=>({ status:'ready',profiles:[] }) }) },get:()=>undefined,
    sessionController:{ resolveAgent:async()=>({ agent:loaded.agent }) } } as unknown as Context
    const denied={ ...shim,sessionPersistence:{ validateAdministratorRoom:async()=>{throw Error('administrator_required')} } } as unknown as Context
    await expect(restoreSavedQuestion(denied,loaded.agent,input)).rejects.toThrow('administrator_required')
    expect(second.adapter.requests).toHaveLength(0)
    await restoreSavedQuestion(shim,loaded.agent,input)
    const recovered=await second.pending
    expect(recovered.questions).toEqual(original.questions)
    expect(questionRecoveryToolDenied(loaded.agent,'ask_user_question',args)).toBe(false)
    expect(questionRecoveryToolDenied(loaded.agent,'send_user_email',{})).toBe(true)
    expect(questionRecoveryToolDenied(loaded.agent,'ask_user_question',{ questions:[{ id:'other',question:'Approve new work?' }] })).toBe(true)
    const messages=loaded.agent.session.ownEvents().filter(event=>event.type==='user/message')
    expect(messages[0]?.data.source).toEqual(source)
    expect(messages.slice(1).every(event=>event.data.source.kind==='plugin'&&event.data.source.plugin==='hivemind-hq/question-recovery')).toBe(true)
    expect(loaded.agent.session.ownEvents().some(event=>event.type==='tool/result'&&event.data.message.content.some(part=>part.type==='tool-result'&&part.toolCallId==='old-question-call'&&!part.isError))).toBe(false)
    expect(await restoreSavedQuestion(shim,loaded.agent,input)).toEqual({ status:'already_recorded' })
    loaded.agent.cancel({ kind:'user' },{ keepInbox:true });await loaded.agent.whenIdle()
  },15000)
  it('requires purpose-separated, owner-bound, short-lived body authentication',()=>{
    const payload={ orgId:actor.orgId,userId:actor.userId,sessionId:'session-a',turn:1,callId:'c',callSequence:10,questionSha256:'a'.repeat(64) },secret='s'.repeat(32),now=1700000000000
    const encode=(x:unknown)=>Buffer.from(JSON.stringify(x)).toString('base64url')
    const unsigned=encode({ alg:'HS256',typ:'JWT' })+'.'+encode({ iss:'hivemind-control-plane',aud:'hivemind-question-recovery',sub:actor.userId,org_id:actor.orgId,iat:now/1000,exp:now/1000+30,body_sha256:createHash('sha256').update(JSON.stringify(payload)).digest('hex') })
    const authorization='Bearer '+unsigned+'.'+createHmac('sha256',secret).update(unsigned).digest('base64url')
    expect(authorizeQuestionRecovery(authorization,secret,payload,now)).toBe(true)
    expect(authorizeQuestionRecovery(authorization,secret,{ ...payload,turn:2 },now)).toBe(false)
    expect(authorizeQuestionRecovery(authorization,secret,payload,now+31000)).toBe(false)
    expect(authorizeQuestionRecovery(undefined,secret,payload,now)).toBe(false)
  })
})
