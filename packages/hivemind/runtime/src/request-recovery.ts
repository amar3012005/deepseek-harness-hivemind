/** Bounded route recovery at native failed-request boundaries, after llm-retry. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'

export interface RequestFallback { provider: string; model: string }
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'hivemind/request-fallback': { turn: number; step: number; provider: string; model: string; failureCode: string }
  }
}
/** Only known request failures qualify; policy/auth/quota/unknown effects never do. */
export function fallbackEligible(failure: LlmFailure): boolean {
  if ([401, 403, 402, 429].includes(failure.status ?? 0)) return false
  if (/policy|safety|refus|content.filter|auth|permission|quota|billing|credit|cancel|tool_outcome_unknown/i.test(`${failure.code} ${failure.message}`)) return false
  return ['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'PROTOCOL', 'INVALID_TOOL_ARGUMENTS'].includes(failure.code)
}
/** Mount after native finite llm-retry; an explicit configured route is required. */
export function installRequestFallback(ctx: Context, route: RequestFallback | undefined): void {
  if (!route?.provider.trim() || !route.model.trim()) return
  const armed = new WeakMap<Agent, RequestFallback>()
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  ctx.effect(() => ctx.on('agent/request-error', async (payload, next) => {
    const { agent, turn, step, failure, signal } = payload
    if (signal.aborted || lifetime.signal.aborted) return
    if (!fallbackEligible(failure) || agent.session.ownEvents().some(event => event.type === 'hivemind/request-fallback' && event.data.turn === turn)) return next()
    let models
    try { models = await ctx.llm.listModels(route.provider) }
    catch { return next() }
    if (signal.aborted || lifetime.signal.aborted) return
    if (!models.some(model => model.id === route.model)) return next()
    agent.session.append('hivemind/request-fallback', { turn, step, provider: route.provider, model: route.model, failureCode: failure.code })
    if (!(await ctx.sessions.flush(agent.session))) throw new Error('request_fallback_persistence_required')
    if (signal.aborted || lifetime.signal.aborted) return
    armed.set(agent, route)
    return { kind: 'retry' as const }
  }))
  ctx.effect(() => ctx.on('agent/request', async ({ agent }, next) => {
    const request = await next()
    const fallback = armed.get(agent)
    if (!fallback || lifetime.signal.aborted) return request
    armed.delete(agent)
    const { reasoningEffort: _effort, ...rest } = request
    return { ...rest, provider: fallback.provider, model: fallback.model }
  }))
  ctx.effect(() => ctx.on('agent/turn-ended', ({ agent }) => { armed.delete(agent) }))
}
