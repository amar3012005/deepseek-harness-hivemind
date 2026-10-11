import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject, type Config } from '../src/index.ts'

class FullAccessControl extends Service {
  constructor(ctx: Context, readonly allowed: (agent: Agent, signal: AbortSignal) => Promise<boolean>) {
    super(ctx, 'hivemindHq')
  }

  async fullAccessAllowed(agent: Agent, signal: AbortSignal): Promise<boolean> {
    return this.allowed(agent, signal)
  }
}

async function mount() {
  const root = new Context()
  const tools = new Map<string, unknown>()
  root.provide('tools', { register(tool: { name: string }) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } })
  root.provide('skills', { register() { return () => {} } })
  root.provide('sessions', { get() { return undefined } })
  root.provide('sessionProjections', { register() { return () => {} } })
  root.provide('hivemindIdentity', { register() { return () => {} } })
  root.provide('hivemindExecutionScope', { require() { throw Error('hivemind execution scope is unavailable') } })
  const current = vi.fn(() => 'workspace-write')
  root.provide('permissionPresets', { current })
  const config: Config = {
    authorityMode: 'scoped-service', agentFeaturesEnabled: true, icarusConfigPath: '/unused',
    requestTimeoutMs: 2_000, responseMaxBytes: 64_000, profileContextMaxChars: 4_000,
    profileBriefMaxChars: 500, recallResultLimit: 7, entityResultLimit: 10,
    recallItemMaxChars: 2_000, historyTurns: 5, historyMaxChars: 8_000,
    webApprovalRequired: true,
  }
  const runtime = await root.plugin({ name: 'runtime-full-access-test', inject, apply }, config)
  const agent = { session: { header: { id: 'runtime' }, snapshotEvents: () => [] } } as unknown as Agent
  const signal = new AbortController().signal
  const nativePolicy = vi.fn(async () => ({ kind: 'deny' as const, reason: 'Native provider restriction' }))
  const execute = (name = 'web_fetch') => root.waterfall('tools/pre-execute', { agent, name, signal } as ToolExecution, nativePolicy)
  const hq = async (allowed: (agent: Agent, signal: AbortSignal) => Promise<boolean>) => root.plugin({
    name: 'runtime-full-access-provider',
    apply(ctx: Context) { new FullAccessControl(ctx, allowed) },
  })
  return { root, runtime, agent, signal, execute, nativePolicy, current, hq }
}

describe('Runtime Full access native Cordis dependency', () => {
  it('rejects a legacy HQ property read outside a declared dependency', async () => {
    const f = await mount()
    try {
      await f.hq(async () => true)
      expect(() => Reflect.get(f.runtime.ctx, 'hivemindHq')).toThrow('cannot get property "hivemindHq" without inject')
    } finally { await f.root.fiber.dispose() }
  })
  it('loads without HQ and keeps web approval', async () => {
    const f = await mount()
    try { await expect(f.execute()).resolves.toMatchObject({ kind: 'ask' }); expect(f.nativePolicy).not.toHaveBeenCalled() }
    finally { await f.root.fiber.dispose() }
  })

  it('uses optional HQ authority without an undeclared service read', async () => {
    const f = await mount()
    const allowed = vi.fn(async () => true)
    try {
      await f.hq(allowed)
      await expect(f.execute()).resolves.toEqual({ kind: 'deny', reason: 'Native provider restriction' })
      expect(allowed).toHaveBeenCalledWith(f.agent, f.signal)
      expect(f.nativePolicy).toHaveBeenCalledOnce()
    } finally { await f.root.fiber.dispose() }
  })

  it('retains approval when HQ denies Full access', async () => {
    const f = await mount()
    try {
      await f.hq(async () => false)
      await expect(f.execute()).resolves.toMatchObject({ kind: 'ask' })
      await expect(f.execute('hivemind_create_project')).resolves.toMatchObject({ kind: 'ask' })
      expect(f.nativePolicy).not.toHaveBeenCalled()
    } finally { await f.root.fiber.dispose() }
  })

  it('clears unloaded HQ authority and binds the replacement provider', async () => {
    const f = await mount()
    const first = vi.fn(async () => true)
    const second = vi.fn(async () => false)
    try {
      const provider = await f.hq(first)
      await expect(f.execute()).resolves.toMatchObject({ kind: 'deny' })
      await provider.dispose()
      await expect(f.execute()).resolves.toMatchObject({ kind: 'ask' })
      expect(first).toHaveBeenCalledOnce()
      await f.hq(second)
      await expect(f.execute()).resolves.toMatchObject({ kind: 'ask' })
      expect(second).toHaveBeenCalledOnce()
    } finally { await f.root.fiber.dispose() }
  })

  it('keeps native Full access working without HQ', async () => {
    const f = await mount()
    try {
      f.current.mockReturnValue('danger-full-access')
      await expect(f.execute()).resolves.toEqual({ kind: 'deny', reason: 'Native provider restriction' })
      expect(f.nativePolicy).toHaveBeenCalledOnce()
    } finally { await f.root.fiber.dispose() }
  })

  it('bypasses only the existing research and project approval checks', async () => {
    const f = await mount()
    try {
      await f.hq(async () => true)
      for (const name of ['hivemind_create_project', 'hivemind_web_search', 'web_fetch',
        'hivemind_research_answer', 'hivemind_research_request', 'hivemind_research_gather',
        'hivemind_meta', 'hivemind_connected_apps', 'browser_markdown']) {
        await expect(f.execute(name)).resolves.toEqual({ kind: 'deny', reason: 'Native provider restriction' })
      }
      expect(f.nativePolicy).toHaveBeenCalledTimes(9)
    } finally { await f.root.fiber.dispose() }
  })

  it('propagates an authenticated HQ authority failure', async () => {
    const f = await mount()
    try {
      await f.hq(async () => { throw Error('runtime_administrator_required') })
      await expect(f.execute()).rejects.toThrow('runtime_administrator_required')
      expect(f.nativePolicy).not.toHaveBeenCalled()
    } finally { await f.root.fiber.dispose() }
  })
})
