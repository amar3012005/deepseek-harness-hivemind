import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { GenerationRegistry, registerGenerationTools } from '../src/generation.ts'
import { markdownReportProvider, presentationProvider, spreadsheetProvider, webProvider } from '../src/office-providers.ts'

const request = (content: string) => ({ title: 'Company validation', content, cwd: '/tmp', signal: new AbortController().signal })

describe('generation providers', () => {
  it('preserves the finished Markdown report without synthesis or format substitution', async () => {
    const markdown = '# Verified brief\n\nDecision: research public sources only.\n\nSource: https://example.com/'
    const file = await markdownReportProvider.generate(request(markdown))
    expect(file.extension).toBe('md')
    expect(file.mediaType).toBe('text/markdown')
    expect(new TextDecoder().decode(file.data)).toBe(markdown)
  })
  it('routes a known self-contained web request directly to generation', () => {
    const tools = new Map<string, ToolDefinition>()
    const ctx = {
      effect(effect: () => unknown) { effect(); return () => {} },
      tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {} } },
    }
    const registry = new GenerationRegistry()
    registerGenerationTools(ctx as never, registry, 'artifacts', 1_000)

    expect(tools.get('hivemind_generation_discover')?.description).toContain('only when the requested format or its input representation is unknown')
    expect(tools.get('hivemind_generation_discover')?.description).toContain('Do not call this for a known self-contained HTML/web request')
    expect(tools.get('hivemind_generate')?.description).toContain('provide complete self-contained HTML directly')
    expect(JSON.stringify(tools.get('hivemind_generate'))).toContain('HIVE visual baseline')
  })

  it('removes disposed providers and never advertises an unconfigured format', () => {
    const registry = new GenerationRegistry()
    const dispose = registry.register(webProvider)
    expect(registry.list()).toEqual([expect.objectContaining({ format: 'web', tool: 'hivemind_generate' })])
    expect(() => registry.register(webProvider)).toThrow('already registered')
    expect(() => registry.get('video')).toThrow('No video generator')
    dispose()
    expect(registry.list()).toEqual([])
  })

  it('routes configured media through the tracked media workflow', () => {
    const registry = new GenerationRegistry()
    registry.register({ id: 'image', format: 'image', instructions: 'brief', async generate() { throw new Error('not called') } })
    registry.register({ id: 'video', format: 'video', instructions: 'brief', async generate() { throw new Error('not called') } })
    expect(registry.list().map(item => [item.format, item.tool])).toEqual([
      ['image', 'hivemind_media_generate'], ['video', 'hivemind_media_generate'],
    ])
  })

  it('produces a readable workbook and preserves formula-like source data as literal strings', async () => {
    const result = await spreadsheetProvider.generate(request('Name,Value\n"A, B",=HYPERLINK(""http://example.com"")\nSource,https://example.com'))
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(result.data as never)
    expect(workbook.worksheets[0]?.getCell('A2').value).toBe('A, B')
    expect(typeof workbook.worksheets[0]?.getCell('B2').value).toBe('string')
    expect(workbook.worksheets[0]?.getCell('B3').value).toBe('https://example.com')
  })

  it('produces an office ZIP presentation with slide content and rejects overflowing slides', async () => {
    const result = await presentationProvider.generate(request('# Decision\nValidate demand.\n# Gate\nThree buyer interviews.'))
    expect(Buffer.from(result.data).subarray(0, 2).toString()).toBe('PK')
    expect(result.data.length).toBeGreaterThan(1000)
    await expect(presentationProvider.generate(request(`# Too much\n${'x'.repeat(1801)}`))).rejects.toThrow('split')
  })

  it('honors cancellation and does not claim to publish generated HTML', async () => {
    const abort = new AbortController(); abort.abort()
    await expect(webProvider.generate({ ...request('<html></html>'), signal: abort.signal })).rejects.toThrow()
    await expect(webProvider.generate(request('plain text'))).rejects.toThrow('complete HTML')
    const rendered = await webProvider.generate({ ...request('<html><head></head><body><h1>Draft</h1></body></html>'), designProfile: 'campaign' })
    expect(new TextDecoder().decode(rendered.data)).toContain('Draft')
    expect(new TextDecoder().decode(rendered.data)).toContain('hivemind-design-profile')
    expect(rendered.designQuality).toEqual(expect.objectContaining({ status: 'needs_review' }))
  })
})
