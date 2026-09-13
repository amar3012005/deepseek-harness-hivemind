/** Verify the installed HIVE profile and agent preset from an image filesystem. */
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const profileDump = process.argv[2]
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const execFileAsync = promisify(execFile)

// pnpm intentionally does not hoist every workspace dependency into the source
// checkout's root node_modules. The immutable image materializes those links,
// while a clean checkout exposes the same packages through pnpm's virtual
// workspace directory. Resolve from either layout so this verifier proves the
// profile in both places instead of depending on an accidental local symlink.
const resolvers = [
  createRequire(resolve(repositoryRoot, 'package.json')),
  createRequire(resolve(repositoryRoot, 'node_modules/.pnpm/node_modules/package.json')),
]

async function importWorkspacePackage(name) {
  for (const resolver of resolvers) {
    try {
      return await import(pathToFileURL(resolver.resolve(name)).href)
    } catch (error) {
      if (error?.code !== 'MODULE_NOT_FOUND' && error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
    }
  }
  throw new Error(`cannot resolve required profile package ${name}`)
}

const { Context } = await importWorkspacePackage('@deepseek-ai/cordis')
const { default: Include } = await importWorkspacePackage('@deepseek-ai/cordis-plugin-include')
const { default: Loader } = await importWorkspacePackage('@deepseek-ai/cordis-plugin-loader')
const { default: AgentPresets } = await importWorkspacePackage('@deepseek-ai/dsh-agent-presets')
const { default: SessionProjectionRegistry } = await importWorkspacePackage('@deepseek-ai/dsh-session-projection')

const dump = profileDump === undefined
  ? (await execFileAsync(process.execPath, [
      resolve(repositoryRoot, 'apps/cli/lib/bin.js'),
      '--profile',
      'hivemind-web',
      '--dump-config',
    ], { cwd: repositoryRoot, maxBuffer: 16 * 1024 * 1024 })).stdout
  : await readFile(profileDump, 'utf8')
const presentation = {
  'Markdown, tables, code, and math': ['ui-renderer', 'ui-conversation', 'ui-chat'],
  reasoning: ['ui-conversation', 'ui-chat'],
  tools: ['ui-tool'],
  trajectory: ['ui-trajectory'],
  attachments: ['ui-attachment'],
  jobs: ['ui-jobs', 'ui-workflow-run'],
  subagents: ['ui-subagent'],
  replay: ['ui-session', 'ui-conversation'],
}

/** Return the emitted profile row for one id without depending on YAML comments. */
function row(id) {
  const match = dump.match(new RegExp(`^- id: ${id}\\n(?:(?!^- id: ).)*`, 'ms'))
  if (match === null) throw new Error(`hivemind-web image profile is missing ${id}`)
  if (/^  disabled: true$/m.test(match[0])) throw new Error(`hivemind-web image profile disables ${id}`)
  return match[0]
}

for (const [feature, ids] of Object.entries(presentation)) {
  for (const id of ids) row(id)
  console.log(`hivemind-web image profile retains ${feature}`)
}

const defaultModel = row('agent-default-model')
if (!defaultModel.includes('provider: cloudflare-openrouter')
  || !defaultModel.includes('model: openrouter/deepseek/deepseek-v4-flash-0731')) {
  throw new Error('hivemind-web image profile must use the Cloudflare OpenRouter default model')
}
const providerRegistry = row('llm-pi-ai')
if (!providerRegistry.includes('cloudflare-openrouter:')
  || !providerRegistry.includes("reasoning: 'off'")) {
  throw new Error('hivemind-web image profile must disable optional reasoning at the provider boundary')
}
if (!dump.includes("'off': none")) {
  throw new Error('hivemind-web image profile must map Harness reasoning off to OpenRouter none')
}
console.log('hivemind-web image profile disables optional default-model reasoning')

const ctx = new Context()
const virtualWorkspaceModules = resolve(repositoryRoot, 'node_modules/.pnpm/node_modules')
const resolverBase = await access(virtualWorkspaceModules).then(
  () => virtualWorkspaceModules,
  () => resolve(repositoryRoot, 'apps/cli'),
)
ctx.baseUrl = pathToFileURL(`${resolverBase}/`).href
try {
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentPresets, {
    default: 'hivemind-chat',
    roots: [],
    includeShippedRoot: true,
    includeUserRoot: false,
    allowed: ['hivemind-chat'],
  })
  const preset = await ctx.agentPresets.resolve('hivemind-chat')
  if (preset.broken !== undefined) throw new Error(`hivemind-chat preset cannot mount: ${preset.broken}`)
  await importWorkspacePackage('@deepseek-ai/dsh-hivemind-connected-apps')
  console.log('hivemind-chat preset and connected-apps resolve from the image')
} finally {
  await ctx.fiber.dispose()
}
