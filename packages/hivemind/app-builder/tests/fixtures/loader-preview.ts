/** Real file-backed Loader proof using exact shipped preset enablement and configuration. */
import type {} from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-hivemind-execution-scope'
import { Context } from '@deepseek-ai/cordis'
import { Loader, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import yaml from 'js-yaml'

const root = fileURLToPath(new URL('../../../../../', import.meta.url))
const orgId = process.env.CRM_NATIVE_PREVIEW_ORG_ID
const userId = process.env.CRM_NATIVE_PREVIEW_USER_ID
const origin = process.env.CRM_NATIVE_PREVIEW_ORIGIN
const secret = process.env.CRM_NATIVE_PREVIEW_SERVICE_SECRET
const appId = process.env.CRM_NATIVE_PREVIEW_APP_ID
const face = process.env.CRM_NATIVE_PREVIEW_FACE ?? 'src'
if (face !== 'src' && face !== 'lib') throw Error('Preview face must be src or lib')
if (!orgId || !userId || !origin || !secret || !appId)
  throw Error('Explicit disposable preview identity, origin, secret and app required')
if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) throw Error('Use a loopback disposable preview')
process.env.HIVEMIND_CONNECTED_RECEIPT_SERVICE_URL = origin
process.env.HIVE_HARNESS_RUNNER_SERVICE_SECRET = secret

function find(value: unknown, id: string): EntryOptions | undefined {
  if (Array.isArray(value)) return value.map(item => find(item, id)).find(Boolean)
  if (!value || typeof value !== 'object') return undefined
  if ('id' in value && value.id === id) return value as EntryOptions
  return Object.values(value).map(item => find(item, id)).find(Boolean)
}
const results = []
for (const [preset, enabled] of [
  ['hivemind-hq', true], ['hivemind-hq', false], ['hivemind-hyperagents', true],
  ['hivemind-hyperagents', false], ['hivemind-chat', true],
] as const) {
  process.env.HIVE_APP_RUNTIME_ENABLED = String(enabled)
  const presetFile = `${root}/packages/preset/agent-presets/presets/${preset}/agent.cordis.yml`
  const presetDefinition = yaml.load(readFileSync(presetFile, 'utf8'), { schema: entryListSchema })
  const row = find(presetDefinition, 'hivemind-app-builder')
  const playbooks = find(presetDefinition, 'hivemind-playbooks')
  const dir = mkdtempSync(join(tmpdir(), 'crm-loader-proof-'))
  const file = join(dir, 'cordis.yml')
  const source = (path: string) => pathToFileURL(`${root}/${path}/${face === 'lib' ? 'lib/index.js' : 'src/index.ts'}`).href
  const configs = [
    { id: 'system-prompt', name: source('packages/core/system-prompt'), config: {} },
    { id: 'tools', name: source('packages/core/tools') },
    { id: 'skills', name: source('packages/skill/skill') },
    { id: 'scope', name: source('packages/hivemind/execution-scope') },
    ...(row ? [{ ...row, name: source('packages/hivemind/app-builder') }] : []),
    ...(playbooks ? [{ ...playbooks, name: source('packages/hivemind/playbooks') }] : []),
  ]
  writeFileSync(file, yaml.dump(configs, { schema: entryListSchema }))
  const ctx = new Context()
  ctx.provide('hivemindMemory', {} as never)
  try {
    await ctx.plugin(Loader, { baseUrl: pathToFileURL(`${dir}/`).href })
    ctx.loader.builtins.include = Include
    await ctx.loader.create({ name: 'cordis:include', config: { path: file } })
    await ctx.loader.await()
    const mounted = !!ctx.tools.get('hivemind_app_get')
    if (mounted !== (!!row && enabled)) throw Error('preset flag mismatch')
    if (playbooks) {
      const { createScope } = await import(source('packages/core/scope')) as typeof import('@deepseek-ai/dsh-scope')
      const events: Array<{ type: string; data: unknown }> = []
      const agent = { session: {
        id: 'crm-progressive-preview',
        append(type: string, data: unknown) { events.push({ type, data }); return { seq: events.length } },
        snapshotEvents() { return events },
      } } as unknown as Agent
      let scope!: ReturnType<typeof createScope>
      await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, { inject: ['systemPrompt', 'tools'] }))
      ;(agent as unknown as { ctx: Context }).ctx = scope.ctx.extend({ agent })
      const original = ctx.tools.schemas().filter(tool => tool.name.startsWith('hivemind_app_'))
      const initial = await ctx.systemPrompt.assemble({ agent, scope: agent })
      if (initial.tools.some(tool => tool.name.startsWith('hivemind_app_'))) throw Error('Apps leaked before lease')
      const principal = { orgId, userId, profile: 'hivemind-chat' as const, variation: preset === 'hivemind-hq' ? 'hivemind-hq' : 'hyperagents' }
      const execute = (name: string, args: Record<string, unknown>) => ctx.hivemindExecutionScope.run(principal, () => ctx.tools.execute({
        name, arguments: args as never, callId: `crm-preview-${name}` as never, agent, signal: new AbortController().signal,
      }))
      const lease = await execute('hivemind_capabilities', { operation: 'lease', capabilities: ['apps'] })
      if (lease.isError) throw Error('Apps lease failed: ' + JSON.stringify(lease))
      const next = await ctx.systemPrompt.assemble({ agent, scope: agent })
      const revealed = next.tools.filter(tool => tool.name.startsWith('hivemind_app_'))
      if (revealed.length !== (mounted ? 9 : 0)) throw Error('Apps lease did not project exactly installed tools')
      for (const tool of original) if (JSON.stringify(tool) !== JSON.stringify(revealed.find(value => value.name === tool.name))) throw Error('Native schema changed: ' + tool.name)
      if (mounted) {
        const skill = await ctx.skills.get('create-crm')
        if (!skill?.content.includes('capabilities [apps]')) throw Error('CRM skill misses apps lease guidance')
        const read = await execute('hivemind_app_get', { app_id: appId })
        if (read.isError) throw Error('Scoped authenticated read failed: ' + JSON.stringify(read))
      }
      const reset = await execute('hivemind_capabilities', { operation: 'reset' })
      if (reset.isError) throw Error('Reset failed')
      const afterReset = await ctx.systemPrompt.assemble({ agent, scope: agent })
      if (afterReset.tools.some(tool => tool.name.startsWith('hivemind_app_'))) throw Error('Apps remained visible after reset')
      const denied = await execute('hivemind_app_get', { app_id: appId })
      if (!denied.isError || !JSON.stringify(denied).includes('UNKNOWN_TOOL')) throw Error('Reset did not close tool execution')
    }
    results.push({ preset, enabled, mounted, skill: mounted ? 'create-crm' : null, progressive: !!playbooks })
  } finally {
    await ctx.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
}
process.stdout.write(JSON.stringify({ passed: true, cases: results }))
