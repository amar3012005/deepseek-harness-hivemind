import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GenerationProviderError } from '../src/image-provider.ts'
import { GenerationRegistry } from '../src/generation.ts'
import { registerMediaWorkflow } from '../src/media-workflow.ts'

afterEach(() => vi.useRealTimers())

async function setup(
  generate: (signal: AbortSignal) => Promise<{ data: Uint8Array; extension: string; mediaType: string }>,
  availability?: () => Promise<{ ready: true } | { ready: false; code: string; action: string }>,
) {
  const cwd = await mkdtemp(join(tmpdir(), 'media-workflow-'))
  const tools = new Map<string, ToolDefinition>(); const events: Array<{ type: string; data: unknown }> = []
  let hooks: { cancel(reason?: string): void; done: Promise<{ status: string; output?: string }> } | undefined
  const ctx = {
    attachments: {
      saveFile: async ({ data, name }: { data: Uint8Array; name: string }) => ({ attachmentId: 'file', name, bytes: data.byteLength }),
      saveImage: async ({ data, mediaType, name }: { data: Uint8Array; mediaType: string; name: string }) => ({ attachmentId: 'image', name, mediaType, bytes: data.byteLength, width: 1, height: 1 }),
    },
    tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {} } },
    jobs: { start(spec: { run(): typeof hooks }) { hooks = spec.run(); return 'media-1' } },
  }
  const registry = new GenerationRegistry()
  registry.register({ id: 'test-image', format: 'image', instructions: 'test', ...(availability ? { availability } : {}), generate: request => generate(request.signal) })
  registerMediaWorkflow(ctx as never, registry, 'artifacts', { maxBriefChars: 1000, imageAttempts: 3, retryBaseDelayMs: 1 })
  const agent = { session: { id: 'session', header: { cwd }, append(type: string, data: unknown) { events.push({ type, data }) }, snapshotEvents() { return events } } } as unknown as Agent
  return { cwd, tools, events, agent, hooks: () => hooks! }
}

async function start(harness: Awaited<ReturnType<typeof setup>>) {
  return harness.tools.get('hivemind_media_generate')!.execute({ kind: 'image', title: 'Draft', brief: 'A complete visual brief.' }, { agent: harness.agent, signal: new AbortController().signal } as never)
}

describe('durable media workflow', () => {
  it('records start, stored artifact, and terminal receipt around one background job', async () => {
    const harness = await setup(async () => ({ data: Uint8Array.of(1, 2, 3), extension: 'png', mediaType: 'image/png' }))
    try {
      await expect(start(harness)).resolves.toMatchObject({ status: 'running', job_id: 'media-1' })
      await expect(harness.hooks().done).resolves.toMatchObject({ status: 'completed' })
      expect(harness.events.map(event => event.type)).toEqual(['hivemind/media-workflow-started', 'hivemind/generation-created', 'hivemind/media-workflow-ended'])
      expect(harness.events.at(-1)?.data).toMatchObject({ status: 'completed', attempts: 1, jobId: 'media-1' })
    } finally { await rm(harness.cwd, { recursive: true, force: true }) }
  })

  it('retries only provider-declared duplicate-safe failures', async () => {
    let calls = 0
    const harness = await setup(async () => {
      calls += 1
      if (calls < 3) throw new GenerationProviderError('rate limited', 'HTTP_429', true)
      return { data: Uint8Array.of(1), extension: 'png', mediaType: 'image/png' }
    })
    try {
      await start(harness); await expect(harness.hooks().done).resolves.toMatchObject({ status: 'completed' })
      expect(calls).toBe(3)
      expect(harness.events.at(-1)?.data).toMatchObject({ attempts: 3 })
    } finally { await rm(harness.cwd, { recursive: true, force: true }) }
  })

  it('does not retry an ambiguous provider failure', async () => {
    let calls = 0
    const harness = await setup(async () => { calls += 1; throw new Error('connection dropped after submission') })
    try {
      await start(harness); await expect(harness.hooks().done).resolves.toMatchObject({ status: 'failed' })
      expect(calls).toBe(1)
      expect(harness.events.at(-1)?.data).toMatchObject({ status: 'failed', attempts: 1 })
    } finally { await rm(harness.cwd, { recursive: true, force: true }) }
  })

  it('returns an actionable authentication gate without starting a job', async () => {
    const harness = await setup(async () => { throw new Error('must not run') }, async () => ({ ready: false, code: 'AUTH_REQUIRED', action: 'Authenticate.' }))
    try {
      await expect(start(harness)).resolves.toMatchObject({ status: 'awaiting_input', code: 'AUTH_REQUIRED' })
      expect(harness.events).toEqual([])
    } finally { await rm(harness.cwd, { recursive: true, force: true }) }
  })

  it('settles killed after native job cancellation aborts its provider', async () => {
    const harness = await setup(signal => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })))
    try {
      await start(harness); harness.hooks().cancel('user cancelled')
      await expect(harness.hooks().done).resolves.toMatchObject({ status: 'killed' })
      expect(harness.events.at(-1)?.data).toMatchObject({ status: 'killed' })
    } finally { await rm(harness.cwd, { recursive: true, force: true }) }
  })
})
