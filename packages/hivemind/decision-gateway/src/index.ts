/** Fail-open progressive capability selection for HIVE-MIND chat. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-hivemind-execution-scope'
import type {} from '@deepseek-ai/dsh-tools'
import { createHmac, randomUUID } from 'node:crypto'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Informational audit of an advisory HIVE decision. It never changes the
     * reconstructed conversation: readers that do not include this extension
     * may preserve and skip it safely.
     */
    'hivemind/decision': {
      stage: 'capability' | 'composio_selection' | 'hivemind_meta_selection' | 'hivemind_recall_filters'
      mode: 'shadow' | 'active'
      status: 'selected' | 'defer'
      selected?: string
      source?: string
      reason?: string
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    hivemindDecisionGateway: HivemindDecisionGateway
  }
}

export const name = 'hivemind-decision-gateway'
export const inject = ['tools', 'hivemindExecutionScope']

export interface Config {
  /** Rollout mode: off does no work, shadow records, and active narrows tools. */
  mode: 'off' | 'shadow' | 'active'
  /** Authenticated Core/control-plane origin that owns the decision provider. */
  serviceApiBase: string
  /** Additional trusted HTTP origins used only by local Compose deployments. */
  serviceHttpOrigins: string[]
  /** Environment variable holding the runner-to-Core HMAC signing secret. */
  serviceSecretEnv: string
  /** Complete deadline for the advisory decision request. */
  timeoutMs: number
}

export const Config: z<Config> = z.object({
  mode: z.union(['off', 'shadow', 'active'] as const).default('off'),
  serviceApiBase: z.string().required(),
  serviceHttpOrigins: z.array(String).default([]),
  serviceSecretEnv: z.string().default('HIVE_HARNESS_RUNNER_SERVICE_SECRET'),
  timeoutMs: z.natural().min(1).max(10_000).default(4_500),
})

interface DecisionResponse {
  status: 'selected' | 'defer'
  mode?: string
  selected?: string | null
  authoritative?: boolean
  receipt?: { source?: string; reason?: string }
  reason?: string
}

export interface DecisionStageInput {
  readonly stage: 'capability' | 'composio_selection' | 'hivemind_meta_selection' | 'hivemind_recall_filters'
  readonly userQuery: string
  readonly turn: number
  readonly context?: unknown
  readonly observation?: unknown
  readonly appMentions?: readonly string[]
  readonly operationalAppIntent?: boolean
  readonly discovery?: unknown
  readonly progress?: unknown
}

const TOOL_BY_CAPABILITY: Readonly<Record<string, readonly string[]>> = Object.freeze({
  direct_answer: [],
  hivemind_context: [],
  hivemind_meta: ['hivemind_meta'],
  hivemind_profile_update: ['hivemind_update_profile'],
  hivemind_save: ['hivemind_save_memory', 'hivemind_batch_save_memories'],
  composio_search: ['hivemind_connected_task'],
})

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function allowedServiceBase(value: string, allowedOrigins: readonly string[]): URL {
  const url = new URL(value)
  const loopback = (url.protocol === 'http:' || url.protocol === 'https:')
    && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
  const compose = url.protocol === 'http:'
    && (url.hostname === 'control-plane' || url.hostname === 'hivemind-control-plane')
  const allowlisted = allowedOrigins.some((origin) => {
    try { return new URL(origin).origin === url.origin } catch { return false }
  })
  if (url.protocol !== 'https:' && !loopback && !compose && !allowlisted) {
    throw new Error('decision service origin must use HTTPS, loopback, or an allowlisted Compose origin')
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('decision service base must contain only an origin')
  }
  return new URL(url.origin)
}

function serviceToken(ctx: Context, config: Config): string {
  const principal = ctx.hivemindExecutionScope.require()
  const secret = process.env[config.serviceSecretEnv]
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error(`decision service secret ${config.serviceSecretEnv} is unavailable or too short`)
  }
  const now = Math.floor(Date.now() / 1000)
  const claims = {
    iss: 'hivemind-harness-runner', aud: 'hivemind-control-plane-harness-proxy',
    sub: principal.userId, org_id: principal.orgId, profile: principal.profile,
    ...(principal.projectId === undefined ? {} : { project_id: principal.projectId }),
    iat: now, exp: now + 30, jti: randomUUID(),
  }
  const input = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url(claims)}`
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`
}

function visibleUserText(messages: readonly UserMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.source?.kind !== 'user') continue
    const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()
    if (text !== '') return text.slice(0, 4000)
  }
  return ''
}

async function decide(ctx: Context, config: Config, input: DecisionStageInput, signal: AbortSignal): Promise<DecisionResponse> {
  const target = new URL('/internal/v1/harness-chat/core/decision', allowedServiceBase(config.serviceApiBase, config.serviceHttpOrigins))
  const response = await fetch(target, {
    method: 'POST',
    headers: { accept: 'application/json', authorization: `Bearer ${serviceToken(ctx, config)}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      runtime: 'harness', stage: input.stage, turn_id: input.turn, user_query: input.userQuery,
      ...(input.context === undefined ? {} : { context: input.context }),
      ...(input.observation === undefined ? {} : { observation: input.observation }),
      ...(input.appMentions === undefined ? {} : { app_mentions: input.appMentions }),
      ...(input.operationalAppIntent === undefined ? {} : { operational_app_intent: input.operationalAppIntent }),
      ...(input.discovery === undefined ? {} : { discovery: input.discovery }),
      ...(input.progress === undefined ? {} : { progress: input.progress }),
    }),
    redirect: 'manual',
    signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
  })
  if (!response.ok || response.status >= 300) throw new Error(`decision service returned ${response.status}`)
  const value: unknown = await response.json()
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('decision response invalid')
  const result = value as Partial<DecisionResponse>
  if (result.status !== 'selected' && result.status !== 'defer') throw new Error('decision status invalid')
  return result as DecisionResponse
}

/** Shared, fail-open decision client available to later progressive stages. */
export class HivemindDecisionGateway {
  constructor(private readonly ctx: Context, private readonly config: Config) {}

  async choose(input: DecisionStageInput, signal: AbortSignal): Promise<DecisionResponse> {
    if (this.config.mode === 'off') return { status: 'defer', mode: 'off', reason: 'decision gateway disabled' }
    return decide(this.ctx, this.config, input, signal)
  }
}

export function appendDecision(agent: Agent, config: Config, stage: DecisionStageInput['stage'], response: DecisionResponse): void {
  if (config.mode === 'off') return
  agent.session.append('hivemind/decision', {
    stage, mode: config.mode,
    status: response.status,
    ...(typeof response.selected === 'string' ? { selected: response.selected } : {}),
    ...(typeof response.receipt?.source === 'string' ? { source: response.receipt.source.slice(0, 80) } : {}),
    ...(typeof (response.reason ?? response.receipt?.reason) === 'string'
      ? { reason: String(response.reason ?? response.receipt?.reason).slice(0, 240) } : {}),
  }, { ignorable: true })
}

/** Mount the first-step decision consumer. The current Harness path is fallback. */
export function apply(ctx: Context, config: Config): void {
  const gateway = new HivemindDecisionGateway(ctx, config)
  if (typeof ctx.provide === 'function') ctx.effect(() => ctx.provide('hivemindDecisionGateway', gateway))
  if (config.mode === 'off') return
  const restrictions = new WeakMap<Agent, () => void>()
  ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    const previous = restrictions.get(payload.agent)
    if (previous !== undefined) {
      previous()
      restrictions.delete(payload.agent)
    }
    if (decision.kind !== 'enter') return decision
    const query = visibleUserText(decision.messages)
    if (query === '') return decision
    try {
      const response = await gateway.choose({ stage: 'capability', userQuery: query, turn: payload.turn }, payload.signal)
      appendDecision(payload.agent, config, 'capability', response)
      if (config.mode !== 'active' || response.status !== 'selected' || response.authoritative !== true
        || typeof response.selected !== 'string') return decision
      const allow = TOOL_BY_CAPABILITY[response.selected]
      if (allow === undefined || allow.some(tool => payload.agent.ctx.tools.get(tool, payload.agent) === undefined)) return decision
      restrictions.set(payload.agent, payload.agent.ctx.tools.restrict({ allow }))
    } catch (error: unknown) {
      appendDecision(payload.agent, config, 'capability', {
        status: 'defer',
        reason: error instanceof Error ? error.message : 'decision gateway unavailable',
      })
    }
    return decision
  }))
}
