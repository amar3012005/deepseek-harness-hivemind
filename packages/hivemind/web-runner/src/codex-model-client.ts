/** Reusable native model client for the user-scoped bridge; no agent loop or OAuth storage. */
import { randomUUID } from 'node:crypto'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { bridgeToken, connectionIdPattern, type CodexBinding, type BridgeAction } from './codex-connection-protocol.ts'
export interface CodexConnectionConfig {
  orgId: string
  userId: string
  connectionId: string
  endpoint: string
  secretEnv: string
  sharedService?: boolean
}
export interface ConnectionStatus {
  available: boolean
  connected: boolean
  models: string[]
  selected_model: string | null
  platform_fallback: false
  capabilities: { text: boolean; image: boolean; voice: boolean }
  usage: { inputTokens: number; outputTokens: number; balance: null; limits: null }
}
export interface ConnectionActor {
  orgId: string
  userId: string
}
export const CODEX_CLOUD_PROVIDER = 'hivemind-codex-cloud'
export class CodexConnections {
  private readonly bindings: (CodexBinding & { sharedService?: boolean })[]
  constructor(
    configs: readonly CodexConnectionConfig[],
    secrets: (name: string) => string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const keys = new Set<string>(),
      ids = new Set<string>()
    this.bindings = configs.map((config) => {
      const endpoint = new URL(config.endpoint),
        secret = secrets(config.secretEnv) ?? ''
      const key = `${config.orgId}:${config.userId}`
      if (
        endpoint.protocol !== 'https:' ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash ||
        Buffer.byteLength(secret) < 32 ||
        !connectionIdPattern.test(config.connectionId) ||
        keys.has(key) ||
        ids.has(config.connectionId) ||
        !/^[0-9a-f-]{36}$/iu.test(config.orgId) ||
        !/^[0-9a-f-]{36}$/iu.test(config.userId)
      )
        throw Error('codex_connection_configuration_invalid')
      keys.add(key)
      ids.add(config.connectionId)
      return { ...config, endpoint: endpoint.href.replace(/\/$/u, ''), secret }
    })
  }
  binding(actor: ConnectionActor): (CodexBinding & { sharedService?: boolean }) | undefined {
    return this.bindings.find(binding => binding.orgId === actor.orgId && binding.userId === actor.userId)
  }
  async request(actor: ConnectionActor, action: BridgeAction, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const binding = this.binding(actor)
    if (!binding) throw new LlmError('No cloud model connection is assigned to this user and workspace.', 'CONNECTION_REQUIRED')
    const timeoutMs = action === 'stream' || action === 'images/generate' || action === 'account/start' ? 180000 : 10000
    return this.fetchImpl(`${binding.endpoint}/bridge/${binding.sharedService ? `${binding.connectionId}/` : ''}${action}`, {
      method: ['status', 'models'].includes(action) ? 'GET' : 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${bridgeToken(binding, action)}`, 'content-type': 'application/json', origin: new URL(binding.endpoint).origin },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    })
  }
  async status(actor: ConnectionActor, signal?: AbortSignal): Promise<ConnectionStatus> {
    const response = await this.request(actor, 'status', undefined, signal)
    if (!response.ok) {
      await response.body?.cancel()
      throw new LlmError('Cloud model connection unavailable. Work is paused.', 'CONNECTION_UNAVAILABLE')
    }
    const input: unknown = await response.json()
    if (!input || typeof input !== 'object') throw Error('connection_invalid_status')
    const value = input as Record<string, unknown>
    if (
      typeof value.connected !== 'boolean' ||
      !Array.isArray(value.models) ||
      (value.models as unknown[]).some(model => typeof model !== 'string') ||
      (value.selected_model !== null && typeof value.selected_model !== 'string') ||
      value.platform_fallback !== false
    )
      throw Error('connection_invalid_status')
    return value as unknown as ConnectionStatus
  }
}
export class CloudCodexAdapter extends LlmAdapter {
  constructor(
    private readonly connections: CodexConnections,
    private readonly actor: () => Promise<ConnectionActor>,
  ) {
    super()
  }
  override providerInfo(provider: string) {
    return { id: provider, name: 'Connected ChatGPT · isolated cloud bridge' }
  }
  override providerRetryPolicy() {
    return { mode: 'normal' as const, maxRetries: 0, retryableCodes: [], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 }
  }
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const actor = await this.actor()
    if (!this.connections.binding(actor)) return []
    const status = await this.connections.status(actor)
    return status.connected ? status.models.map(id => ({ provider, id, name: id, inputModalities: ['text'] as const })) : []
  }
  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const response = await this.connections.request(await this.actor(), 'resolve-model', { model }, signal)
    if (!response.ok) {
      await response.body?.cancel()
      throw new LlmError('Connected model metadata unavailable.', 'CONNECTION_UNAVAILABLE')
    }
    const value = (await response.json()) as LlmResolvedModelInfo
    if (value.id !== model) throw Error('connection_model_identity_invalid')
    return { ...value, provider, inputModalities: ['text'] }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const actor = await this.actor()
    const { signal, ...request } = options
    const response = await this.connections.request(actor, 'stream', { request_id: randomUUID(), request }, signal)
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new LlmError('Connected model unavailable. Work is paused; no paid fallback was used.', 'CONNECTION_UNAVAILABLE')
    }
    const reader = response.body.getReader(),
      decoder = new TextDecoder()
    let pending = '',
      bytes = 0,
      terminals = 0
    try {
      while (true) {
        signal?.throwIfAborted()
        const part = await reader.read()
        if (part.done) break
        bytes += part.value.length
        if (bytes > 16_000_000) throw Error('connection_stream_too_large')
        pending += decoder.decode(part.value, { stream: true })
        if (pending.length > 4_000_000) throw Error('connection_stream_too_large')
        let newline: number
        while ((newline = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, newline)
          pending = pending.slice(newline + 1)
          if (!line) continue
          const input: unknown = JSON.parse(line)
          if (!input || typeof input !== 'object' || !('type' in input)) throw Error('connection_stream_invalid')
          const chunk = input as StreamChunk
          if (
            !['block-start', 'text-delta', 'reasoning-delta', 'tool-call-delta', 'block-end', 'usage', 'finish'].includes(chunk.type) ||
            terminals > 0
          )
            throw Error('connection_stream_invalid')
          if (chunk.type === 'finish') terminals++
          yield chunk
        }
      }
      if (terminals !== 1 || pending.trim())
        throw new LlmError('Connected model result is unconfirmed. It has not been repeated.', 'CONNECTION_UNCONFIRMED')
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
}

/** Mount the same native adapter in any harness with an authenticated execution actor. */
export function installSelectedCodexModels(ctx: import('@deepseek-ai/cordis').Context,
  connections: CodexConnections, actor: () => Promise<ConnectionActor | undefined>): void {
  ctx.inject(['llm'], (scope) => {
    scope.effect(() => scope.llm.registerAdapter([CODEX_CLOUD_PROVIDER], new CloudCodexAdapter(connections, async () => {
      const identity = await actor()
      if (!identity) throw Error('connection_actor_required')
      return identity
    })))
    scope.effect(() => scope.on('agent/request', async (request, next) => {
      const previous = await next(), identity = await actor()
      if (!identity || !connections.binding(identity)) return previous
      const account = await connections.status(identity, request.signal)
      if (!account.selected_model) return previous
      if (!account.connected) throw new LlmError('Reconnect ChatGPT to continue.', 'CONNECTION_REQUIRED')
      return { provider: CODEX_CLOUD_PROVIDER, model: account.selected_model }
    }, { global: true }))
  })
}
