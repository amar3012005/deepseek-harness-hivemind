import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { installArtifactProductionGuidance, artifactProductionSkill, imageGenerationSkill } from '../src/production-guidance.ts'

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
  expect(loaded?.content).toContain('use returned page counts and inspect all task-relevant pages and sections')
  expect(loaded?.content).toContain('Citations or source IDs in prose alone do not admit colleague access')
  expect(loaded?.content).toContain('recover and share it rather than asking the human or producer to reupload it')
  const image = await registry.get(imageGenerationSkill.name)
  expect(image?.content).toContain('fallback_from_operation')
  expect(image?.content).toContain('actual saved pixels')
  dispose?.()
  expect(await registry.get(imageGenerationSkill.name)).toBeUndefined()
  expect(await registry.get(artifactProductionSkill.name)).toBeUndefined()
})

it('defaults substantial delegated work to HTML while preserving explicit formats and saved context', () => {
  expect(artifactProductionSkill.content).toContain('delegated investor narratives, research reports and checklists')
  expect(artifactProductionSkill.content).toContain('default to a saved HTML artifact')
  expect(artifactProductionSkill.content).toContain('only when the human explicitly requests that format')
  expect(artifactProductionSkill.content).toContain('recorded explicit final-format requirement and Runtime review')
  expect(artifactProductionSkill.content).toContain('format web and complete self-contained HTML')
  expect(artifactProductionSkill.content).not.toContain('concrete delivery requirement justifies it')
  expect(artifactProductionSkill.content).toContain('native Team task description and observable acceptance criteria')
  expect(artifactProductionSkill.content).toContain('recall the relevant private handoff')
  expect(artifactProductionSkill.content).toContain('do not reconstruct identifiers or regenerate accepted work')
})
