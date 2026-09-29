import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.ts'

/**
 * Opt-in authenticated contract canary. It intentionally uses a harmless public
 * page and proves the same compact tools mounted by HyperAgents can create and
 * read a real durable receipt. It never prints the ICARUS credential.
 */
const live = process.env.HIVEMIND_RESEARCH_LIVE === '1'

describe.skipIf(!live)('live HIVE-MIND research contract', () => {
  it('creates a known-URL job and receives a terminal evidence receipt', async () => {
    const tools = new Map<string, ToolDefinition>()
    const events: Array<{ type: string; data: unknown }> = []
    const ctx = {
      tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {} } },
      hivemindExecutionScope: { require() { return { userId: 'local-canary', orgId: 'local-canary', profile: 'hyperagents' as const, variation: 'canary' } } },
    }
    apply(ctx as never, { maxResults: 3, maxUrls: 1, requestTimeoutMs: 30_000 })
    const request = tools.get('hivemind_research_request')
    const status = tools.get('hivemind_research_status')
    if (request === undefined || status === undefined) throw new Error('research tools were not registered')
    const agent = { session: { append(type: string, data: unknown) { events.push({ type, data }) } } } as unknown as Agent
    const started = await request.execute({
      objective: 'Extract the page title and primary heading from this public page.',
      research_type: 'known_url',
      urls: ['https://example.com/'],
      limit: 1,
    }, { agent, signal: new AbortController().signal } as never) as { research: { jobId: string } }

    let terminal: { status: string; receipt: { evidenceState: string; sources: unknown[] } } | undefined
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await status.execute(
        { job_id: started.research.jobId }, { agent, signal: new AbortController().signal } as never,
      ) as typeof terminal
      if (result === undefined) continue
      if (result.status !== 'queued' && result.status !== 'running' && result.status !== 'pending') {
        terminal = result
        break
      }
      await new Promise(resolve => setTimeout(resolve, 1_000))
    }
    expect(terminal, 'research job did not reach a terminal receipt within 20 seconds').toBeDefined()
    expect(['succeeded', 'partial', 'failed']).toContain(terminal?.status)
    expect(['ready', 'partial', 'unavailable']).toContain(terminal?.receipt.evidenceState)
    if (terminal?.status === 'succeeded') {
      expect(terminal.receipt.evidenceState).toBe('ready')
      expect(terminal.receipt.sources.length).toBeGreaterThan(0)
    }
    expect(events.some(event => event.type === 'hivemind/research-requested')).toBe(true)
    expect(events.some(event => event.type === 'hivemind/research-receipt')).toBe(true)
  }, 30_000)
})
