import type {} from '@deepseek-ai/dsh-hivemind-artifact-renderer'
import WebSocket from 'ws'
import type {} from './codex-voice-connection.ts'
/** Runner-owned model routing; credentials remain in the selected isolated worker. */
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { HivemindPrincipal } from '@deepseek-ai/dsh-hivemind-execution-scope'
import {
  bridgeToken,
  connectionBody,
  connectionReply,
  type BridgeAction,
} from './codex-connection-protocol.ts'
import type {} from '@deepseek-ai/dsh-api-session-controller'

export { CloudCodexAdapter, CodexConnections } from './codex-model-client.ts'
export type { CodexConnectionConfig, ConnectionActor } from './codex-model-client.ts'
import { CodexConnections, installSelectedCodexModels, type CodexConnectionConfig, type ConnectionActor } from './codex-model-client.ts'
/** Install only when deployment supplies isolated connections; existing routes remain unchanged otherwise. */
export function installCodexConnections(
  ctx: Context,
  configs: readonly CodexConnectionConfig[],
  options: {
    authorize(req: IncomingMessage, signal: AbortSignal): Promise<ConnectionActor | undefined>
    actor(principal: HivemindPrincipal, signal: AbortSignal): Promise<ConnectionActor>
    origin(req: IncomingMessage): string
  },
): void {
  const connections = new CodexConnections(configs, name => process.env[name])
  const actor = async (): Promise<ConnectionActor> => {
    const principal = ctx.hivemindExecutionScope.require()
    const identity = principal
    return options.actor({ ...principal, orgId: identity.orgId, userId: identity.userId }, AbortSignal.timeout(10000))
  }
  if (configs.length) installSelectedCodexModels(ctx, connections, async () => {
    try { ctx.hivemindExecutionScope.require() } catch { return undefined }
    return actor()
  })
  ctx.on('hivemind/codex-voice-connection', async () => {
    const identity = await actor(), binding = connections.binding(identity)
    if (!binding) return undefined
    const account = await connections.status(identity)
    if (!account.selected_model) return undefined
    if (!account.connected) throw Error('connection_sign_in_required')
    return {
      start: async (input, signal) => {
        const response = await connections.request(identity, 'voice/start', input, signal)
        if (!response.ok) throw Error('Selected ChatGPT voice connection is unavailable; no paid fallback was used')
        const value = await response.json() as { call_id?: unknown; sdp?: unknown }
        if (typeof value.call_id !== 'string' || !/^[\w-]{1,256}$/u.test(value.call_id)
          || typeof value.sdp !== 'string' || value.sdp.length > 100000) throw Error('connection_voice_invalid_receipt')
        return new Response(value.sdp, { headers: { location: `/calls/${value.call_id}` } })
      },
      socket: (callId) => {
        const url = new URL(`${binding.endpoint}/bridge/${binding.sharedService ? `${binding.connectionId}/` : ''}voice/socket`)
        url.protocol = 'wss:'; url.searchParams.set('call_id', callId)
        return new WebSocket(url, { headers: { authorization: `Bearer ${bridgeToken(binding, 'voice/socket')}`,
          origin: new URL(binding.endpoint).origin }, handshakeTimeout: 20000, maxPayload: 1_000_000 })
      },
    }
  })
  ctx.on('hivemind/selected-image-provider', async () => {
    const identity = await actor()
    if (!connections.binding(identity)) return undefined
    const account = await connections.status(identity)
    if (!account.selected_model) return undefined
    if (!account.connected) throw Error('connection_sign_in_required')
    return {
      id: 'codex:user-connection', format: 'image' as const,
      instructions: 'Generate through the selected user ChatGPT connection; reuse operation IDs for reconciliation.',
      availability: async () => ({ ready: true as const }),
      generate: async (request) => {
        if (!request.owner || !request.operationId) throw Error('connection_image_owner_required')
        const response = await connections.request(identity, 'images/generate', {
          operation_id: request.operationId, session_id: request.owner.sessionId,
          content: request.content, title: request.title,
          transparent_background: request.transparentBackground ?? false,
          reconcile_only: request.reconcileOnly ?? false,
          ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
          ...(request.referenceFiles?.length ? {
            reference_files: request.referenceFiles.map(file => Buffer.from(file.data).toString('base64')),
          } : {}),
        }, request.signal)
        if (!response.ok) throw Error('Selected ChatGPT image request failed; no paid fallback was used')
        const value = await response.json() as Record<string, unknown>
        if (value.connection_id !== connections.binding(identity)?.connectionId || value.operation_id !== request.operationId
          || value.media_type !== 'image/png' || value.extension !== 'png' || typeof value.data !== 'string'
          || value.data.length > 34_000_000) throw Error('connection_image_invalid_receipt')
        return { data: Buffer.from(value.data, 'base64'), extension: 'png', mediaType: 'image/png' }
      },
    }
  })
  const actions = ['status', 'models', 'start', 'answer', 'cancel', 'select', 'disconnect'] as const
  for (const action of actions)
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'exact',
          path: `/api/hivemind/model-connection/${action}`,
          handler: async (req, res) => {
            const method = ['status', 'models'].includes(action) ? 'GET' : 'POST'
            if (req.method !== method) {
              connectionReply(res, 405, { error: 'method_not_allowed' })
              return
            }
            if (method === 'POST' && req.headers.origin !== options.origin(req)) {
              connectionReply(res, 403, { error: 'same_origin_required' })
              return
            }
            try {
              const identity = await options.authorize(req, AbortSignal.timeout(10000))
              if (!identity) {
                connectionReply(res, 401, { error: 'authentication_required' })
                return
              }
              if (!connections.binding(identity)) {
                connectionReply(res, 200, { available: false, connected: false })
                return
              }
              const input = method === 'GET' ? undefined : await connectionBody(req, 10000)
              const allowed =
                action === 'start'
                  ? ['consent']
                  : action === 'answer'
                    ? ['attempt_id', 'prompt_id', 'answer']
                    : action === 'cancel'
                      ? ['attempt_id']
                      : action === 'select'
                        ? ['model']
                        : []
              if (input && Object.keys(input).some(key => !allowed.includes(key))) {
                connectionReply(res, 400, { error: 'connection_invalid_request' })
                return
              }
              if (action === 'start' && input?.consent !== true) {
                connectionReply(res, 400, { error: 'cloud_execution_consent_required' })
                return
              }
              const controller = new AbortController(),
                close = (): void => {
                  if (!res.writableEnded) controller.abort()
                }
              res.once('close', close)
              try {
                const accountAction = ['start', 'answer', 'cancel'].includes(action)
                const upstream = await connections.request(
                  identity,
                  accountAction ? (`account/${action}` as BridgeAction) : (action as BridgeAction),
                  accountAction ? { ...input, consent: undefined, session_id: 'session-codex-connection' } : input,
                  controller.signal,
                )
                if (!upstream.body) {
                  connectionReply(res, 503, { error: 'connection_unavailable' })
                  return
                }
                res.writeHead(upstream.status, {
                  'content-type': action === 'start' && upstream.ok ? 'text/event-stream' : 'application/json',
                  'cache-control': 'no-store',
                  'x-accel-buffering': 'no',
                })
                const reader = upstream.body.getReader()
                try {
                  while (true) {
                    const part = await reader.read()
                    if (part.done) break
                    if (res.destroyed) break
                    if (!res.write(part.value))
                      await new Promise<void>((resolve) => {
                        res.once('drain', resolve)
                        res.once('close', resolve)
                      })
                  }
                } finally {
                  await reader.cancel().catch(() => {})
                  reader.releaseLock()
                }
                if (!res.destroyed) res.end()
              } finally {
                res.off('close', close)
              }
            } catch {
              if (!res.headersSent) connectionReply(res, 503, { error: 'connection_unavailable' })
              else res.destroy()
            }
          },
        }),
      `codex-connection:authenticated-${action}`,
    )
}
