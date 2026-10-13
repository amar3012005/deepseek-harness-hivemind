/** Explicit legacy company-room migration onto the registered platform default. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-settings'

/** Preserve generic native policy and newer choices; migrate authorized historical platform Haiku pins.
 * @param ctx - authenticated company host using native Session and model services.
 * @param agent - existing persistent room; no new room or task is created.
 * @param signal - native admitted turn lifetime.
 * @returns whether the session-local model selection was durably migrated.
 */
export async function migrateLegacyCompanyModel(
  ctx: Context, agent: Agent, signal: AbortSignal, settings?: Pick<Context['settings'], 'describe' | 'replace'>,
): Promise<boolean> {
  signal.throwIfAborted()
  const preset = ctx.sessionProjections.stateOf(agent.session, 'agentPreset')
  if (preset !== 'hivemind-hq' && preset !== 'hivemind-hyperagents' && preset !== 'hivemind-chat') return false
  const intent = currentIntent(ctx, agent)
  if (!intent) return false
  const providers = ctx.llm.listProviders()
  const haiku = isHistoricalPlatformHaiku(intent)
  const state = ctx.sessionProjections.stateOf(agent.session, 'modelSelection')
  const legacy = state?.pending === null && intent.provider === 'openai-codex'
    && !providers.some(provider => provider.id === intent.provider)
  if (!haiku && !legacy) return false
  if (haiku && settings) {
    if (!await resetHistoricalGlobalDefault(settings, signal)) return false
  }
  const configured = ctx.sessionController.currentDefaultModelSelection()
  if (!providers.some(provider => provider.id === configured.provider)) return false
  const resolved = await ctx.llm.resolveCallConfig(configured, signal)
  signal.throwIfAborted()
  if (resolved.provider === intent.provider && resolved.model === intent.model
    && resolved.reasoningEffort === intent.reasoningEffort) return false
  // Re-read durable intent after validation: a newer non-Haiku selection wins.
  const latest = currentIntent(ctx, agent)
  if (!latest || (haiku ? !isHistoricalPlatformHaiku(latest)
    : ctx.sessionProjections.stateOf(agent.session, 'modelSelection')?.pending !== null)) return false
  ctx.sessionController.selectForAdmittedRequest(agent, {
    provider: resolved.provider, model: resolved.model,
    ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
  })
  if (!(await ctx.sessions.flush(agent.session))) throw new Error('company_model_migration_persistence_required')
  return true
}

/** A fallback request header is execution evidence, not the user's selected primary. */
function currentIntent(ctx: Context, agent: Agent): ModelSelection | undefined {
  const state = ctx.sessionProjections.stateOf(agent.session, 'modelSelection')
  if (state?.pending) return state.pending
  const events = agent.session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type === 'model/selection') return event.data
  }
  return agent.session.requestHeader()?.config
}
function isHistoricalPlatformHaiku(selection: ModelSelection): boolean {
  return selection.provider === 'cloudflare-openrouter-streaming'
    && selection.model === 'anthropic/claude-haiku-5.5'
}

/** Reset only the operator-authorized obsolete global override through native CAS. */
async function resetHistoricalGlobalDefault(settings: Pick<Context['settings'], 'describe' | 'replace'>, signal: AbortSignal): Promise<boolean> {
  const namespace = settings.describe().find(section => section.ns === 'agent-default-model')
  if (!namespace) return true
  const base = selectionRecord(namespace.base)
  const user = selectionRecord(namespace.user)
  const value = selectionRecord(namespace.value)
  if (!base || base.provider !== 'cloudflare-workers-ai' || base.model !== '@cf/zai-org/glm-5.3-flash'
    || !user || user.model !== 'anthropic/claude-haiku-5.5'
    || !value || !isHistoricalPlatformHaiku(value)) return true
  signal.throwIfAborted()
  try { await settings.replace('agent-default-model', {}, namespace.revision) }
  catch (error) {
    if (error instanceof Error && error.name === 'SettingsConflictError') return false
    throw error
  }
  signal.throwIfAborted()
  return true
}
function selectionRecord(value: unknown): ModelSelection | undefined {
  if (!value || typeof value !== 'object' || !('provider' in value) || !('model' in value)
    || typeof value.provider !== 'string' || typeof value.model !== 'string') return undefined
  return { provider: value.provider, model: value.model }
}

/** Use the native post-admission pre-step seam before provider lookup. */
export function installLegacyCompanyModelMigration(ctx: Context): void {
  ctx.inject(['sessionController', 'llm', 'sessionProjections', 'sessions'], (scope) => {
    let settings: Context['settings'] | undefined
    scope.inject(['settings'], (settingsScope) => {
      settings = settingsScope.settings
      settingsScope.effect(() => () => { settings = undefined })
    })
    scope.effect(() => scope.on('agent/pre-step', async ({ agent, signal }, next) => {
      const decision = await next()
      if (decision.kind !== 'reject') await migrateLegacyCompanyModel(scope, agent, signal, settings)
      return decision
    }, { global: true }))
  })
}
