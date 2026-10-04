import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { companyAwakeningSkill, installCompanyAwakeningGuidance } from '../src/awakening-guidance.ts'

it('keeps company awakening instructions behind native skill loading and disposes them', async () => {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  const registry = ctx.get('skills')!
  const dispose = registry.register(companyAwakeningSkill)
  const summary = (await registry.list()).find(skill => skill.name === companyAwakeningSkill.name)
  expect(summary).toBeDefined()
  expect(summary).not.toHaveProperty('content')
  const skill = await registry.get(companyAwakeningSkill.name)
  expect(skill?.content).toBe(companyAwakeningSkill.content)
  expect(skill?.content).toContain('same pending notes as a scheduled wake')
  expect(skill?.content).toContain('do not replace it with placeholder HTML')
  expect(skill?.content).toContain('measured warmth and thoughtful curiosity')
  expect(skill?.content).toContain('without public search')
  expect(skill?.content).toContain('once per fresh lifecycle')
  expect(skill?.content).toContain('Partial or empty recall does not establish')
  expect(skill?.content).toContain('Match domain, location and company identity')
  expect(skill?.content).toContain('collect a successful context or source tool result')
  expect(skill?.content).toContain('copy its exact returned reference')
  expect(skill?.content).toContain('do not call non-conversation awakening checkpoints')
  expect(skill?.content).toContain('reading their directory entries alone does not complete')
  expect(skill?.content).toContain('existing team checkpoint')
  expect(skill?.content).toContain('Awakening Plan visibly in normal chat')
  expect(skill?.content).toContain('current company objective is missing')
  expect(skill?.content).toContain('only actually saved assignments')
  expect(skill?.content).toContain('calm, reflective and curious arrival')
  expect(skill?.content).toContain('Sofia, Elena and Ravi')
  expect(skill?.content).toContain("preserve Ravi's existing assignment")
  expect(skill?.content).toContain('first visible region of the HTML plan')
  expect(skill?.content).toContain('not a fixed assignment count for ordinary Runtime work')
  expect(skill?.content).toContain('Wakeup Chief alone is sufficient')
  expect(skill?.content).toContain('each participate with a dedicated saved schedule')
  expect(skill?.content).toContain('not a claim that you were born')
  expect(skill?.content).toContain('persistent employee rooms')
  expect(skill?.content).toContain('does not by itself block authorized internal discovery')
  expect(skill?.content).toContain('Distinguish scheduled, submitted and completed work')
  expect(skill?.content).toContain('scoped private Runtime memory')
  expect(skill?.content).toContain('before finishing the HTML plan')
  expect(skill?.content).toContain('revise the plan to match')
  expect(skill?.content).toContain('private user visual references')
  expect(skill?.content).toContain('Before the final conversation checkpoint')
  expect(skill?.content).toContain('well-designed HTML Awakening Plan artifact')
  expect(skill?.content).toContain('loading hivemind-artifact-production')
  expect(skill?.content).toContain('Inspect the rendered HTML')
  expect(skill?.content).toContain('exact saved HTML artifact ID in reference')
  expect(skill?.content).toContain('existing relevant research playbook')
  expect(skill?.content).toContain('ordinary later work can have zero new assignments')
  expect(skill?.content).toContain('inspect actual pixels')
  dispose()
  expect(await registry.get(companyAwakeningSkill.name)).toBeUndefined()
})


it('mounts awakening guidance through a disposable native skill contribution', () => {
  const remove = vi.fn()
  let dispose: (() => void) | undefined
  const register = vi.fn(() => remove)
  const scope = { skills: { register }, effect: (effect: () => () => void) => { dispose = effect() } }
  const ctx = { inject: (names: string[], callback: (value: unknown) => void) => {
    expect(names).toEqual(['skills'])
    callback(scope)
  } } as unknown as Context
  installCompanyAwakeningGuidance(ctx)
  expect(register).toHaveBeenCalledWith(companyAwakeningSkill)
  dispose?.()
  expect(remove).toHaveBeenCalledOnce()
})
