import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const repo = process.env.DSH_VERIFY_REPO ?? '/opt/deepseek-harness'
process.env.DATABASE_URL ??= 'postgres://smoke:smoke@127.0.0.1:1/smoke'
process.env.REDIS_URL ??= 'redis://127.0.0.1:1/15'
process.env.HIVE_HARNESS_TICKET_SECRET ??= 'image-smoke-ticket-secret-not-a-credential'
process.env.HIVE_HARNESS_RUNNER_SERVICE_SECRET ??= 'image-smoke-runner-secret-not-a-credential'
process.env.HIVEMIND_PARENT_ORIGINS ??= 'http://127.0.0.1:0'
process.env.HIVEMIND_CONTROL_PLANE_URL ??= 'http://127.0.0.1:1'
process.env.HIVE_SHARED_ORGANIZATION_AGENTS_ENABLED ??= 'false'
// The configured preset's read-only roster requires the mounted action-toolkit
// service. Nonempty smoke values mount that native capability; this verifier
// never executes its tools or sends an outbound request.
process.env.HIVEMIND_ACTION_CLOUDFLARE_ACCOUNT_ID ??= 'image-smoke-account'
process.env.HIVEMIND_ACTION_BROWSER_TOKEN ??= 'image-smoke-browser-token-not-a-credential'
const require = createRequire(join(repo, 'apps/cli/package.json'))
const { createRuntimeResolution, loadProfileDirectory, PluginPackages, boot } = require('@deepseek-ai/dsh-app-boot')
const { provideCmdline } = require('@deepseek-ai/dsh-cmdline')

const home = process.env.DSH_HOME
if (!home) throw new Error('DSH_HOME must point to the prepared disposable profile home')
const relativeHome = relative(resolve(tmpdir()), resolve(home))
if (relativeHome === '..' || relativeHome.startsWith(`..${sep}`) || isAbsolute(relativeHome)) {
  throw new Error('native profile smoke may only write beneath the temporary directory')
}
const profileDir = join(home, 'profiles', 'hivemind-web')
await mkdir(profileDir, { recursive: true })
await writeFile(join(profileDir, 'cordis.yml'), '[]\n')
await writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n')

const profile = loadProfileDirectory('image-smoke', profileDir, join(repo, 'apps/cli/package.json'))
const resolution = await createRuntimeResolution({
  installAnchor: join(repo, 'apps/cli/package.json'),
  home,
  profile,
})
const hostOnly = [
  { id: 'webserver', disabled: true },
  { id: 'web-runtime', disabled: true },
  { id: 'connection', disabled: true },
  { id: 'client-hmr', disabled: true },
  { id: 'open-in-app', disabled: true },
  { id: 'session-telemetry-otel', disabled: true },
  { id: 'desktop-product-telemetry', disabled: true },
  { id: 'product-analytics', disabled: true },
]

const context = await boot(
  'dsh-hivemind-image-smoke',
  join(profileDir, 'cordis.yml'),
  [...profile.layers.flatMap(layer => layer.patches), ...hostOnly],
  async ctx => {
    ctx.provide('profileContext', {
      name: 'hivemind-web',
      dir: profileDir,
      patchPath: profile.patchPath,
      installAnchor: join(repo, 'apps/cli/package.json'),
      home,
      cwd: home,
      startedBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-hivemind-web-app'],
      overlays: [],
      telemetryDisabledEnv: '1',
    })
    await ctx.plugin(PluginPackages, { resolution })
    ctx.provide('appReady', { onReady: () => () => {} })
    provideCmdline(ctx, { args: [], exit: () => {} })
  },
)

try {
  const toolsRequire = createRequire(join(repo, 'packages/core/tools/package.json'))
  const runtimeRequire = createRequire(join(repo, 'packages/hivemind/runtime/package.json'))
  const hiveRequire = createRequire(join(repo, 'packages/bundle/hivemind-web-app/package.json'))
  for (const [name, owners] of [
    ['@deepseek-ai/dsh-scope', [toolsRequire, runtimeRequire, hiveRequire]],
    ['@deepseek-ai/dsh-tools', [toolsRequire, runtimeRequire, hiveRequire]],
  ]) {
    const paths = owners.map(owner => owner.resolve(name))
    if (new Set(paths).size !== 1) throw new Error(`native identity package resolves to multiple files: ${name}`)
    const instances = await Promise.all(paths.map(path => import(pathToFileURL(path).href)))
    if (instances.some(instance => instance !== instances[0])) {
      throw new Error(`native identity package has multiple module instances: ${name}`)
    }
  }
  const presets = await context.agentPresets.list()
  const broken = presets.filter(preset => preset.broken)
  const ids = presets.map(preset => preset.id).sort()
  const expected = ['cordis', 'hivemind-chat', 'hivemind-hq', 'hivemind-hyperagents', 'minimal', 'ptc', 'standard']
  if (JSON.stringify(ids) !== JSON.stringify(expected)) {
    throw new Error(`unexpected assembled native preset roster: ${JSON.stringify(ids)}`)
  }
  if (broken.length !== 1 || broken[0].id !== 'hivemind-hq'
    || !broken[0].broken?.includes('waiting for agentTeams, sessionPersistence, schedule, hivemindHq, sessionController')) {
    throw new Error(`unexpected native preset diagnostics: ${broken.map(preset => `${preset.id}: ${preset.broken}`).join('; ')}`)
  }
  console.log(`native composed preset roster verified: ${ids.join(', ')}; HQ waits for runtime database services`)
} finally {
  await context.fiber.dispose()
}
