/** Higgsfield CLI video provider executed as a cancellable background media job. */
import { spawn } from 'node:child_process'
import type { GenerationProvider, GenerationRequest } from './generation.ts'

export interface HiggsfieldVideoConfig {
  readonly command: string
  readonly model: string
  readonly timeoutMs: number
  readonly maxBytes: number
  readonly resolution: string
}

interface CommandResult { readonly stdout: string; readonly stderr: string; readonly code: number }

function run(command: string, args: readonly string[], cwd: string, signal: AbortSignal, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''; let settled = false
    const finish = (error?: Error, code = -1) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort)
      if (error) reject(error); else resolve({ stdout, stderr, code })
    }
    const append = (current: string, chunk: Buffer) => (current + chunk.toString('utf8')).slice(-2_000_000)
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk as Buffer) })
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk as Buffer) })
    child.once('error', error => finish(error))
    child.once('exit', code => finish(undefined, code ?? -1))
    const abort = () => { child.kill('SIGTERM'); finish(new Error('Video generation cancelled')) }
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(new Error('Video generation timed out')) }, timeoutMs)
    if (signal.aborted) abort()
  })
}

function resultUrls(value: unknown): string[] {
  if (typeof value === 'string') return /^https:\/\//.test(value) ? [value] : []
  if (Array.isArray(value)) return value.flatMap(resultUrls)
  if (typeof value !== 'object' || value === null) return []
  return Object.values(value).flatMap(resultUrls)
}

async function download(url: string, signal: AbortSignal, maxBytes: number): Promise<Uint8Array> {
  const response = await fetch(url, { signal })
  if (!response.ok || !response.body) throw new Error(`Video download HTTP ${response.status}`)
  if (new URL(response.url).protocol !== 'https:') throw new Error('Video provider returned a non-HTTPS result')
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > maxBytes) throw new Error('Generated video exceeds the configured size limit')
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.byteLength
    if (size > maxBytes) { await reader.cancel(); throw new Error('Generated video exceeds the configured size limit') }
    chunks.push(next.value)
  }
  const bytes = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

/** Create the authenticated Higgsfield provider without leaking its CLI schema to the model. */
export function higgsfieldVideoProvider(config: HiggsfieldVideoConfig): GenerationProvider {
  return {
    id: `higgsfield:${config.model}`,
    format: 'video',
    instructions: 'Provide a production-ready motion brief. Optional duration_seconds is 4–15 and aspect_ratio is 16:9, 9:16, or 1:1. A source_artifact_id may reference an image generated earlier in this session.',
    async availability() {
      try {
        const status = await run(config.command, ['account', 'status', '--no-color'], process.cwd(), new AbortController().signal, 10_000)
        return status.code === 0
          ? { ready: true as const }
          : { ready: false as const, code: 'AUTH_REQUIRED', action: 'Run higgsfield auth login on this runtime host, then retry the same media workflow.' }
      } catch {
        return { ready: false as const, code: 'PROVIDER_UNAVAILABLE', action: 'Install the Higgsfield CLI on this runtime host, then retry the same media workflow.' }
      }
    },
    async generate(request: GenerationRequest) {
      const duration = request.durationSeconds ?? 12
      const aspectRatio = request.aspectRatio ?? '16:9'
      const args = ['generate', 'create', config.model, '--prompt', request.content, '--duration', String(duration), '--aspect_ratio', aspectRatio, '--resolution', config.resolution]
      if (request.sourcePath) args.push('--start-image', request.sourcePath)
      args.push('--wait', '--wait-timeout', `${Math.max(1, Math.ceil(config.timeoutMs / 60_000))}m`, '--json', '--no-color')
      const result = await run(config.command, args, request.cwd, request.signal, config.timeoutMs)
      if (result.code !== 0) throw new Error(`Higgsfield video generation failed: ${result.stderr.trim().slice(-500) || `exit ${result.code}`}`)
      let urls: string[] = []
      try { urls = resultUrls(JSON.parse(result.stdout)) } catch { urls = result.stdout.match(/https:\/\/[^\s"']+/g) ?? [] }
      const url = urls.find(candidate => /\.mp4(?:\?|$)/i.test(candidate)) ?? urls[0]
      if (!url) throw new Error('Higgsfield returned no downloadable video URL')
      const data = await download(url, request.signal, config.maxBytes)
      if (data.byteLength < 12 || String.fromCharCode(...data.slice(4, 8)) !== 'ftyp') throw new Error('Higgsfield result is not a valid MP4 file')
      return { data, extension: 'mp4', mediaType: 'video/mp4' }
    },
  }
}
