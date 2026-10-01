import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import ExecutionScope from '@deepseek-ai/dsh-hivemind-execution-scope'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { liveVoicePlugin } from '../src/live-voice.ts'

let root: string | undefined; let ctx: Context | undefined
const principal = { orgId: 'org-a', userId: 'user-a', profile: 'hivemind-chat' as const, variation: 'company' }
afterEach(async () => { await ctx?.fiber.dispose(); if (root) await rm(root, { recursive: true, force: true }); vi.restoreAllMocks() })

async function composition() {
  root = await mkdtemp(join(tmpdir(), 'hive-voice-loader-'))
  const config = join(root, 'cordis.yml')
  await writeFile(config, [
    '- name: web', '  config:', '    host: 127.0.0.1', '    port: 0',
    '- name: session', '- name: agents', '- name: prompt', '- name: typert', '- name: scope', '- name: storage-fixture', '- name: voice', '',
  ].join('\n'))
  ctx = new Context(); ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader); ctx.loader.builtins.include = Include
  const storage = { name: 'voice-storage-fixture', inject: ['hivemindExecutionScope'], apply(context: Context) {
    context.provide('connection', {} as never)
    context.provide('sessionQuery', {} as never)
    context.provide('sessionController', { resolveAgent: () => { throw new Error('foreign Session must never resolve') } } as never)
    // External tenant persistence boundary; reject a Session from a different organization.
    context.provide('sessionPersistence', { stat: async () => {
      expect(context.hivemindExecutionScope.require()).toEqual(principal)
      return undefined
    } } as never)
  } }
  const modules = new Map<string, unknown>([
    ['web', WebServer], ['session', SessionStore], ['agents', AgentRegistry], ['prompt', SystemPrompt], ['typert', TypertRegistry], ['scope', ExecutionScope], ['storage-fixture', storage],
    ['voice', liveVoicePlugin({ enabled: true, model: 'gpt-live-1-codex', voice: 'cove', timeoutMs: 1000, maxDurationMs: 60000, maxConnections: 2 },
      req => req.headers.cookie === 'fixture=authenticated' ? principal : undefined)],
  ])
  ctx.loader.internal = { version: 'v2', async import(name: string) {
    if (!modules.has(name)) throw new Error(`unexpected import: ${name}`)
    return modules.get(name)
  } } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } }); await ctx.loader.await()
  return ctx
}

describe('native voice real Loader composition', () => {
  it('loads native service dependencies, rejects anonymous/cross-origin requests, and restores tenant scope before admission', async () => {
    const c = await composition()
    expect([...c.loader.entries()].filter(entry => !entry.disabled && entry.fiber === undefined)).toEqual([])
    const base = `http://127.0.0.1:${c.webServer.port}`
    const send = (cookie?: string, origin = base) => fetch(`${base}/api/hivemind/voice/start`, { method: 'POST', headers: { 'content-type': 'application/json', origin, ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ sessionId: 'other-tenant-session', sdp: 'v=0\r\nfixture' }) })
    expect((await send()).status).toBe(401)
    expect((await send('fixture=authenticated', 'https://untrusted.example')).status).toBe(403)
    const denied = await send('fixture=authenticated')
    expect(denied.status).toBe(404)
    expect(await denied.json()).toEqual({ error: 'session_not_found' })
    expect(() => c.hivemindExecutionScope.require()).toThrow()
  })
})
