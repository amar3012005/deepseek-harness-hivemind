import { describe, expect, it } from 'vitest'
import { BrainPlanAdapter, planChunks, planRequest, requestBrainPlan } from '../src/chatgpt-plan.ts'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

const options = (messages: unknown[]): GenerateOptions => ({ provider: 'hivemind-chatgpt-plan-brain', model: 'test-gpt',
  sessionId: 'owned-brain', messages, system: 'initial', temperature: 1, maxTokens: 100 } as unknown as GenerateOptions)
const event = (value: unknown): string => `data: ${JSON.stringify(value)}\r\n\r\n`
const complete = (output: unknown[]): string => event({ type: 'response.completed', response: { status: 'completed', output } })
const textItem = (text: string): unknown => ({ type: 'message', content: [{ type: 'output_text', text }] })
async function collect(response: Response): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of planChunks(response)) chunks.push(chunk)
  return chunks
}

describe('gated public plan adapter', () => {
  it('preserves system context and mixed text/function order, excludes unsupported options', () => {
    const body = planRequest(options([{ role: 'system', content: [{ type: 'text', text: 'later' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'before' }, { type: 'tool-call', id: 'call-one', name: 'lookup', arguments: '{}' }, { type: 'text', text: 'after' }] }]))
    expect(body.instructions).toBe('initial\n\nlater')
    expect((body.input as { type?: string; content?: unknown }[]).map(item => item.type ?? 'message')).toEqual(['message', 'function_call', 'message'])
    expect(body).not.toHaveProperty('temperature'); expect(body).not.toHaveProperty('max_output_tokens')
    expect(body.store).toBe(false); expect(body.stream).toBe(true)
  })
  it('maps final output even without deltas, tolerates split CRLF', async () => {
    const wire = complete([textItem('hello')]); const split = wire.indexOf('\r') + 1
    const response = new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(wire.slice(0, split)))
      controller.enqueue(new TextEncoder().encode(wire.slice(split))); controller.close()
    } }))
    const chunks = await collect(response)
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'hello' })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })
  it('returns completed namespaced tool calls once; does not dispatch a late failed call', async () => {
    const call = { type: 'function_call', namespace: 'hivemind', call_id: 'call-one', name: 'lookup', arguments: '{}' }
    const success = await collect(new Response(complete([call])))
    expect(success.filter(chunk => chunk.type === 'block-end')).toHaveLength(1)
    expect(success.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    const observed: StreamChunk[] = []
    const failed = new Response(event({ type: 'response.output_item.added', item: call }) + event({ type: 'response.failed' }))
    await expect((async () => { for await (const chunk of planChunks(failed)) observed.push(chunk) })()).rejects.toThrow('did not complete')
    expect(observed.some(chunk => chunk.type === 'tool-call-delta')).toBe(false)
  })
  it('rejects EOF before completion and unsupported media', async () => {
    await expect(collect(new Response(event({ type: 'response.output_text.delta', delta: 'partial' })))).rejects.toThrow('before completed')
    expect(() => planRequest(options([{ role: 'user', content: [{ type: 'image', attachment: {} }] }]))).toThrow('text and function')
  })
  it('sends only verified principal service identity to Core, never user grant', async () => {
    let request: RequestInit | undefined
    await requestBrainPlan('https://control.example', 'fixture-secret-not-a-grant', {
      orgId: 'fixture-org', userId: 'fixture-user', profile: 'hivemind-chat', variation: 'work',
    }, options([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]), async (_url, init) => { request = init; return new Response('') })
    const headers = new Headers(request?.headers)
    const token = headers.get('authorization')!.slice(7)
    const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())
    expect(claims.sub).toBe('fixture-user'); expect(claims.org_id).toBe('fixture-org')
    expect(JSON.parse(String(request?.body))).toHaveProperty('session_id', 'owned-brain')
    expect(headers.has('user-agent')).toBe(true)
  })
  it('missing session prevents even a broker request', async () => {
    let called = false
    const adapter = new BrainPlanAdapter(async () => { called = true; return new Response('') })
    const missing = options([]); delete missing.sessionId
    await expect((async () => { for await (const _ of adapter.stream(missing)) { /* no output */ } })()).rejects.toThrow('Owned Brain')
    expect(called).toBe(false)
  })
})
