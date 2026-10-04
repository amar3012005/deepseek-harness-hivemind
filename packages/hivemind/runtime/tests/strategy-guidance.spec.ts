import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { readFileSync } from 'node:fs'
import { companyStrategySkill, installCompanyStrategyGuidance } from '../src/strategy-guidance.ts'

it('discovers shared strategy as a summary and loads the complete method on demand', async () => {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  installCompanyStrategyGuidance(ctx)
  const registry = ctx.get('skills')!
  const summary = (await registry.list()).find(skill => skill.name === companyStrategySkill.name)
  expect(summary).toBeDefined()
  expect(summary).not.toHaveProperty('content')
  const loaded = await registry.get(companyStrategySkill.name)
  expect(loaded?.content).toBe(companyStrategySkill.content)
  expect(loaded?.content).toContain('success measure')
  expect(loaded?.content).toContain("agenda's intended outcome and constraints")
  expect(loaded?.content).toContain('bottleneck')
  expect(loaded?.content).toContain('Compare plausible approaches and their tradeoffs')
  expect(loaded?.content).toContain('small measurable experiment')
  expect(loaded?.content).toContain('continuing, changing or stopping')
  expect(loaded?.content).toContain('rather than fixed quotas')
  expect(loaded?.content).toContain('An employee owns the assigned contribution')
  expect(loaded?.content).toContain('no new assignment')
  expect(loaded?.content).toContain('existing approval requirements')
})

it('keeps routing compact and uses the same native methods for both personas', () => {
  for (const profile of ['hivemind-hq', 'hivemind-hyperagents']) {
    const text = readFileSync(new URL(`../../../preset/agent-presets/presets/${profile}/agent.cordis.yml`, import.meta.url), 'utf8')
    expect(text).toContain('no special prompt is required')
    expect(text).toContain('load hivemind-company-strategy')
    expect(text).toContain('hivemind-artifact-production')
    expect(text).not.toContain('a polished content calendar is not a strategy')
  }
})
