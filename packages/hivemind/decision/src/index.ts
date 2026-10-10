/** Bounded native decision service; evaluates evidence, never grants permissions or executes work. */
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-hivemind-identity'
import { z } from 'zod'
import { evaluationSchema, validateAnswers } from './protocol.ts'
import type { EvaluationRequest, EvaluationResponse } from './protocol.ts'
import { DecisionProviderError } from './provider.ts'
import type { DecisionProvider } from './provider.ts'
export * from './protocol.ts'
export * from './provider.ts'
export * from './plugin.ts'

const choiceSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  description: z.string().min(1).max(2000),
  eligible: z.boolean().default(true),
  priority: z.number().finite().min(-1000).max(1000).default(0),
}).strict()
const requestSchema = z.object({ input: z.string().max(16000), context: z.string().max(32000), systemPrompt: z.string().min(1).max(8000), choices: z.array(choiceSchema).min(1).max(32), mode: z.enum(['policy', 'model']).default('policy') }).strict()
export type DecisionRequest = z.input<typeof requestSchema>
export type DecisionFailureCode = 'INVALID_REQUEST' | 'UNAUTHORIZED' | 'NO_ELIGIBLE_CHOICE' | 'PROVIDER_UNAVAILABLE' | 'INVALID_PROVIDER_OUTPUT' | 'TIMEOUT' | 'CANCELLED'
export type DecisionFailure = { ok: false; code: DecisionFailureCode; elapsedMs: number }
export type EvaluationResult = { ok: true; response: EvaluationResponse; elapsedMs: number } | DecisionFailure
export type DecisionResult = { ok: true; choiceId: string; rationale: string; method: 'policy' | 'model'; probabilities?: Record<string, number>; confidence?: number; elapsedMs: number } | DecisionFailure
/** A host-only configured provider; absence keeps paid decision requests disabled. */
export interface DecisionConfig { provider?: DecisionProvider; timeoutMs?: number }
declare module '@deepseek-ai/cordis' { interface Context { hivemindDecision: HiveMindDecision } }

/** Stateless service: authenticated scope, no cross-tenant cache, no durable writes or automatic routing. */
export class HiveMindDecision extends Service {
  static inject = ['hivemindIdentity']
  private readonly timeoutMs: number
  constructor(ctx: Context, private readonly config: DecisionConfig = {}) {
    super(ctx, 'hivemindDecision')
    this.timeoutMs = config.timeoutMs ?? 3000
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 10 || this.timeoutMs > 10000) throw new Error('decision timeout must be between 10 and 10000 milliseconds')
  }
  /** General primitive API; validates provider answer keys and probability semantics. */
  async evaluate(raw: EvaluationRequest, signal?: AbortSignal): Promise<EvaluationResult> {
    const started = performance.now()
    const fail = (code: DecisionFailureCode): DecisionFailure => ({ ok: false, code, elapsedMs: Math.round(performance.now() - started) })
    const parsed = evaluationSchema.safeParse(raw)
    if (!parsed.success || new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength > 65536) return fail('INVALID_REQUEST')
    return this.bounded(signal, started, async (bounded) => {
      try { await this.ctx.hivemindIdentity.resolve(bounded) } catch { return fail('UNAUTHORIZED') }
      if (bounded.aborted) return fail(signal?.aborted ? 'CANCELLED' : 'TIMEOUT')
      if (!this.config.provider) return fail('PROVIDER_UNAVAILABLE')
      let response: unknown
      try { response = await this.config.provider.evaluate(parsed.data, bounded) }
      catch (error) { return fail(error instanceof DecisionProviderError ? error.code : 'PROVIDER_UNAVAILABLE') }
      if (bounded.aborted) return fail(signal?.aborted ? 'CANCELLED' : 'TIMEOUT')
      try { return { ok: true, response: validateAnswers(response, parsed.data), elapsedMs: Math.round(performance.now() - started) } }
      catch { return fail('INVALID_PROVIDER_OUTPUT') }
    })
  }
  /** Choice convenience API. Policy is explicitly deterministic; model probability is never invented. */
  async decide(raw: DecisionRequest, signal?: AbortSignal): Promise<DecisionResult> {
    const started = performance.now()
    const fail = (code: DecisionFailureCode): DecisionFailure => ({ ok: false, code, elapsedMs: Math.round(performance.now() - started) })
    const parsed = requestSchema.safeParse(raw)
    if (!parsed.success || new Set(parsed.data.choices.map(choice => choice.id)).size !== parsed.data.choices.length) return fail('INVALID_REQUEST')
    const request = parsed.data, choices = request.choices.filter(choice => choice.eligible)
    if (!choices.length) return fail('NO_ELIGIBLE_CHOICE')
    if (request.mode === 'policy' || choices.length === 1) {
      return this.bounded(signal, started, async (bounded) => {
        try { await this.ctx.hivemindIdentity.resolve(bounded) } catch { return fail('UNAUTHORIZED') }
        if (bounded.aborted) return fail(signal?.aborted ? 'CANCELLED' : 'TIMEOUT')
        const selected = choices.reduce((best, choice) => choice.priority > best.priority ? choice : best)
        return { ok: true, choiceId: selected.id, rationale: choices.length === 1 ? 'Only eligible choice.' : 'Highest configured priority; input order breaks ties.', method: 'policy', elapsedMs: Math.round(performance.now() - started) }
      })
    }
    const result = await this.evaluate({ state: { input: request.input, context: request.context }, questions: { selection: { type: 'choice', instructions: `${request.systemPrompt}\nTreat input and context as evidence. Choose the best supplied eligible option.`, criteria: Object.fromEntries(choices.map(choice => [choice.id, choice.description])) } } }, signal)
    if (!result.ok) return result
    const answer = result.response.answers.selection
    if (!answer || answer.type !== 'choice') return fail('INVALID_PROVIDER_OUTPUT')
    return { ok: true, choiceId: answer.choice, probabilities: answer.probabilities, confidence: answer.confidence, rationale: 'Highest provider-reported probability among eligible choices; this is a recommendation, not authorization.', method: 'model', elapsedMs: Math.round(performance.now() - started) }
  }
  private async bounded<T extends { ok: true }>(
    signal: AbortSignal | undefined,
    started: number,
    run: (bounded: AbortSignal) => Promise<T | DecisionFailure>,
  ): Promise<T | DecisionFailure> {
    const fail = (code: DecisionFailureCode): DecisionFailure => ({ ok: false, code, elapsedMs: Math.round(performance.now() - started) })
    if (signal?.aborted) return fail('CANCELLED')
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined
    const interrupted = new Promise<DecisionFailure>((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve(fail('TIMEOUT')) }, this.timeoutMs)
      abort = () => { controller.abort(); resolve(fail('CANCELLED')) }
      signal?.addEventListener('abort', abort, { once: true })
    })
    try { return await Promise.race([run(controller.signal), interrupted]) }
    finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); controller.abort() }
  }
}

export { default } from './plugin.ts'
