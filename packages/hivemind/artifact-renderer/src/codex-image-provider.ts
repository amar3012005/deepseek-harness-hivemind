/** Native Codex image bridge with private, replayable per-operation state. */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, realpath, stat, open } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { createInterface } from 'node:readline'
import type { MediaOwner } from './media-admission.ts'
import type { GenerationProvider, GenerationRequest, GeneratedFile } from './generation.ts'

/** Host-only OAuth grant: never returned as tool content or persisted in a session. */
export interface CodexImageAuth { accessToken: string; chatgptAccountId: string; chatgptPlanType: string | null }
/** Server-owned image runtime settings. */
export interface CodexImageConfig {
  command: string
  stateDirectory: string
  model: string
  timeoutMs: number
  auth(signal: AbortSignal): Promise<CodexImageAuth | undefined>
}
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Host-only native image credential resolution; never serialized.
     * @param input - Credential cancellation signal.
     * @mode serial
     */
    'hivemind/codex-image-auth'(input: { signal: AbortSignal }): Promise<CodexImageAuth | undefined>
  }
}
interface State { owner?: MediaOwner; status: 'pending' | 'completed'; threadId?: string; turnId?: string; filename?: string }
const active = new Map<string, { owner: MediaOwner | undefined; run: Promise<GeneratedFile> }>()
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }

/** Small stdio RPC transport; refuses shell, MCP, and approval requests from the image worker. */
class ImageWire {
  private sequence = 0
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  private listeners = new Set<(message: Record<string, unknown>) => void>()
  private readonly process
  private readonly lines
  constructor(config: CodexImageConfig, root: string, private readonly signal: AbortSignal) {
    const command = config.command.endsWith('.js') ? process.execPath : config.command
    const prefix = config.command.endsWith('.js') ? [config.command] : []
    const overrides = ['features.image_generation=true', 'features.shell_tool=false', 'features.unified_exec=false',
      'features.browser_use=false', 'features.computer_use=false', 'web_search="disabled"',
      'features.unbounded_connection_retries=false']
      .flatMap(value => ['-c', value])
    this.process = spawn(command, [...prefix, 'app-server', '--listen', 'stdio://', ...overrides], {
      cwd: root, env: {
        ...(process.env.CODEX_CA_CERTIFICATE ? { CODEX_CA_CERTIFICATE: process.env.CODEX_CA_CERTIFICATE } : {}),
        ...(process.env.SSL_CERT_FILE ? { SSL_CERT_FILE: process.env.SSL_CERT_FILE }
          : existsSync('/etc/ssl/certs/ca-certificates.crt') ? { SSL_CERT_FILE: '/etc/ssl/certs/ca-certificates.crt' } : {}),
        PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, CODEX_HOME: root, LANG: 'C.UTF-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.process.stderr.resume() // Raw provider diagnostics may contain sensitive input; never forward them.
    this.lines = createInterface({ input: this.process.stdout })
    this.lines.on('line', (line) => {
      let value: unknown
      try { value = JSON.parse(line) } catch { return }
      if (!object(value)) return
      if (typeof value.id === 'number' && !value.method) {
        const waiting = this.pending.get(value.id); this.pending.delete(value.id)
        if (waiting) {
          if (value.error) waiting.reject(new Error('Codex image RPC was rejected'))
          else waiting.resolve(value.result)
        }
      } else if (value.method) {
        if (value.id !== undefined) {
          if (value.method === 'account/chatgptAuthTokens/refresh') {
            void config.auth(signal).then(auth => this.send(auth ? { id: value.id, result: auth }
              : { id: value.id, error: { code: -32000, message: 'Image authorization unavailable' } }))
              .catch(() => this.send({ id: value.id, error: { code: -32000, message: 'Image authorization unavailable' } }))
          } else this.send({ id: value.id, error: { code: -32000, message: 'Only native image generation is permitted' } })
        }
        for (const listener of this.listeners) listener(value)
      }
    })
    this.process.once('error', () => this.fail(new Error('Codex image runtime could not start')))
    this.process.once('exit', () => this.fail(new Error('Codex image runtime exited; reconcile this operation before retrying')))
    signal.addEventListener('abort', this.abort, { once: true })
  }
  private abort = () => { this.fail(new Error('Image operation interrupted; reconcile before retrying')); this.close() }
  private fail(error: Error) { for (const listener of this.listeners) listener({ method: 'bridge/closed' }); for (const waiting of this.pending.values()) waiting.reject(error); this.pending.clear() }
  private send(value: unknown) { if (!this.process.stdin.destroyed) this.process.stdin.write(`${JSON.stringify(value)}\n`) }
  async request(method: string, params: unknown): Promise<unknown> {
    this.signal.throwIfAborted()
    const id = ++this.sequence
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.send({ id, method, params }) })
  }
  notify(method: string) { this.send({ method, params: {} }) }
  listen(listener: (message: Record<string, unknown>) => void) {
    this.listeners.add(listener); return () => this.listeners.delete(listener)
  }
  close() {
    this.signal.removeEventListener('abort', this.abort)
    this.lines.close(); this.process.kill('SIGTERM')
    const timer = setTimeout(() => { if (this.process.exitCode === null) this.process.kill('SIGKILL') }, 1500)
    timer.unref()
    this.fail(new Error('Codex image runtime closed'))
  }
}

async function saveState(root: string, state: State): Promise<void> {
  const temp = join(root, 'operation.tmp')
  const file = await open(temp, 'w', 0o600)
  try { await file.writeFile(JSON.stringify(state)); await file.sync() } finally { await file.close() }
  await rename(temp, join(root, 'operation.json'))
  const directory = await open(root, 'r')
  try { await directory.sync() } finally { await directory.close() }
}
async function storedOutput(root: string, filename: string): Promise<GeneratedFile> {
  const path = await realpath(filename)
  const rel = relative(await realpath(root), path)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) throw new Error('Codex image output is outside its private operation directory')
  const info = await stat(path)
  if (!info.isFile() || info.size < 1 || info.size > 30 * 1024 * 1024) throw new Error('Codex image output has an invalid size')
  const data = await readFile(path)
  const png = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const jpeg = data[0] === 255 && data[1] === 216
  const webp = data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP'
  if (!png && !jpeg && !webp) throw new Error('Codex returned an unsupported image format')
  return { data, extension: png ? 'png' : jpeg ? 'jpg' : 'webp', mediaType: png ? 'image/png' : jpeg ? 'image/jpeg' : 'image/webp' }
}

/** Generate through the authenticated native runtime; a saved operation is never blindly restarted. */
export function codexImageProvider(config: CodexImageConfig): GenerationProvider {
  return {
    id: 'codex:gpt-image-2', format: 'image',
    instructions: 'Use a complete brief. Edits use session-owned reference_artifact_ids; no arbitrary paths or remote URLs. Reuse operation_id on recovery.',
    async availability() {
      try { await stat(config.command); return await config.auth(AbortSignal.timeout(15_000)) ? { ready: true }
        : { ready: false, code: 'image_authorization_unavailable', action: 'Connect the configured image account before generating.' } }
      catch { return { ready: false, code: 'image_runtime_unavailable', action: 'The image runtime is unavailable. Try again later.' } }
    },
    async generate(request) {
      if (!request.operationId) throw new Error('Codex image generation requires a durable operation identity')
      if (request.referenceImages?.length) throw new Error('Codex image references must be session-owned artifacts, not remote URLs')
      const root = join(config.stateDirectory, createHash('sha256').update(request.operationId).digest('hex'))
      const prior = active.get(root)
      if (prior) {
        if (JSON.stringify(prior.owner) !== JSON.stringify(request.owner)) throw new Error('Image operation ownership mismatch')
        return prior.run
      }
      const run = runImage(config, root, request)
      active.set(root, { owner: request.owner, run })
      try { return await run } finally { active.delete(root) }
    },
  }
}
async function runImage(config: CodexImageConfig, root: string, request: GenerationRequest): Promise<GeneratedFile> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  let state: State | undefined
  try { state = JSON.parse(await readFile(join(root, 'operation.json'), 'utf8')) as State }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Image operation state cannot be read safely') }
  if (state?.owner && !request.owner) throw new Error('Image operation ownership is required')
  if (state && request.owner && (!state.owner || state.owner.orgId !== request.owner.orgId || state.owner.userId !== request.owner.userId || state.owner.sessionId !== request.owner.sessionId)) throw new Error('Image operation ownership mismatch')
  if (!state && request.reconcileOnly) throw new Error('Previous image submission has no confirmed provider receipt; it was not regenerated')
  if (state?.status === 'completed' && state.filename) return storedOutput(root, state.filename)
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(config.timeoutMs)])
  const auth = await config.auth(signal)
  if (!auth) throw new Error('Image authorization is unavailable')
  const wire = new ImageWire(config, root, signal)
  try {
    await wire.request('initialize', { clientInfo: { name: 'hivemind_image', version: '1.0.0' }, capabilities: { experimentalApi: true } })
    wire.notify('initialized')
    await wire.request('account/login/start', { type: 'chatgptAuthTokens', ...auth })
    if (state) {
      if (state.threadId) {
        const recovered = await wire.request('thread/read', { threadId: state.threadId, includeTurns: true })
        if (object(recovered) && object(recovered.thread) && Array.isArray(recovered.thread.turns)) {
          for (const turn of recovered.thread.turns) {
            if (!object(turn) || turn.id !== state.turnId || !Array.isArray(turn.items)) continue
            for (const item of turn.items) {
              if (object(item) && item.type === 'imageGeneration' && item.status === 'completed' && typeof item.savedPath === 'string') {
                const output = await storedOutput(root, item.savedPath)
                await saveState(root, { ...state, status: 'completed', filename: item.savedPath })
                return output
              }
            }
          }
        }
      }
      throw new Error('Previous image outcome is unknown. This operation was not regenerated; inspect its existing run before starting a new operation.')
    }
    await saveState(root, { ...(request.owner ? { owner: request.owner } : {}), status: 'pending' })
    const thread = await wire.request('thread/start', { cwd: root, model: config.model, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: false,
      baseInstructions: 'You produce exactly one image using image_gen.imagegen. Do not use shell, research, MCP, or other tools. Do not answer with prose in place of generation. Reference paths are authorized inputs. Use the native image tool once.' })
    if (!object(thread) || !object(thread.thread) || typeof thread.thread.id !== 'string') throw new Error('Codex image thread was not accepted')
    state = { ...(request.owner ? { owner: request.owner } : {}), status: 'pending', threadId: thread.thread.id }
    await saveState(root, state)
    let image: Record<string, unknown> | undefined
    let turnError: string | undefined
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    const stop = wire.listen((message) => {
      if (message.method === 'bridge/closed') { finish(); return }
      if (!object(message.params) || message.params.threadId !== state?.threadId) return
      const item = message.params.item
      if (message.method === 'item/completed' && object(item) && item.type === 'imageGeneration') image = item
      if (message.method === 'turn/completed') {
        const turn = message.params.turn
        if (object(turn) && object(turn.error) && typeof turn.error.message === 'string') {
          turnError = turn.error.message.includes('not supported when using Codex with a ChatGPT account')
            ? 'The configured image worker model is not supported by this ChatGPT account. Select a model from the authenticated Codex model catalog.'
            : 'Codex image turn failed before confirmed output; inspect the private provider trace.'
        }
        finish()
      }
    })
    try {
      const paths: string[] = []
      for (const [index, reference] of (request.referenceFiles ?? []).entries()) {
        const path = join(root, `input-${index}.png`)
        await writeFile(path, reference.data, { mode: 0o600 }); paths.push(path)
      }
      const prompt = `${request.content}\n${request.aspectRatio ? `Composition aspect ratio: ${request.aspectRatio}.` : ''}\nUse transparent_background=${request.transparentBackground === true}. ${paths.length ? `Edit the supplied images using referenced_image_paths=${JSON.stringify(paths)}.` : 'Generate a new image.'}`
      const turn = await wire.request('turn/start', { threadId: state.threadId, input: [{ type: 'text', text: prompt }] })
      if (!object(turn) || !object(turn.turn) || typeof turn.turn.id !== 'string') throw new Error('Codex image turn was not accepted')
      state = { ...state, turnId: turn.turn.id }; await saveState(root, state)
      await done
      signal.throwIfAborted()
      if (turnError) throw new Error(turnError)
      if (!image || image.status !== 'completed' || typeof image.savedPath !== 'string' || image.failure) throw new Error('Codex returned no confirmed image output')
      const output = await storedOutput(root, image.savedPath)
      await saveState(root, { ...state, status: 'completed', filename: image.savedPath })
      return output
    } finally { stop() }
  } finally { wire.close() }
}
