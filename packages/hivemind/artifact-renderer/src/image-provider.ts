/** OpenRouter-compatible image generation using deployment-owned credentials and model selection. */
import type { GenerationProvider } from './generation.ts'

/** Provider failure classification used by the durable media retry policy. */
export class GenerationProviderError extends Error {
  constructor(message: string, readonly code: string, readonly retryable: boolean) { super(message) }
}

/** Configuration shared by OpenRouter and a compatible authenticated gateway. */
export interface ImageProviderConfig {
  readonly baseURL: string
  readonly apiKeyEnv: string
  readonly model: string
  readonly timeoutMs: number
  readonly gatewayByokAlias?: string
}

/** Construct a replaceable image provider without changing the main session model. */
export function openRouterImageProvider(config: ImageProviderConfig): GenerationProvider {
  return {
    id: `openrouter:${config.model}`, format: 'image',
    instructions: 'Provide the finished image brief: audience, composition, exact copy, verified brand colours and visual constraints. Supply reference_images for public brand or product references. Image generation does not verify marketing claims.',
    async generate(request) {
      const apiKey = process.env[config.apiKeyEnv]
      if (!apiKey) throw new Error(`Image generation credential is not configured: ${config.apiKeyEnv}`)
      const response = await fetch(`${config.baseURL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', ...(config.gatewayByokAlias ? { 'cf-aig-byok-alias': config.gatewayByokAlias } : {}) },
        body: JSON.stringify({ model: config.model, stream: false, modalities: ['image', 'text'], messages: [{ role: 'user', content: [{ type: 'text', text: request.content }, ...(request.referenceImages ?? []).map(url => ({ type: 'image_url', image_url: { url } }))] }] }),
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(config.timeoutMs)]),
      })
      if (!response.ok) throw new GenerationProviderError(`Image provider HTTP ${response.status}`, `HTTP_${response.status}`, response.status === 429)
      const body = await response.json() as {
        error?: { code?: number | string }
        choices?: { message?: { images?: { image_url?: { url?: string } }[] } }[]
      }
      if (body.error) {
        const code = String(body.error.code ?? 'unknown')
        throw new GenerationProviderError(`Image provider error ${code}`, code, code === '429' || code === 'rate_limit_exceeded')
      }
      const image = body.choices?.[0]?.message?.images?.[0]?.image_url?.url
      const match = image?.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/)
      if (!match?.[1] || !match[2]) throw new Error('Image provider returned no supported inline image; no artifact was created')
      const data = Buffer.from(match[2], 'base64')
      const kind = match[1]
      if (!data.length) throw new Error('Image provider returned an empty image')
      return { data, extension: kind === 'jpeg' ? 'jpg' : kind, mediaType: `image/${kind}` }
    },
  }
}
