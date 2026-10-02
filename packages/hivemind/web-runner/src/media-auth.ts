/** Host-only Codex grants for native image workers; credentials never enter tool receipts. */
import type {} from '@deepseek-ai/dsh-hivemind-execution-scope'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import { createModels } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { authContextFrom, credentialStoreFrom } from '@deepseek-ai/dsh-llm-pi-ai'
import { codexAccountId } from './live-voice.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Resolve authenticated media coordinates.
     * @param input - Native session identity.
     * @mode serial
     */
    'hivemind/media-owner'(input: { sessionId: string }): Promise<{ orgId: string; userId: string; sessionId: string }>
    /** Resolve an in-memory, refreshable native image grant. Never persist or expose the result.
     * @param input - Cancellation for credential resolution.
     * @mode serial
     */
    'hivemind/codex-image-auth'(input: { signal: AbortSignal }): Promise<{
      accessToken: string
      chatgptAccountId: string
      chatgptPlanType: string | null
    } | undefined>
  }
}
/** Register a host-only credential resolver using the existing protected store. */
export function registerMediaAuth(ctx: Context): void {
  const models = createModels({ credentials: credentialStoreFrom(ctx), authContext: authContextFrom(ctx) })
  models.setProvider(openaiCodexProvider())
  ctx.on('hivemind/media-owner', async ({ sessionId }) => {
    const principal = ctx.hivemindExecutionScope.require()
    if (!await ctx.sessionPersistence.stat(SessionId(sessionId))) throw new Error('Media session is unavailable')
    return { orgId: principal.orgId, userId: principal.userId, sessionId }
  })
  ctx.on('hivemind/codex-image-auth', async ({ signal }) => {
    const grant = await models.getAuth('openai-codex', { signal })
    const accessToken = grant?.auth.apiKey
    return accessToken ? { accessToken, chatgptAccountId: codexAccountId(accessToken), chatgptPlanType: null } : undefined
  })
}
