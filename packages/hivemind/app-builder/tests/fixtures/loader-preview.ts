/** Real file-backed Loader proof using exact shipped preset enablement and configuration. */
import type {} from '@deepseek-ai/dsh-tools'
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

function find(value: unknown): EntryOptions | undefined {
  if (Array.isArray(value)) return value.map(find).find(Boolean)
  if (!value || typeof value !== 'object') return undefined
  if ('id' in value && value.id === 'hivemind-app-builder') return value as EntryOptions
  return Object.values(value).map(find).find(Boolean)
}
const results = []
for (const [preset, enabled] of [
  ['hivemind-hq', true], ['hivemind-hyperagents', true],
  ['hivemind-hyperagents', false], ['hivemind-chat', true],
] as const) {
  process.env.HIVE_APP_RUNTIME_ENABLED = String(enabled)
  const presetFile = `${root}/packages/preset/agent-presets/presets/${preset}/agent.cordis.yml`
  const row = find(yaml.load(readFileSync(presetFile, 'utf8'), { schema: entryListSchema }))
  const dir = mkdtempSync(join(tmpdir(), 'crm-loader-proof-'))
  const file = join(dir, 'cordis.yml')
  const source = (path: string) => pathToFileURL(`${root}/${path}/${face === 'lib' ? 'lib/index.js' : 'src/index.ts'}`).href
  const configs = [
    { id: 'system-prompt', name: source('packages/core/system-prompt'), config: {} },
    { id: 'tools', name: source('packages/core/tools') },
    { id: 'skills', name: source('packages/skill/skill') },
    { id: 'scope', name: source('packages/hivemind/execution-scope') },
    ...(row ? [{ ...row, name: source('packages/hivemind/app-builder') }] : []),
  ]
  writeFileSync(file, yaml.dump(configs, { schema: entryListSchema }))
  const ctx = new Context()
  try {
    await ctx.plugin(Loader, { baseUrl: pathToFileURL(`${dir}/`).href })
    ctx.loader.builtins.include = Include
    await ctx.loader.create({ name: 'cordis:include', config: { path: file } })
    await ctx.loader.await()
    const mounted = !!ctx.tools.get('hivemind_app_get')
    if (mounted !== (!!row && enabled)) throw Error('preset flag mismatch')
    if (mounted) {
      const principal = { orgId, userId, profile: 'hivemind-chat' as const, variation: preset === 'hivemind-hq' ? 'hivemind-hq' : 'hyperagents' }
      if (!(await ctx.skills.get('create-crm'))?.content) throw Error('skill absent')
      await ctx.hivemindExecutionScope.run(principal, () => ctx.tools.get('hivemind_app_get')!.execute(
        { app_id: appId }, { signal: new AbortController().signal } as never,
      ))
    }
    results.push({ preset, enabled, mounted, skill: mounted ? 'create-crm' : null })
  } finally {
    await ctx.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
}
process.stdout.write(JSON.stringify({ passed: true, cases: results }))
