/** Gated public Responses adapter. Core owns grants; no OAuth token enters the runner. */
import type { Context } from '@deepseek-ai/cordis'
import { createHmac, randomUUID } from 'node:crypto'
import { LlmAdapter, LlmError, ToolCallId, attributionHeaders } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { HivemindPrincipal } from '@deepseek-ai/dsh-hivemind-execution-scope'

export function planRequest(options: GenerateOptions): Record<string, unknown> {
  if (options.stop !== undefined) throw new LlmError('Plan route does not support stop', 'UNSUPPORTED_OPTION')
  const input: Record<string, unknown>[] = []
  const instructions = options.system ? [options.system] : []
  for (const message of options.messages) {
    if (message.role === 'system') {
      instructions.push(message.content.map((block) => {
        if (block.type !== 'text') throw new LlmError('Plan system context must be text', 'UNSUPPORTED_CONTENT')
        return block.text
      }).join('\n'))
      continue
    }
    const text: string[] = []
    const flushText = (): void => {
      if (!text.length) return
      input.push({ role: message.role, content: text.map(value => ({
        type: message.role === 'assistant' ? 'output_text' : 'input_text', text: value,
      })) })
      text.length = 0
    }
    for (const block of message.content) {
      if (block.type === 'text') text.push(block.text)
      else if (block.type === 'tool-call') {
        flushText()
        input.push({ type: 'function_call', namespace: 'hivemind',
          call_id: String(block.id), name: block.name, arguments: block.arguments })
      }
      else if (block.type === 'tool-result') {
        flushText()
        const output = block.content.map((part) => {
          if (part.type !== 'text') throw new LlmError('Plan tool outputs must be text', 'UNSUPPORTED_CONTENT')
          return part.text
        }).join('\n')
        input.push({ type: 'function_call_output', call_id: String(block.toolCallId), output })
      } else if (block.type !== 'reasoning') {
        throw new LlmError('Initial plan route supports text and function tools only', 'UNSUPPORTED_CONTENT')
      }
    }
    flushText()
  }
  return { model: options.model, input, store: false, stream: true,
    ...(instructions.length ? { instructions: instructions.join('\n\n') } : {}),
    ...(options.tools?.length ? { tools: [{ type: 'namespace', name: 'hivemind',
      description: 'Authorized native HIVEMIND tools, executed by Harness.',
      tools: options.tools.map(tool => ({ type: 'function', name: tool.name,
        description: tool.description, parameters: tool.parameters, strict: false })),
    }] } : {}),
  }
}

/** Parse bounded SSE. Only a completed response exposes executable tool blocks. */
export async function* planChunks(response: Response, signal?: AbortSignal, toolNames?: ReadonlySet<string>): AsyncIterable<StreamChunk> {
  if (!response.ok || !response.body) throw new LlmError(`Plan broker refused (${response.status})`, 'PLAN_BROKER_REFUSED')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let total = 0
  let text = ''
  let opened = false
  let terminal = false
  try {
    while (true) {
      signal?.throwIfAborted()
      const part = await reader.read()
      if (part.done) break
      total += part.value.byteLength
      if (total > 16_000_000) throw new LlmError('Plan response too large', 'PLAN_STREAM_BOUND')
      buffer = (buffer + decoder.decode(part.value, { stream: true })).replace(/\r\n/g, '\n')
      if (buffer.length > 4_000_000) throw new LlmError('Plan event too large', 'PLAN_STREAM_BOUND')
      let end: number
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2)
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (!data || data === '[DONE]') continue
        const event = JSON.parse(data) as { type?: string; delta?: string; response?: Record<string, unknown> }
        if (event.type === 'response.failed' || event.type === 'error' || event.type === 'response.incomplete') {
          throw new LlmError('Plan response did not complete; no tool calls dispatched', 'PLAN_RESPONSE_FAILED')
        }
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
          if (!opened) { opened = true; yield { type: 'block-start', index: 0, blockType: 'text' } }
          text += event.delta
          yield { type: 'text-delta', index: 0, text: event.delta }
        }
        if (event.type === 'response.completed') {
          if (terminal || event.response?.status !== 'completed') throw new LlmError('Invalid plan terminal event', 'PLAN_RESPONSE_FAILED')
          terminal = true

          const output = event.response['output']
          if (!Array.isArray(output)) throw new LlmError('Plan output missing', 'PLAN_RESPONSE_FAILED')
          const finalText = (output as Record<string, unknown>[]).filter(item => item['type'] === 'message')
            .flatMap(item => Array.isArray(item['content']) ? item['content'] as Record<string, unknown>[] : [])
            .filter(part => part['type'] === 'output_text').map(part => String(part['text'] ?? '')).join('')
          if (finalText && finalText !== text) {
            if (!finalText.startsWith(text)) throw new LlmError('Plan text changed after streaming', 'PLAN_RESPONSE_FAILED')
            if (!opened) { opened = true; yield { type: 'block-start', index: 0, blockType: 'text' } }
            yield { type: 'text-delta', index: 0, text: finalText.slice(text.length) }
            text = finalText
          }
          if (opened) yield { type: 'block-end', index: 0, block: { type: 'text', text } }
          let index = opened ? 1 : 0
          const calls = (output as Record<string, unknown>[]).filter(item => item['type'] === 'function_call')
          for (const call of calls) {
            if (call['namespace'] !== 'hivemind' || typeof call['name'] !== 'string'
              || typeof call['call_id'] !== 'string' || typeof call['arguments'] !== 'string'
              || (toolNames && !toolNames.has(call['name']))) {
              throw new LlmError('Plan tool contract invalid', 'PLAN_RESPONSE_FAILED')
            }
          }
          let tools = false
          for (const item of output as Record<string, unknown>[]) {
            if (item['type'] !== 'function_call') continue
            if (item['namespace'] !== 'hivemind' || typeof item['name'] !== 'string'
              || typeof item['call_id'] !== 'string' || typeof item['arguments'] !== 'string') {
              throw new LlmError('Plan tool contract invalid', 'PLAN_RESPONSE_FAILED')
            }
            tools = true
            const id = ToolCallId(item['call_id'])
            yield { type: 'block-start', index, blockType: 'tool-call' }
            yield { type: 'tool-call-delta', index, id, name: item['name'], argumentsDelta: item['arguments'] }
            yield { type: 'block-end', index, block: { type: 'tool-call', id, name: item['name'], arguments: item['arguments'] } }
            index++
          }
          const usage = event.response['usage'] as Record<string, unknown> | undefined
          if (usage && typeof usage['input_tokens'] === 'number' && typeof usage['output_tokens'] === 'number'
            && Number.isFinite(usage['input_tokens']) && Number.isFinite(usage['output_tokens'])
            && usage['input_tokens'] >= 0 && usage['output_tokens'] >= 0) {
            yield { type: 'usage', usage: { inputTokens: usage['input_tokens'], outputTokens: usage['output_tokens'],
              totalTokens: usage['input_tokens'] + usage['output_tokens'] } }
          }
          yield { type: 'finish', reason: tools ? { kind: 'tool-calls' } : { kind: 'stop' } }
          return
        }
      }
    }
    if (!terminal) throw new LlmError('Plan stream ended before completed', 'PLAN_RESPONSE_FAILED')
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export interface BrainPlanConfig { enabled?: boolean }
export class BrainPlanAdapter extends LlmAdapter {
  constructor(private readonly broker: (options: GenerateOptions) => Promise<Response>) { super() }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (!options.sessionId) throw new LlmError('Owned Brain session required', 'PLAN_SESSION_REQUIRED')
    yield* planChunks(await this.broker(options), options.signal, new Set(options.tools?.map(tool => tool.name) ?? []))
  }
}

export function brainBrokerToken(principal: HivemindPrincipal, secret: string): string {
  const encoded = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${encoded({ alg: 'HS256', typ: 'JWT' })}.${encoded({
    iss: 'hivemind-harness-runner', aud: 'hivemind-control-plane-harness-proxy',
    sub: principal.userId, org_id: principal.orgId, profile: principal.profile,
    iat: now, exp: now + 30, jti: randomUUID(),
  })}`
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`
}
export async function requestBrainPlan(base: string, secret: string, principal: HivemindPrincipal,
  options: GenerateOptions, fetchImpl: typeof fetch = fetch): Promise<Response> {
  return fetchImpl(`${base}/internal/v1/harness-chat/core/chatgpt-plan/brain/responses`, {
    method: 'POST', redirect: 'error', ...(options.signal ? { signal: options.signal } : {}),
    headers: { ...attributionHeaders(), authorization: `Bearer ${brainBrokerToken(principal, secret)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: options.sessionId, request: planRequest(options) }),
  })
}

/** Native Cordis service registration, disposed with its plugin scope. */
export function registerBrainPlan(ctx: Context, enabled: boolean,
  broker: (options: GenerateOptions) => Promise<Response>): void {
  if (!enabled) return
  ctx.inject(['llm'], (planCtx) => {
    planCtx.effect(() => planCtx.llm.registerAdapter(['hivemind-chatgpt-plan-brain'], new BrainPlanAdapter(broker)))
  })
}
