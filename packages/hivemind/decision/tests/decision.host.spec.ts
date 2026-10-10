import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { HiveMindDecision, OpenRouterDecisionProvider, validateAnswers } from '../src/index.ts'
import type { DecisionProvider, DecisionRequest, EvaluationRequest } from '../src/index.ts'
const choice: DecisionRequest = { input: 'hi', context: 'current conversation', systemPrompt: 'Route by required reasoning complexity.', mode: 'model', choices: [{ id: 'fast', description: 'Simple conversation' }, { id: 'deep', description: 'Complex investigation' }] }
const evaluation: EvaluationRequest = { state: 'hi', questions: { selection: { type: 'choice', instructions: 'Route', criteria: { fast: 'Simple', deep: 'Complex' } } } }
const answer = { model: 'inception/mercury-decide', answers: { selection: { type: 'choice', choice: 'fast', probabilities: { fast: 0.9, deep: 0.1 }, confidence: 0.8 } } }
async function boot(provider?: DecisionProvider, denied = false, timeoutMs = 100) {
  const ctx = new Context()
  await ctx.plugin({ name: 'scope-fixture', apply(scope) { scope.provide('hivemindExecutionScope', { require: vi.fn(() => { if (denied) throw new Error('private details'); return { userId: 'admin', orgId: 'test-company',profile:'hivemind-chat',variation:'harness' } }) }) } })
  const fiber = await ctx.plugin(HiveMindDecision, { ...(provider ? { provider } : {}), timeoutMs })
  return Object.assign(ctx, { dispose: () => fiber.dispose() })
}
describe('native decision service', () => {
  it('uses an authenticated execution scope and returns calibrated choice probabilities', async () => {
    const provider = { evaluate: vi.fn(async () => answer) }, ctx = await boot(provider)
    try { expect(await ctx.hivemindDecision.decide(choice)).toMatchObject({ ok: true, choiceId: 'fast', method: 'model', confidence: 0.8 }); expect(provider.evaluate).toHaveBeenCalledOnce() } finally { await ctx.dispose() }
  })
  it('rejects failed authentication before contacting provider without leaking errors', async () => {
    const provider = { evaluate: vi.fn(async () => answer) }, ctx = await boot(provider, true)
    try { expect(await ctx.hivemindDecision.decide(choice)).toMatchObject({ ok: false, code: 'UNAUTHORIZED' }); expect(provider.evaluate).not.toHaveBeenCalled() } finally { await ctx.dispose() }
  })
  it('keeps provider calls disabled until configured', async () => {
    const ctx = await boot()
    try { expect(await ctx.hivemindDecision.decide(choice)).toMatchObject({ ok: false, code: 'PROVIDER_UNAVAILABLE' }) } finally { await ctx.dispose() }
  })
  it('makes deterministic policy explicit and omits invented confidence', async () => {
    const provider = { evaluate: vi.fn(async () => answer) }, ctx = await boot(provider)
    try {
      const result = await ctx.hivemindDecision.decide({ ...choice, mode: 'policy', choices: [{ id: 'fast', description: 'Fast', priority: 1 }, { id: 'deep', description: 'Deep', priority: 10, eligible: false }] })
      expect(result).toMatchObject({ ok: true, choiceId: 'fast', method: 'policy' }); expect(result).not.toHaveProperty('confidence'); expect(provider.evaluate).not.toHaveBeenCalled()
    } finally { await ctx.dispose() }
  })
  it('rejects duplicate choices and empty eligible sets', async () => {
    const ctx = await boot()
    try {
      expect(await ctx.hivemindDecision.decide({ ...choice, choices: [{ id: 'x', description: 'x' }, { id: 'x', description: 'x' }] })).toMatchObject({ code: 'INVALID_REQUEST' })
      expect(await ctx.hivemindDecision.decide({ ...choice, choices: [{ id: 'x', description: 'x', eligible: false }] })).toMatchObject({ code: 'NO_ELIGIBLE_CHOICE' })
    } finally { await ctx.dispose() }
  })
  it('refuses invented answer keys and unnormalized distributions', async () => {
    expect(() => validateAnswers({ ...answer, answers: { another: answer.answers.selection } }, evaluation)).toThrow()
    expect(() => validateAnswers({ ...answer, answers: { selection: { ...answer.answers.selection, choice: 'unknown' } } }, evaluation)).toThrow()
    const invalid = { ...answer, answers: { selection: { ...answer.answers.selection, probabilities: { fast: 0.9, deep: 0.9 } } } }
    expect(() => validateAnswers(invalid, evaluation)).toThrow()
  })
  it('supports noul and ordered score answers in the same request', () => {
    const request: EvaluationRequest = { state: { message: 'Urgent' }, questions: { urgent: { type: 'noul', instructions: 'Urgent?' }, quality: { type: 'score', instructions: 'Quality?', criteria: ['Low', 'High'] } } }
    expect(validateAnswers({ model: 'inception/mercury-decide', answers: { urgent: { type: 'noul', noul: 0.8 }, quality: { type: 'score', score: 0.75, probabilities: { 0: 0.25, 1: 0.75 }, confidence: 0.5 } } }, request).answers.urgent).toEqual({ type: 'noul', noul: 0.8 })
  })
  it('bounds an uncooperative provider and signals cancellation', async () => {
    let bounded: AbortSignal | undefined
    const ctx = await boot({ evaluate: async (_, signal) => { bounded = signal; return new Promise(() => {}) } }, false, 15)
    try { expect(await ctx.hivemindDecision.decide(choice)).toMatchObject({ ok: false, code: 'TIMEOUT' }); expect(bounded?.aborted).toBe(true) } finally { await ctx.dispose() }
  })
  it('honors prior caller cancellation without contacting provider', async () => {
    const provider = { evaluate: vi.fn(async () => answer) }, ctx = await boot(provider)
    const controller = new AbortController(); controller.abort()
    try { expect(await ctx.hivemindDecision.decide(choice, controller.signal)).toMatchObject({ code: 'CANCELLED' }); expect(provider.evaluate).not.toHaveBeenCalled() } finally { await ctx.dispose() }
  })
})
describe('dedicated Decisions HTTP provider', () => {
  it('sends an unwrapped Decisions body through a server-configured Cloudflare custom route', async () => {
    let sent: RequestInit | undefined
    const provider = new OpenRouterDecisionProvider({ endpoint: 'https://gateway.ai.cloudflare.com/v1/account/gateway/custom-openrouter-decisions/api/alpha/decisions', resolveHeaders: async () => ({ authorization: 'Bearer fixture', 'cf-aig-authorization': 'Bearer gateway' }), fetch: vi.fn(async (_, init) => { sent = init; return new Response(JSON.stringify(answer)) }) as typeof fetch })
    await provider.evaluate(evaluation, new AbortController().signal)
    expect(JSON.parse(String(sent?.body))).toEqual({ model: 'inception/mercury-decide', ...evaluation })
    const headers = new Headers(sent?.headers); expect(headers.get('cf-aig-collect-log')).toBe('false'); expect(headers.get('cf-aig-skip-cache')).toBe('true'); expect(sent?.redirect).toBe('error')
  })
  it('refuses unsafe endpoints, redirects and missing credentials', async () => {
    expect(() => new OpenRouterDecisionProvider({ endpoint: 'http://localhost/api/alpha/decisions', resolveHeaders: async () => ({}) })).toThrow()
    const fetcher = vi.fn(), provider = new OpenRouterDecisionProvider({ endpoint: 'https://openrouter.ai/api/alpha/decisions', resolveHeaders: async () => ({}), fetch: fetcher })
    await expect(provider.evaluate(evaluation, new AbortController().signal)).rejects.toThrow('PROVIDER_UNAVAILABLE'); expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('native credential composition', () => {
  it('installs policy-only without credentials and requires references for activation', async () => {
    const { createOpenRouterDecisionPlugin } = await import('../src/plugin.ts')
    expect(() => createOpenRouterDecisionPlugin({ enabled: true })).toThrow()
    const ctx = new Context()
    ctx.provide('hivemindExecutionScope', { require: () => ({ userId: 'u', orgId: 'o',profile:'hivemind-chat',variation:'harness' }) })
    const fiber = await ctx.plugin(createOpenRouterDecisionPlugin())
    try { expect(await ctx.hivemindDecision.decide({ ...choice, mode: 'policy' })).toMatchObject({ ok: true, method: 'policy' }) } finally { await fiber.dispose() }
  })
  it('resolves refreshed native credentials for each request instead of caching secret values', async () => {
    const { createOpenRouterDecisionPlugin } = await import('../src/plugin.ts')
    const ctx = new Context(), authorizations: string[] = []
    let version = 1
    ctx.provide('hivemindExecutionScope', { require: () => ({ userId: 'u', orgId: 'o',profile:'hivemind-chat',variation:'harness' }) })
    ctx.provide('credentials', { resolve: async () => ({ value: `fixture-${version}` }) })
    vi.stubGlobal('fetch', vi.fn(async (_, init: RequestInit) => { authorizations.push(new Headers(init.headers).get('authorization')!); return new Response(JSON.stringify(answer)) }))
    const fiber = await ctx.plugin(createOpenRouterDecisionPlugin({ enabled: true, endpoint: 'https://openrouter.ai/api/alpha/decisions', apiKeyRef: 'OPENROUTER_API_KEY' }))
    try {
      expect(await ctx.hivemindDecision.decide(choice)).toMatchObject({ ok: true }); version = 2
      expect(await ctx.hivemindDecision.decide(choice)).toMatchObject({ ok: true })
      expect(authorizations).toEqual(['Bearer fixture-1', 'Bearer fixture-2'])
    } finally { await fiber.dispose(); vi.unstubAllGlobals() }
  })
  it('returns bounded provider errors without reflecting a secret response body', async () => {
    const provider = new OpenRouterDecisionProvider({ endpoint: 'https://openrouter.ai/api/alpha/decisions', resolveHeaders: async () => ({ authorization: 'Bearer fixture' }), fetch: vi.fn(async () => new Response('private-debug-token', { status: 429 })) as typeof fetch })
    const ctx = await boot(provider)
    try { const result = await ctx.hivemindDecision.decide(choice); expect(result).toMatchObject({ ok: false, code: 'PROVIDER_UNAVAILABLE' }); expect(JSON.stringify(result)).not.toContain('private-debug-token') } finally { await ctx.dispose() }
  })
})

describe('global host authenticated composition', () => {
  it('boots without per-agent identity and refuses calls outside an authenticated dispatch', async () => {
    const { default: ExecutionScope } = await import('../../execution-scope/src/index.ts')
    const { createOpenRouterDecisionPlugin } = await import('../src/plugin.ts')
    const ctx = new Context()
    const scope = await ctx.plugin(ExecutionScope)
    const decision = await ctx.plugin(createOpenRouterDecisionPlugin())
    try {
      expect(ctx.hivemindDecision).toBeDefined()
      expect(await ctx.hivemindDecision.decide({ ...choice, mode: 'policy' })).toMatchObject({ ok: false, code: 'UNAUTHORIZED' })
      expect(await ctx.hivemindExecutionScope.run({ orgId: 'a', userId: 'admin', profile: 'hivemind-chat', variation: 'harness' }, () => ctx.hivemindDecision.decide({ ...choice, mode: 'policy' }))).toMatchObject({ ok: true })
    } finally { await decision.dispose(); await scope.dispose() }
  })
  it('keeps concurrent request principals isolated and does not accept identity from model input', async () => {
    const { default: ExecutionScope } = await import('../../execution-scope/src/index.ts')
    const ctx = new Context(), seen: string[] = []
    const scope = await ctx.plugin(ExecutionScope)
    const decision = await ctx.plugin(HiveMindDecision, { provider: { async evaluate() {
      await new Promise(resolve => setTimeout(resolve, 5))
      const principal = ctx.hivemindExecutionScope.require()
      seen.push(`${principal.orgId}/${principal.userId}`)
      return answer
    } } })
    try {
      const results = await Promise.all(['a', 'b'].map(orgId => ctx.hivemindExecutionScope.run({ orgId, userId: `user-${orgId}`, profile: 'hivemind-chat', variation: 'harness' }, () => ctx.hivemindDecision.evaluate(evaluation))))
      expect(results.every(result => result.ok)).toBe(true)
      expect(seen.sort()).toEqual(['a/user-a', 'b/user-b'])
      expect(await ctx.hivemindDecision.evaluate({ ...evaluation, state: { orgId: 'a', userId: 'user-a' } })).toMatchObject({ ok: false, code: 'UNAUTHORIZED' })
      expect(seen).toHaveLength(2)
    } finally { await decision.dispose(); await scope.dispose() }
  })
})
