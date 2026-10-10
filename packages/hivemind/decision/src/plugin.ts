/** Profile-friendly composition using native credentials instead of retaining secret values. */
import type { Context, Plugin } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { HiveMindDecision } from './index.ts'
import { OpenRouterDecisionProvider } from './provider.ts'
export interface OpenRouterDecisionPluginConfig {
  /** Explicit activation: defaults to a policy-only service. */
  enabled?: boolean
  endpoint?: string
  apiKeyRef?: string
  gatewayTokenRef?: string
  gatewayByokAlias?: string
  timeoutMs?: number
}
/** Register one host-scoped service. Caller tools never receive credential or endpoint fields. */
export function createOpenRouterDecisionPlugin(config: OpenRouterDecisionPluginConfig = {}): Plugin.Object<void> {
  const apiKeyRef = config.apiKeyRef ? credentialRef(config.apiKeyRef) : undefined
  const gatewayTokenRef = config.gatewayTokenRef ? credentialRef(config.gatewayTokenRef) : undefined
  if (config.enabled && (!config.endpoint || (!apiKeyRef && !gatewayTokenRef))) throw new Error('enabled decision provider requires endpoint and credential references')
  return {
    name: 'hivemind-openrouter-decisions',
    inject: config.enabled ? ['hivemindExecutionScope', 'credentials'] : ['hivemindExecutionScope'],
    async apply(ctx: Context) {
      const provider = config.enabled ? new OpenRouterDecisionProvider({
        endpoint: config.endpoint ?? '',
        async resolveHeaders(signal) {
          if (signal.aborted) return {}
          const headers: Record<string, string> = {}
          if (apiKeyRef) {
            const key = await ctx.credentials.resolve(apiKeyRef)
            if (!key) throw new Error('decision credential unavailable')
            headers.authorization = `Bearer ${key.value}`
          }
          if (gatewayTokenRef) {
            const key = await ctx.credentials.resolve(gatewayTokenRef)
            if (!key) throw new Error('decision gateway credential unavailable')
            headers['cf-aig-authorization'] = `Bearer ${key.value}`
          }
          if (config.gatewayByokAlias) headers['cf-aig-byok-alias'] = config.gatewayByokAlias
          return headers
        },
      }) : undefined
      await ctx.plugin(HiveMindDecision, {
        ...(provider ? { provider } : {}),
        ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
      })
    },
  }
}

export default { name: 'hivemind-decision-provider', apply: async (ctx: Context, config: OpenRouterDecisionPluginConfig) => { await ctx.plugin(createOpenRouterDecisionPlugin(config)) } }
