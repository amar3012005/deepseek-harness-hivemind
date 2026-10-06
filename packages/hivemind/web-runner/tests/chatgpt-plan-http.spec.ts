/** Opt-in isolated HTTP smoke: fake approval/grant/provider, never public inference. */
import { createServer } from 'node:http'
import { createHmac } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { registerBrainPlan, requestBrainPlan } from '../src/chatgpt-plan.ts'

const core = process.env['HIVE_PLAN_SMOKE_CORE_SOURCE']
describe.skipIf(!core)('Cordis / loopback Core / fixture SSE preview', () => {
  it('registers natively and streams over real HTTP with exact owner and gateway auth', async () => {
    const { serveBrainPlan } = await import(pathToFileURL(`${core}/core/src/chatgpt-plan/brain-broker.js`).href)
    const { storeVerifiedPlanGrant } = await import(pathToFileURL(`${core}/core/src/chatgpt-plan/connections.js`).href)
    const savedEnv = { ...process.env }
    Object.assign(process.env, { CLOUDFLARE_AI_GATEWAY_ENABLED: 'true', CLOUDFLARE_ACCOUNT_ID: 'fixture-account',
      CLOUDFLARE_AI_GATEWAY_ID: 'fixture-gateway', CLOUDFLARE_AI_GATEWAY_TOKEN: 'fixture-gateway-token',
      CLOUDFLARE_AI_GATEWAY_OPENAI_BYOK_ALIAS: 'platform' })
    const env = { HIVE_CHATGPT_PLAN_ENABLED: 'true', HIVE_CHATGPT_PLAN_APPROVED: 'true',
      HIVE_CHATGPT_PLAN_CLIENT_ID: 'fixture-client', HIVE_CHATGPT_PLAN_ENCRYPTION_KEY: 'ab'.repeat(32) }
    const principal = { orgId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222', profile: 'hivemind-chat', variation: 'work' }
    const secret = 'fixture-service-secret-longer-than-thirty-two'
    let row: Record<string, unknown> | undefined
    let upstreamCalls = 0
    let terminalSent = false
    const prisma = {
      userOrganization: { findUnique: async () => ({ isActive: true }) },
      harnessSession: { findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        where.id === 'owned-brain' && where.orgId === principal.orgId && where.userId === principal.userId
          ? { profile: 'hivemind-chat', header: { agentPreset: 'hivemind-chat' } } : null },
      chatgptPlanConnection: { upsert: async ({ create }: { create: Record<string, unknown> }) => {
        row = { id: 'fixture', ...create }; return row
      }, findUnique: async () => row },
    }
    const upstream = createServer((req, res) => {
      upstreamCalls++
      expect(req.url).toBe('/v1/fixture-account/fixture-gateway/openai/responses')
      expect(req.headers['authorization']).toBe('Bearer fixture-user-grant')
      expect(req.headers['cf-aig-authorization']).toBe('Bearer fixture-gateway-token')
      expect(req.headers['cf-aig-byok-alias']).toBeUndefined()
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"type":"response.output_text.delta","delta":"fixture hello"}\r\n\r\n')
      setTimeout(() => {
        terminalSent = true
        res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [
          { type: 'message', content: [{ type: 'output_text', text: 'fixture hello' }] },
          { type: 'function_call', namespace: 'hivemind', call_id: 'fixture-call', name: 'lookup', arguments: '{}' },
        ], usage: { input_tokens: 3, output_tokens: 4 } } })}\r\n\r\n`)
      }, 20)
    })
    const listen = async (server: ReturnType<typeof createServer>): Promise<string> => {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing isolated address')
      return `http://127.0.0.1:${address.port}`
    }
    const upstreamBase = await listen(upstream)
    const broker = createServer(async (req, res) => {
      const token = String(req.headers['authorization']).slice(7)
      const [header, payload, signature] = token.split('.')
      expect(signature).toBe(createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url'))
      const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString())
      expect(claims.sub).toBe(principal.userId); expect(claims.org_id).toBe(principal.orgId)
      await serveBrainPlan({ req, res, prisma, claims, env,
        parseBody: async () => { const parts = []; for await (const part of req) parts.push(part)
          return JSON.parse(Buffer.concat(parts).toString()) },
        jsonResponse: (_res: typeof res, body: unknown, status: number) => {
          res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body))
        }, fetchImpl: async (url: string, init: RequestInit) => {
          expect(url).toBe('https://gateway.ai.cloudflare.com/v1/fixture-account/fixture-gateway/openai/responses')
          return fetch(`${upstreamBase}${new URL(url).pathname}`, init)
        },
      })
    })
    const brokerBase = await listen(broker)
    const ctx = new Context()
    try {
      await storeVerifiedPlanGrant(prisma, principal, { issuer: 'https://auth.openai.com', subject: 'fixture-subject',
        clientId: 'fixture-client', accessToken: 'fixture-user-grant', scopes: ['chatgpt.tokens.use.direct'],
        expiresAt: Date.now() + 60000, models: ['fixture-gpt'] }, env)
      await ctx.plugin(LlmRuntime)
      registerBrainPlan(ctx, false, async () => { throw new Error('disabled adapter called') })
      expect(ctx.llm.listProviders()).toEqual([])
      registerBrainPlan(ctx, true, options => requestBrainPlan(brokerBase, secret, principal, options))
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(ctx.llm.listProviders().map(item => item.id)).toContain('hivemind-chatgpt-plan-brain')
      const options = { provider: 'hivemind-chatgpt-plan-brain', model: 'fixture-gpt', sessionId: 'owned-brain',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture request' }] }],
        tools: [{ name: 'lookup', description: 'fixture tool', parameters: { type: 'object', properties: {} } }],
      } as GenerateOptions
      const chunks: StreamChunk[] = []
      for await (const chunk of ctx.llm.stream(options)) {
        if (chunk.type === 'tool-call-delta') expect(terminalSent).toBe(true)
        chunks.push(chunk)
      }
      expect(chunks.filter(chunk => chunk.type === 'tool-call-delta')).toHaveLength(1)
      expect(chunks).toContainEqual({ type: 'usage', usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } })
      expect(upstreamCalls).toBe(1)
      const denied = await requestBrainPlan(brokerBase, secret, principal, { ...options, sessionId: 'not-owned' })
      expect(denied.status).toBe(403); expect(upstreamCalls).toBe(1)
    } finally {
      await Promise.all([broker, upstream].map(server => new Promise<void>(resolve => server.close(() => resolve()))))
      for (const key of Object.keys(process.env)) if (!(key in savedEnv)) Reflect.deleteProperty(process.env, key)
      Object.assign(process.env, savedEnv)
    }
  })
})
