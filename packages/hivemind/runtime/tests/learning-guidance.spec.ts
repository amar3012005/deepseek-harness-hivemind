import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { completionLearningSkill, installCompletionLearningGuidance } from '../src/learning-guidance.ts'
import { submissionReviewSkill } from '../src/review-guidance.ts'

it('discovers completion learning without eagerly loading its method', async () => {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  installCompletionLearningGuidance(ctx)
  const registry = ctx.get('skills')
  if (!registry) throw new Error('skill registry missing')
  const summary = (await registry.list()).find(skill => skill.name === completionLearningSkill.name)
  expect(summary).not.toHaveProperty('content')
  const loaded = await registry.get(completionLearningSkill.name)
  expect(loaded?.content).toContain('task and exact available evidence')
  expect(loaded?.content).toContain('under your own identity')
  expect(loaded?.content).toContain('does not require a new learning')
  expect(loaded?.content).toContain('revise_plan changes a task')
  expect(loaded?.content).toContain('not an approved company revision')
  expect(loaded?.content).toContain('later comparable authorized task')
})

it('reviews method proposals without confusing infrastructure failures or blocking accepted work', () => {
  expect(submissionReviewSkill.content).toContain('provider outage, access failure or platform defect')
  expect(submissionReviewSkill.content).toContain('existing human approval boundary')
  expect(submissionReviewSkill.content).toContain('Do not delay acceptance')
})
