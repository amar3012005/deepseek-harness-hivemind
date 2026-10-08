import type {} from '@deepseek-ai/dsh-agent-presets'
import { registerPlanConnection } from './chatgpt-plan-connection.ts'
import { registerBrainPlan, requestBrainPlan, requestBrainAccount, requestBrainRoute } from './chatgpt-plan.ts'
/** HIVE-MIND embedded Web authentication and production health routes. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createClient, type RedisClientType } from 'redis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { SessionId } from '@deepseek-ai/dsh-session'
import { authenticatedActorFromSource, principalForActor, type AuthenticatedActor } from '@deepseek-ai/dsh-hivemind-execution-scope'
import { resolveOrganizationAgentAccess, currentTurnActor, referencedSessionIds, admittedVoiceCallRef, admittedUserConfirmationRef, runtimeWitnessServices, withAuthenticatedInitiator, retainAdmittedUserWitness, retainTurnConfirmationRef } from './organization-agent-access.ts'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-api-gateway'
import { registerQuestionRespondents, validateQuestionRoom } from './question-respondent.ts'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { projectHyperagentProfiles } from '@deepseek-ai/dsh-hivemind-employee-directory'
import { registerRunnerDrainStatus } from './runner-drain.ts'
import { principalMembershipActive } from './principal-membership.ts'
import { nativeSessionBinding, nativePrincipalAllowed } from './native-consent.ts'
import { registerMediaAuth } from './media-auth.ts'
import { liveVoicePlugin, type LiveVoiceConfig } from './live-voice.ts'

export const name = 'hivemind-web-runner'
export const inject = ['webServer', 'connection', 'sessionPersistence', 'hivemindExecutionScope', 'agents']

const EXCHANGE_PATH = '/api/hivemind/embed/exchange'
const ESTABLISH_PATH = '/api/hivemind/session/establish'
const BOOT_PATH = '/api/hivemind/boot'
const PROJECTS_PATH = '/api/hivemind/projects'
const EMPLOYEES_PATH = '/api/hivemind/employees'
const HEALTH_PATH = '/health'
const TICKET_NONCE_PREFIX = 'hive:harness-ticket:'
const MAX_BODY_BYTES = 8192
const MAX_TICKET_TTL_SECONDS = 60
const CLOCK_SKEW_SECONDS = 5
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u

let nativeStylesPromise: Promise<string[]> | undefined
function nativeStyles(): Promise<string[]> {
  nativeStylesPromise ??= readFile(join(process.env.HIVEMIND_WEB_DIST || '/opt/deepseek-harness/apps/web/dist', 'index.html'), 'utf8')
    .then(html => [...html.matchAll(/<link\b[^>]*>/gi)]
      .map(([tag]) => tag)
      .filter(tag => /\brel=["']stylesheet["']/i.test(tag))
      .map(tag => tag.match(/\bhref=["']([^"']+)["']/i)?.[1])
      .filter((href): href is string => Boolean(href))
      .map(href => href.replace(/^\.\//, '/')))
    .catch(() => [])
  return nativeStylesPromise
}

export interface Config {
  sharedOrganizationAgents?: boolean
  parentOrigins: string[]
  ticketSecretEnv: string
  redisUrlEnv: string
  redisJtiPrefix: string
  sessionMaxAgeSeconds: number
  /** Control-plane origin for the scoped project catalog. */
  onboardingServiceApiBase?: string
  serviceApiBase: string
  /** Additional HTTP origins allowed only for local/Compose development. */
  serviceHttpOrigins: string[]
  /** Environment variable holding the runner-to-control-plane signing secret. */
  serviceSecretEnv: string
  /** Native voice capability; authorization is resolved on the server. */
  liveVoice: LiveVoiceConfig
  /** Disabled until hosted plan approval, credentials and canary are ready. */
  chatgptPlanBrainEnabled?: boolean
  chatgptPlanFallbackProvider?: string
  chatgptPlanFallbackModel?: string
}

export const Config: z<Config> = z.object({
  sharedOrganizationAgents: z.boolean().default(false),
  parentOrigins: z.array(String).required(),
  ticketSecretEnv: z.string().required(),
  redisUrlEnv: z.string().required(),
  redisJtiPrefix: z.string().required(),
  sessionMaxAgeSeconds: z.natural().min(60).max(86400).required(),
  onboardingServiceApiBase: z.string(),
  serviceApiBase: z.string().required(),
  serviceHttpOrigins: z.array(String).default([]),
  serviceSecretEnv: z.string().required(),
  chatgptPlanBrainEnabled: z.boolean().default(false),
  chatgptPlanFallbackProvider: z.string().default('cloudflare-openrouter-streaming'),
  chatgptPlanFallbackModel: z.string().default('openai/gpt-6-luna'),
  liveVoice: z.object({
    enabled: z.boolean().default(true),
    model: z.string().default('gpt-live-1-codex'),
    voice: z.string().default('cove'),
    timeoutMs: z.natural().min(1000).max(60000).default(25000),
    maxDurationMs: z.natural().min(60000).max(3600000).default(900000),
    maxConnections: z.natural().min(1).max(1000).default(20),
  }).default({ enabled: true, model: 'gpt-live-1-codex', voice: 'cove', timeoutMs: 25000, maxDurationMs: 900000, maxConnections: 20 }),
})

export interface TicketClaims {
  iss: 'hivemind-control-plane'
  aud: 'hivemind-harness-runner'
  sub: string
  org_id: string
  profile: 'hivemind-chat'
  project_id?: string
  native_session_hash?: string
  variation: string
  jti: string
  iat: number
  exp: number
}

function json(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  res.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8', ...headers })
  res.end(JSON.stringify(body))
}

function base64url(value: string): Buffer {
  return Buffer.from(value, 'base64url')
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function ticketHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function equalText(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

class AdmissionError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.code = code
  }
}

/** Verify the compact HMAC ticket and its fixed runner audience. */
export function verifyTicket(token: string, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): TicketClaims {
  if (!TOKEN_PATTERN.test(token)) throw new AdmissionError('invalid_ticket')
  const [encodedHeader, encodedPayload, encodedSignature] = token.split('.') as [string, string, string]
  const expected = createHmac('sha256', secret).update(`${encodedHeader}.${encodedPayload}`).digest()
  const actual = base64url(encodedSignature)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new AdmissionError('invalid_ticket_signature')
  let header: unknown
  let claims: unknown
  try {
    header = JSON.parse(base64url(encodedHeader).toString('utf8'))
    claims = JSON.parse(base64url(encodedPayload).toString('utf8'))
  } catch {
    throw new AdmissionError('invalid_ticket')
  }
  if (typeof header !== 'object' || header === null
    || (header as Record<string, unknown>).alg !== 'HS256'
    || (header as Record<string, unknown>).typ !== 'JWT') {
    throw new AdmissionError('invalid_ticket')
  }
  if (typeof claims !== 'object' || claims === null) throw new AdmissionError('invalid_ticket_claims')
  const value = claims as Record<string, unknown>
  if (value.iss !== 'hivemind-control-plane' || value.aud !== 'hivemind-harness-runner'
    || value.profile !== 'hivemind-chat' || !nonEmpty(value.sub) || !nonEmpty(value.org_id)
    || !nonEmpty(value.variation) || !nonEmpty(value.jti)
    || !Number.isSafeInteger(value.iat) || !Number.isSafeInteger(value.exp)
    || (value.project_id !== undefined && !nonEmpty(value.project_id))) {
    throw new AdmissionError('invalid_ticket_claims')
  }
  try { nativeSessionBinding(value.native_session_hash) } catch { throw new AdmissionError('invalid_ticket_claims') }
  const issuedAt = value.iat as number
  const expiresAt = value.exp as number
  if (issuedAt > nowSeconds + CLOCK_SKEW_SECONDS || expiresAt <= nowSeconds
    || expiresAt <= issuedAt || expiresAt - issuedAt > MAX_TICKET_TTL_SECONDS) {
    throw new AdmissionError('expired_ticket')
  }
  return value as unknown as TicketClaims
}

/** Verify one ticket and atomically consume its replay identifier. */
export async function consumeTicket(
  token: string,
  secret: string,
  consume: (jti: string) => Promise<boolean>,
  nowSeconds?: number,
): Promise<TicketClaims> {
  const claims = verifyTicket(token, secret, nowSeconds)
  if (!await consume(claims.jti)) throw new AdmissionError('ticket_already_consumed')
  return claims
}

async function body(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += bytes.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function publicHost(req: IncomingMessage): string | undefined {
  const forwarded = req.headers['x-forwarded-host']
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',', 1)[0]?.trim()
  return typeof req.headers.host === 'string' ? req.headers.host : undefined
}

function sameOrigin(req: IncomingMessage): boolean {
  const host = publicHost(req)
  const origin = req.headers.origin
  if (host === undefined || origin === undefined) return false
  try {
    const parsed = new URL(origin)
    const forwarded = req.headers['x-forwarded-proto']
    const protocol = typeof forwarded === 'string' ? forwarded.split(',', 1)[0]?.trim() : undefined
    const expectedProtocol = protocol === 'http' || protocol === 'https' ? `${protocol}:` : parsed.protocol
    return parsed.protocol === expectedProtocol && parsed.host === host
  } catch {
    return false
  }
}



function env(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`hivemind-web-runner: ${name} is required`)
  return value
}

function serviceBase(value: string, allowedOrigins: string[]): URL {
  const target = new URL(value)
  const loopback = (target.protocol === 'http:' || target.protocol === 'https:')
    && (target.hostname === 'localhost' || target.hostname === '127.0.0.1' || target.hostname === '[::1]')
  const compose = target.protocol === 'http:' && (target.hostname === 'control-plane' || target.hostname === 'hivemind-control-plane')
  const allowlisted = allowedOrigins.some((origin) => {
    try { return new URL(origin).origin === target.origin } catch { return false }
  })
  if (target.protocol !== 'https:' && !loopback && !compose && !allowlisted) {
    throw new Error('hivemind-web-runner: project catalog service must use HTTPS or an allowed local origin')
  }
  if (target.username || target.password || target.search || target.hash || (target.pathname !== '/' && target.pathname !== '')) {
    throw new Error('hivemind-web-runner: project catalog service must contain only an origin')
  }
  return new URL(target.origin)
}

function serviceToken(principal: Record<string, string>, secret: string): string {
  const now = Math.floor(Date.now() / 1000)
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  const claims = {
    iss: 'hivemind-harness-runner', aud: 'hivemind-control-plane-harness-proxy',
    sub: principal.user_id, org_id: principal.org_id, profile: 'hivemind-chat',
    ...(principal.project_id === undefined ? {} : { project_id: principal.project_id }),
    ...(principal.native_session_hash === undefined ? {} : { native_session_hash: nativeSessionBinding(principal.native_session_hash) }),
    iat: now, exp: now + 30, jti: randomUUID(),
  }
  const input = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`
}

function compactProjects(value: unknown): Array<{ id: string; name: string; slug: string }> {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { projects?: unknown }).projects)) {
    throw new Error('invalid project catalog response')
  }
  return (value as { projects: unknown[] }).projects.flatMap((project) => {
    if (typeof project !== 'object' || project === null) return []
    const row = project as Record<string, unknown>
    return typeof row.id === 'string' && typeof row.name === 'string' && typeof row.slug === 'string'
      ? [{ id: row.id, name: row.name, slug: row.slug }]
      : []
  }).slice(0, 100)
}

/** Mount the one-time ticket exchange and health routes. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  registerMediaAuth(ctx)
  const secret = env(config.ticketSecretEnv)
  if (Buffer.byteLength(secret, 'utf8') < 32) throw new Error('hivemind-web-runner: ticket secret must be at least 32 bytes')
  const parentOrigins = config.parentOrigins.map((value) => {
    const origin = new URL(value)
    if (origin.origin !== value || (origin.protocol !== 'https:' && origin.hostname !== 'localhost')) {
      throw new Error(`hivemind-web-runner: invalid parent origin ${JSON.stringify(value)}`)
    }
    return origin.origin
  })
  if (parentOrigins.length === 0) throw new Error('hivemind-web-runner: at least one parent origin is required')
  const projectCatalogBase = serviceBase(config.serviceApiBase, config.serviceHttpOrigins)
  const projectCatalogSecret = env(config.serviceSecretEnv)
  if (Buffer.byteLength(projectCatalogSecret, 'utf8') < 32) {
    throw new Error('hivemind-web-runner: project catalog service secret must be at least 32 bytes')
  }
  const resolveAccess = async (principal: import('@deepseek-ai/dsh-hivemind-execution-scope').HivemindPrincipal, signal: AbortSignal) => {
    const token = serviceToken({ user_id:principal.userId,org_id:principal.orgId,profile:principal.profile,variation:principal.variation,
      ...(principal.projectId === undefined ? {} : { project_id:principal.projectId }) },projectCatalogSecret)
    return resolveOrganizationAgentAccess(projectCatalogBase.origin,token,principal,signal)
  }
  const resolveActor = async (principal:import('@deepseek-ai/dsh-hivemind-execution-scope').HivemindPrincipal,signal:AbortSignal)=> (await resolveAccess(principal,signal)).actor
  ctx.plugin(liveVoicePlugin(config.liveVoice, (req) => {
    const principal = ctx.connection.principal({ headers: {
      host: publicHost(req) || req.headers.host, cookie: req.headers.cookie,
    } })
    if (principal?.profile !== 'hivemind-chat' || !nonEmpty(principal.user_id)
      || !nonEmpty(principal.org_id) || !nonEmpty(principal.variation)) return undefined
    return { orgId: principal.org_id, userId: principal.user_id, profile: 'hivemind-chat',
      variation: principal.variation, ...(principal.project_id ? { projectId: principal.project_id } : {}) }
  }, config.sharedOrganizationAgents ? async(principal,signal,id)=> {
    if(!id) return undefined
    const snapshot=await ctx.hivemindExecutionScope.run(principal,()=>ctx.sessionPersistence.stat(SessionId(id)))
    if(!snapshot) throw Error('session_not_found')
    if(!['hivemind-hq','hivemind-hyperagents'].includes(snapshot.header.agentPreset ?? '') && snapshot.header.parentSession===undefined) return undefined
    return resolveActor(principal,signal)
  } : undefined))
  if (config.sharedOrganizationAgents) {
    const turns=new Map<string,number>()
    const actors = new Map<string,AuthenticatedActor>()
    const confirmationRefs=new Map<string,string>()
    const admittedUsers=new Map<string,{ id:string;actor:AuthenticatedActor }>()
    const clearTurn=(id:string)=>{turns.delete(id);actors.delete(id);confirmationRefs.delete(id);admittedUsers.delete(id)}
    ctx.effect(()=>ctx.on('agent/disposed',({ agent })=>clearTurn(agent.id),{ global:true }))
    ctx.effect(()=>ctx.on('session/disposed',session=>clearTurn(session.id),{ global:true }))
    ctx.effect(()=>()=>{turns.clear();actors.clear();confirmationRefs.clear();admittedUsers.clear()})
    const organizationAgent = (agent:import('@deepseek-ai/dsh-agent').Agent):boolean => {
      const chosen = agent.session.snapshotEvents().findLast(event=>event.type==='agent-preset/selected')
      const preset = chosen?.type==='agent-preset/selected' ? chosen.data.agentPreset : agent.session.header.agentPreset
      if(['hivemind-hq','hivemind-hyperagents'].includes(preset ?? '')) return true
      let parent=agent.session.header.parentSession
      const seen=new Set<string>()
      while(parent!==undefined) {
        if(seen.has(parent)) throw Error('organization_agent_parent_cycle')
        seen.add(parent)
        const root=ctx.agents.get(parent)
        if(!root) return true // Orphaned descendants cannot bypass the admin boundary.
        if(['hivemind-hq','hivemind-hyperagents'].includes(root.session.header.agentPreset ?? '')) return true
        parent=root.session.header.parentSession
      }
      return false
    }
    ctx.effect(()=>ctx.on('api-session/user-authorship',async (agent)=> {
      if (!organizationAgent(agent)) return undefined
      return resolveActor(ctx.hivemindExecutionScope.require(),new AbortController().signal)
    }))
    await registerQuestionRespondents(ctx,{
      authorize:async (input)=>{
        const principal=ctx.hivemindExecutionScope.require()
        const agent=ctx.agents.get(SessionId(input.agentId))
        if(!agent)throw Error('session_not_found')
        if(!organizationAgent(agent))return undefined
        const access=await resolveAccess(principal,input.signal)
        const snapshot=await ctx.sessionPersistence.stat(SessionId(input.agentId),{ signal:input.signal })
        if(!snapshot)throw Error('session_not_found')
        let profiles:Record<string,unknown>[]|undefined
        const selected=agent.session.snapshotEvents().findLast(event=>event.type==='agent-preset/selected')
        const preset=selected?.type==='agent-preset/selected'?selected.data.agentPreset:snapshot.header.agentPreset
        if(preset==='hivemind-hyperagents') {
          const response=await fetch(new URL('/internal/v1/harness-chat/core/v1/hyperagents/profiles',projectCatalogBase),{
            headers:{ authorization:`Bearer ${serviceToken({ user_id:principal.userId,org_id:principal.orgId,
              profile:principal.profile,variation:principal.variation },projectCatalogSecret)}` },
            redirect:'error',signal:AbortSignal.any([input.signal,AbortSignal.timeout(3000)]),
          })
          if(!response.ok)throw Error('question_answer_employee_not_active')
          profiles=projectHyperagentProfiles(await response.json()).profiles as Record<string,unknown>[]
        }
        validateQuestionRoom(input,access,snapshot,agent,principal,profiles)
        return { agent,actor:access.actor }
      },
      admitted:(agent,actor,id)=>{
        // This is the blocked turn's human response, not a new work assignment.
        actors.set(agent.id,actor)
        admittedUsers.set(agent.id,{ id,actor })
        confirmationRefs.delete(agent.id)
      },
    })
    ctx.effect(()=>ctx.on('agent/turn-ended',({ agent,turn })=>{if(turns.get(agent.id)===turn)clearTurn(agent.id)},{ global:true }))
    ctx.effect(()=>ctx.on('agent/pre-step',async ({ agent,messages,signal,turn },next)=> {
      if (!organizationAgent(agent)) return next()
      const sameTurn=turns.get(agent.id)===turn
      if(!sameTurn)clearTurn(agent.id)
      const previousActor=actors.get(agent.id)
      const authored = currentTurnActor(messages,previousActor,sameTurn)
      const principal = principalForActor(ctx.hivemindExecutionScope.require(),authored)
      const actor = await resolveActor(principal,signal)
      turns.set(agent.id,turn)
      actors.set(agent.id,actor)
      const admitted=messages.filter(message=>message.source.kind==='user' && authenticatedActorFromSource(message.source)?.userId===actor.userId).at(-1)
      if(admitted) admittedUsers.set(agent.id,{ id:admitted.id,actor })
      else {
        const retained=retainAdmittedUserWitness(admittedUsers.get(agent.id),actor,sameTurn)
        if(retained)admittedUsers.set(agent.id,retained)
        else admittedUsers.delete(agent.id)
      }
      const admittedWitness=admittedUsers.get(agent.id)
      const witness=admittedWitness ? admittedUserConfirmationRef(agent.session.snapshotEvents(),admittedWitness.id,actor) : undefined
      const callRef=admittedVoiceCallRef(messages,agent.session.snapshotEvents(),actor)
      const retainedRef=retainTurnConfirmationRef(confirmationRefs.get(agent.id),previousActor,actor,sameTurn)
      const userConfirmationRef=witness ?? callRef ?? (!admitted ? retainedRef : undefined)
      if(userConfirmationRef) confirmationRefs.set(agent.id,userConfirmationRef); else confirmationRefs.delete(agent.id)
      const decision=await ctx.hivemindExecutionScope.run({ ...principal,authenticatedActor:actor,userConfirmationRef },next)
      return withAuthenticatedInitiator(decision,actor,messages.length>0)
    }))
    ctx.inject(runtimeWitnessServices, toolCtx=>toolCtx.effect(()=>toolCtx.on('tools/execute',async (execution,next)=> {
      if (!execution.agent || !organizationAgent(execution.agent)) return next()
      const principal = principalForActor(ctx.hivemindExecutionScope.require(),actors.get(execution.agent.id))
      const actor = await resolveActor(principal,execution.signal)
      // Native pre-step admission precedes session append. Resolve only this
      // admitted message after append, never the newest unrelated history event.
      const admitted=admittedUsers.get(execution.agent.id)
      const witness=admitted?.actor.userId===actor.userId && admitted.actor.orgId===actor.orgId
        ? admittedUserConfirmationRef(execution.agent.session.snapshotEvents(),admitted.id,actor) : undefined
      const userConfirmationRef=witness ?? confirmationRefs.get(execution.agent.id)
      if(witness && !await toolCtx.sessions.flush(execution.agent.session)) throw Error('runtime_confirmation_not_persisted')
      if(witness)confirmationRefs.set(execution.agent.id,witness)
      const authorized={ ...principal,authenticatedActor:actor,userConfirmationRef }
      return ctx.hivemindExecutionScope.run(authorized,next)
    })))
  }
  registerBrainPlan(ctx, config.chatgptPlanBrainEnabled ?? false, options =>
    requestBrainPlan(projectCatalogBase.origin, projectCatalogSecret, ctx.hivemindExecutionScope.require(), options), {
    route: (options) => {
      let principal
      try { principal = ctx.hivemindExecutionScope.require() } catch { return Promise.resolve(false) }
      return requestBrainRoute(projectCatalogBase.origin, projectCatalogSecret, principal, options)
    },
    account: () => requestBrainAccount(projectCatalogBase.origin, projectCatalogSecret, ctx.hivemindExecutionScope.require()),
    fallback: (options) => {
      const provider = config.chatgptPlanFallbackProvider ?? 'cloudflare-openrouter-streaming'
      if (provider === 'hivemind-chatgpt-plan-brain') throw new Error('ChatGPT fallback must use a platform provider')
      return ctx.llm.stream({ ...options, provider, model: config.chatgptPlanFallbackModel ?? 'openai/gpt-6-luna' })
    },
  })
  registerPlanConnection(ctx, projectCatalogBase.origin, (req) => {
    const principal = ctx.connection.principal({ headers: { host: publicHost(req) || req.headers.host, cookie: req.headers.cookie } })
    return principal?.profile === 'hivemind-chat' && nonEmpty(principal.user_id) && nonEmpty(principal.org_id)
      ? serviceToken(principal, projectCatalogSecret) : undefined
  }, req => `https://${publicHost(req) || req.headers.host}`)
  registerRunnerDrainStatus(ctx, projectCatalogSecret)
  const redis = createClient({ url: env(config.redisUrlEnv) }) as RedisClientType
  redis.on('error', (error) => { ctx.logger.warn('hivemind-web-runner: Redis error', error) })
  await redis.connect()
  ctx.effect(() => ctx.connection.registerPrincipalScope((principal, action) => {
    if (principal['profile'] !== 'hivemind-chat' || principal['org_id'] === undefined
      || principal['user_id'] === undefined || principal['variation'] === undefined) {
      throw new Error('hivemind-web-runner: authenticated principal is incomplete')
    }
    return (ctx.hivemindExecutionScope).run({
      orgId: principal['org_id'], userId: principal['user_id'], profile: 'hivemind-chat',
      variation: principal['variation'],
      ...principal['project_id'] === undefined ? {} : { projectId: principal['project_id'] },
    }, action)
  }), 'hivemind-web-runner: principal execution scope')
  ctx.effect(() => ctx.connection.registerPrincipalRpcGuard(async (principal, endpoint, args, signal) => {
    if (!await principalMembershipActive(projectCatalogBase.origin, serviceToken(principal, projectCatalogSecret), signal)) {
      return { code: 'auth/unauthorized', message: 'authorization unavailable or membership inactive', details: {} }
    }
    const ids = referencedSessionIds(args)
    if (endpoint === 'session/create' && ids.size > 0) {
      return { code: 'session/not-found', message: 'session not found', details: {} }
    }
    for (const id of ids) {
      signal.throwIfAborted()
      const visible = await ctx.sessionPersistence.stat(SessionId(id), { signal })
      if (visible === undefined) return { code: 'session/not-found', message: 'session not found', details: {} }
    }
    return undefined
  }), 'hivemind-web-runner: tenant session authorization')
  ctx.effect(() => async () => { await redis.quit() }, 'hivemind-web-runner: Redis connection')
  ctx.on('webserver/index-inject', table => table.push({
    kind: 'global',
    name: '__HIVEMIND_EMBED_CONFIG__',
    value: { version: 1, parentOrigins },
  }))
  const exchange = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const origin = req.headers.origin
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, diagnostic: 'method_not_allowed' })
      return
    }
    if (typeof origin !== 'string' || !parentOrigins.includes(origin) || !sameOrigin(req)) {
      json(res, 403, { ok: false, diagnostic: 'origin_denied' })
      return
    }
    if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      json(res, 400, { ok: false, diagnostic: 'invalid_request' })
      return
    }
    try {
      const input = await body(req)
      if (typeof input !== 'object' || input === null) throw new AdmissionError('invalid_request')
      const request = input as Record<string, unknown>
      if (!nonEmpty(request.ticket) || !nonEmpty(request.request_id)) throw new AdmissionError('invalid_request')
      const ticket = request.ticket
      const noncePrefix = config.redisJtiPrefix || TICKET_NONCE_PREFIX
      const claims = await consumeTicket(ticket, secret, async (jti) => {
        const stored = await redis.getDel(`${noncePrefix}${jti}`)
        return typeof stored === 'string' && equalText(stored, ticketHash(ticket))
      })
      const expiresAt = Date.now() + config.sessionMaxAgeSeconds * 1000
      const principal: Record<string, string> = {
        user_id: claims.sub,
        org_id: claims.org_id,
        profile: claims.profile,
        variation: claims.variation,
        ...claims.project_id === undefined ? {} : { project_id: claims.project_id },
        ...claims.native_session_hash === undefined ? {} : { native_session_hash: claims.native_session_hash },
      }
      const authorityHost = publicHost(req)
      if (!await nativePrincipalAllowed(principal, () => principalMembershipActive(
        projectCatalogBase.origin, serviceToken(principal, projectCatalogSecret), new AbortController().signal,
      ))) throw new AdmissionError('native_session_denied')
      const cookie = ctx.connection.authorizePrincipal({
        headers: { host: authorityHost || req.headers.host, cookie: req.headers.cookie },
      }, principal, expiresAt)
      json(res, 200, { ok: true, expires_at: expiresAt, profile: 'hivemind-chat' }, { 'set-cookie': cookie })
    } catch (error) {
      const diagnostic = error instanceof AdmissionError ? error.code : 'admission_denied'
      ctx.logger.warn('hivemind-web-runner: ticket exchange rejected', diagnostic)
      json(res, diagnostic === 'origin_denied' ? 403 : 401, { ok: false, diagnostic })
    }
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: EXCHANGE_PATH, handler: exchange }), 'hivemind-web-runner: embed ticket exchange')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ESTABLISH_PATH, handler: exchange }), 'hivemind-web-runner: session establish')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: BOOT_PATH,
    handler: async (req, res) => {
      const authorityHost = publicHost(req)
      const principal = ctx.connection.principal({
        headers: { host: authorityHost || req.headers.host, cookie: req.headers.cookie },
      })
      if (principal?.['profile'] !== 'hivemind-chat') {
        json(res, 401, { ok: false, diagnostic: 'authentication_required' })
        return
      }
      if (!await nativePrincipalAllowed(principal, () => principalMembershipActive(
        projectCatalogBase.origin, serviceToken(principal, projectCatalogSecret), new AbortController().signal,
      ))) {
        json(res, 403, { ok: false, diagnostic: 'native_session_denied' })
        return
      }
      const injections: IndexInjection[] = []
      ctx.emit('webserver/index-inject', injections)
      json(res, 200, { ok: true, profile: 'hivemind-chat', injections, styles: await nativeStyles() })
    },
  }), 'hivemind-web-runner: authenticated browser boot graph')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PROJECTS_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, diagnostic: 'method_not_allowed' }, { allow: 'GET' })
        return
      }
      const authorityHost = publicHost(req)
      const principal = ctx.connection.principal({
        headers: { host: authorityHost || req.headers.host, cookie: req.headers.cookie },
      })
      if (principal?.profile !== 'hivemind-chat' || !nonEmpty(principal.user_id) || !nonEmpty(principal.org_id)) {
        json(res, 401, { ok: false, diagnostic: 'authentication_required' })
        return
      }
      try {
        const response = await fetch(new URL('/internal/v1/harness-chat/core/projects', projectCatalogBase), {
          method: 'GET',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${serviceToken(principal, projectCatalogSecret)}`,
          },
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
        })
        if (!response.ok) throw new Error(`project catalog status ${response.status}`)
        json(res, 200, { ok: true, projects: compactProjects(await response.json()) })
      } catch {
        json(res, 503, { ok: false, diagnostic: 'project_catalog_unavailable' })
      }
    },
  }), 'hivemind-web-runner: authenticated project catalog')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: EMPLOYEES_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, diagnostic: 'method_not_allowed' }, { allow: 'GET' })
        return
      }
      const principal = ctx.connection.principal({
        headers: { host: publicHost(req) || req.headers.host, cookie: req.headers.cookie },
      })
      if (principal?.profile !== 'hivemind-chat' || !nonEmpty(principal.user_id) || !nonEmpty(principal.org_id)) {
        json(res, 401, { ok: false, diagnostic: 'authentication_required' })
        return
      }
      try {
        const response = await fetch(new URL('/internal/v1/harness-chat/core/v1/hyperagents/profiles', projectCatalogBase), {
          method: 'GET',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${serviceToken(principal, projectCatalogSecret)}`,
          },
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
        })
        if (!response.ok) throw new Error(`employee catalog status ${response.status}`)
        const projected = projectHyperagentProfiles(await response.json())
        const profiles = projected.profiles as Array<Record<string, unknown>>
        json(res, 200, { ok: true, profiles: profiles.map(profile => ({
          id: profile.id, name: profile.name, role_archetype: profile.role_archetype,
          avatar_url: profile.avatar_url, status: profile.status,
          persona: profile.persona, tools: profile.tools, policy_rules: profile.policy_rules,
        })) })
      } catch {
        json(res, 503, { ok: false, diagnostic: 'employee_catalog_unavailable' })
      }
    },
  }), 'hivemind-web-runner: authenticated employee catalog')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/api/hivemind/onboarding/screenshot',
    handler: async (req, res) => {
      if (req.method !== 'GET') { json(res, 405, { diagnostic: 'method_not_allowed' }, { allow: 'GET' }); return }
      const principal = ctx.connection.principal({ headers: { host: publicHost(req) || req.headers.host, cookie: req.headers.cookie } })
      if (principal?.profile !== 'hivemind-chat' || !nonEmpty(principal.user_id) || !nonEmpty(principal.org_id)) { json(res, 401, { diagnostic: 'authentication_required' }); return }
      try {
        const response = await fetch(new URL('/internal/v1/harness-chat/core/v1/hyperagents/onboarding/homepage-screenshot', serviceBase(config.onboardingServiceApiBase ?? config.serviceApiBase, config.serviceHttpOrigins)), {
          headers: { accept: 'application/json', authorization: `Bearer ${serviceToken(principal, projectCatalogSecret)}` },
          redirect: 'manual', signal: AbortSignal.timeout(10_000),
        })
        if (!response.ok) { json(res, response.status === 404 ? 404 : 503, { diagnostic: 'retained_screenshot_unavailable' }); return }
        const payload = await response.json() as Record<string, unknown>
        if (typeof payload.base64 !== 'string' || payload.base64.length > 2 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(String(payload.media_type))) throw new Error('invalid retained screenshot')
        res.writeHead(200, { 'content-type': String(payload.media_type), 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' })
        res.end(Buffer.from(payload.base64, 'base64'))
      } catch { json(res, 503, { diagnostic: 'retained_screenshot_unavailable' }) }
    },
  }), 'hivemind-web-runner: tenant-authenticated retained onboarding screenshot')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: HEALTH_PATH, handler: async (_req, res) => {
    try {
      const persistence = ctx.sessionPersistence as typeof ctx.sessionPersistence & { health?: () => Promise<void> }
      if (persistence.health === undefined) throw new Error('hivemind-web-runner: persistence health check is unavailable')
      await Promise.all([redis.ping(), persistence.health()])
      json(res, 200, { ok: true, profile: 'hivemind-chat' })
    } catch {
      json(res, 503, { ok: false, profile: 'hivemind-chat' })
    }
  } }), 'hivemind-web-runner: health route')
}
