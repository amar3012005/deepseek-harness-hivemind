/** Native Cordis OpenAI search plugin; credentials remain owned by the server. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { createModels } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { authContextFrom, credentialStoreFrom } from '@deepseek-ai/dsh-llm-pi-ai'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-web'
import { OpenAISearchProvider } from './provider.ts'
import { WebError } from '@deepseek-ai/dsh-web'

export { OpenAISearchProvider } from './provider.ts'
export type { OpenAISearchOptions, OpenAISearchRequest } from './provider.ts'

/** Function-plugin identity. */
export const name = 'web-search-openai'
/** Required native provider registry. */
export const inject = ['web']

/** Deployment-owned settings; no per-user connector setup. */
export interface Config {
  /** Credential reference for an externally refreshed SIWC access token. */
  accessTokenEnv?: string
  /** Codex uses the existing llm-pi-ai/openai-codex grant, as in Prime Agent. */
  transport?: 'codex' | 'responses'
  /** Account-supported auxiliary search model. */
  model?: string
  /** Primary deadline, leaving time for the existing HIVE search fallback. */
  timeoutMs?: number
}

/** Native schema validates plugin settings before activation. */
export const Config: z<Config> = z.object({
  accessTokenEnv: z.string().role('credential-ref').default('OPENAI_SEARCH_ACCESS_TOKEN'),
  transport: z.union(['codex', 'responses'] as const).default('codex'),
  model: z.string().default('gpt-6-luna'),
  timeoutMs: z.natural().min(1000).max(30000).default(12000),
})

/** Register one global provider, automatically disposed with its Cordis fiber. */
export function apply(ctx: Context, config: Config): void {
  const ref = credentialRef(config.accessTokenEnv ?? 'OPENAI_SEARCH_ACCESS_TOKEN')
  const transport = config.transport ?? 'codex'
  const models = createModels({ credentials: credentialStoreFrom(ctx), authContext: authContextFrom(ctx) })
  models.setProvider(openaiCodexProvider())
  ctx.web.registerSearchProvider(new OpenAISearchProvider({
    available: () => Boolean(ctx.get('credentials') || (transport === 'responses' && launchEnvironmentOf(ctx).get(ref)?.value)),
    resolveToken: async (signal) => {
      try {
        if (transport === 'codex') {
          const resolved = await models.getAuth('openai-codex', { signal })
          const token = resolved?.auth.apiKey
          if (!token) return undefined
          // Routing metadata only: the upstream service validates the token.
          const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>
          const account = payload['https://api.openai.com/auth'] as Record<string, unknown> | undefined
          const accountId = account?.chatgpt_account_id
          if (typeof accountId !== 'string' || !accountId) throw new Error('account routing unavailable')
          return { token, accountId }
        }
        const stored = await ctx.get('credentials')?.resolve(ref)
        const token = stored?.value ?? launchEnvironmentOf(ctx).get(ref)?.value
        return token ? { token } : undefined
      } catch {
        if (signal.aborted) throw signal.reason
        throw new WebError('HIVEMIND search authorization needs renewal', 'WEB_CREDENTIAL_UNAVAILABLE')
      }
    },
    transport,
    model: config.model ?? 'gpt-6-luna',
    timeoutMs: config.timeoutMs ?? 12000,
    recordRequest: (request) => {
      ctx.get('agents')?.currentInitiator()?.session.append('web/openai-search-request', request)
    },
  }))
}
