/** Bounded independent-route recovery at the native durable model-step boundary. */
import type { Context } from '@deepseek-ai/cordis'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { LlmFallbackEventData } from './types.ts'

/** Explicit platform-owned fallback; disabled unless a route is configured. */
export interface StepFallbackConfig {
  /** Only requests on this primary provider may use the independent route. */
  fromProvider: string
  /** Independently authorized provider; must differ from the primary. */
  provider: string
  /** Model verified to support this provider's text and tool protocol. */
  model: string
  /** Bound output reservation on the recovery route independently of the primary. */
  maxTokens?: number
}
type State = LlmFallbackEventData | null
const call = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string().optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().optional(),
  stop: z.array(z.string()).optional(),
})
const schema = z.object({
  turn: z.number().int(),
  step: z.number().int(),
  primary: call,
  fallback: call,
  failureCode: z.string(),
}).nullable() as unknown as z.ZodType<State>
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Last fallback checkpoint, retained so a cold-restored next step returns to primary. */
    llmStepFallback: State
  }
}
const ELIGIBLE = new Set(['QUOTA','RATE_LIMIT','SERVER','NETWORK','TRANSPORT','TIMEOUT','EMPTY_RESPONSE'])

/**
 * Recover one failed attempt without replaying the loop or completed tools.
 * @param ctx - Native plugin context and projection registry.
 * @param config - Independently authorized route; absent keeps existing retry behavior.
 */
export function registerStepFallback(ctx: Context, config: StepFallbackConfig | readonly StepFallbackConfig[] | undefined): void {
  ctx.sessionProjections.register({ key:'llmStepFallback',stateVersion:1,stateSchema:schema,init:()=>null,
    apply:(state,event)=>{
      // Optional session-controller's durable explicit choice outranks recovery.
      if ((event.type as string)==='model/selection') return null
      return event.type==='llm/fallback' ? event.data : state
    } })
  // Always restore old checkpoints, including when the operator disables fallback.
  ctx.on('agent/request', async ({ agent,turn,step },next) => {
    const proposal = await next()
    const state = ctx.sessionProjections.stateOf(agent.session,'llmStepFallback')
    if (!state) return proposal
    const wasFallback=proposal.provider===state.fallback.provider && proposal.model===state.fallback.model
    const wasPrimary=proposal.provider===state.primary.provider && proposal.model===state.primary.model
    if (turn===state.turn && step===state.step && (wasPrimary || wasFallback)) return state.fallback
    return wasFallback ? state.primary : proposal
  })
  if (!config) return
  const routes = Array.isArray(config) ? config : [config as StepFallbackConfig]
  const primaries = new Set<string>()
  for (const route of routes) {
    if (!route.fromProvider || !route.provider || !route.model || route.provider === route.fromProvider || primaries.has(route.fromProvider)
      || (route.maxTokens !== undefined && (!Number.isInteger(route.maxTokens) || route.maxTokens < 1))) {
      throw new Error('llm-retry: fallback must name a unique primary, distinct authorized provider, model and positive output cap')
    }
    primaries.add(route.fromProvider)
  }
  ctx.on('agent/request-error', async ({ agent,turn,step,provider,failure,signal },next) => {
    const route = routes.find(candidate => candidate.fromProvider === provider)
    if (signal.aborted || !route || !ELIGIBLE.has(failure.code)) return next()
    const previous=ctx.sessionProjections.stateOf(agent.session,'llmStepFallback')
    if (previous?.turn===turn && previous.step===step) return next()
    const primary=agent.session.requestHeader()?.config
    if (!primary || primary.provider!==provider) return next()
    const maxTokens = route.maxTokens === undefined
      ? primary.maxTokens
      : Math.min(primary.maxTokens ?? route.maxTokens, route.maxTokens)
    const fallback:LlmCallConfig={ provider:route.provider,model:route.model,
      ...(maxTokens === undefined ? {} : { maxTokens }) }
    agent.session.append('llm/fallback',{ turn,step,primary:{ ...primary },fallback,failureCode:failure.code })
    // No waiting on the exhausted primary budget and no mutation of selected options.
    return { kind:'retry' }
  }, { prepend:true })
}
