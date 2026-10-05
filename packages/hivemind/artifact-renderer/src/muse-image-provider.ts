/** Muse's image endpoint, routed exclusively through the deployment's Cloudflare AI Gateway. */
import { loadImage } from '@napi-rs/canvas'
import type { GenerationProvider } from './generation.ts'
import { GenerationProviderError } from './image-provider.ts'

function gateway() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID?.trim()
  const gatewayId = process.env.CLOUDFLARE_AI_GATEWAY_ID?.trim()
  const token = process.env.CLOUDFLARE_AI_GATEWAY_TOKEN?.trim()
  const alias = process.env.CLOUDFLARE_AI_GATEWAY_OPENROUTER_BYOK_ALIAS?.trim()
  const key = process.env.OPENROUTER_API_KEY?.trim()
  if (!account || !gatewayId || !token || (!alias && !key)) return undefined
  return { account, gatewayId, token, alias, key }
}

/** Secondary provider; selection belongs to the Cordis profile, never model arguments. */
export function museImageProvider(timeoutMs: number): GenerationProvider {
  return {
    id: 'openrouter:meta/muse-image', format: 'image',
    instructions: 'Provide the finished image brief and verified visual constraints.',
    async availability() {
      return gateway() ? { ready: true } : {
        ready: false, code: 'IMAGE_GATEWAY_UNAVAILABLE', action: 'Configure the image gateway credentials on the server.',
      }
    },
    async generate(request) {
      if (request.reconcileOnly) throw new Error('Muse outcome is unknown; automatic regeneration is disabled')
      const config = gateway()
      if (!config) throw new Error('Muse Cloudflare AI Gateway credentials are unavailable')
      if (request.transparentBackground) throw new Error('Muse does not support transparent background requests')
      const references = [...(request.referenceImages ?? [])]
      for (const file of request.referenceFiles ?? []) {
        const bytes = Buffer.from(file.data)
        const type = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'png'
          : bytes[0] === 255 && bytes[1] === 216 ? 'jpeg'
            : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'webp' : undefined
        if (!type || bytes.length > 3_000_000) throw new Error('Muse references must be PNG, JPEG or WebP under 3 MB')
        const image = await loadImage(bytes)
        if (image.width * image.height > 40_000_000) throw new Error('Muse reference exceeds pixel budget')
        references.push(`data:image/${type};base64,${bytes.toString('base64')}`)
      }
      if (references.some(value => !value.startsWith('data:image/') && (!value.startsWith('https://') || new URL(value).username || new URL(value).password))) throw new Error('Muse reference URL must be public HTTPS')
      if (references.length > 4) throw new Error('Muse accepts at most four reference images')
      const aspect = request.aspectRatio ?? 'auto'
      if (!['1:1', '3:2', '2:3', '4:5', '5:4', 'auto'].includes(aspect)) throw new Error('Muse does not support the requested aspect ratio; it was not silently changed')
      const ratio = aspect
      const headers: Record<string, string> = {
        'content-type': 'application/json', 'cf-aig-authorization': `Bearer ${config.token}`,
        'cf-aig-skip-cache': 'true', 'HTTP-Referer': 'https://singulancelabs.com', 'X-Title': 'HIVEMIND',
        ...(config.alias ? { 'cf-aig-byok-alias': config.alias } : { authorization: `Bearer ${config.key}` }),
      }
      const url = `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(config.account)}/${encodeURIComponent(config.gatewayId)}/openrouter/images`
      const response = await fetch(url, {
        method: 'POST', headers,
        body: JSON.stringify({ model: 'meta/muse-image', prompt: request.content, n: 1, aspect_ratio: ratio,
          ...(references.length ? { input_references: references.map(url => ({ type: 'image_url', image_url: { url } })) } : {}),
        }),
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]),
      })
      if (!response.ok) throw new GenerationProviderError(`Image gateway HTTP ${response.status}`, `HTTP_${response.status}`, false)
      if (Number(response.headers.get('content-length') ?? 0) > 41_000_000) throw new Error('Muse response exceeds byte budget')
      const chunks: Uint8Array[] = []; let size = 0
      if (!response.body) throw new Error('Muse response body unavailable')
      for await (const chunk of response.body) { size += chunk.byteLength; if (size > 41_000_000) throw new Error('Muse response exceeds byte budget'); chunks.push(chunk) }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { data?: { b64_json?: string; media_type?: string }[] }
      const image = body.data?.[0]
      if (!image?.b64_json || !/^[A-Za-z0-9+/=\r\n]+$/.test(image.b64_json)) throw new Error('Muse returned no confirmed inline image')
      const data = Buffer.from(image.b64_json, 'base64')
      const mediaType = image.media_type ?? 'image/png'
      const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as Record<string, string>)[mediaType]
      if (!extension || !data.length || data.length > 30_000_000) throw new Error('Muse returned an unsupported image')
      const actual = data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
        : data[0] === 255 && data[1] === 216 && data[2] === 255 ? 'image/jpeg'
          : data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : undefined
      if (actual !== mediaType) throw new Error('Muse output media type does not match its bytes')
      const decoded = await loadImage(data)
      if (decoded.width * decoded.height > 40_000_000) throw new Error('Muse output exceeds pixel budget')
      return { data, extension, mediaType }
    },
  }
}
