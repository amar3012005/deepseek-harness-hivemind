/** Verify the installed HIVE profile and agent preset from an image filesystem. */
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'

const profileDump = process.argv[2]
if (profileDump === undefined) throw new Error('usage: profile-smoke.mjs <resolved-profile.yml>')

const dump = await readFile(profileDump, 'utf8')
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

const ctx = new Context()
ctx.baseUrl = pathToFileURL('/opt/deepseek-harness/apps/cli/').href
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
  await import('@deepseek-ai/dsh-hivemind-connected-apps')
  console.log('hivemind-chat preset and connected-apps resolve from the image')
} finally {
  await ctx.fiber.dispose()
}
