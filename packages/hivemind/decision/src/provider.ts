/** Dedicated Decisions transport: deliberately never uses chat completions or llm.stream. */
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { validateAnswers, type EvaluationRequest } from './protocol.ts'
export interface DecisionProvider { evaluate(request: EvaluationRequest, signal: AbortSignal): Promise<unknown> }
export interface OpenRouterDecisionConfig {
  /** Exact server-managed HTTPS endpoint. No endpoint may be supplied by agent/user input. */
  endpoint: string
  model?: string
  fallbackModel?: string
  primaryTimeoutMs?: number
  /** Resolve native credential references on each call; never retain or log secret headers. */
  resolveHeaders: (signal: AbortSignal) => Promise<HeadersInit>
  fetch?: typeof fetch
}
export class DecisionProviderError extends Error {
  constructor(readonly code: 'PROVIDER_UNAVAILABLE' | 'INVALID_PROVIDER_OUTPUT', readonly status?: number) { super(code) }
}
/** Cloudflare custom-provider route or direct OpenRouter endpoint with explicitly provisioned credentials. */
export class OpenRouterDecisionProvider implements DecisionProvider {
  private readonly endpoint: string
  private readonly primaryTimeoutMs: number
  constructor(private readonly config: OpenRouterDecisionConfig) {
    const url = new URL(config.endpoint)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['/api/alpha/decisions', '/api/v1/systemone'].some(path => url.pathname.endsWith(path))) throw new Error('decision endpoint must be an HTTPS Decisions endpoint')
    this.endpoint = url.href
    this.primaryTimeoutMs = config.primaryTimeoutMs ?? 0
    if (config.fallbackModel && (!Number.isInteger(this.primaryTimeoutMs) || this.primaryTimeoutMs < 10 || this.primaryTimeoutMs > 10000)) throw new Error('fallback requires bounded primaryTimeoutMs')
    for (const model of [config.model, config.fallbackModel]) {
      if (model && !['inception/mercury-decide', 'inception/mercury-decide:free', 'typesafe/jev-1.13'].includes(model)) throw new Error('unsupported decision model')
    }
  }
  async evaluate(request: EvaluationRequest, signal: AbortSignal): Promise<unknown> {
    const primary = this.config.model ?? 'inception/mercury-decide'
    const models = [...new Set([primary, ...(this.config.fallbackModel ? [this.config.fallbackModel] : [])])]
    let lastError: unknown
    for (const [index, model] of models.entries()) {
      if (signal.aborted) throw new DecisionProviderError('PROVIDER_UNAVAILABLE')
      // Reserve time for the alternate within the caller's existing total deadline.
      const attemptSignal = models.length > 1 && index === 0
        ? AbortSignal.any([signal, AbortSignal.timeout(this.primaryTimeoutMs)]) : signal
      try {
        const result = await this.evaluateModel(request, attemptSignal, model)
        try { return validateAnswers(result, request) } catch { throw new DecisionProviderError('INVALID_PROVIDER_OUTPUT') }
      } catch (error) {
        lastError = error
        if (signal.aborted) throw error
      }
    }
    throw lastError
  }
  private async evaluateModel(request: EvaluationRequest, signal: AbortSignal, model: string): Promise<unknown> {
    const headers = new Headers(await this.config.resolveHeaders(signal))
    if (signal.aborted) throw new DecisionProviderError('PROVIDER_UNAVAILABLE')
    const bearer = headers.get('authorization'), gateway = headers.get('cf-aig-authorization')
    if ((!bearer || !/^Bearer \S+$/.test(bearer)) && (!gateway || !/^Bearer \S+$/.test(gateway))) throw new DecisionProviderError('PROVIDER_UNAVAILABLE')
    for (const [key, value] of Object.entries(attributionHeaders())) headers.set(key, value)
    headers.set('content-type', 'application/json')
    // Disable gateway body logging/caching; context is private and results are request-specific.
    headers.set('cf-aig-skip-cache', 'true')
    headers.set('cf-aig-collect-log', 'false')
    const response = await (this.config.fetch ?? fetch)(this.endpoint, {
      method: 'POST', headers, body: JSON.stringify({ model, ...request }), redirect: 'error', signal,
    })
    if (!response.ok) { await response.body?.cancel(); throw new DecisionProviderError('PROVIDER_UNAVAILABLE', response.status) }
    if (!response.body) throw new DecisionProviderError('INVALID_PROVIDER_OUTPUT')
    const reader = response.body.getReader(), decoder = new TextDecoder()
    let text = '', bytes = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.length
        if (bytes > 131072) throw new DecisionProviderError('INVALID_PROVIDER_OUTPUT')
        text += decoder.decode(chunk.value, { stream: true })
      }
      text += decoder.decode()
      try { return JSON.parse(text) } catch { throw new DecisionProviderError('INVALID_PROVIDER_OUTPUT') }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  }
}
