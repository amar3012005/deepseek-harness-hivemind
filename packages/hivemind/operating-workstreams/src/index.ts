/** Plan-selected HyperAgents workstream execution. @module @deepseek-ai/dsh-hivemind-operating-workstreams */

import { createHash } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { HyperagentDirectory } from '@deepseek-ai/dsh-hivemind-employee-directory'
import type { PlannedWorkstream, RunPlanRecorded } from '@deepseek-ai/dsh-hivemind-playbooks'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

export const name = 'hivemind-operating-workstreams'
export const inject = ['tools', 'hivemindEmployeeDirectory', 'approval']

/** Deployment-owned bounds for workstream receipts and inline persona context. */
export interface Config { maxSummaryChars: number; maxPersonaChars: number }

export const Config: z<Config> = z.object({
  maxSummaryChars: z.natural().min(1).default(4_000),
  maxPersonaChars: z.natural().min(1).default(8_000),
})

interface WorkstreamActorSnapshot {
  readonly kind: PlannedWorkstream['actor']['kind']
  readonly employeeId?: string
  readonly employeeName?: string
  readonly role?: string
  readonly avatarUrl?: string
  readonly profileVersion?: string
  readonly personaSha256?: string
}

interface WorkstreamStarted {
  readonly runId: string
  readonly planId: string
  readonly planRevision: number
  readonly workstreamId: string
  readonly objective: string
  readonly outcome?: string
  readonly actor: WorkstreamActorSnapshot
  readonly approvalRequired?: boolean
}

interface WorkstreamProgress { readonly runId: string; readonly planId: string; readonly workstreamId: string; readonly summary: string }
interface WorkstreamCompleted {
  readonly runId: string
  readonly planId: string
  readonly workstreamId: string
  readonly summary: string
  readonly evidenceIds: readonly string[]
  readonly artifactIds: readonly string[]
}
interface WorkstreamFailed { readonly runId: string; readonly planId: string; readonly workstreamId: string; readonly diagnostic: string }
interface WorkstreamApproval { readonly runId: string; readonly planId: string; readonly workstreamId: string; readonly outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'; readonly reason: string }
interface EvidenceGapRecorded { readonly runId: string; readonly planId: string; readonly workstreamId: string; readonly summary: string }

/** A native capability receipt projected into the current operating run. */
interface OperatingReceipt {
  readonly runId: string
  readonly planId: string
  readonly receiptId: string
  readonly kind: 'browser' | 'artifact' | 'workflow' | 'connected_action'
  readonly status: 'running' | 'completed' | 'failed'
  readonly title: string
  readonly toolName?: string
  readonly callId?: string
  readonly summary?: string
}

/** A compact, observational close-out proposal. It never asserts business success. */
interface RunEvaluation {
  readonly runId: string
  readonly planId: string
  readonly status: 'ready'
  readonly receiptCounts: Readonly<Record<string, number>>
  readonly next: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Records the planned actor snapshot when execution of one workstream starts. */
    'hivemind/workstream-started': WorkstreamStarted
    /** Records bounded progress supplied by the active parent or linked child execution. */
    'hivemind/workstream-progress': WorkstreamProgress
    /** Records terminal workstream output references without replacing the native tool or child receipts. */
    'hivemind/workstream-completed': WorkstreamCompleted
    /** Records a terminal workstream failure. */
    'hivemind/workstream-failed': WorkstreamFailed
    /** A real approval-service decision bound to one operating workstream. */
    'hivemind/workstream-approval': WorkstreamApproval
    /** A specific unresolved evidence need that intentionally reopens research for the current plan. */
    'hivemind/evidence-gap-recorded': EvidenceGapRecorded
    /** Native browser, artifact, workflow, or approved-action receipt correlated to this operating run. */
    'hivemind/operating-receipt': OperatingReceipt
    /** Compact run close-out proposal emitted only when no observed work remains pending. */
    'hivemind/run-evaluation': RunEvaluation
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { hivemindOperatingRuns: HiveMindOperatingRuns }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`hivemind-operating-workstreams: ${label} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, maxChars: number): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`hivemind-operating-workstreams: ${label} must be a non-empty string`)
  const result = value.trim()
  if (result.length > maxChars) throw new TypeError(`hivemind-operating-workstreams: ${label} exceeds ${maxChars} characters`)
  return result
}

function list(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new TypeError(`hivemind-operating-workstreams: ${label} must be an array`)
  return value.map((item, index) => text(item, `${label}[${index}]`, 500))
}

function latestPlan(agent: Agent): RunPlanRecorded | undefined {
  const events = agent.session.snapshotEvents() as ReadonlyArray<{ readonly type: string; readonly data: unknown }>
  const event = events.findLast(item => item.type === 'hivemind/run-plan' || item.type === 'hivemind/run-plan-revised')
  return event?.data as RunPlanRecorded | undefined
}

function requireLatestPlan(agent: Agent): RunPlanRecorded {
  const plan = latestPlan(agent)
  if (plan === undefined) throw new Error('hivemind-operating-workstreams: no operating plan is recorded')
  return plan
}

function planned(agent: Agent, workstreamId: string): { plan: RunPlanRecorded; workstream: PlannedWorkstream } {
  const plan = requireLatestPlan(agent)
  let workstream = plan.workstreams.find(item => item.id === workstreamId)
  // Smaller models occasionally echo the prominently displayed plan id into
  // workstream_id. When the plan has exactly one unfinished workstream, that
  // intent is unambiguous and can be normalized without weakening isolation.
  if (workstream === undefined && workstreamId === plan.planId) {
    const unfinished = plan.workstreams.filter(item => terminalWorkstream(agent, plan.planId, item.id) === undefined)
    if (unfinished.length === 1) workstream = unfinished[0]
  }
  if (workstream === undefined) throw new Error('hivemind-operating-workstreams: workstream is not in the current operating plan')
  return { plan, workstream }
}

function terminalWorkstream(agent: Agent, planId: string, workstreamId: string): { readonly status: 'completed' | 'failed' } | undefined {
  const events = agent.session.snapshotEvents() as ReadonlyArray<{ readonly type: string; readonly data: unknown }>
  const event = events.findLast((item) => {
    if (item.type !== 'hivemind/workstream-completed' && item.type !== 'hivemind/workstream-failed') return false
    const data = asRecord(item.data)
    return data?.['planId'] === planId && data['workstreamId'] === workstreamId
  })
  if (event === undefined) return undefined
  return { status: event.type === 'hivemind/workstream-completed' ? 'completed' : 'failed' }
}

function workstreamApprovalGranted(agent: Agent, planId: string, workstreamId: string): boolean {
  return sessionWorkstreamApprovalGranted(agent.session as unknown as SessionLike, planId, workstreamId)
}

function sessionWorkstreamApprovalGranted(session: SessionLike, planId: string, workstreamId: string): boolean {
  return session.snapshotEvents().some(item => item.type === 'hivemind/workstream-approval'
    && asRecord(item.data)?.['planId'] === planId
    && asRecord(item.data)?.['workstreamId'] === workstreamId
    && asRecord(item.data)?.['outcome'] === 'allowed-once')
}

function latestOperatingContext(agent: Agent): { readonly runId: string; readonly objective: string } | undefined {
  const events = agent.session.snapshotEvents() as ReadonlyArray<{ readonly type: string; readonly data: unknown }>
  const event = events.findLast(item => item.type === 'hivemind/operating-context')
  const data = asRecord(event?.data)
  const runId = stringValue(data?.['runId'])
  const objective = stringValue(data?.['objective'])
  return runId === undefined || objective === undefined ? undefined : { runId, objective }
}

function startedCoordinates(agent: Agent, workstreamId: string): { readonly runId: string; readonly planId: string } | undefined {
  const events = agent.session.snapshotEvents() as ReadonlyArray<{ readonly type: string; readonly data: unknown }>
  const event = events.findLast(item => item.type === 'hivemind/workstream-started' && asRecord(item.data)?.['workstreamId'] === workstreamId)
  const data = asRecord(event?.data)
  const runId = stringValue(data?.['runId'])
  const planId = stringValue(data?.['planId'])
  return runId === undefined || planId === undefined ? undefined : { runId, planId }
}

type SessionLike = {
  readonly snapshotEvents: () => ReadonlyArray<{ readonly type: string; readonly data: unknown }>
  readonly append: (type: string, data: unknown) => unknown
}

type TodoItem = { readonly content: string; readonly status: 'pending' | 'in_progress' | 'completed' }

function latestTodos(session: SessionLike): readonly TodoItem[] | undefined {
  const event = session.snapshotEvents().findLast(item => item.type === 'todo/write')
  const todos = asRecord(event?.data)?.['todos']
  return Array.isArray(todos) ? todos as TodoItem[] : undefined
}

function updateWorkstreamTodo(session: SessionLike, workstreamId: string, status: 'in_progress' | 'completed'): void {
  const current = latestTodos(session)
  if (current === undefined) return
  const prefix = `[${workstreamId}] `
  const index = current.findIndex(item => item.content.startsWith(prefix))
  if (index < 0) return
  const todos = current.map((item, itemIndex) => itemIndex === index ? { ...item, status } : { ...item })
  if (status === 'completed') {
    const next = todos.findIndex((item, itemIndex) => itemIndex > index && item.status === 'pending')
    const nextTodo = todos[next]
    if (nextTodo !== undefined) todos[next] = { ...nextTodo, status: 'in_progress' }
  }
  session.append('todo/write', { todos })
}

function currentTurnEvents(agent: Agent, turn: number): ReadonlyArray<{ readonly type: string; readonly data: unknown }> {
  const events = agent.session.snapshotEvents() as ReadonlyArray<{ readonly type: string; readonly data: unknown }>
  const boundary = events.findLastIndex(event => event.type === 'turn/start'
    && asRecord(event.data)?.['turn'] === turn)
  return boundary < 0 ? events : events.slice(boundary)
}

function hasVisibleAnswer(events: ReadonlyArray<{ readonly type: string; readonly data: unknown }>): boolean {
  return events.some((event) => {
    if (event.type !== 'assistant/message') return false
    const message = asRecord(asRecord(event.data)?.['message'])
    const content = message?.['content']
    return Array.isArray(content) && content.some((block) => {
      const value = asRecord(block)
      return value?.['type'] === 'text' && stringValue(value['text']) !== undefined
    })
  })
}

function planForSession(session: SessionLike): RunPlanRecorded | undefined {
  const event = session.snapshotEvents().findLast(item => item.type === 'hivemind/run-plan' || item.type === 'hivemind/run-plan-revised')
  return event?.data as RunPlanRecorded | undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function callForResult(session: SessionLike, result: unknown): { readonly callId: string; readonly name: string } | undefined {
  const message = asRecord(asRecord(result)?.['message'])
  const source = asRecord(message?.['source'])
  const content = Array.isArray(message?.['content']) ? message['content'] : []
  const resultBlock = content.map(asRecord).find(block => block?.['type'] === 'tool-result')
  const callId =
    stringValue(source?.['callId']) ??
    stringValue(resultBlock?.['toolCallId']) ??
    // Retain compatibility with the compact synthetic result shape used by
    // older integrations while preferring Harness's native user-message form.
    stringValue(message?.['toolCallId'])
  if (callId === undefined) return undefined
  const call = session.snapshotEvents().findLast(event => event.type === 'tool/call' && stringValue(asRecord(event.data)?.['callId']) === callId)
  const name = stringValue(asRecord(call?.data)?.['name'])
  return name === undefined ? undefined : { callId, name }
}

function hasMedia(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasMedia)
  const input = asRecord(value)
  if (input === undefined) return false
  if (input['type'] === 'image' || input['type'] === 'file') return true
  return Object.values(input).some(hasMedia)
}

function browserTool(name: string): boolean {
  const normalized = name.toLowerCase()
  return normalized.startsWith('browser_') || normalized.includes('browser__') || normalized.includes('playwright')
}

function isOperatingInternal(name: string): boolean {
  return name.startsWith('hivemind_')
}

function receiptStatus(value: unknown): 'completed' | 'failed' {
  return asRecord(value)?.['error'] === undefined ? 'completed' : 'failed'
}

function activePending(session: SessionLike, plan: RunPlanRecorded): boolean {
  const events = session.snapshotEvents()
  const waitingResearch = new Set<string>()
  const waitingEmployees = new Set<string>()
  const waitingReceipts = new Set<string>()
  for (const event of events) {
    const data = asRecord(event.data)
    if (data?.['runId'] !== plan.runId) continue
    if (event.type === 'hivemind/research-requested') {
      const id = stringValue(data['jobId']); if (id !== undefined) waitingResearch.add(id)
    } else if (event.type === 'hivemind/research-receipt') {
      const id = stringValue(data['jobId']); if (id !== undefined && data['evidenceState'] !== 'pending') waitingResearch.delete(id)
    } else if (event.type === 'hivemind/employee-delegation-start') {
      const id = stringValue(data['delegationId']); if (id !== undefined) waitingEmployees.add(id)
    } else if (event.type === 'hivemind/employee-delegation-end') {
      const id = stringValue(data['delegationId']); if (id !== undefined) waitingEmployees.delete(id)
    } else if (event.type === 'hivemind/operating-receipt') {
      const id = stringValue(data['receiptId'])
      if (id !== undefined && data['status'] === 'running') waitingReceipts.add(id)
      else if (id !== undefined) waitingReceipts.delete(id)
    }
  }
  const waitingApproval = plan.workstreams.some(item => item.approvalRequired === true
    && !sessionWorkstreamApprovalGranted(session, plan.planId, item.id))
  const unfinishedWorkstream = plan.workstreams.some(item => !events.some((event) => {
    if (event.type !== 'hivemind/workstream-completed' && event.type !== 'hivemind/workstream-failed') return false
    const data = asRecord(event.data)
    return data?.['planId'] === plan.planId && data['workstreamId'] === item.id
  }))
  const unfinishedTodo = latestTodos(session)?.some(item => item.status !== 'completed') ?? false
  return waitingResearch.size > 0
    || waitingEmployees.size > 0
    || waitingReceipts.size > 0
    || waitingApproval
    || unfinishedWorkstream
    || unfinishedTodo
}

function chooseEvidenceWorkstream(session: SessionLike, plan: RunPlanRecorded, requested?: string): PlannedWorkstream | undefined {
  if (requested !== undefined) return plan.workstreams.find(item => item.id === requested)
  const terminal = new Set(session.snapshotEvents().flatMap((event) => {
    if (event.type !== 'hivemind/workstream-completed' && event.type !== 'hivemind/workstream-failed') return []
    const data = asRecord(event.data)
    return data?.['planId'] === plan.planId && typeof data['workstreamId'] === 'string' ? [data['workstreamId']] : []
  }))
  const candidates = plan.workstreams.filter(item => !terminal.has(item.id) && item.approvalRequired !== true)
  const evidence = candidates.filter(item => /evidence|research|source|verify|market|regulat|adoption/iu.test(`${item.id} ${item.objective} ${item.outcome ?? ''}`))
  return evidence.length === 1 ? evidence[0] : candidates.length === 1 ? candidates[0] : undefined
}

function recordEvaluation(session: SessionLike, plan: RunPlanRecorded): void {
  if (activePending(session, plan)) return
  const events = session.snapshotEvents()
  const alreadyRecorded = events.some(event => event.type === 'hivemind/run-evaluation' && asRecord(event.data)?.['runId'] === plan.runId)
  if (alreadyRecorded) return
  const receiptCounts: Record<string, number> = {}
  for (const event of events) {
    const data = asRecord(event.data)
    if (event.type !== 'hivemind/operating-receipt' || data?.['runId'] !== plan.runId) continue
    const kind = stringValue(data['kind'])
    if (kind !== undefined) receiptCounts[kind] = (receiptCounts[kind] ?? 0) + 1
  }
  session.append('hivemind/run-evaluation', {
    runId: plan.runId,
    planId: plan.planId,
    status: 'ready',
    receiptCounts,
    next: 'Use the completed receipts and evidence to synthesize the requested outcome; propose a playbook improvement only when the run exposed a repeatable gap.',
  } satisfies RunEvaluation)
}

function profileVersion(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  for (const key of ['version', 'version_label', 'id']) if (typeof input[key] === 'string' && input[key].trim() !== '') return input[key].trim()
  return undefined
}

function employee(
  directory: HyperagentDirectory,
  employeeId: string,
  maxPersonaChars: number,
): { snapshot: WorkstreamActorSnapshot; persona: string } {
  const raw = directory.profiles.find(item => item['id'] === employeeId)
  if (raw === undefined) throw new Error('hivemind-operating-workstreams: employee is not in the authenticated organization directory')
  const name = text(raw['name'], 'employee name', 500)
  const persona = text(raw['persona'], 'employee persona', maxPersonaChars)
  const role = typeof raw['role_archetype'] === 'string' && raw['role_archetype'].trim() !== '' ? raw['role_archetype'].trim() : 'HIVE-MIND employee'
  const avatarUrl = typeof raw['avatar_url'] === 'string' && /^https?:\/\//.test(raw['avatar_url']) ? raw['avatar_url'] : undefined
  const version = profileVersion(raw['active_prompt_version'])
  return {
    snapshot: {
      kind: 'inline_employee',
      employeeId,
      employeeName: name,
      role,
      ...(avatarUrl === undefined ? {} : { avatarUrl }),
      ...(version === undefined ? {} : { profileVersion: version }),
      personaSha256: createHash('sha256').update(persona).digest('hex'),
    },
    persona,
  }
}

/** Scoped execution service that follows actor choices already stored in the current plan. */
export class HiveMindOperatingRuns extends Service {
  constructor(ctx: Context, private readonly maxPersonaChars: number) { super(ctx, 'hivemindOperatingRuns') }

  /** Resolve one workstream from the latest plan. */
  planned(agent: Agent, workstreamId: string): { plan: RunPlanRecorded; workstream: PlannedWorkstream } {
    return planned(agent, workstreamId)
  }

  /** Normalize an unambiguous plan-id echo to its canonical workstream id. */
  canonicalWorkstreamId(agent: Agent, requestedId: string): string {
    return latestPlan(agent) === undefined ? requestedId : planned(agent, requestedId).workstream.id
  }

  /** Start a plan-selected employee child and return its immutable plan coordinates. */
  startEmployeeChild(agent: Agent, workstreamId: string, employeeId: string): WorkstreamStarted {
    const { plan, workstream } = planned(agent, workstreamId)
    if (workstream.actor.kind !== 'employee_subagent' || workstream.actor.employeeId !== employeeId) throw new Error('hivemind-operating-workstreams: delegation does not match the current operating plan')
    const event: WorkstreamStarted = { runId: plan.runId, planId: plan.planId, planRevision: plan.revision, workstreamId, objective: workstream.objective, ...(workstream.outcome === undefined ? {} : { outcome: workstream.outcome }), actor: { kind: 'employee_subagent', employeeId } }
    agent.session.append('hivemind/workstream-started', event)
    return event
  }

  /**
   * Correlate a delegation with one unambiguous child workstream already
   * selected in the durable plan. The model never supplies this identifier.
   */
  startPlanSelectedEmployeeChild(agent: Agent, employeeId: string): WorkstreamStarted | undefined {
    const plan = requireLatestPlan(agent)
    const events = agent.session.snapshotEvents() as ReadonlyArray<{ readonly type: string; readonly data: unknown }>
    const started = new Set(events.flatMap((event) => {
      if (event.type !== 'hivemind/workstream-started') return []
      const data = asRecord(event.data)
      return data?.['planId'] === plan.planId && typeof data['workstreamId'] === 'string' ? [data['workstreamId']] : []
    }))
    const candidates = plan.workstreams.filter(workstream =>
      workstream.actor.kind === 'employee_subagent'
      && workstream.actor.employeeId === employeeId
      && !started.has(workstream.id),
    )
    if (candidates.length !== 1) return undefined
    const candidate = candidates[0]
    return candidate === undefined ? undefined : this.startEmployeeChild(agent, candidate.id, employeeId)
  }

  /** Complete a child-linked workstream. */
  completeEmployeeChild(agent: Agent, workstreamId: string, summary: string): void {
    const { plan } = planned(agent, workstreamId)
    if (terminalWorkstream(agent, plan.planId, workstreamId) !== undefined) return
    agent.session.append('hivemind/workstream-completed', { runId: plan.runId, planId: plan.planId, workstreamId, summary, evidenceIds: [], artifactIds: [] })
  }

  /** Fail a child-linked workstream. */
  failEmployeeChild(agent: Agent, workstreamId: string, diagnostic: string): void {
    const { plan } = planned(agent, workstreamId)
    if (terminalWorkstream(agent, plan.planId, workstreamId) !== undefined) return
    agent.session.append('hivemind/workstream-failed', { runId: plan.runId, planId: plan.planId, workstreamId, diagnostic })
  }

  /** Start a parent-executed workstream and inject an authenticated inline employee snapshot when selected. */
  async start(agent: Agent, workstreamId: string, signal: AbortSignal, fallbackObjective?: string): Promise<WorkstreamStarted> {
    const currentPlan = latestPlan(agent)
    const context = currentPlan === undefined ? latestOperatingContext(agent) : undefined
    if (currentPlan === undefined && context === undefined) {
      throw new Error('hivemind-operating-workstreams: retrieve operating context before recording a workstream')
    }
    const plan: RunPlanRecorded = currentPlan ?? {
      runId: context?.runId ?? '',
      planId: `adaptive:${context?.runId ?? ''}`,
      revision: 0,
      objective: context?.objective ?? '',
      playbooks: [],
      approach: 'Native Harness adaptive execution',
      workstreams: [],
    }
    const workstream: PlannedWorkstream = currentPlan === undefined
      ? { id: workstreamId, objective: fallbackObjective ?? context?.objective ?? '', actor: { kind: 'main' } }
      : planned(agent, workstreamId).workstream
    let actor: WorkstreamActorSnapshot = workstream.actor
    let persona: string | undefined
    if (workstream.actor.kind === 'inline_employee') {
      const directory = await this.ctx.hivemindEmployeeDirectory.profiles(signal)
      const employeeId = workstream.actor.employeeId
      if (employeeId === undefined) throw new Error('hivemind-operating-workstreams: inline employee id is missing')
      const selected = employee(directory, employeeId, this.maxPersonaChars)
      actor = selected.snapshot
      persona = selected.persona
    }
    if (workstream.actor.kind === 'employee_subagent') throw new Error('hivemind-operating-workstreams: use hivemind_delegate_employee for an employee_subagent workstream')
    const event: WorkstreamStarted = {
      runId: plan.runId,
      planId: plan.planId,
      planRevision: plan.revision,
      workstreamId,
      objective: workstream.objective,
      ...(workstream.outcome === undefined ? {} : { outcome: workstream.outcome }),
      ...(workstream.approvalRequired === true ? { approvalRequired: true } : {}),
      actor,
    }
    agent.session.append('hivemind/workstream-started', event)
    if (persona !== undefined) agent.inject(createUserMessage({
      content: [{
        type: 'text',
        text: `Active operating workstream: ${workstream.objective}\nEmployee perspective: ${actor.employeeName} (${actor.role}).\nApply the bounded employee persona below while executing this planned workstream. You remain the parent HyperAgents runtime and own tool use, evidence, plan revision, and final synthesis.\n\n${persona}`,
      }],
      source: { kind: 'plugin', plugin: name },
    }))
    return event
  }

  /** Resolve lifecycle coordinates from a plan or an adaptively started main workstream. */
  coordinates(agent: Agent, workstreamId: string): { readonly runId: string; readonly planId: string } {
    const plan = latestPlan(agent)
    if (plan !== undefined) {
      if (!plan.workstreams.some(item => item.id === workstreamId)) throw new Error('hivemind-operating-workstreams: workstream is not in the current operating plan')
      return { runId: plan.runId, planId: plan.planId }
    }
    const coordinates = startedCoordinates(agent, workstreamId)
    if (coordinates === undefined) throw new Error('hivemind-operating-workstreams: start the adaptive workstream before updating it')
    return coordinates
  }
}

/** Register the plan-following service and compact lifecycle tool. */
export function apply(ctx: Context, config: Partial<Config> = {}): void {
  const maxSummaryChars = config.maxSummaryChars ?? 4_000
  const service = new HiveMindOperatingRuns(ctx, config.maxPersonaChars ?? 8_000)

  // This observer is deliberately observational. It follows native session and
  // approval receipts, derives the active run from the session log, and never
  // picks a provider, employee, workflow, or output format for the model.
  const approvedCalls = new WeakMap<object, Set<string>>()
  const approvalCalls = new WeakMap<object, Map<string, string>>()
  const continuedTurns = new WeakMap<Agent, Set<number>>()

  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const plan = latestPlan(agent)
    if (plan === undefined) return
    const events = currentTurnEvents(agent, turn)
    const pending = activePending(agent.session as unknown as SessionLike, plan)
    if (!pending && hasVisibleAnswer(events)) return
    if (!pending && !events.some(event => event.type === 'tool/call')) return
    const continued = continuedTurns.get(agent) ?? new Set<number>()
    if (continued.has(turn)) return
    if (typeof agent.steer !== 'function') return
    continued.add(turn)
    continuedTurns.set(agent, continued)
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: pending
        ? 'Continue the active operating plan. Finish or fail every remaining workstream and todo before final synthesis. Use completed receipts; do not repeat orientation or satisfied research. Record a specific evidence gap before reopening research.'
        : 'Continue the current operating plan by synthesizing the requested outcome now from its completed durable receipts.' }],
      source: { kind: 'plugin', plugin: name },
    }))
  })
  // `Session.append()` publishes observers while its append boundary is held,
  // so projections derived from native receipts must be written immediately
  // *after* that publication. This keeps the observer purely additive while
  // retaining the original native event and its tool UI/receipt unchanged.
  const appendProjection = (session: SessionLike, type: string, data: unknown): void => {
    queueMicrotask(() => { session.append(type, data) })
  }
  ctx.on('session/event', (session, event) => {
    const sessionLike = session as unknown as SessionLike
    const plan = planForSession(sessionLike)
    if (plan === undefined) return
    // The observer intentionally accepts optional plugin event families without
    // importing or requiring their implementation packages.
    const observed = event as unknown as { readonly type: string; readonly data: unknown }
    const data = asRecord(observed.data)
    const sessionKey = session as unknown as object
    if (observed.type === 'hivemind/research-gathered') {
      if (data?.['planId'] !== plan.planId || (data['runId'] !== undefined && data['runId'] !== plan.runId)) return
      const workstream = chooseEvidenceWorkstream(sessionLike, plan, stringValue(data['workstreamId']))
      if (workstream === undefined) return
      const evidenceIds = Array.isArray(data['objectives'])
        ? data['objectives'].flatMap(item => stringValue(asRecord(item)?.['jobId']) ?? [])
        : []
      appendProjection(sessionLike, 'hivemind/workstream-progress', {
        runId: plan.runId, planId: plan.planId, workstreamId: workstream.id,
        summary: data['status'] === 'failed'
          ? 'Research gather failed; assess the evidence gap before closing this workstream.'
          : `Research gather returned ${evidenceIds.length} terminal evidence receipt${evidenceIds.length === 1 ? '' : 's'}; verify coverage before closing this workstream.`,
      } satisfies WorkstreamProgress)
      return
    }
    if (observed.type === 'approval/asked') {
      const approvalId = stringValue(data?.['id'])
      const callId = stringValue(data?.['callId'])
      if (approvalId !== undefined && callId !== undefined) {
        const calls = approvalCalls.get(sessionKey) ?? new Map<string, string>()
        calls.set(approvalId, callId)
        approvalCalls.set(sessionKey, calls)
      }
      return
    }
    if (observed.type === 'approval/decided') {
      const approvalId = stringValue(data?.['id'])
      const callId = approvalId === undefined ? undefined : approvalCalls.get(sessionKey)?.get(approvalId)
      if (data?.['outcome'] === 'allowed-once' && callId !== undefined) {
        const calls = approvedCalls.get(sessionKey) ?? new Set<string>()
        calls.add(callId)
        approvedCalls.set(sessionKey, calls)
      }
      return
    }
    if (observed.type === 'tool-workflow/run-start') {
      const workflowId = stringValue(data?.['runId'])
      if (workflowId !== undefined) appendProjection(sessionLike, 'hivemind/operating-receipt', {
        runId: plan.runId, planId: plan.planId, receiptId: `workflow:${workflowId}`,
        kind: 'workflow', status: 'running', title: `Workflow: ${stringValue(data?.['name']) ?? workflowId}`,
      } satisfies OperatingReceipt)
      return
    }
    if (observed.type === 'tool-workflow/run-end') {
      const workflowId = stringValue(data?.['runId'])
      if (workflowId !== undefined) {
        const reason = stringValue(data?.['stopReason'])
        appendProjection(sessionLike, 'hivemind/operating-receipt', {
          runId: plan.runId, planId: plan.planId, receiptId: `workflow:${workflowId}`,
          kind: 'workflow', status: reason === 'completed' ? 'completed' : 'failed',
          title: `Workflow ${reason ?? 'ended'}`,
          ...(reason === undefined ? {} : { summary: reason }),
        } satisfies OperatingReceipt)
      }
      return
    }
    if (observed.type === 'tool/result') {
      const call = callForResult(sessionLike, observed.data)
      if (call === undefined || isOperatingInternal(call.name)) return
      const error = receiptStatus(observed.data)
      const wasApproved = approvedCalls.get(sessionKey)?.delete(call.callId) ?? false
      const kind = browserTool(call.name) ? 'browser' : wasApproved ? 'connected_action' : hasMedia(observed.data) ? 'artifact' : undefined
      if (kind === undefined) return
      const title = kind === 'browser'
        ? 'Browser receipt'
        : kind === 'artifact'
          ? 'Artifact receipt'
          : 'Approved connected action'
      appendProjection(sessionLike, 'hivemind/operating-receipt', {
        runId: plan.runId, planId: plan.planId, receiptId: `${kind}:${call.callId}`,
        kind, status: error, title, toolName: call.name, callId: call.callId,
      } satisfies OperatingReceipt)
      return
    }
    if (observed.type === 'turn/end') queueMicrotask(() =>{  recordEvaluation(sessionLike, plan) })
  })

  ctx.tools.register(defineTool({
    name: 'hivemind_workstream',
    description: 'Execute visible work selected by the native Harness runtime. Call start once, perform the work with native Harness capabilities, then call complete or fail exactly once. Native tool receipts represent intermediate progress. Use evidence_gap only for a specific missing fact and request_approval only when the plan requires it. A recorded plan supplies the actor.',
    parameters: {
      action: { type: 'string', required: true, enum: ['start', 'evidence_gap', 'request_approval', 'complete', 'fail'] },
      workstream_id: { type: 'string', required: true },
      objective: { type: 'string', description: 'Optional concise objective when starting adaptive main-runtime work before a plan is recorded.' },
      summary: { type: 'string', description: 'Bounded progress, result, or failure text.' },
      approval_reason: { type: 'string', description: 'Concise human-facing decision being requested. Required for request_approval.' },
      evidence_ids: { type: 'array', items: { type: 'string' } },
      artifact_ids: { type: 'array', items: { type: 'string' } },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => false,
    async execute(args, execution) {
      if (execution.agent === undefined) throw new Error('hivemind-operating-workstreams: active agent required')
      const input = record(args as JsonValue, 'arguments')
      const action = text(input['action'], 'action', 20)
      const requestedWorkstreamId = text(input['workstream_id'], 'workstream_id', 100)
      const workstreamId = service.canonicalWorkstreamId(execution.agent, requestedWorkstreamId)
      if (action === 'start') {
        const plan = latestPlan(execution.agent)
        const terminal = plan === undefined ? undefined : terminalWorkstream(execution.agent, plan.planId, workstreamId)
        if (terminal !== undefined && plan !== undefined) {
          return { status: terminal.status, already_terminal: true, plan_id: plan.planId, workstream_id: workstreamId }
        }
        const started = startedCoordinates(execution.agent, workstreamId)
        if (started !== undefined) {
          return { status: 'running', already_started: true, plan_id: started.planId, workstream_id: workstreamId }
        }
        const objective = input['objective'] === undefined ? undefined : text(input['objective'], 'objective', maxSummaryChars)
        const workstream = await service.start(execution.agent, workstreamId, execution.signal, objective)
        updateWorkstreamTodo(execution.agent.session as unknown as SessionLike, workstreamId, 'in_progress')
        return { status: 'running', workstream } as unknown as Record<string, JsonValue>
      }
      const coordinates = service.coordinates(execution.agent, workstreamId)
      if (action === 'request_approval') {
        const plan = latestPlan(execution.agent)
        const workstream = plan?.workstreams.find(item => item.id === workstreamId)
        if (workstream?.approvalRequired !== true) throw new Error('hivemind-operating-workstreams: the current plan does not require approval for this workstream')
        if (startedCoordinates(execution.agent, workstreamId) === undefined) {
          await service.start(execution.agent, workstreamId, execution.signal)
          updateWorkstreamTodo(execution.agent.session as unknown as SessionLike, workstreamId, 'in_progress')
        }
        const reason = text(input['approval_reason'], 'approval_reason', maxSummaryChars)
        const presets = ctx.get('permissionPresets') as { current(session: Agent['session']): string } | undefined
        const outcome = presets?.current(execution.agent.session) === 'danger-full-access' ? 'allowed-once' as const
          : await ctx.approval.request({ agent: execution.agent, toolName: 'hivemind_workstream', reason, signal: execution.signal })
        execution.agent.session.append('hivemind/workstream-approval', { ...coordinates, workstreamId, outcome, reason })
        return { status: outcome === 'allowed-once' ? 'approved' : 'not_approved', outcome, plan_id: coordinates.planId, workstream_id: workstreamId }
      }
      const summary = text(input['summary'], 'summary', maxSummaryChars)
      if (action === 'evidence_gap') {
        execution.agent.session.append('hivemind/evidence-gap-recorded', { ...coordinates, workstreamId, summary })
        return { status: 'research_reopened', plan_id: coordinates.planId, workstream_id: workstreamId }
      }
      const terminal = terminalWorkstream(execution.agent, coordinates.planId, workstreamId)
      if (terminal !== undefined && (action === 'complete' || action === 'fail')) {
        return { status: terminal.status, already_terminal: true, plan_id: coordinates.planId, workstream_id: workstreamId }
      }
      if (action === 'progress') execution.agent.session.append('hivemind/workstream-progress', { ...coordinates, workstreamId, summary })
      else if (action === 'complete') {
        const plan = latestPlan(execution.agent)
        const workstream = plan?.workstreams.find(item => item.id === workstreamId)
        if (workstream?.approvalRequired === true && !workstreamApprovalGranted(execution.agent, coordinates.planId, workstreamId)) {
          throw new Error('hivemind-operating-workstreams: completion requires a real allowed-once approval receipt for this workstream')
        }
        execution.agent.session.append('hivemind/workstream-completed', { ...coordinates, workstreamId, summary, evidenceIds: list(input['evidence_ids'], 'evidence_ids'), artifactIds: list(input['artifact_ids'], 'artifactIds') })
        updateWorkstreamTodo(execution.agent.session as unknown as SessionLike, workstreamId, 'completed')
      }
      else if (action === 'fail') execution.agent.session.append('hivemind/workstream-failed', { ...coordinates, workstreamId, diagnostic: summary })
      else throw new TypeError('hivemind-operating-workstreams: unsupported action')
      return { status: action === 'complete' ? 'completed' : action === 'fail' ? 'failed' : 'running', plan_id: coordinates.planId, workstream_id: workstreamId }
    },
    presentCall(args) { return { card: 'generic', title: 'Run HIVE-MIND workstream', kind: 'read', rawInput: String(args.workstream_id ?? '') } },
  }))
}
