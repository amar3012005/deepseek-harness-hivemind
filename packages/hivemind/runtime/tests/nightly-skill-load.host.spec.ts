import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import HiveMindEmployeeDirectory from '@deepseek-ai/dsh-hivemind-employee-directory'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { installNightlyRoutineGuidance, nightlyActiveTaskContext, nightlyRoutineSkill } from '../src/nightly-routine-guidance.ts'

it('keeps the legacy Nightly phase note aligned with direct authenticated HQ stage loading', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nightly-skill-load-'))
  const ctx = new Context()
  let handle: Awaited<ReturnType<typeof ctx.agents.create>> | undefined
  try {
    await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(AgentRegistry)
    await ctx.plugin(SkillRegistry); await ctx.plugin(JsonlSessionPersistence, { root }); await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(HiveMindEmployeeDirectory); await ctx.plugin(WorkingDirectory)
    provideWorkingDirectoryFixture(ctx)
    installNightlyRoutineGuidance(ctx)
    handle = await ctx.agents.create({ sessionId: SessionId('nightly-skill-load'), meta: { agentPreset: 'hivemind-hq' }, agentOptions: { provider: 'mock', model: 'mock' } })
    const catalog = await ctx.skills.list({ scope: handle.agent })
    expect(catalog.find(skill => skill.name === nightlyRoutineSkill.name)?.description).toBe(nightlyRoutineSkill.description)
    expect(JSON.stringify(catalog)).not.toContain(nightlyRoutineSkill.content)
    const loaded = await ctx.skills.get(nightlyRoutineSkill.name, { scope: handle.agent })
    expect(loaded?.content).toContain('NIGHTLY_REVIEW_REQUEST=')
    expect(loaded?.content).toContain('runtime_support_report')
    expect(loaded?.content).toContain('today’s work')
    const phase = nightlyActiveTaskContext('2030-04-05T00:00:00.000Z')
    expect(phase).toContain('2030-04-05T00:00:00.000Z')
    expect(phase).toContain('loads the complete hivemind-nightly-routine-check body directly')
    expect(phase).toContain('without invoking a duplicate model-facing skill load')
    expect(phase).not.toContain('Load the full instructions through the native skill tool')
  } finally {
    await handle?.dispose()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
