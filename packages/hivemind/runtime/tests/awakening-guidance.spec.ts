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
  expect(skill?.content).toContain('without public search')
  expect(skill?.content).toContain('once per fresh lifecycle')
  expect(skill?.content).toContain('Partial or empty recall does not establish')
  expect(skill?.content).toContain('Match domain, location and company identity')
  expect(skill?.content).toContain('existing relevant research playbook')
  expect(skill?.content).toContain('zero new assignments')
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
