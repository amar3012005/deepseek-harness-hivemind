import { afterEach, describe, expect, it } from 'vitest'
import { codexRequestPayload, preserveOptionalToolArguments, PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

afterEach(closeMockServers)

describe('subscription tool arguments', () => {
  it('preserves optional schemas without mutating the request or native tools', () => {
    const parameters = { type: 'object', required: ['query'], properties: { query: { type: 'string' }, filename: { type: 'string' } } }
    const native = { type: 'web_search' }
    const original = { tools: [{ type: 'function', name: 'recall', parameters, strict: null }, native] }
    expect(preserveOptionalToolArguments(original)).toEqual({ tools: [{ type: 'function', name: 'recall', parameters, strict: false }, native] })
    expect(original.tools[0]).toHaveProperty('strict', null)
    expect(parameters.required).toEqual(['query'])
  })

  it('leaves requests without tools intact', () => {
    expect(preserveOptionalToolArguments(undefined)).toBeUndefined()
    const request = { input: [] }
    expect(preserveOptionalToolArguments(request)).toBe(request)
  })
})


describe('Codex explicit minimal reasoning', () => {
  it('sets none while keeping optional tool arguments and the original payload intact', () => {
    const original = { reasoning: { effort: 'low', summary: 'auto' }, tools: [{ type: 'function', strict: null }] }
    expect(codexRequestPayload(original, { api: 'openai-codex-responses', thinkingLevelMap: { off: 'none' } }, 'off'))
      .toEqual({ reasoning: { effort: 'none' }, tools: [{ type: 'function', strict: false }] })
    expect(original.reasoning.effort).toBe('low')
    expect(original.tools[0]?.strict).toBeNull()
  })
  it.each([undefined, null])('does not force none for an undeclared off mapping %s', (off) => {
    const request = { input: [] }
    expect(codexRequestPayload(request, { api: 'openai-codex-responses', thinkingLevelMap: { off } }, 'off')).toBe(request)
  })
  it('keeps explicit low and other provider protocols unchanged', () => {
    const request = { reasoning: { effort: 'low' } }
    expect(codexRequestPayload(request, { api: 'openai-codex-responses', thinkingLevelMap: { off: 'none' } }, 'low')).toBe(request)
    expect(codexRequestPayload(request, { api: 'openai-completions', thinkingLevelMap: { off: 'none' } }, 'off')).toBe(request)
  })
})


it('emits none and non-strict tools through the actual Codex adapter transport', async () => {
  const server = await mockServer([{ events: [JSON.stringify({ type: 'response.completed', response: { id: 'fictional', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } })] }])
  const token = `test.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fictional-account' } })).toString('base64')}.test`
  const adapter = new PiAiAdapter({
    profiles: () => resolveProfiles({ 'openai-codex': { baseURL: server.url, transport: 'sse', timeoutMs: 1000, streamIdleTimeoutMs: 1000, models: [{ id: 'gpt-6-luna', reasoningEfforts: { off: 'none', low: 'low' } }] } }),
    resolveApiKey: async () => undefined,
    auth: memoryAuth({ 'openai-codex': { type: 'oauth', access: token, refresh: 'fictional', expires: Date.now() + 86400000 } }),
  })
  for await (const chunk of adapter.stream({ provider: 'openai-codex', model: 'gpt-6-luna', reasoningEffort: ReasoningEffortId('off'), messages: [], tools: [{ name: 'read_fixture', description: 'Fictional read', parameters: { type: 'object', properties: { query: { type: 'string' }, optionalFilter: { type: 'string' } }, required: ['query'] } }] })) {
    expect(chunk).not.toMatchObject({ type: 'error' })
    if (chunk.type === 'finish') expect(chunk.reason).toMatchObject({ kind: 'error', failure: { code: 'EMPTY_RESPONSE' } })
  }
  expect(server.requests[0]).toMatchObject({ reasoning: { effort: 'none' }, tools: [{ type: 'function', name: 'read_fixture', strict: false }] })
})
