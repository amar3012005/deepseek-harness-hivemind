import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GenerationProviderError } from '../src/image-provider.ts'
import { GenerationRegistry, type GenerationRequest } from '../src/generation.ts'
import { registerMediaWorkflow } from '../src/media-workflow.ts'

interface StartReceipt {
  request: string
  owner: { orgId: string; userId: string; sessionId: string }
  workflowId: string
}
afterEach(() => vi.useRealTimers())

async function setup(
  generate: (signal: AbortSignal) => Promise<{ data: Uint8Array; extension: string; mediaType: string }>,
  availability?: () => Promise<{ ready: true } | { ready: false; code: string; action: string }>,
  ownership = false,
) {
  const cwd = await mkdtemp(join(tmpdir(), 'media-workflow-'))
  const tools = new Map<string, ToolDefinition>(); const events: Array<{ type: string; data: unknown }> = []
  let hooks: { cancel(reason?: string): void; done: Promise<{ status: string; output?: string }> } | undefined
  const listeners = new Map<string, (value: { agent: Agent }) => Promise<void>>()
  const disposers: Array<() => void> = []
  const owner = { orgId: 'org-a', userId: 'user-a', sessionId: 'session' }
  const requests: GenerationRequest[] = []
  const ctx = {
    on: (event: string, listener: (value: { agent: Agent }) => Promise<void>) => { listeners.set(event, listener); return () => {} },
    effect: (effect: () => () => void) => { disposers.push(effect()) },
    serial: async () => owner,
    sessions: { flush: async () => true },
    attachments: {
      saveFile: async ({ data, name }: { data: Uint8Array; name: string }) => ({ attachmentId: 'file', name, bytes: data.byteLength }),
      saveImage: async ({ data, mediaType, name }: { data: Uint8Array; mediaType: string; name: string }) => ({ attachmentId: 'image', name, mediaType, bytes: data.byteLength, width: 1, height: 1 }),
    },
    tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => {} } },
    jobs: { list: () => [], start(spec: { run(): typeof hooks }) { hooks = spec.run(); return 'media-1' } },
  }
  const registry = new GenerationRegistry()
  registry.register({ id: ownership ? 'codex:gpt-image-2' : 'test-image', format: 'image', instructions: 'test', ...(availability ? { availability } : {}), generate: (request) => { requests.push(request); return generate(request.signal) } })
  registerMediaWorkflow(ctx as never, registry, 'artifacts', { maxBriefChars: 1000, imageAttempts: 3, retryBaseDelayMs: 1, ...(ownership ? { requireOwner: true, admission: { path: join(cwd, 'queue.sqlite'), globalConcurrency: 2, tenantConcurrency: 1, maxQueued: 3, dailyUserLimit: 50 } } : {}) })
  const agent = { session: { id: 'session', header: { cwd, id: 'session' }, append(type: string, data: unknown) { events.push({ type, data }) }, snapshotEvents() { return events } } } as unknown as Agent
  return { cwd, tools, events, agent, requests, listeners, dispose: () => disposers.forEach(dispose => dispose()), hooks: () => hooks! }
}

async function start(harness: Awaited<ReturnType<typeof setup>>) {
  return harness.tools.get('hivemind_media_generate')!.execute({ kind: 'image', title: 'Draft', brief: 'A complete visual brief.' }, { agent: harness.agent, signal: new AbortController().signal } as never)
}

describe('durable media workflow', () => {
  it('binds accepted work and receipts to authenticated owner and preserves recovery identity', async () => {
    const harness = await setup(async () => ({ data: Uint8Array.of(1), extension: 'png', mediaType: 'image/png' }), undefined, true)
    try {
      await start(harness); await harness.hooks().done
      expect(harness.requests[0]?.owner).toEqual({ orgId: 'org-a', userId: 'user-a', sessionId: 'session' })
      const initial = harness.events[0]!.data as StartReceipt
      expect(initial.request).toContain('A complete visual brief.')
      expect(harness.events[1]!.data).toMatchObject({ owner: initial.owner })
      // Simulate a persisted dispatched intent without a terminal receipt on cold reopen.
      harness.events.splice(1)
      await harness.listeners.get('agent/created')!({ agent: harness.agent })
      await harness.hooks().done
      expect(harness.requests[1]?.reconcileOnly).toBe(true)
      expect((harness.events[1]!.data as StartReceipt).workflowId).toBe(initial.workflowId)
      expect(harness.requests[1]?.operationId).toBe(harness.requests[0]?.operationId)
    } finally { harness.dispose(); await rm(harness.cwd, { recursive: true, force: true }) }
  })

  it('records start, stored artifact, and terminal receipt around one background job', async () => {
    const harness = await setup(async () => ({ data: Uint8Array.of(1, 2, 3), extension: 'png', mediaType: 'image/png' }))
    try {
      await expect(start(harness)).resolves.toMatchObject({ status: 'running', job_id: 'media-1' })
      await expect(harness.hooks().done).resolves.toMatchObject({ status: 'completed' })
      expect(harness.events.map(event => event.type)).toEqual(['hivemind/media-workflow-started', 'hivemind/generation-created', 'hivemind/media-workflow-ended'])
      expect(harness.events.at(-1)?.data).toMatchObject({ status: 'completed', attempts: 1, jobId: 'media-1' })
    } finally { harness.dispose(); await rm(harness.cwd, { recursive: true, force: true }) }
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
    } finally { harness.dispose(); await rm(harness.cwd, { recursive: true, force: true }) }
  })

  it('does not retry an ambiguous provider failure', async () => {
    let calls = 0
    const harness = await setup(async () => { calls += 1; throw new Error('connection dropped after submission') })
    try {
      await start(harness); await expect(harness.hooks().done).resolves.toMatchObject({ status: 'failed' })
      expect(calls).toBe(1)
      expect(harness.events.at(-1)?.data).toMatchObject({ status: 'failed', attempts: 1 })
    } finally { harness.dispose(); await rm(harness.cwd, { recursive: true, force: true }) }
  })

  it('returns an actionable authentication gate without starting a job', async () => {
    const harness = await setup(async () => { throw new Error('must not run') }, async () => ({ ready: false, code: 'AUTH_REQUIRED', action: 'Authenticate.' }))
    try {
      await expect(start(harness)).resolves.toMatchObject({ status: 'awaiting_input', code: 'AUTH_REQUIRED' })
      expect(harness.events).toEqual([])
    } finally { harness.dispose(); await rm(harness.cwd, { recursive: true, force: true }) }
  })

  it('settles killed after native job cancellation aborts its provider', async () => {
    const harness = await setup(signal => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })))
    try {
      await start(harness); await Promise.resolve(); harness.hooks().cancel('user cancelled')
      await expect(harness.hooks().done).resolves.toMatchObject({ status: 'killed' })
      expect(harness.events.at(-1)?.data).toMatchObject({ status: 'killed' })
    } finally { harness.dispose(); await rm(harness.cwd, { recursive: true, force: true }) }
  })
})
