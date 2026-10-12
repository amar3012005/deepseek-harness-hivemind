import { Context } from '@deepseek-ai/cordis'
import SessionStore,{ SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import { expect,it } from 'vitest'
import { runtimeWitnessServices } from '../src/organization-agent-access.ts'

it('reproduces missing Sessions dependency and flushes through the injected tool context',async()=>{
  const root=new Context();await root.plugin(SessionStore);root.provide('tools',{})
  const session=root.sessions.create(SessionId('session-witness-di'))
  let durable=0
  root.on('session/flush',()=>{durable++},{ global:true })
  const broken=await root.plugin({ name:'witness-old-context',inject:['tools'],apply(){} })
  expect(()=>broken.ctx.sessions.flush(session)).toThrow('cannot get property "sessions" without inject')
  await broken.dispose()
  const fixed=await root.plugin({ name:'witness-injected-listener',inject:runtimeWitnessServices,apply(ctx){
    ctx.on('tools/execute',async(_execution,next)=>{
      if(!await ctx.sessions.flush(session)) throw Error('runtime_confirmation_not_persisted')
      return next()
    })
  } })
  try{
    let toolCalls=0
    await root.waterfall('tools/execute',{} as never,async()=>{toolCalls++;return undefined as never})
    expect(durable).toBe(1);expect(toolCalls).toBe(1)
  }finally{await fixed.dispose()}
})
