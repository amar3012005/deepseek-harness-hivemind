import { describe, it, expect, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { mountActionToolkits } from '../src/action-toolkit.ts'

describe('native browser output contracts', () => {
  it('accepts provider link arrays and Markdown strings through native execution', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    mountActionToolkits(ctx, { accountId:'test',browserToken:'test',gatewayId:'test',gatewayToken:'test' })
    const agent = { ctx, session:{ append:vi.fn() } }
    await ctx.hivemindActionToolkits.load(agent as never, 'browser-use')
    const links = ['https://example.com/custom-path']
    vi.stubGlobal('fetch', vi.fn(async (url:string) => new Response(JSON.stringify({ success:true,result:url.endsWith('/links') ? links : '# Real page text' }), { headers:{ 'content-type':'application/json' } })))
    try {
      for (const [name,value] of [['browser_links',links],['browser_markdown','# Real page text']] as const) {
        const result = await ctx.tools.execute({ name,arguments:{ url:'https://example.com' },callId:ToolCallId(name),signal:new AbortController().signal })
        expect(result.isError).toBe(false)
        expect(result.content[0]).toEqual({ type:'text',text:typeof value==='string' ? value : JSON.stringify(value) })
      }
    } finally {vi.unstubAllGlobals();await ctx.fiber.dispose()}
  })
  it('accepts a full-page PNG larger than the old two-megabyte limit', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const preview = { attachmentId:'sha256:'+'0'.repeat(64),mediaType:'image/png',width:1280,height:720,bytes:1,name:'Homepage.png' }
    const saveImages = vi.fn(async () => [preview])
    const saveFile = vi.fn(async () => ({ ...preview }))
    ctx.provide('attachments', { saveImages,saveFile } as never)
    mountActionToolkits(ctx, { accountId:'test',browserToken:'test',gatewayId:'test',gatewayToken:'test' })
    await ctx.hivemindActionToolkits.load({ ctx,session:{ append:vi.fn() } } as never,'browser-use')
    const png = new Uint8Array(4596532)
    png.set([137,80,78,71,13,10,26,10])
    vi.stubGlobal('fetch',vi.fn(async () => new Response(png,{ headers:{ 'content-type':'image/png' } })))
    try {
      const result = await ctx.tools.execute({ name:'browser_capture',arguments:{ url:'https://example.com' },callId:ToolCallId('capture'),signal:new AbortController().signal })
      expect(result.isError).toBe(false)
      expect(saveImages).toHaveBeenCalledOnce()
      expect(saveFile).toHaveBeenCalledOnce()
      expect(result.content.some(item => item.type==='image')).toBe(true)
    } finally {vi.unstubAllGlobals();await ctx.fiber.dispose()}
  })

})
