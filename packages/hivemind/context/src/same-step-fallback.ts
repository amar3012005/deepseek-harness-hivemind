/** Bounded independent-route recovery at the native durable model-step boundary. */
import type { Context } from '@deepseek-ai/cordis'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import type {} from '@deepseek-ai/dsh-session-projection'

/** Explicit platform-owned route; disabled unless a route is configured. */
export interface SameStepFallbackConfig {
  /** Only requests on this primary provider may use the independent route. */
  fromProvider: string
  /** Independently authorized provider; must differ from the primary. */
  provider: string
  /** Model verified to support this provider's text and tool protocol. */
  model: string
  /** Bound output reservation on the recovery route independently of the primary. */
  maxTokens?: number
}

export interface LlmFallbackEventData {
  turn: number
  step: number
  primary: LlmCallConfig
  fallback: LlmCallConfig
  failureCode: string
}

type State = LlmFallbackEventData | null
const callSchema = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string().optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
  stop: z.array(z.string()).optional(),
}).strict()
const stateSchema = z.object({
  turn: z.number().int(),
  step: z.number().int(),
  primary: callSchema,
  fallback: callSchema,
  failureCode: z.string(),
}).strict().nullable() as unknown as z.ZodType<State>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Last fallback checkpoint, retained so a cold-restored next step returns to primary. */
    llmStepFallback: State
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable record of the independently routed retry for one failed native step. */
    'llm/fallback': LlmFallbackEventData
  }
}

const ELIGIBLE = new Set(['QUOTA', 'RATE_LIMIT', 'SERVER', 'NETWORK', 'TRANSPORT', 'TIMEOUT', 'EMPTY_RESPONSE'])

/** Register durable route restoration and the opt-in native failed-step recovery hook. */
export function registerSameStepFallback(
  ctx: Context,
  config: SameStepFallbackConfig | readonly SameStepFallbackConfig[] | undefined,
): void {
  ctx.sessionProjections.register({
    key: 'llmStepFallback',
    stateVersion: 1,
    stateSchema,
    init: () => null,
    apply: (state, event) => {
      if ((event.type as string) === 'model/selection') return null
      return event.type === 'llm/fallback' ? event.data : state
    },
  })

  // Always restore old checkpoints, including when the operator disables fallback.
  ctx.on('agent/request', async ({ agent, turn, step }, next) => {
    const proposal = await next()
    const state = ctx.sessionProjections.stateOf(agent.session, 'llmStepFallback')
    if (state == null) return proposal
    const wasFallback = proposal.provider === state.fallback.provider && proposal.model === state.fallback.model
    const wasPrimary = proposal.provider === state.primary.provider && proposal.model === state.primary.model
    if (turn === state.turn && step === state.step && (wasPrimary || wasFallback)) return state.fallback
    return wasFallback ? state.primary : proposal
  })

  if (config === undefined) return
  const routes = Array.isArray(config) ? config : [config as SameStepFallbackConfig]
  const primaries = new Set<string>()
  for (const route of routes) {
    if (!route.fromProvider.trim() || !route.provider.trim() || !route.model.trim()
      || route.provider === route.fromProvider || primaries.has(route.fromProvider)
      || (route.maxTokens !== undefined && (!Number.isInteger(route.maxTokens) || route.maxTokens < 1))) {
      throw new Error('hivemind-context: fallback must name a unique primary, distinct authorized provider, model and positive output cap')
    }
    primaries.add(route.fromProvider)
  }

  ctx.on('agent/request-error', async ({ agent, turn, step, provider, failure, signal }, next) => {
    const route = routes.find(candidate => candidate.fromProvider === provider)
    if (signal.aborted || route === undefined || !ELIGIBLE.has(failure.code)) return next()
    const previous = ctx.sessionProjections.stateOf(agent.session, 'llmStepFallback')
    if (previous?.turn === turn && previous.step === step) return next()
    const primary = agent.session.requestHeader()?.config
    if (primary === undefined || primary.provider !== provider) return next()
    const maxTokens = route.maxTokens === undefined
      ? primary.maxTokens
      : Math.min(primary.maxTokens ?? route.maxTokens, route.maxTokens)
    const fallback: LlmCallConfig = {
      provider: route.provider,
      model: route.model,
      ...(maxTokens === undefined ? {} : { maxTokens }),
    }
    agent.session.append('llm/fallback', { turn, step, primary: { ...primary }, fallback, failureCode: failure.code })
    // Session append is write-behind; establish durability before asking the
    // native loop to retry, so a process loss cannot resume this step on primary.
    if (!await ctx.sessions.flush(agent.session)) throw new Error('llm_fallback_persistence_required')
    return { kind: 'retry' }
  }, { prepend: true })
}
