import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as Persona from '@deepseek-ai/dsh-persona'
import { employeePersona } from '../../employee-delegation/src/index.ts'
import { load, DEFAULT_SCHEMA, Type } from 'js-yaml'
import { expect, it } from 'vitest'

const schema = DEFAULT_SCHEMA.extend(new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value }))
function persona(name: string): Persona.Config {
  const rows = load(readFileSync(new URL(`../../../preset/agent-presets/presets/${name}/agent.cordis.yml`, import.meta.url), 'utf8'), { schema }) as { id: string; config: { patches: { id: string; config: Persona.Config }[] } }[]
  const result = rows.find(row => row.id === 'hivemind-chat-base')?.config.patches.find(row => row.id === 'persona')?.config
  if (!result) throw Error('missing scoped persona')
  return result
}
it('assembles distinct Chief, persistent specialist and delegated child personas without losing shared guidance', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt, { personaPrefix: 'Deployment identity', includeHarnessIdentity: false })
    ctx.systemPrompt.section({ name: 'review-contract', order: 100, text: 'Accepted current-revision review is required.' })
    const keys = [{ agent: 'runtime' }, { agent: 'employee' }, { agent: 'child' }]
    const [chief, specialist, child] = keys.map(key => createScope(ctx, key))
    if (!chief || !specialist || !child) throw Error('missing scope')
    await chief.ctx.plugin(Persona, persona('hivemind-hq'))
    await specialist.ctx.plugin(Persona, persona('hivemind-hyperagents'))
    await child.ctx.plugin(Persona, { prefix: employeePersona({ name: 'Verified employee', role: 'Research', persona: 'Inspect first-party evidence.' }) })
    const assembled = await Promise.all(keys.map(scope => ctx.systemPrompt.assemble({ scope }).then(renderPrompt)))
    for (const text of assembled) {
      expect(text).not.toContain('Deployment identity')
      expect(text).toContain('Accepted current-revision review is required.')
    }
    expect(assembled[0]).toContain("the user's AI Chief of Staff")
    expect(assembled[0]).toContain('For a delegated typed blocker, use its saved blocker_id')
    expect(assembled[0]).toContain('residual native ask under approval=never is rejected')
    expect(assembled[1]).toContain('proactive expert specialist')
    expect(assembled[1]).toContain('Finish with the verified result, or a concrete blocker')
    expect(assembled[1]).toContain('Direct human-assigned tasks retain their existing question')
    expect(assembled[2]).toContain('You are Verified employee')
    expect(assembled[2]).toContain('native Team mailbox')
    expect(assembled[2]).toContain('Inspect first-party evidence.')
    for (const text of assembled.slice(0, 2)) expect(text).toContain('Keep full details inspectable.')
  } finally { await ctx.fiber.dispose() }
})
