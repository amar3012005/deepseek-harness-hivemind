import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { describe, it, expect, vi } from 'vitest'
import { listDesignReferences, readCatalogReference, registerDesignReferenceCatalog } from '../src/design-reference-catalog.ts'
import { registerPrivateDesignReferences } from '../src/design-reference.ts'
import { registerMediaWorkflow } from '../src/media-workflow.ts'
import { GenerationRegistry, registerGenerationTools } from '../src/generation.ts'

const summary = { id: 'editorial', title: 'Editorial reference', description: 'Ivory paper and large serif hierarchy.', purposes: ['editorial'], source: 'https://in.pinterest.com/pin/123/' }
describe('described design reference selection', () => {
  it('lists descriptions separately, reads exact image bytes and rejects damaged images or unknown ids', async () => {
    const root = await mkdtemp(join(tmpdir(),'design-catalog-'))
    try {
      const data = Buffer.from([137,80,78,71,13,10,26,10]); const sha256 = createHash('sha256').update(data).digest('hex')
      await writeFile(join(root,'editorial.png'),data)
      await writeFile(join(root,'manifest.json'),JSON.stringify({ version:1,references:[{ ...summary,file:'editorial.png',sha256 }] }))
      expect(await listDesignReferences(root)).toEqual([summary])
      expect((await readCatalogReference(root,'editorial')).data).toEqual(data)
      await expect(readCatalogReference(root,'../other-user')).rejects.toThrow('exact reference ID')
      await writeFile(join(root,'editorial.png'),Buffer.from('broken'))
      await expect(readCatalogReference(root,'editorial')).rejects.toThrow('integrity')
    } finally { await rm(root,{ recursive:true,force:true }) }
  })
  it('does not generate an HTML file when a model bypasses reference selection', async () => {
    const ctx = new Context(); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
    try {
      ctx.on('hivemind/design-reference-list',async()=>[summary])
      const generate = vi.fn(); const registry = new GenerationRegistry()
      registry.register({ id:'test-web',format:'web',instructions:'HTML',generate })
      registerGenerationTools(ctx,registry,'artifacts',1000,true)
      const agent = { session:{ header:{ cwd:'/tmp' },snapshotEvents:()=>[] } } as unknown as Agent
      const result = await ctx.tools.execute({ name:'hivemind_generate',arguments:{ format:'web',title:'Report',content:'<html>Report</html>' },agent,callId:ToolCallId('missing-reference'),signal:new AbortController().signal })
      expect(result.isError).toBe(false)
      expect(JSON.stringify(result)).toContain('design_reference_required')
      expect(JSON.stringify(result)).toContain(summary.description)
      expect(generate).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })
  it('delivers the chosen reference as native model-visible image content',async()=>{
    const ctx = new Context(); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
    try {
      const preview={ attachmentId:'sha256:chosen',mediaType:'image/png',width:474,height:800,bytes:100 }
      const selected=vi.fn(async()=>({ id:'editorial',sha256:'hash',preview }))
      ctx.on('hivemind/design-reference',selected as never)
      registerDesignReferenceCatalog(ctx,'/unused-for-selection')
      const agent={} as Agent
      const result=await ctx.tools.execute({ name:'hivemind_design_reference',arguments:{ reference_id:'editorial' },agent,callId:ToolCallId('chosen-reference'),signal:new AbortController().signal })
      expect(result.isError).toBe(false)
      expect(selected).toHaveBeenCalledWith(expect.objectContaining({ referenceId:'editorial',agent }))
      expect(result.content).toContainEqual({ type:'image',attachment:preview })
    } finally { await ctx.fiber.dispose() }
  })
  it('completes catalog choice, pixel delivery and generation with a durable reference receipt', async () => {
    const root=await mkdtemp(join(tmpdir(),'design-roundtrip-'))
    const ctx=new Context(); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
    try {
      const data=Buffer.from([137,80,78,71,13,10,26,10]); const sha256=createHash('sha256').update(data).digest('hex')
      await writeFile(join(root,'editorial.png'),data)
      await writeFile(join(root,'manifest.json'),JSON.stringify({ version:1,references:[{ ...summary,file:'editorial.png',sha256 }] }))
      const preview={ attachmentId:'sha256:'+sha256,mediaType:'image/png',width:1,height:1,bytes:data.length }
      const saveImage=vi.fn(async()=>preview)
      ctx.provide('attachments',{ saveImage,saveFile:async()=>({ attachmentId:'saved-html',name:'report.html',bytes:20 }) } as never)
      ctx.provide('sessions',{ flush:async()=>true } as never)
      ctx.on('hivemind/media-owner',async()=>({ sessionId:'session-test',orgId:'org-a',userId:'user-a' }))
      const events: unknown[]=[]
      const agent={ session:{ header:{ id:'session-test',cwd:'/tmp' },snapshotEvents:()=>events,append:(type:string,data:unknown)=>events.push({ type,data }) } } as unknown as Agent
      registerPrivateDesignReferences(ctx,join(root,'private'),40000,root)
      const registry=new GenerationRegistry()
      registry.register({ id:'test-web',format:'web',instructions:'HTML',generate:async()=>({ data:Buffer.from('<html>report</html>'),extension:'html',mediaType:'text/html' }) })
      registerGenerationTools(ctx,registry,'artifacts',1000,true)
      const run=(name:string,args:object)=>ctx.tools.execute({
        name,arguments:args as never,agent,callId:ToolCallId(name),signal:new AbortController().signal,
      })
      expect(JSON.stringify(await run('hivemind_design_reference',{}))).toContain(summary.description)
      const selection=await run('hivemind_design_reference',{ reference_id:'editorial' })
      expect(selection.content).toContainEqual({ type:'image',attachment:preview })
      expect(saveImage).toHaveBeenCalledWith(expect.objectContaining({ data }))
      const generated=await run('hivemind_generate',{ format:'web',title:'Report',content:'<html>report</html>' })
      expect(generated.isError).toBe(false)
      expect(JSON.stringify(generated)).toContain('design_reference')
      expect(events).toContainEqual(expect.objectContaining({ type:'hivemind/generation-created',data:expect.objectContaining({ designReference:{ id:'editorial',sha256 } }) }))
    } finally { await ctx.fiber.dispose(); await rm(root,{ recursive:true,force:true }) }
  })

  it('does not start an image job without the selected reference pixels', async () => {
    const ctx=new Context(); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
    try {
      ctx.on('hivemind/design-reference-list',async()=>[summary])
      const generate=vi.fn(); const registry=new GenerationRegistry()
      registry.register({ id:'test-image',format:'image',instructions:'image',generate })
      registerMediaWorkflow(ctx,registry,'artifacts',{ maxBriefChars:1000,imageAttempts:1,retryBaseDelayMs:1 })
      const agent={ session:{ header:{ id:'test',cwd:'/tmp' },snapshotEvents:()=>[] } } as unknown as Agent
      const result=await ctx.tools.execute({ name:'hivemind_media_generate',arguments:{ kind:'image',title:'Illustration',brief:'Original research illustration' },agent,callId:ToolCallId('image-no-reference'),signal:new AbortController().signal })
      expect(result.isError).toBe(false)
      expect(JSON.stringify(result)).toContain('design_reference_required')
      expect(generate).not.toHaveBeenCalled()
    } finally { await ctx.fiber.dispose() }
  })

})
