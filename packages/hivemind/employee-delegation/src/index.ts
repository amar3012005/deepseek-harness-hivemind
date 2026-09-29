/** Authenticated employee delegation over the native Harness subagent seam. @module @deepseek-ai/dsh-hivemind-employee-delegation */

import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-hivemind-employee-directory'
import type {} from '@deepseek-ai/dsh-hivemind-operating-workstreams'

export const name = 'hivemind-employee-delegation'
// Jobs remain available for explicitly asynchronous employee work. Foreground
// native children are the default because their result returns in the same
// tool step, avoiding an extra completion/read model cycle.
export const inject = ['tools', 'subagents', 'jobs', 'hivemindEmployeeDirectory', 'hivemindOperatingRuns']

/** Deployment-owned limits and child capability restrictions. */
export interface Config {
  provider: string
  maxDepth: number
  maxTaskChars: number
  maxOutputTokens: number
  outputPreviewChars: number
  maxDurationMs: number
  denyChildTools: string[]
  runInBackground: boolean
  maxPanelAssignments: number
}

export const Config: z<Config> = z.object({
  provider: z.string().default('spawn'),
  maxDepth: z.natural().min(1).default(1),
  maxTaskChars: z.natural().min(1).default(16_000),
  maxOutputTokens: z.natural().min(1).default(4096),
  outputPreviewChars: z.natural().min(1).max(8_000).default(2_000),
  maxDurationMs: z.natural().min(1).default(120_000),
  denyChildTools: z.array(z.string()).default(['hivemind_delegate_employee', 'subagent_fork', 'workflow', 'ralph']),
  runInBackground: z.boolean().default(false),
  maxPanelAssignments: z.natural().min(2).max(8).default(5),
})

interface SelectedPlaybook {
  readonly id: string
  readonly version: string
}

interface EmployeeDelegationStart {
  readonly delegationId: string
  readonly panelId?: string
  /** Native Harness background job id when the child is executed asynchronously. */
  readonly jobId?: string
  /** A queued child has been durably accepted but has not produced its handoff yet. */
  readonly executionState?: 'pending'
  readonly workstreamId?: string
  readonly employeeId: string
  readonly employeeName: string
  readonly role: string
  readonly profileVersion?: string
  readonly personaSha256: string
  readonly provider: string
  readonly task: string
  readonly reason: string
  readonly requestedOutput?: string
  readonly acceptanceCriteria: readonly string[]
  readonly selectedPlaybooks: readonly SelectedPlaybook[]
  readonly parentRun: { readonly sessionId: string; readonly runId?: string; readonly planSeq?: number }
  readonly budget: { readonly maxOutputTokens: number; readonly maxDurationMs: number; readonly maxDepth: number }
  readonly modelRoute: {
    readonly provider?: string
    readonly model?: string
    readonly reasoningEffort?: string
    readonly maxTokens?: number
  }
  readonly effectiveToolPolicy: { readonly deny: readonly string[] }
  readonly profilePolicySha256?: string
  readonly personaContractSha256?: string
  readonly profileToolsSha256?: string
}

interface EmployeeDelegationEnd {
  readonly delegationId: string
  readonly panelId?: string
  readonly workstreamId?: string
  readonly employeeId: string
  readonly childSessionId?: string
  readonly status: 'completed' | 'failed'
  readonly stopReason?: SubagentStopReason
  readonly diagnostic?: string
  readonly outputSha256?: string
  readonly outputChars?: number
  readonly outputPreview?: string
}

/**
 * Narrow, host-owned jobs seam. Keeping this structural avoids forcing every
 * composition that can delegate a short child to load jobs, while the full
 * HyperAgents composition gets native background lifecycle and wake-up.
 */
interface EmployeeJobRegistry {
  start(spec: {
    kind: string
    label: string
    owner: Agent
    outputLimitBytes: number
    run(): { cancel(reason?: string): void; done: Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string; output?: string }> }
  }): string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Records immutable employee identity, assignment, model budget, evidence scope,
     * and effective child policy before native child publication.
     * Profile-body digests prevent later edits from reinterpreting the assignment
     * without copying sensitive or bulky source content.
     */
    'hivemind/employee-delegation-start': EmployeeDelegationStart
    /**
     * Records terminal status, native child identity, diagnostic, and output
     * fingerprint for one attempted employee delegation. Its identifier pairs
     * with the start record even when child startup rejects before publication.
     */
    'hivemind/employee-delegation-end': EmployeeDelegationEnd
  }
}

function asRecord(value: JsonValue, label: string): Record<string, JsonValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`hivemind-employee-delegation: ${label} must be an object`)
  return value as Record<string, JsonValue>
}

function requiredText(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`hivemind-employee-delegation: ${label} must be a non-empty string`)
  return value.trim()
}

function optionalText(value: JsonValue | undefined, label: string): string | undefined {
  if (value === undefined) return undefined
  return requiredText(value, label)
}

function digestJson(value: JsonValue | undefined): string | undefined {
  if (value === undefined) return undefined
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function latestOperatingContext(parent: Agent): { parentRun: EmployeeDelegationStart['parentRun']; selectedPlaybooks: readonly SelectedPlaybook[] } {
  const events = parent.session.snapshotEvents() as ReadonlyArray<{ readonly type: string; readonly seq: number; readonly data: unknown }>
  const plan = events.findLast(event => event.type === 'hivemind/run-plan' || event.type === 'hivemind/run-plan-revised')
  const selectedPlaybooks: SelectedPlaybook[] = []
  if (typeof plan?.data === 'object' && plan.data !== null && !Array.isArray(plan.data)) {
    const raw = (plan.data as { playbooks?: unknown }).playbooks
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
        const id = (item as { id?: unknown }).id
        const version = (item as { version?: unknown }).version
        if (typeof id === 'string' && id.trim() !== '' && typeof version === 'string' && version.trim() !== '') {
          selectedPlaybooks.push({ id: id.trim(), version: version.trim() })
        }
      }
    }
  }
  const runId = typeof plan?.data === 'object' && plan.data !== null && !Array.isArray(plan.data)
    ? (plan.data as { runId?: unknown }).runId
    : undefined
  return {
    parentRun: { sessionId: String(parent.session.id), ...(typeof runId === 'string' && runId.trim() !== '' ? { runId } : {}), ...(plan === undefined ? {} : { planSeq: plan.seq }) },
    selectedPlaybooks,
  }
}

function selectedEmployeeActorKind(parent: Agent, employeeId: string): string | undefined {
  const events = parent.session.snapshotEvents() as ReadonlyArray<{ readonly type: string; readonly data: unknown }>
  const plan = events.findLast(event => event.type === 'hivemind/run-plan' || event.type === 'hivemind/run-plan-revised')
  if (typeof plan?.data !== 'object' || plan.data === null || Array.isArray(plan.data)) return undefined
  const raw = (plan.data as { workstreams?: unknown }).workstreams
  if (!Array.isArray(raw)) return undefined
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const actor = (item as { actor?: unknown }).actor
    if (typeof actor !== 'object' || actor === null || Array.isArray(actor)) continue
    const candidate = actor as { employeeId?: unknown; kind?: unknown }
    if (candidate.employeeId === employeeId && typeof candidate.kind === 'string') return candidate.kind
  }
  return undefined
}

/** Read an optional profile-version label without treating profile metadata shape as an execution gate. */
function profileVersion(value: JsonValue | undefined): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, JsonValue>
  for (const key of ['version', 'version_label', 'id']) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return undefined
}

function currentAgent(agent: Agent | undefined): Agent {
  if (agent === undefined) throw new Error('hivemind-employee-delegation: this tool requires an active agent')
  return agent
}

function nativeJobs(ctx: Context): EmployeeJobRegistry | undefined {
  const get = (ctx as unknown as { get?: (name: string) => unknown }).get
  return typeof get === 'function' ? get.call(ctx, 'jobs') as EmployeeJobRegistry | undefined : undefined
}

function profileSnapshot(profile: Record<string, JsonValue>): {
  id: string
  name: string
  role: string
  persona: string
  version?: string
} {
  const id = requiredText(profile['id'], 'employee id')
  const name = requiredText(profile['name'], 'employee name')
  const persona = requiredText(profile['persona'], 'employee persona')
  const role = optionalText(profile['role_archetype'], 'employee role') ?? 'HIVE-MIND employee'
  const version = profileVersion(profile['active_prompt_version'])
  return { id, name, role, persona, ...(version === undefined ? {} : { version }) }
}

function employeePersona(employee: { name: string; role: string; persona: string }): string {
  return `You are ${employee.name}, a verified HIVE-MIND employee acting as ${employee.role}. Your employee persona is below. Work only on the assigned task, distinguish evidence from assumptions, do not claim unexecuted external actions, and return a concise handoff to the parent agent.\n\n${employee.persona}`
}

function taskPrompt(
  employee: { name: string; role: string }, task: string,
  acceptanceCriteria: readonly string[], selectedPlaybooks: readonly SelectedPlaybook[],
): string {
  const playbookContext = selectedPlaybooks.length === 0
    ? ''
    : `\n\nOperating playbooks selected by the parent:\n${selectedPlaybooks.map(item => `- ${item.id}@${item.version}`).join('\n')}`
  return `You are assigned as ${employee.name} (${employee.role}).\n\nTask:\n${task}\n\nAcceptance criteria:\n${acceptanceCriteria.map(item => `- ${item}`).join('\n')}${playbookContext}\n\nComplete this bounded assignment directly. The parent already resolved company context, your identity, the operating plan, and the selected playbooks; do not call operating-context, operating-plan, employee-directory, or playbook discovery again. Treat facts supplied in the task as parent-provided evidence and identify any uncertainty in the handoff. Do not repeat research already being handled by the parent. When this assignment explicitly requires new external evidence, lease the research capability once if needed, issue at most one bounded parallel hivemind_research_gather call covering the independent evidence questions, and then synthesize immediately from that receipt without follow-up search or fetch rounds. Never guess a source or URL. Return only the completed work product, supporting evidence or explicit assumptions, and material blockers for the parent agent.`
}

function pendingEmployeeDelegation(events: ReadonlyArray<{ readonly type: string; readonly data: unknown }>): boolean {
  const pending = new Set<string>()
  for (const event of events) {
    if (typeof event.data !== 'object' || event.data === null) continue
    const data = event.data as { delegationId?: unknown; executionState?: unknown }
    if (typeof data.delegationId !== 'string') continue
    if (event.type === 'hivemind/employee-delegation-start' && data.executionState === 'pending') pending.add(data.delegationId)
    if (event.type === 'hivemind/employee-delegation-end') pending.delete(data.delegationId)
  }
  return pending.size > 0
}

function completedPanelId(agent: Agent, planSeq: number | undefined): string | undefined {
  if (planSeq === undefined) return undefined
  const events = agent.session.snapshotEvents() as ReadonlyArray<{ readonly type: string; readonly data: unknown }>
  const starts = events.filter(event => event.type === 'hivemind/employee-delegation-start'
    && typeof event.data === 'object' && event.data !== null
    && (event.data as { panelId?: unknown; parentRun?: { planSeq?: unknown } }).parentRun?.planSeq === planSeq
    && typeof (event.data as { panelId?: unknown }).panelId === 'string')
  for (const start of starts) {
    const data = start.data as { panelId: string; delegationId: string }
    const ended = events.some(event => event.type === 'hivemind/employee-delegation-end'
      && typeof event.data === 'object' && event.data !== null
      && (event.data as { delegationId?: unknown }).delegationId === data.delegationId)
    if (ended) return data.panelId
  }
  return undefined
}

/** Register the tenant-scoped model tool and its durable start/end records. */
export function apply(ctx: Context, config: Partial<Config> = {}): void {
  const provider = config.provider ?? 'spawn'
  const maxDepth = config.maxDepth ?? 1
  const maxTaskChars = config.maxTaskChars ?? 16_000
  const maxOutputTokens = config.maxOutputTokens ?? 4096
  const outputPreviewChars = config.outputPreviewChars ?? 2_000
  const maxDurationMs = config.maxDurationMs ?? 120_000
  const maxPanelAssignments = config.maxPanelAssignments ?? 5
  const denyChildTools = config.denyChildTools ?? ['hivemind_delegate_employee', 'subagent_fork', 'workflow', 'ralph']
  const continuedTurns = new WeakMap<Agent, Set<number>>()

  // A provider may finish after tool use without a visible answer. Continue the
  // exact turn once for synthesis, without imposing employee participation.
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const events = agent.session.snapshotEvents() as ReadonlyArray<{ readonly type: string; readonly data: unknown }>
    const boundary = events.findLastIndex(event => event.type === 'turn/start'
      && typeof event.data === 'object' && event.data !== null
      && (event.data as { turn?: unknown }).turn === turn)
    const current = boundary < 0 ? events : events.slice(boundary)
    // A queued employee owns the next continuation. Waking now teaches the
    // model to poll job_output and repeats the entire prompt; the terminal
    // child receipt below resumes the parent exactly once instead.
    if (pendingEmployeeDelegation(current)) return
    const hasToolCall = current.some(event => event.type === 'tool/call')
    const hasVisibleAnswer = current.some((event) => {
      if (event.type !== 'assistant/message' || typeof event.data !== 'object' || event.data === null) return false
      const message = (event.data as { message?: unknown }).message
      if (typeof message !== 'object' || message === null) return false
      const content = (message as { content?: unknown }).content
      return Array.isArray(content) && content.some(block => typeof block === 'object' && block !== null
        && (block as { type?: unknown }).type === 'text'
        && typeof (block as { text?: unknown }).text === 'string'
        && (block as { text: string }).text.trim() !== '')
    })
    const needsVisibleCompletion = hasToolCall && !hasVisibleAnswer
    if (!needsVisibleCompletion) return
    const continued = continuedTurns.get(agent) ?? new Set<number>()
    if (continued.has(turn)) return
    continued.add(turn)
    continuedTurns.set(agent, continued)
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: 'Complete the current work now with a visible final handoff. Follow the recorded operating plan, use the evidence already gathered, state material limitations, and do not end on private reasoning or a promise of another step.' }],
      source: { kind: 'plugin', plugin: name },
    }))
  })

  ctx.tools.register(defineTool({
    name: 'hivemind_employee_panel',
    description: 'Run two or more independent plan-selected assignments concurrently through exact authenticated HIVE-MIND employees. Use one panel call when independent employee perspectives, specialist work, or challenge would materially improve the result. The coordinator freezes each profile, starts native Harness children in parallel, preserves their ordinary delegation receipts, and returns one compact handoff. Use hivemind_delegate_employee for one assignment.',
    parameters: {
      assignments: {
        type: 'array',
        required: true,
        description: `Two to ${maxPanelAssignments} independent employee assignments selected by the operating plan.`,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            employee_id: { type: 'string', required: true, description: 'Exact employee id from the authenticated directory.' },
            task: { type: 'string', required: true, description: 'Self-contained bounded assignment.' },
            outcome: { type: 'string', description: 'Optional acceptance target.' },
          },
        },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = asRecord(args as JsonValue, 'arguments')
      if (!Array.isArray(input['assignments'])) throw new TypeError('hivemind-employee-delegation: assignments must be an array')
      if (input['assignments'].length < 2 || input['assignments'].length > maxPanelAssignments) {
        throw new TypeError(`hivemind-employee-delegation: panel requires 2 to ${maxPanelAssignments} assignments`)
      }
      const assignments = input['assignments'].map((value, index) => {
        const item = asRecord(value, `assignments[${index}]`)
        const employeeId = requiredText(item['employee_id'], `assignments[${index}].employee_id`)
        const task = requiredText(item['task'], `assignments[${index}].task`)
        const outcome = optionalText(item['outcome'], `assignments[${index}].outcome`)
        if (task.length > maxTaskChars || (outcome?.length ?? 0) > maxTaskChars) {
          throw new Error(`hivemind-employee-delegation: task fields exceed the ${maxTaskChars} character limit`)
        }
        return { employeeId, task, outcome }
      })
      if (new Set(assignments.map(item => item.employeeId)).size !== assignments.length) {
        throw new TypeError('hivemind-employee-delegation: panel employee ids must be unique')
      }
      const parent = currentAgent(exec.agent)
      for (const assignment of assignments) {
        if (selectedEmployeeActorKind(parent, assignment.employeeId) === 'inline_employee') {
          throw new Error(`hivemind-employee-delegation: the active plan selected inline_employee for ${assignment.employeeId}; use hivemind_workstream or revise the plan`)
        }
      }
      const operatingContext = latestOperatingContext(parent)
      const previousPanelId = completedPanelId(parent, operatingContext.parentRun.planSeq)
      if (previousPanelId !== undefined) return {
        status: 'already_completed',
        panel_id: previousPanelId,
        next: 'This operating plan already completed its employee panel. Synthesize from the recorded handoffs or revise the plan before assigning materially different work.',
      }
      const directory = await ctx.hivemindEmployeeDirectory.profiles(exec.signal)
      const profiles = new Map(directory.profiles.map(profile => [profile['id'], profile]))
      const employees = assignments.map((assignment) => {
        const rawProfile = profiles.get(assignment.employeeId)
        if (rawProfile === undefined) throw new Error(`hivemind-employee-delegation: employee ${assignment.employeeId} is not in the authenticated organization directory`)
        return { assignment, rawProfile, employee: profileSnapshot(rawProfile) }
      })
      const panelId = `panel-${randomUUID()}`
      const effectiveMaxOutputTokens = Math.min(maxOutputTokens, parent.options.maxTokens ?? maxOutputTokens)
      const operatingRuns = (ctx as unknown as {
        hivemindOperatingRuns?: {
          startPlanSelectedEmployeeChild(agent: Agent, employeeId: string): { workstreamId: string } | undefined
          completeEmployeeChild(agent: Agent, workstreamId: string, summary: string): void
          failEmployeeChild(agent: Agent, workstreamId: string, diagnostic: string): void
        }
      }).hivemindOperatingRuns
      const prepared = employees.map(({ assignment, rawProfile, employee }) => {
        const workstreamId = operatingRuns?.startPlanSelectedEmployeeChild(parent, employee.id)?.workstreamId
        const delegationId = randomUUID()
        const acceptanceCriteria = [assignment.outcome ?? 'Return completed work, supporting evidence or explicit assumptions, and material blockers.']
        const profilePolicySha256 = digestJson(rawProfile['policy_rules'])
        const personaContractSha256 = digestJson(rawProfile['persona_contract'])
        const profileToolsSha256 = digestJson(rawProfile['tools'])
        const start: EmployeeDelegationStart = {
          delegationId,
          panelId,
          ...(workstreamId === undefined ? {} : { workstreamId }),
          employeeId: employee.id,
          employeeName: employee.name,
          role: employee.role,
          ...(employee.version === undefined ? {} : { profileVersion: employee.version }),
          personaSha256: createHash('sha256').update(employee.persona).digest('hex'),
          provider,
          task: assignment.task,
          reason: 'Selected by the parent operating plan for concurrent independent work.',
          ...(assignment.outcome === undefined ? {} : { requestedOutput: assignment.outcome }),
          acceptanceCriteria,
          selectedPlaybooks: operatingContext.selectedPlaybooks,
          parentRun: operatingContext.parentRun,
          budget: { maxOutputTokens: effectiveMaxOutputTokens, maxDurationMs, maxDepth },
          modelRoute: {
            ...(parent.options.provider === undefined ? {} : { provider: parent.options.provider }),
            ...(parent.options.model === undefined ? {} : { model: parent.options.model }),
            ...(parent.options.reasoningEffort === undefined ? {} : { reasoningEffort: parent.options.reasoningEffort }),
            ...(parent.options.maxTokens === undefined ? {} : { maxTokens: parent.options.maxTokens }),
          },
          effectiveToolPolicy: { deny: [...denyChildTools] },
          ...(profilePolicySha256 === undefined ? {} : { profilePolicySha256 }),
          ...(personaContractSha256 === undefined ? {} : { personaContractSha256 }),
          ...(profileToolsSha256 === undefined ? {} : { profileToolsSha256 }),
        }
        parent.session.append('hivemind/employee-delegation-start', start)
        return { assignment, employee, acceptanceCriteria, delegationId, workstreamId }
      })
      const settled = await Promise.allSettled(prepared.map(async (item) => {
        let run: Awaited<ReturnType<typeof ctx.subagents.start>> | undefined
        try {
          const operationSignal = AbortSignal.any([exec.signal, AbortSignal.timeout(maxDurationMs)])
          run = await ctx.subagents.start(provider, {
            label: `${item.employee.name}: ${item.assignment.task.slice(0, 96)}`,
            parent,
            signal: operationSignal,
            prompt: [{ type: 'text', text: taskPrompt(item.employee, item.assignment.task, item.acceptanceCriteria, operatingContext.selectedPlaybooks) }],
            persona: employeePersona(item.employee),
            toolFilter: { deny: denyChildTools },
            maxDepth,
            agentOptions: { maxTokens: effectiveMaxOutputTokens },
          })
          const result = await run.result
          const outputText = result.output.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
          const status = result.stopReason === 'completed' ? 'completed' : 'failed'
          parent.session.append('hivemind/employee-delegation-end', {
            delegationId: item.delegationId, panelId,
            ...(item.workstreamId === undefined ? {} : { workstreamId: item.workstreamId }),
            employeeId: item.employee.id,
            childSessionId: run.id, status, stopReason: result.stopReason,
            ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
            outputSha256: createHash('sha256').update(outputText).digest('hex'), outputChars: outputText.length,
            ...(outputText.length === 0 ? {} : { outputPreview: outputText.slice(0, outputPreviewChars) }),
          })
          if (item.workstreamId !== undefined) {
            if (status === 'completed') operatingRuns?.completeEmployeeChild(
              parent, item.workstreamId, outputText.slice(0, outputPreviewChars) || 'Employee workstream completed.',
            )
            else operatingRuns?.failEmployeeChild(parent, item.workstreamId, result.diagnostic ?? `Child stopped: ${result.stopReason}`)
          }
          return {
            employee: { id: item.employee.id, name: item.employee.name, role: item.employee.role },
            child_session_id: run.id, status, output_text: outputText,
            ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
          }
        } catch (error: unknown) {
          const diagnostic = error instanceof Error ? error.message : String(error)
          parent.session.append('hivemind/employee-delegation-end', { delegationId: item.delegationId, panelId, ...(item.workstreamId === undefined ? {} : { workstreamId: item.workstreamId }), employeeId: item.employee.id, status: 'failed', diagnostic })
          if (item.workstreamId !== undefined) operatingRuns?.failEmployeeChild(parent, item.workstreamId, diagnostic)
          return { employee: { id: item.employee.id, name: item.employee.name, role: item.employee.role }, status: 'failed' as const, diagnostic, output_text: '' }
        } finally {
          if (run !== undefined) await run.dispose()
        }
      }))
      const results = settled.map(result => result.status === 'fulfilled' ? result.value : { status: 'failed' as const, diagnostic: String(result.reason), output_text: '' })
      const completed = results.filter(result => result.status === 'completed').length
      return {
        status: completed === results.length ? 'completed' : completed > 0 ? 'partial' : 'failed',
        panel_id: panelId,
        completed,
        failed: results.length - completed,
        results,
        next: completed === 0 ? 'Report the employee panel failure and continue only with other grounded evidence.' : 'Synthesize from these independent employee handoffs and the other recorded evidence. Do not run another panel for this plan.',
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Convene HIVE-MIND employee panel', kind: 'read', rawInput: 'parallel employee panel' }),
  }))

  ctx.tools.register(defineTool({
    name: 'hivemind_delegate_employee',
    description: 'Delegate one bounded task to an exact authenticated HIVE-MIND employee. Supply only the employee, task, and optional desired outcome; Harness derives the frozen assignment, limits, playbooks, and audit receipt.',
    parameters: {
      employee_id: { type: 'string', required: true, description: 'Exact employee id from the authenticated HIVE-MIND employee directory.' },
      task: { type: 'string', required: true, description: 'Complete self-contained task assigned to this employee.' },
      outcome: { type: 'string', description: 'Optional concise result or acceptance target.' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = asRecord(args as JsonValue, 'arguments')
      const employeeId = requiredText(input['employee_id'], 'employee_id')
      const task = requiredText(input['task'], 'task')
      const outcome = optionalText(input['outcome'], 'outcome')
      if (task.length > maxTaskChars || (outcome?.length ?? 0) > maxTaskChars) {
        throw new Error(`hivemind-employee-delegation: task fields exceed the ${maxTaskChars} character limit`)
      }
      const parent = currentAgent(exec.agent)
      if (selectedEmployeeActorKind(parent, employeeId) === 'inline_employee') {
        throw new Error(`hivemind-employee-delegation: the active plan selected inline_employee for ${employeeId}; use hivemind_workstream or revise the plan`)
      }
      const operatingContext = latestOperatingContext(parent)
      const acceptanceCriteria = [outcome ?? 'Return completed work, supporting evidence or explicit assumptions, and material blockers.']
      const effectiveMaxOutputTokens = Math.min(maxOutputTokens, parent.options.maxTokens ?? maxOutputTokens)
      const reason = 'Selected by the parent runtime for this bounded task.'
      const directory = await ctx.hivemindEmployeeDirectory.profiles(exec.signal)
      const rawProfile = directory.profiles.find(profile => profile['id'] === employeeId)
      if (rawProfile === undefined) throw new Error('hivemind-employee-delegation: employee is not in the authenticated organization directory')
      const employee = profileSnapshot(rawProfile)
      // Production composition always supplies the operating-run service. The
      // optional form keeps this delegation capability usable in narrow test
      // and standalone compositions, where there is no operating plan to
      // correlate in the first place.
      const operatingRuns = (ctx as unknown as {
        hivemindOperatingRuns?: { startPlanSelectedEmployeeChild(agent: Agent, employeeId: string): { workstreamId: string } | undefined }
      }).hivemindOperatingRuns
      const selectedChild = operatingRuns?.startPlanSelectedEmployeeChild(parent, employee.id)
      const workstreamId = selectedChild?.workstreamId
      const delegationId = randomUUID()
      const profilePolicySha256 = digestJson(rawProfile['policy_rules'])
      const personaContractSha256 = digestJson(rawProfile['persona_contract'])
      const profileToolsSha256 = digestJson(rawProfile['tools'])
      const start: EmployeeDelegationStart = {
        delegationId,
        ...(workstreamId === undefined ? {} : { workstreamId }),
        employeeId: employee.id,
        employeeName: employee.name,
        role: employee.role,
        ...(employee.version === undefined ? {} : { profileVersion: employee.version }),
        personaSha256: createHash('sha256').update(employee.persona).digest('hex'),
        provider,
        task,
        reason,
        ...(outcome === undefined ? {} : { requestedOutput: outcome }),
        acceptanceCriteria,
        selectedPlaybooks: operatingContext.selectedPlaybooks,
        parentRun: operatingContext.parentRun,
        budget: { maxOutputTokens: effectiveMaxOutputTokens, maxDurationMs, maxDepth },
        modelRoute: {
          ...(parent.options.provider === undefined ? {} : { provider: parent.options.provider }),
          ...(parent.options.model === undefined ? {} : { model: parent.options.model }),
          ...(parent.options.reasoningEffort === undefined ? {} : { reasoningEffort: parent.options.reasoningEffort }),
          ...(parent.options.maxTokens === undefined ? {} : { maxTokens: parent.options.maxTokens }),
        },
        effectiveToolPolicy: { deny: [...denyChildTools] },
        ...(profilePolicySha256 === undefined ? {} : { profilePolicySha256 }),
        ...(personaContractSha256 === undefined ? {} : { personaContractSha256 }),
        ...(profileToolsSha256 === undefined ? {} : { profileToolsSha256 }),
      }
      const assignment = {
        parent_run: operatingContext.parentRun,
        acceptance_criteria: acceptanceCriteria,
        playbooks: operatingContext.selectedPlaybooks.map(item => ({ id: item.id, version: item.version })),
        budget: { max_output_tokens: effectiveMaxOutputTokens, max_duration_ms: maxDurationMs, max_depth: maxDepth },
        review_status: 'unreviewed' as const,
      }
      const employeeCard = {
        id: employee.id, name: employee.name, role: employee.role,
        ...(employee.version === undefined ? {} : { profile_version: employee.version }),
      }
      const jobs = nativeJobs(ctx)
      if (jobs !== undefined && config.runInBackground) {
        const jobId = jobs.start({
          kind: 'hivemind_employee',
          label: `${employee.name}: ${task.slice(0, 96)}`,
          owner: parent,
          outputLimitBytes: outputPreviewChars,
          run() {
            const controller = new AbortController()
            const done = (async () => {
              let run: Awaited<ReturnType<typeof ctx.subagents.start>> | undefined
              try {
                const operationSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(maxDurationMs)])
                run = await ctx.subagents.start(provider, {
                  label: `${employee.name}: ${task.slice(0, 96)}`,
                  parent,
                  signal: operationSignal,
                  prompt: [{ type: 'text', text: taskPrompt(employee, task, acceptanceCriteria, operatingContext.selectedPlaybooks) }],
                  persona: employeePersona(employee),
                  toolFilter: { deny: denyChildTools },
                  maxDepth,
                  agentOptions: { maxTokens: effectiveMaxOutputTokens },
                })
                const result = await run.result
                const outputText = result.output.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
                const status = result.stopReason === 'completed' ? 'completed' : 'failed'
                parent.session.append('hivemind/employee-delegation-end', {
                  delegationId,
                  ...(workstreamId === undefined ? {} : { workstreamId }),
                  employeeId: employee.id,
                  childSessionId: run.id,
                  status,
                  stopReason: result.stopReason,
                  ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
                  outputSha256: createHash('sha256').update(outputText).digest('hex'),
                  outputChars: outputText.length,
                  ...(outputText.length === 0 ? {} : { outputPreview: outputText.slice(0, outputPreviewChars) }),
                })
                if (workstreamId !== undefined) {
                  if (status === 'completed') ctx.hivemindOperatingRuns.completeEmployeeChild(parent, workstreamId, outputText.slice(0, outputPreviewChars) || 'Employee workstream completed.')
                  else ctx.hivemindOperatingRuns.failEmployeeChild(parent, workstreamId, result.diagnostic ?? `Child stopped: ${result.stopReason}`)
                }
                return {
                  status: status === 'completed' ? 'completed' as const : 'failed' as const,
                  ...(status === 'completed' ? { output: outputText } : { detail: result.diagnostic ?? `Child stopped: ${result.stopReason}`, output: outputText }),
                }
              } catch (error: unknown) {
                const diagnostic = error instanceof Error ? error.message : String(error)
                parent.session.append('hivemind/employee-delegation-end', { delegationId, ...(workstreamId === undefined ? {} : { workstreamId }), employeeId: employee.id, status: 'failed', diagnostic })
                if (workstreamId !== undefined) ctx.hivemindOperatingRuns.failEmployeeChild(parent, workstreamId, diagnostic)
                return { status: controller.signal.aborted ? 'killed' as const : 'failed' as const, detail: diagnostic, output: diagnostic }
              } finally {
                if (run !== undefined) await run.dispose()
              }
            })()
            return { cancel: () => controller.abort(), done }
          },
        })
        parent.session.append('hivemind/employee-delegation-start', { ...start, jobId, executionState: 'pending' })
        return {
          status: 'pending',
          delegation_id: delegationId,
          job_id: jobId,
          employee: employeeCard,
          assignment,
          next: 'The employee is working asynchronously. Continue independent work; native Harness will notify this session when job_output is ready.',
        }
      }
      parent.session.append('hivemind/employee-delegation-start', start)
      let run: Awaited<ReturnType<typeof ctx.subagents.start>> | undefined
      try {
        const operationSignal = AbortSignal.any([exec.signal, AbortSignal.timeout(maxDurationMs)])
        run = await ctx.subagents.start(provider, {
          label: `${employee.name}: ${task.slice(0, 96)}`,
          parent,
          signal: operationSignal,
          prompt: [{ type: 'text', text: taskPrompt(employee, task, acceptanceCriteria, operatingContext.selectedPlaybooks) }],
          persona: employeePersona(employee),
          toolFilter: { deny: denyChildTools },
          maxDepth,
          agentOptions: { maxTokens: effectiveMaxOutputTokens },
        })
        const result = await run.result
        const outputText = result.output.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
        const status = result.stopReason === 'completed' ? 'completed' : 'failed'
        parent.session.append('hivemind/employee-delegation-end', {
          delegationId,
          ...(workstreamId === undefined ? {} : { workstreamId }),
          employeeId: employee.id,
          childSessionId: run.id,
          status,
          stopReason: result.stopReason,
          ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
          outputSha256: createHash('sha256').update(outputText).digest('hex'),
          outputChars: outputText.length,
          ...(outputText.length === 0 ? {} : { outputPreview: outputText.slice(0, outputPreviewChars) }),
        })
        if (workstreamId !== undefined) {
          if (status === 'completed') ctx.hivemindOperatingRuns.completeEmployeeChild(parent, workstreamId, outputText.slice(0, outputPreviewChars) || 'Employee workstream completed.')
          else ctx.hivemindOperatingRuns.failEmployeeChild(parent, workstreamId, result.diagnostic ?? `Child stopped: ${result.stopReason}`)
        }
        return {
          status,
          delegation_id: delegationId,
          employee: employeeCard,
          assignment,
          child_session_id: run.id,
          stop_reason: result.stopReason,
          ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
          output_text: outputText,
        }
      } catch (error: unknown) {
        const diagnostic = error instanceof Error ? error.message : String(error)
        parent.session.append('hivemind/employee-delegation-end', { delegationId, ...(workstreamId === undefined ? {} : { workstreamId }), employeeId: employee.id, status: 'failed', diagnostic })
        if (workstreamId !== undefined) ctx.hivemindOperatingRuns.failEmployeeChild(parent, workstreamId, diagnostic)
        throw error
      } finally {
        if (run !== undefined) await run.dispose()
      }
    },
    presentCall(args) { return { card: 'generic', title: 'Delegate to HIVE-MIND employee', kind: 'read', rawInput: String(args.employee_id ?? '') } },
  }))
}
