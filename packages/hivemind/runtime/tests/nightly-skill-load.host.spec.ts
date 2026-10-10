import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as toolSkill from '@deepseek-ai/dsh-tool-skill'
import { installNightlyRoutineGuidance, nightlyRoutineSkill } from '../src/nightly-routine-guidance.ts'

it('loads the registered nightly instructions through the real native skill tool only on demand', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(toolSkill)
  installNightlyRoutineGuidance(ctx)
  const catalog = await ctx.skills.list()
  expect(catalog.find(skill => skill.name === nightlyRoutineSkill.name)?.description).toBe(nightlyRoutineSkill.description)
  expect(JSON.stringify(catalog)).not.toContain(nightlyRoutineSkill.content)
  const loaded = await ctx.tools.execute({
    signal: new AbortController().signal, callId: ToolCallId('nightly-skill-load'),
    name: 'skill', arguments: { name: nightlyRoutineSkill.name },
  })
  expect(loaded.isError).toBe(false)
  expect(JSON.stringify(loaded.content)).toContain('NIGHTLY_REVIEW_REQUEST=')
  expect(JSON.stringify(loaded.content)).toContain('runtime_support_report')
  expect(JSON.stringify(loaded.content)).toContain('today’s work')
  const missing = await ctx.tools.execute({
    signal: new AbortController().signal, callId: ToolCallId('nightly-missing-skill'),
    name: 'skill', arguments: { name: 'missing-nightly-skill' },
  })
  expect(missing.isError).toBe(true)
})
