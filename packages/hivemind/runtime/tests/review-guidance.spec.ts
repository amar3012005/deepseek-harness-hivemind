import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { installSubmissionReviewGuidance, submissionReviewSkill } from '../src/review-guidance.ts'
it('registers a scoped on-demand native skill and disposes its registry entry', () => {
  let registered: typeof submissionReviewSkill | undefined
  let dispose: (() => void) | undefined
  const remove = vi.fn(() => { registered = undefined })
  const scope = {
    skills: { register: (skill: typeof submissionReviewSkill) => { registered = skill; return remove } },
    effect: (effect: () => () => void) => { dispose = effect() },
  }
  const ctx = { inject: (names: string[], callback: (value: unknown) => void) => {
    expect(names).toEqual(['skills'])
    callback(scope)
  } } as unknown as Context
  installSubmissionReviewGuidance(ctx)
  expect(registered?.name).toBe('runtime-submission-review')
  expect(registered?.description).toContain('Not for greetings')
  expect(registered?.invocation).toEqual({ modelInvocable: true, userInvocable: false })
  expect(registered?.content).toContain('evidence_hash')
  expect(registered?.content).toContain('inspect the actual pixels')
  expect(registered?.content).toContain('inspect rendered pages')
  expect(registered?.content).toContain('inspect representative frames')
  expect(registered?.content).toContain('do not infer unseen content')
  expect(registered?.content).toContain('validated producer attachment references')
  expect(registered?.content).not.toContain('currently exposes saved document text, not universal')
  expect(registered?.content).toContain('Jev\'s action review is optional advisory')
  dispose?.()
  expect(remove).toHaveBeenCalledTimes(1)
  expect(registered).toBeUndefined()
})

it('advertises only a summary until the native registry loads the body', async () => {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  const registry = ctx.get('skills')!
  const dispose = registry.register(submissionReviewSkill)
  const summary = (await registry.list()).find(skill => skill.name === submissionReviewSkill.name)
  expect(summary).toBeDefined()
  expect(summary).not.toHaveProperty('content')
  expect((await registry.get(submissionReviewSkill.name))?.content).toBe(submissionReviewSkill.content)
  dispose()
  expect(await registry.get(submissionReviewSkill.name)).toBeUndefined()
})
