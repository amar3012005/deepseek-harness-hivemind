/** Explicit legacy company-room migration onto the registered platform default. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'

/** Preserve generic native model policy and all explicit pending choices.
 * @param ctx - authenticated company host using native Session and model services.
 * @param agent - existing persistent room; no new room or task is created.
 * @param signal - native admitted turn lifetime.
 * @returns whether the session-local model selection was durably migrated.
 */
export async function migrateLegacyCompanyModel(ctx: Context, agent: Agent, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted()
  const preset = ctx.sessionProjections.stateOf(agent.session, 'agentPreset')
  if (preset !== 'hivemind-hq' && preset !== 'hivemind-hyperagents') return false
  const state = ctx.sessionProjections.stateOf(agent.session, 'modelSelection')
  if (state === undefined || state.pending !== null) return false
  const current = agent.session.requestHeader()?.config
  if (current?.provider !== 'openai-codex') return false
  const providers = ctx.llm.listProviders()
  if (providers.some(provider => provider.id === current.provider)) return false
  const configured = ctx.sessionController.currentDefaultModelSelection()
  if (!providers.some(provider => provider.id === configured.provider)) return false
  const resolved = await ctx.llm.resolveCallConfig(configured, signal)
  signal.throwIfAborted()
  // A concurrent explicit choice wins over compatibility repair.
  if (ctx.sessionProjections.stateOf(agent.session, 'modelSelection')?.pending !== null) return false
  ctx.sessionController.selectForAdmittedRequest(agent, {
    provider: resolved.provider, model: resolved.model,
    ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
  })
  if (!(await ctx.sessions.flush(agent.session))) throw new Error('company_model_migration_persistence_required')
  return true
}

/** Use the native post-admission pre-step seam before provider lookup. */
export function installLegacyCompanyModelMigration(ctx: Context): void {
  ctx.inject(['sessionController', 'llm', 'sessionProjections', 'sessions'], (scope) => {
    scope.effect(() => scope.on('agent/pre-step', async ({ agent, signal }, next) => {
      const decision = await next()
      if (decision.kind !== 'reject') await migrateLegacyCompanyModel(scope, agent, signal)
      return decision
    }, { global: true }))
  })
}
