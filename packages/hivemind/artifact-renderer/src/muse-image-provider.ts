/** Muse's image endpoint, routed exclusively through the deployment's Cloudflare AI Gateway. */
import { loadImage } from '@napi-rs/canvas'
import type { GenerationProvider } from './generation.ts'

export interface MuseBridgeInput {
  signal: AbortSignal
  owner?: { orgId: string; userId: string; sessionId: string }
  payload?: { prompt: string; aspect_ratio: string; references: string[] }
}
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Scoped native Muse transport; gateway credentials remain in Core. @mode serial */
    'hivemind/muse-image'(input: MuseBridgeInput): Promise<unknown>
  }
}
export type MuseBridge = (input: MuseBridgeInput) => Promise<unknown>
/** Secondary provider; selection belongs to the Cordis profile, never model arguments. */
export function museImageProvider(timeoutMs: number, bridge: MuseBridge): GenerationProvider {
  return {
    id: 'openrouter:meta/muse-image', format: 'image',
    instructions: 'Provide the finished image brief and verified visual constraints.',
    async availability() {
      const result = await bridge({ signal: AbortSignal.timeout(10_000) }) as { ready?: boolean } | undefined
      return result?.ready ? { ready: true } : { ready: false, code: 'IMAGE_GATEWAY_UNAVAILABLE', action: 'Enable the authorized Core image gateway bridge.' }
    },
    async generate(request) {
      if (request.reconcileOnly) throw new Error('Muse outcome is unknown; automatic regeneration is disabled')
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
      if (references.some(value => !value.startsWith('data:image/'))) throw new Error('Muse bridge references require authorized native image bytes')
      if (references.length > 4) throw new Error('Muse accepts at most four reference images')
      const aspect = request.aspectRatio ?? 'auto'
      if (!['1:1', '3:2', '2:3', '4:5', '5:4', 'auto'].includes(aspect)) throw new Error('Muse does not support the requested aspect ratio; it was not silently changed')
      const body = await bridge({ signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]),
        ...(request.owner ? { owner: request.owner } : {}),
        payload: { prompt: request.content, aspect_ratio: aspect, references },
      }) as { data?: { b64_json?: string; media_type?: string }[] }
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
