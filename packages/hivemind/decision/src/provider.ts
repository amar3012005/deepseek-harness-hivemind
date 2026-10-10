/** Dedicated Decisions transport: deliberately never uses chat completions or llm.stream. */
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import type { EvaluationRequest } from './protocol.ts'
export interface DecisionProvider { evaluate(request: EvaluationRequest, signal: AbortSignal): Promise<unknown> }
export interface OpenRouterDecisionConfig {
  /** Exact server-managed HTTPS endpoint. No endpoint may be supplied by agent/user input. */
  endpoint: string
  model?: string
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
  constructor(private readonly config: OpenRouterDecisionConfig) {
    const url = new URL(config.endpoint)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/api/alpha/decisions')) throw new Error('decision endpoint must be an HTTPS alpha Decisions endpoint')
    this.endpoint = url.href
    if (config.model && config.model !== 'inception/mercury-decide') throw new Error('this provider supports inception/mercury-decide only')
  }
  async evaluate(request: EvaluationRequest, signal: AbortSignal): Promise<unknown> {
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
      method: 'POST', headers, body: JSON.stringify({ model: this.config.model ?? 'inception/mercury-decide', ...request }), redirect: 'error', signal,
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
