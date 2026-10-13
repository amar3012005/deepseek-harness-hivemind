import { afterEach, expect, it } from 'vitest'
import type { JsonSchemaResponseFormat } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

afterEach(closeMockServers)

const schema: JsonSchemaResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'policy_review', strict: true,
    description: 'A structured policy review.',
    schema: { type: 'object', additionalProperties: false, properties: { accepted: { type: 'boolean' } }, required: ['accepted'] },
  },
}

it('sends strict JSON Schema in the Chat Completions response_format for the GLM route', async () => {
  const server = await mockServer([{ events: textEvents }])
  const adapter = new PiAiAdapter({
    profiles: () => resolveProfiles({ 'local-gateway': {
      baseURL: server.url, api: 'openai-completions', apiKeyEnv: 'PI_TEST_KEY',
      models: [{ id: '@cf/zai-org/glm-5.3-flash', input: ['text'], contextWindow: 8192, maxTokens: 1024 }],
    } }),
    resolveApiKey: async () => 'test-key', auth: memoryAuth(),
  })
  const chunks = []
  for await (const chunk of adapter.stream({ provider: 'local-gateway', model: '@cf/zai-org/glm-5.3-flash',
    messages: [], maxTokens: 128, responseFormat: schema })) chunks.push(chunk)
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  expect(server.requests[0]).toMatchObject({ response_format: schema })
})

it('maps strict JSON Schema to Codex Responses text.format without losing other text fields', async () => {
  const server = await mockServer([{ events: [JSON.stringify({ type: 'response.completed', response: {
    id: 'fictional', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{}', annotations: [] }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  } })] }])
  const token = `test.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fictional-account' } })).toString('base64')}.test`
  const adapter = new PiAiAdapter({
    profiles: () => resolveProfiles({ 'openai-codex': { baseURL: server.url, transport: 'sse', timeoutMs: 1000,
      streamIdleTimeoutMs: 1000, models: [{ id: 'gpt-6-luna', reasoningEfforts: { off: 'none', low: 'low' } }] } }),
    resolveApiKey: async () => undefined,
    auth: memoryAuth({ 'openai-codex': { type: 'oauth', access: token, refresh: 'fixture', expires: Date.now() + 86400000 } }),
  })
  for await (const chunk of adapter.stream({ provider: 'openai-codex', model: 'gpt-6-luna', messages: [], responseFormat: schema })) {
    expect(chunk.type).not.toBe('block-start')
  }
  expect(server.requests[0]).toMatchObject({
    text: { format: { type: 'json_schema', name: 'policy_review', strict: true, schema: schema.json_schema.schema,
      description: schema.json_schema.description } },
  })
})
