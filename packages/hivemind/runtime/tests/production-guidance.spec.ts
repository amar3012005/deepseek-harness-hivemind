import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { installArtifactProductionGuidance, artifactProductionSkill } from '../src/production-guidance.ts'

it('provides only a native summary until production guidance is loaded and disposes it', async () => {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  const registry = ctx.get('skills')!
  let dispose: (() => void) | undefined
  installArtifactProductionGuidance({ inject: (_names: string[], callback: (scope: unknown) => void) => {
    callback({ skills: registry, effect: (effect: () => () => void) => { dispose = effect() } })
  } } as unknown as Context)
  const summary = (await registry.list()).find(skill => skill.name === artifactProductionSkill.name)
  expect(summary).toBeDefined()
  expect(summary).not.toHaveProperty('content')
  const loaded = await registry.get(artifactProductionSkill.name)
  expect(loaded?.content).toContain('current Brand DNA')
  expect(loaded?.content).toContain('provisional style')
  expect(loaded?.content).toContain('actionable even before a future deadline')
  expect(loaded?.content).toContain('not image assembly')
  expect(loaded?.content).toContain('view image pixels')
  expect(loaded?.content).toContain('operation lease and capabilities [artifact]')
  expect(loaded?.content).toContain('not the capability lease')
  expect(loaded?.content).toContain('Do not force artifact production for casual replies')
  dispose?.()
  expect(await registry.get(artifactProductionSkill.name)).toBeUndefined()
})
