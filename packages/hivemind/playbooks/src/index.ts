/** Progressive company playbook retrieval and run-plan receipts. @module @deepseek-ai/dsh-hivemind-playbooks */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tool-todo/types'
import '@deepseek-ai/dsh-hivemind-memory'
import { createUserMessage, ReasoningEffortId, type LlmCallConfig, type ToolSchema } from '@deepseek-ai/dsh-llm'
import { joinContextSections, renderContextSections, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { PLAYBOOKS, type Playbook, type PlaybookLevel } from './catalog.ts'
import { registerFieldMethods } from './field-methods.ts'

export const name = 'hivemind-playbooks'
export const inject = ['tools', 'hivemindMemory']

/** Deployment-owned retrieval bounds. */
export interface Config {
  maxSearchResults: number
  maxSelectedPlaybooks: number
  maxObjectiveChars: number
  maxOperatingEmployees: number
  maxOperatingEvidenceItems: number
  maxOperatingEvidenceChars: number
  maxOperatingCompanyChars: number
  reasoningCaps: {
    provider: string
    model: string
    effort: 'off' | 'low' | 'medium' | 'high'
  }[]
  employeeSubagentPlanning: boolean
  nativeTeamCoordination: boolean
  progressiveToolDisclosure: boolean
}

export const Config: z<Config> = z.object({
  maxSearchResults: z.natural().min(1).max(12).default(5),
  maxSelectedPlaybooks: z.natural().min(1).max(12).default(6),
  maxObjectiveChars: z.natural().min(1).default(8_000),
  maxOperatingEmployees: z.natural().min(1).max(20).default(6),
  maxOperatingEvidenceItems: z.natural().min(1).max(10).default(3),
  maxOperatingEvidenceChars: z.natural().min(200).max(8_000).default(1_200),
  maxOperatingCompanyChars: z.natural().min(500).max(12_000).default(3_000),
  reasoningCaps: z
    .array(
      z.object({
        provider: z.string().required(),
        model: z.string().required(),
        effort: z.union(['off', 'low', 'medium', 'high'] as const).required(),
      }),
    )
    .default([]),
  employeeSubagentPlanning: z.boolean().default(true),
  nativeTeamCoordination: z.boolean().default(false),
  progressiveToolDisclosure: z.boolean().default(false),
})

interface OperatingContextRecorded {
  readonly runId: string
  readonly objective: string
  readonly companyContext: Record<string, JsonValue>
  readonly internalEvidence: Record<string, JsonValue>
  readonly playbookCandidates: readonly Record<string, JsonValue>[]
  readonly recommendedGlobalPlaybooks: readonly string[]
  readonly compatibleLocalPlaybooks: readonly string[]
  readonly employeeCandidates: readonly Record<string, JsonValue>[]
  readonly employeeExecution: {
    readonly defaultActorKind: 'inline_employee' | 'persistent_employee'
    readonly tool: 'hivemind_workstream' | 'hivemind_hq_contract'
    readonly childAgents: 'optional_escalation' | 'disabled_for_preset' | 'persistent_room_execution'
  }
  readonly capabilityGuidance: readonly string[]
  readonly likelyNeeds: readonly string[]
  readonly retrieval: {
    readonly companyContext: 'ready'
    readonly internalRecall: 'ready' | 'empty'
    readonly employeeDirectory: 'ready' | 'empty'
    readonly additionalRecallNeeded: boolean
    readonly additionalRecallReason: string
    readonly externalEvidenceLikelyNeeded: boolean
  }
}

/**
 * A short, newest-message orientation seam for models that otherwise treat a
 * large operating-context receipt as ordinary search fodder. It deliberately
 * does not hide native tools or prescribe a graph: it only makes the immediate
 * decision (direct work or one plan) unambiguous before execution begins.
 */
function operatingContextHandoff(event: OperatingContextRecorded): string {
  const methods = event.playbookCandidates
    .slice(0, 4)
    .flatMap(candidate => typeof candidate['id'] === 'string' ? [candidate['id']] : [])
  const employees = event.employeeCandidates
    .slice(0, 3)
    .flatMap((candidate) => {
      const id = typeof candidate['id'] === 'string' ? candidate['id'] : undefined
      const name = typeof candidate['name'] === 'string' ? candidate['name'] : undefined
      return id === undefined ? [] : [`${name ?? id} (${id})`]
    })
  return [
    '## Company-work orientation complete',
    `Objective: ${event.objective.slice(0, 500)}`,
    `Retrieved: company evidence ${event.retrieval.companyContext}; internal recall ${event.retrieval.internalRecall}; employee directory ${event.retrieval.employeeDirectory}.`,
    methods.length === 0 ? 'Playbook candidates: none.' : `Playbook candidates: ${methods.join(', ')}.`,
    employees.length === 0 ? 'Employee candidates: none.' : `Employee candidates: ${employees.join(', ')}.`,
    event.employeeExecution.defaultActorKind === 'persistent_employee'
      ? 'Runtime coordinates and reviews. Delegate employee deliverables through hivemind_hq_contract into the authenticated employee persistent room; use native Schedule for saved future starts. Never perform an assigned employee research or artifact task inline. Answer ordinary direct questions concisely without company-plan setup.'
      : 'Decide the approach now. For substantial multi-step company work, call hivemind_operating_plan once before searching, delegating, or starting a workstream. Choose inline_employee for ordinary employee perspectives; this parent runtime performs the work. A bounded task may proceed directly. Native Harness tools remain available after this decision.',
  ].join('\n')
}

interface PlaybooksLoaded {
  readonly runId?: string
  readonly playbooks: readonly { readonly id: string; readonly version: string }[]
}

export type WorkstreamActorKind = 'main' | 'inline_employee' | 'employee_subagent' | 'dynamic_subagent' | 'workflow'

export interface PlannedWorkstream {
  readonly id: string
  readonly objective: string
  readonly actor: {
    readonly kind: WorkstreamActorKind
    readonly employeeId?: string
    readonly role?: string
  }
  readonly outcome?: string
  /** A human decision must be durably granted before this workstream can complete. */
  readonly approvalRequired?: boolean
}

export interface RunPlanRecorded {
  readonly runId: string
  readonly planId: string
  readonly revision: number
  readonly objective: string
  readonly playbooks: readonly { readonly id: string; readonly version: string; readonly reason: string }[]
  readonly approach: string
  readonly workstreams: readonly PlannedWorkstream[]
  readonly revisionReason?: string
}

type OperatingTodoItem = { readonly content: string; readonly status: 'pending' | 'in_progress' | 'completed' }

function operatingPlanTodos(plan: RunPlanRecorded): OperatingTodoItem[] {
  if (plan.workstreams.length === 0)
    return [{ content: 'Complete and deliver the requested outcome', status: 'in_progress' }]
  return plan.workstreams.map((workstream, index) => ({
    content: `[${workstream.id}] ${workstream.objective}`,
    status: index === 0 ? ('in_progress' as const) : ('pending' as const),
  }))
}

interface RequestAssemblyBudget {
  readonly requestIndex: number
  readonly systemChars: number
  readonly contextChars: number
  readonly toolSchemaChars: number
  readonly toolCount: number
  readonly totalFixedChars: number
  readonly historyChars: number
  readonly historyMessageCount: number
  readonly totalAttributedChars: number
  readonly sections: readonly { readonly name: string; readonly chars: number }[]
  readonly tools: readonly { readonly name: string; readonly chars: number }[]
}

type CapabilityLane =
  | 'research'
  | 'web'
  | 'browser'
  | 'workspace'
  | 'employees'
  | 'orchestration'
  | 'automation'
  | 'skills'
  | 'artifact'
  | 'visual'
  | 'memory'
  | 'connected'

interface CapabilityLeaseRecorded {
  readonly operation: 'initial' | 'lease' | 'reset'
  readonly capabilities: readonly CapabilityLane[]
  readonly visibleTools: readonly string[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Compact company evidence and operating candidates retrieved for one natural objective. */
    'hivemind/operating-context': OperatingContextRecorded
    /** Records the exact global doctrines and local methods made visible before an operating plan. */
    'hivemind/playbooks-loaded': PlaybooksLoaded
    /** Task-local playbook selection and adaptive approach used for this run. */
    'hivemind/run-plan': RunPlanRecorded
    /** Complete replacement of an earlier operating plan chosen by the parent runtime. */
    'hivemind/run-plan-revised': RunPlanRecorded
    /** Exact character attribution for the assembled fixed request surface. Never enters model context. */
    'hivemind/request-assembly-budget': RequestAssemblyBudget
    /** Progressive projection of the installed native Harness tool registry for one agent. */
    'hivemind/capability-lease': CapabilityLeaseRecorded
  }
}

const CORE_TOOLS = [
  'ask_user_question',
  'hivemind_capabilities',
  'hivemind_meta',
  'hyperagents_memory',
  'hivemind_agent_message',
  'hivemind_operating_context',
  'hivemind_operating_plan',
  'hivemind_research_answer',
  'hivemind_browser_capture',
  'hivemind_read_attachment',
  'hivemind_media_generate',
  'job_output',
  'job_list',
  'job_kill',
] as const

// Schedule and Team register in each eligible Agent scope. Scoped registrations are
// always exempt from tools.restrict(), whose allow-list accepts global names.
const AGENT_LOCAL_TOOLS = new Set([
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
  'spawn_teammate', 'list_agents', 'send_message', 'wait_agent', 'interrupt_agent',
  'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update',
])

const CAPABILITY_TOOLS: Readonly<Record<CapabilityLane, readonly string[]>> = {
  connected: ['hivemind_connected_task'],
  research: ['hivemind_research_answer', 'hivemind_research_gather', 'hivemind_research_request', 'hivemind_research_status'],
  web: ['web_search', 'web_fetch'],
  browser: ['hivemind_browser_capture', 'hivemind_browser_discover'],
  workspace: ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'job_list', 'job_output', 'job_kill'],
  employees: [
    'hivemind_employee_panel',
    'hivemind_delegate_employee',
    'list_agents',
    'send_message',
    'interrupt_agent',
    'subagent_fork',
  ],
  orchestration: [
    'hivemind_operating_plan',
    'hivemind_playbooks',
    'hivemind_field_step',
    'hivemind_workstream',
    'todo_write',
  ],
  automation: [
    'schedule_create',
    'schedule_list',
    'schedule_update',
    'schedule_delete',
    'workflow',
    'create_goal',
    'get_goal',
    'update_goal',
    'ralph',
  ],
  skills: ['hivemind_skills'],
  artifact: ['hivemind_artifact_render', 'hivemind_generation_discover', 'hivemind_generate', 'hivemind_media_generate',
    'hivemind_calculate', 'job_list', 'job_output', 'job_kill'],
  visual: ['inspect_image', 'read_image'],
  memory: ['hivemind_meta', 'hivemind_save_memory'],
}

const CAPABILITY_DESCRIPTIONS: Readonly<Record<CapabilityLane, string>> = {
  connected: 'Authenticated application discovery, connection continuation and approved execution through Composio.',
  research: 'Governed multi-source external research jobs with evidence receipts.',
  web: 'Quick public-web discovery and direct text retrieval when a governed research job is unnecessary.',
  browser: 'Progressive browser discovery, navigation, extraction and capture.',
  workspace: 'Filesystem, shell and background job work.',
  employees: 'Employee delegation and native child-agent collaboration.',
  orchestration: 'Playbooks, operating plans, inline workstreams, and session todo tracking.',
  automation: 'Tenant-scoped scheduled tasks, durable workflows, goals, and autonomous Ralph execution.',
  skills: 'Search and load exact specialized instructions progressively without mounting the full skill catalog.',
  artifact:
    'Discover configured PDF, presentation, spreadsheet, image, video and web generators, then produce stored files. Load document design or Brand DNA when useful. Calculate financial totals with the deterministic calculator.',
  visual:
    'On-demand image inspection, including extracting working Brand DNA from an official-site screenshot when stored guidance is absent.',
  memory: 'Durable HIVE-MIND memory writes.',
}

const CAPABILITY_SECTIONS: Readonly<Partial<Record<CapabilityLane, readonly string[]>>> = {
  web: ['tool:web_search', 'tool:web_fetch'],
  workspace: [
    'tool:bash', 'tool:read', 'tool:write', 'tool:edit', 'tool:glob', 'tool:grep', 'tool:jobs',
    // These describe how to modify the Harness checkout and Web shell. They
    // are useful only after the runtime intentionally selects workspace work.
    'harness:source', 'app:web-surface',
  ],
  employees: ['tool:subagent_fork'],
  automation: ['tool:goal', 'tool:workflow', 'tool:ralph'],
}

const PROGRESSIVE_SECTION_NAMES = new Set(Object.values(CAPABILITY_SECTIONS).flatMap(value => value ?? []))

function recommendedSkills(capabilities: ReadonlySet<CapabilityLane>): string[] {
  const skills: string[] = []
  if (capabilities.has('artifact')) skills.push('hivemind-document-design')
  if (capabilities.has('artifact') && capabilities.has('visual')) skills.push('hivemind-brand-dna')
  return skills
}

function record(value: JsonValue | undefined, label: string): Record<string, JsonValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError(`hivemind-playbooks: ${label} must be an object`)
  return value
}

function text(value: JsonValue | undefined, label: string, maxChars = 8_000): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError(`hivemind-playbooks: ${label} must be a non-empty string`)
  const result = value.trim()
  if (result.length > maxChars) throw new TypeError(`hivemind-playbooks: ${label} exceeds ${maxChars} characters`)
  return result
}

function optionalText(value: JsonValue | undefined, label: string, fallback: string, maxChars = 8_000): string {
  return value === undefined ? fallback : text(value, label, maxChars)
}

function stringList(value: JsonValue | undefined, label: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new TypeError(`hivemind-playbooks: ${label} must be an array`)
  return value.map((item, index) => text(item, `${label}[${index}]`, 200))
}

function tokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter(token => token.length > 2),
  )
}

const RECALL_STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'from',
  'with',
  'that',
  'this',
  'into',
  'its',
  'our',
  'your',
  'prepare',
  'produce',
  'create',
  'give',
  'using',
  'include',
  'grounded',
  'current',
  'company',
  'evidence',
  'decision',
  'decision-ready',
  'ready',
  'recommendation',
  'whether',
  'should',
  'first',
  'internal',
  'independent',
  'challenge',
  'concrete',
  'validation',
  'step',
  'requested',
  'outcome',
])

/** Keep named subjects and domain terms while removing task-instruction boilerplate. */
function focusedRecallQuery(objective: string): string {
  const values = (objective.match(/[\p{L}\p{N}][\p{L}\p{N}._/-]*/gu) ?? []).map(value =>
    value.replace(/^[._/-]+|[._/-]+$/gu, ''),
  )
  const selected = values.filter(value => value.length > 2 && !RECALL_STOP_WORDS.has(value.toLowerCase()))
  return (selected.length === 0 ? objective : selected.slice(0, 16).join(' ')).slice(0, 400)
}

function boundedJson(value: JsonValue, maxChars: number): JsonValue {
  const encoded = JSON.stringify(value)
  if (encoded.length <= maxChars) return value
  return { summary: `${encoded.slice(0, maxChars)}…`, truncated: true }
}

function compactEvidence(value: Record<string, JsonValue>, limit: number, maxChars: number): Record<string, JsonValue> {
  // The runtime provider preserves the public meta-tool receipt shape
  // (`{ status, operation, result: { results } }`). Tests and alternative
  // providers may return the result payload directly. Accept both without
  // making the model understand or repair transport envelopes.
  const nested =
    typeof value['result'] === 'object' && value['result'] !== null && !Array.isArray(value['result'])
      ? (value['result'] as Record<string, JsonValue>)
      : value
  const raw = Array.isArray(nested['results']) ? nested['results'] : []
  const results = raw.slice(0, limit).flatMap((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return []
    const source = item as Record<string, JsonValue>
    const compact: Record<string, JsonValue> = {}
    for (const key of ['id', 'citation_id', 'title', 'memory_type', 'source', 'score']) {
      const value = source[key]
      if (value !== undefined) compact[key] = value
    }
    if (typeof source['content'] === 'string') compact['content'] = source['content'].slice(0, maxChars)
    return [compact]
  })
  return { status: typeof value['status'] === 'string' ? value['status'] : 'ready', results, count: results.length }
}

function score(playbook: Playbook, query: Set<string>, domains: ReadonlySet<string>): number {
  const searchable = tokens(
    [playbook.id, playbook.title, playbook.description, ...playbook.domains, ...playbook.intents].join(' '),
  )
  let value = 0
  for (const token of query) if (searchable.has(token)) value += 1
  for (const domain of playbook.domains) if (domains.has(domain)) value += 3
  return value
}

function currentAgent(agent: Agent | undefined): Agent {
  if (agent === undefined) throw new TypeError('hivemind-playbooks: active agent required')
  return agent
}

function normalizeOperation(value: JsonValue | undefined): 'search' | 'load' | 'record_plan' | 'revise_plan' {
  const operation = text(value, 'operation', 40)
  // Discovery aliases are accepted at the provider boundary so a concise
  // natural-language request cannot strand the run before a playbook exists.
  // The returned receipt always uses the canonical operation name.
  if (operation === 'search' || operation === 'brief' || operation === 'discover' || operation === 'select')
    return 'search'
  if (operation === 'load') return 'load'
  if (operation === 'record_plan' || operation === 'record' || operation === 'plan') return 'record_plan'
  if (operation === 'revise_plan' || operation === 'revise') return 'revise_plan'
  throw new TypeError('hivemind-playbooks: operation must be search, load, record_plan, or revise_plan')
}

function plannedWorkstreamId(value: JsonValue | undefined, objective: string, index: number): string {
  if (value !== undefined && typeof value !== 'string')
    throw new TypeError(`hivemind-playbooks: workstreams[${index}].id must be a string`)
  const supplied = value?.trim()
  if (supplied) return text(supplied, `workstreams[${index}].id`, 100)
  const derived = objective
    .normalize('NFKD')
    .toLocaleLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '_')
    .replaceAll(/^_+|_+$/g, '')
    .slice(0, 80)
    .replaceAll(/_+$/g, '')
  return derived || `workstream_${index + 1}`
}

function workstreams(
  value: JsonValue | undefined,
  maxChars: number,
  allowedActorKinds: readonly WorkstreamActorKind[],
  fallbackInvalidActorsToMain = false,
): PlannedWorkstream[] {
  if (value === undefined) return []
  const raw: JsonValue[] =
    typeof value === 'string'
      ? value
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map((line, index) => {
          const parts = line.split('::').map(part => part.trim())
          if (parts.length < 4 || parts.length > 5)
            throw new TypeError(
              `hivemind-playbooks: workstreams line ${index + 1} must use id :: actor_kind :: employee-or-role-or-- :: objective :: optional-outcome`,
            )
          const [id, actorKind, actor, objective, outcome] = parts
          return {
            id,
            actor_kind: actorKind,
            objective,
            ...(actor !== undefined && actor !== '-' && actor !== ''
              ? actorKind === 'dynamic_subagent'
                ? { role: actor }
                : { employee_id: actor }
              : {}),
            ...(outcome !== undefined && outcome !== '-' && outcome !== '' ? { outcome } : {}),
          } as unknown as JsonValue
        })
      : Array.isArray(value)
        ? value
        : (() => {
          throw new TypeError('hivemind-playbooks: workstreams must be a compact string or array')
        })()
  if (raw.length > 12) throw new TypeError('hivemind-playbooks: workstreams cannot exceed 12 items')
  const normalized = raw.filter((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return true
    return Object.keys(item).length > 0
  })
  const result = normalized.map((item, index) => {
    const input = record(item, `workstreams[${index}]`)
    const objective = text(input['objective'], `workstreams[${index}].objective`, maxChars)
    const id = plannedWorkstreamId(input['id'], objective, index)
    const requestedKind = text(input['actor_kind'], `workstreams[${index}].actor_kind`, 40) as WorkstreamActorKind
    let kind = requestedKind
    if (!allowedActorKinds.includes(kind)) {
      if (!fallbackInvalidActorsToMain) throw new TypeError(`hivemind-playbooks: unsupported actor_kind ${kind}`)
      kind = 'main'
    }
    const employeeId =
      input['employee_id'] === undefined
        ? undefined
        : text(input['employee_id'], `workstreams[${index}].employee_id`, 200)
    const role = input['role'] === undefined ? undefined : text(input['role'], `workstreams[${index}].role`, 500)
    const outcome =
      input['outcome'] === undefined ? undefined : text(input['outcome'], `workstreams[${index}].outcome`, maxChars)
    if (input['approval_required'] !== undefined && typeof input['approval_required'] !== 'boolean')
      throw new TypeError(`hivemind-playbooks: workstreams[${index}].approval_required must be a boolean`)
    const approvalRequired = input['approval_required'] === true
    if ((kind === 'inline_employee' || kind === 'employee_subagent') && employeeId === undefined) {
      if (!fallbackInvalidActorsToMain) throw new TypeError(`hivemind-playbooks: ${kind} requires employee_id`)
      kind = 'main'
    }
    if (kind === 'dynamic_subagent' && role === undefined) {
      if (!fallbackInvalidActorsToMain) throw new TypeError('hivemind-playbooks: dynamic_subagent requires role')
      kind = 'main'
    }
    return {
      id,
      objective,
      actor: {
        kind,
        ...(kind === 'main' || employeeId === undefined ? {} : { employeeId }),
        ...(kind !== 'dynamic_subagent' || role === undefined ? {} : { role }),
      },
      ...(outcome === undefined ? {} : { outcome }),
      ...(approvalRequired ? { approvalRequired: true } : {}),
    }
  })
  if (new Set(result.map(item => item.id)).size !== result.length)
    throw new TypeError('hivemind-playbooks: workstream ids must be unique')
  return result
}

function latestPlan(agent: Agent): RunPlanRecorded | undefined {
  const events = agent.session.snapshotEvents() as ReadonlyArray<{ readonly type: string; readonly data: unknown }>
  const event = events.findLast(
    item => item.type === 'hivemind/run-plan' || item.type === 'hivemind/run-plan-revised',
  )
  return event?.data as RunPlanRecorded | undefined
}

/**
 * The progressive browser plugin registers executable official MCP tools in
 * the live agent scope. Cordis deliberately keeps scope-local registrations
 * out of a standing preset assembly, so project their durable schema receipt
 * here rather than relying on a global provider re-scan. The runtime still
 * dispatches the original scope-local definitions; this only restores their
 * model-visible contract on the following step.
 */
function leasedBrowserToolSchemas(agent: Agent): ToolSchema[] {
  const events = agent.session.snapshotEvents() as ReadonlyArray<{ readonly type: string; readonly data: unknown }>
  const event = events.findLast(item => item.type === 'hivemind/browser-capability-lease')
  if (typeof event?.data !== 'object' || event.data === null || Array.isArray(event.data)) return []
  const tools = (event.data as Record<string, unknown>)['tools']
  if (!Array.isArray(tools)) return []
  return tools.flatMap((value): ToolSchema[] => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
    const tool = value as Record<string, unknown>
    const name = tool['name']
    const description = tool['description']
    const parameters = tool['parameters']
    if (
      typeof name !== 'string'
      || !name.startsWith('mcp__singulance_browser__browser_')
      || typeof description !== 'string'
      || typeof parameters !== 'object'
      || parameters === null
      || Array.isArray(parameters)
    ) return []
    return [{ name, description, parameters: structuredClone(parameters as Record<string, unknown>) }]
  })
}

function latestPlanTodos(agent: Agent): OperatingTodoItem[] {
  const events = agent.session.snapshotEvents() as ReadonlyArray<{ readonly type: string; readonly data: unknown }>
  const event = events.findLast(item => item.type === 'todo/write')
  if (typeof event?.data !== 'object' || event.data === null || Array.isArray(event.data)) return []
  const values = (event.data as { readonly todos?: unknown }).todos
  if (!Array.isArray(values)) return []
  return values.flatMap((value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
    const item = value as Record<string, unknown>
    const content = typeof item['content'] === 'string' ? item['content'] : undefined
    const status = item['status']
    if (content === undefined || (status !== 'pending' && status !== 'in_progress' && status !== 'completed')) return []
    return [{ content, status } satisfies OperatingTodoItem]
  })
}

function hasUnfinishedPlanTodo(agent: Agent): boolean {
  return latestPlanTodos(agent).some(todo => todo.status !== 'completed')
}

function latestOperatingContext(agent: Agent): OperatingContextRecorded | undefined {
  const events = agent.session.snapshotEvents() as ReadonlyArray<{ readonly type: string; readonly data: unknown }>
  const event = events.findLast(item => item.type === 'hivemind/operating-context')
  return event?.data as OperatingContextRecorded | undefined
}

function operatingContextForRun(agent: Agent, runId: string): OperatingContextRecorded | undefined {
  const events = agent.session.snapshotEvents() as ReadonlyArray<{ readonly type: string; readonly data: unknown }>
  const event = events.findLast(
    item =>
      item.type === 'hivemind/operating-context' &&
      (item.data as Partial<OperatingContextRecorded> | undefined)?.runId === runId,
  )
  return event?.data as OperatingContextRecorded | undefined
}

function latestLoadedPlaybooks(agent: Agent): PlaybooksLoaded | undefined {
  const events = agent.session.snapshotEvents() as ReadonlyArray<{ readonly type: string; readonly data: unknown }>
  const event = events.findLast(item => item.type === 'hivemind/playbooks-loaded')
  return event?.data as PlaybooksLoaded | undefined
}

function resolveEmployeeActors(
  agent: Agent,
  selectedWorkstreams: readonly PlannedWorkstream[],
): readonly PlannedWorkstream[] {
  const employeeActors = selectedWorkstreams.filter(
    item => item.actor.kind === 'inline_employee' || item.actor.kind === 'employee_subagent',
  )
  if (employeeActors.length === 0) return selectedWorkstreams
  const context = latestOperatingContext(agent)
  if (context === undefined)
    throw new TypeError('hivemind-playbooks: retrieve operating context before selecting an authenticated employee')
  const available = context.employeeCandidates.flatMap((candidate) => {
    const id = typeof candidate['id'] === 'string' ? candidate['id'] : undefined
    const name = typeof candidate['name'] === 'string' ? candidate['name'] : undefined
    return id === undefined ? [] : [{ id, name }]
  })
  return selectedWorkstreams.map((item) => {
    if (item.actor.kind !== 'inline_employee' && item.actor.kind !== 'employee_subagent') return item
    const supplied = item.actor.employeeId
    const matched = available.find(candidate =>
      candidate.id === supplied || candidate.name?.localeCompare(supplied ?? '', undefined, { sensitivity: 'accent' }) === 0,
    )
    if (matched === undefined) {
      throw new TypeError(
        `hivemind-playbooks: employee ${supplied} was not returned by the current operating context`,
      )
    }
    return { ...item, actor: { ...item.actor, employeeId: matched.id } }
  })
}

function employeeCapabilities(profile: Record<string, JsonValue>, role: string): string[] {
  const values = [role]
  for (const key of ['tools', 'peer_review_targets']) {
    const value = profile[key]
    if (Array.isArray(value)) values.push(...value.filter((item): item is string => typeof item === 'string'))
  }
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].slice(0, 6)
}

function capabilityGuidance(objective: string): string[] {
  const query = tokens(objective)
  const guidance: string[] = []
  if (
    [...query].some(token =>
      ['current', 'latest', 'market', 'research', 'regulation', 'verify', 'evidence'].includes(token),
    )
  )
    guidance.push('current external evidence may be needed')
  if ([...query].some(token => ['review', 'challenge', 'risk', 'legal', 'compliance', 'regulation'].includes(token)))
    guidance.push('an independent employee review may help')
  if ([...query].some(token => ['pdf', 'deck', 'report', 'presentation', 'image', 'video'].includes(token)))
    guidance.push(
      'load a relevant artifact skill after evidence is ready; for externally facing branded work, use stored Brand DNA or recover it from the official website through browser capture and visual inspection',
    )
  if ([...query].some(token => ['send', 'email', 'slack', 'publish', 'schedule'].includes(token)))
    guidance.push('a connected action requires an approval-backed receipt')
  return guidance
}

const REASONING_RANK = new Map([
  ['off', 0],
  ['low', 1],
  ['medium', 2],
  ['high', 3],
  ['xhigh', 4],
  ['max', 5],
  ['ultra', 6],
])

function selectionWithParents(ids: readonly string[], byId: ReadonlyMap<string, Playbook>): Playbook[] {
  const selected = new Map<string, Playbook>()
  for (const id of ids) {
    const playbook = byId.get(id)
    if (playbook === undefined) throw new TypeError(`hivemind-playbooks: unknown playbook ${id}`)
    selected.set(playbook.id, playbook)
  }
  for (const playbook of [...selected.values()]) {
    if (playbook.level !== 'local') continue
    const parentIds = playbook.parentGlobalIds ?? []
    if (parentIds.some(parentId => selected.has(parentId))) continue
    const parent = parentIds.map(parentId => byId.get(parentId)).find((item): item is Playbook => item !== undefined)
    if (parent !== undefined) selected.set(parent.id, parent)
  }
  return [...selected.values()].sort(
    (left, right) => Number(right.level === 'global') - Number(left.level === 'global'),
  )
}

const output = {
  schema: { type: 'object' as const, additionalProperties: true, properties: {} },
  render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

/** Register compact discovery, progressive loading, and a durable task-local run-plan receipt. */
export function apply(ctx: Context, config: Partial<Config> = {}): void {
  registerFieldMethods(ctx)
  const maxSearchResults = config.maxSearchResults ?? 5
  const maxSelectedPlaybooks = config.maxSelectedPlaybooks ?? 6
  const maxObjectiveChars = config.maxObjectiveChars ?? 8_000
  const maxOperatingEmployees = config.maxOperatingEmployees ?? 6
  const maxOperatingEvidenceItems = config.maxOperatingEvidenceItems ?? 3
  const maxOperatingEvidenceChars = config.maxOperatingEvidenceChars ?? 1_200
  const maxOperatingCompanyChars = config.maxOperatingCompanyChars ?? 3_000
  const reasoningCaps = config.reasoningCaps ?? []
  const employeeSubagentPlanning = config.employeeSubagentPlanning ?? true
  const nativeTeamCoordination = config.nativeTeamCoordination ?? false
  const progressiveToolDisclosure = config.progressiveToolDisclosure ?? false
  const plannedActorKinds: readonly WorkstreamActorKind[] = employeeSubagentPlanning
    ? ['main', 'inline_employee', 'employee_subagent', 'dynamic_subagent', 'workflow']
    : ['main', 'inline_employee', 'workflow']
  // Keep the public plan contract compatible with native Harness actors even
  // when this preset executes employee work in the parent session. The
  // execution normalizer below converts unsupported or incomplete child actor
  // requests to `main` instead of failing the entire operating run.
  const acceptedActorKinds: readonly WorkstreamActorKind[] = employeeSubagentPlanning
    ? plannedActorKinds
    : ['main', 'inline_employee', 'dynamic_subagent', 'workflow']
  const employeeActorDescription = employeeSubagentPlanning
    ? 'main = parent runtime; inline_employee = normal employee choice, where the parent executes with a frozen authenticated persona via hivemind_workstream and avoids another full Harness session; employee_subagent = independent native child only when isolated context, genuine concurrent long-running work, or a distinct model/tool boundary is materially useful; dynamic_subagent = task-created specialist; workflow = durable workflow.'
    : 'main = parent runtime; inline_employee = an authenticated employee identity projected through hivemind_workstream while this parent runtime performs the work; workflow = durable workflow. Employee assignments in this preset never create child sessions.'
  const byId = new Map(PLAYBOOKS.map(playbook => [playbook.id, playbook]))
  const loadedByAgent = new WeakMap<Agent, Set<string>>()
  const assemblyIndexByAgent = new WeakMap<Agent, number>()
  const capabilityStateByAgent = new WeakMap<
    Agent,
    {
      capabilities: Set<CapabilityLane>
      availableTools: Set<string>
      localBaseTools: Set<string>
      visibleTools: Set<string>
      lift: () => void
    }
  >()

  function toolsSuppressedByRunState(agent: Agent): Set<string> {
    const allEvents = agent.session.snapshotEvents() as ReadonlyArray<{
      readonly type: string
      readonly seq?: number
      readonly data: unknown
    }>
    const latestTurnStart = allEvents.findLast(event => event.type === 'turn/start')
    const turnStartSeq = latestTurnStart?.seq ?? Number.NEGATIVE_INFINITY
    const currentEvents = allEvents.filter(event => (event.seq ?? Number.POSITIVE_INFINITY) > turnStartSeq)
    const previousTurnEnd = [...allEvents].reverse().find(event => event.type === 'turn/end' && (event.seq ?? Number.NEGATIVE_INFINITY) < turnStartSeq)
    const previousReason = typeof previousTurnEnd?.data === 'object' && previousTurnEnd.data !== null && !Array.isArray(previousTurnEnd.data)
      ? (previousTurnEnd.data as Record<string, unknown>)['reason']
      : undefined
    const previousReasonKind = typeof previousReason === 'object' && previousReason !== null && !Array.isArray(previousReason)
      ? (previousReason as Record<string, unknown>)['kind']
      : undefined
    const resumesInterruptedRun = previousReasonKind === 'aborted' || previousReasonKind === 'interrupted'
    const events = resumesInterruptedRun ? allEvents : currentEvents
    // Discovery is a one-shot capability transition. After the browser plugin
    // records an unexpired lease, its exact native tools are already present
    // in the agent scope. Keep those tools visible while removing only the
    // discovery entry so a model cannot spend later steps rediscovering the
    // same browser surface. Expiry naturally restores discovery.
    const browserLease = events.findLast(event => event.type === 'hivemind/browser-capability-lease')
    const browserLeaseExpiresAt = typeof browserLease?.data === 'object'
      && browserLease.data !== null
      && !Array.isArray(browserLease.data)
      && typeof (browserLease.data as Record<string, unknown>)['expiresAt'] === 'number'
      ? (browserLease.data as Record<string, unknown>)['expiresAt'] as number
      : undefined
    const browserSuppressed = browserLeaseExpiresAt !== undefined && Date.now() < browserLeaseExpiresAt
      ? ['hivemind_browser_discover']
      : []
    const plan = events.findLast(event => event.type === 'hivemind/run-plan' || event.type === 'hivemind/run-plan-revised')
    const planId = typeof plan?.data === 'object' && plan.data !== null && !Array.isArray(plan.data)
      ? (plan.data as Record<string, unknown>)['planId']
      : undefined
    if (typeof planId !== 'string') {
      const oriented = events.some(event => event.type === 'hivemind/operating-context')
      // An unplanned request is a bounded task. Once its PDF receipt is
      // durable, another render in the same turn is duplicate work, not a
      // continuation. Multi-artifact work uses a plan and keeps this lane.
      const artifactSuppressed = events.some(event => event.type === 'hivemind/artifact-created')
        ? ['hivemind_artifact_render', 'hivemind_generate', 'hivemind_generation_discover']
        : []
      return oriented
        ? new Set(['ask_user_question', 'hivemind_operating_context', 'hivemind_playbooks', 'hivemind_capabilities', ...browserSuppressed, ...artifactSuppressed])
        : new Set([...browserSuppressed, ...artifactSuppressed])
    }
    const suppressed = new Set(['hivemind_operating_context', 'hivemind_playbooks', ...browserSuppressed])
    const plannedWorkstreams = typeof plan?.data === 'object' && plan.data !== null && !Array.isArray(plan.data)
      ? (plan.data as Record<string, unknown>)['workstreams']
      : undefined
    const plannedIds = Array.isArray(plannedWorkstreams)
      ? plannedWorkstreams.flatMap((value) => {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
        const id = (value as Record<string, unknown>)['id']
        return typeof id === 'string' ? [id] : []
      })
      : []
    const terminalIds = new Set(events.flatMap((event) => {
      if (event.type !== 'hivemind/workstream-completed' && event.type !== 'hivemind/workstream-failed') return []
      if (typeof event.data !== 'object' || event.data === null || Array.isArray(event.data)) return []
      const data = event.data as Record<string, unknown>
      return data['planId'] === planId && typeof data['workstreamId'] === 'string'
        ? [data['workstreamId']]
        : []
    }))
    if (plannedIds.length > 0 && plannedIds.every(id => terminalIds.has(id))) {
      return new Set([
        ...suppressed,
        ...CAPABILITY_TOOLS.research,
        ...CAPABILITY_TOOLS.web,
        ...CAPABILITY_TOOLS.orchestration.filter(tool => tool !== 'hivemind_workstream'),
        ...CAPABILITY_TOOLS.automation,
        'hivemind_capabilities',
      ])
    }
    for (const event of [...events].reverse()) {
      if (
        event.type === 'hivemind/evidence-gap-recorded'
        && typeof event.data === 'object'
        && event.data !== null
        && !Array.isArray(event.data)
        && (event.data as Record<string, unknown>)['planId'] === planId
      ) return suppressed
      if (
        event.type === 'hivemind/research-gathered'
        && typeof event.data === 'object'
        && event.data !== null
        && !Array.isArray(event.data)
        && (event.data as Record<string, unknown>)['planId'] === planId
      ) {
        return new Set([
          ...suppressed,
          'hivemind_research_gather',
          'hivemind_research_request',
          'hivemind_research_status',
          'web_search',
        ])
      }
    }
    return suppressed
  }

  function hasUnfinishedPlanWorkstreams(agent: Agent): boolean {
    const plan = latestPlan(agent)
    if (plan === undefined || plan.workstreams.length === 0) return false
    const terminal = new Set(
      (agent.session.snapshotEvents() as ReadonlyArray<{ readonly type: string; readonly data: unknown }>).flatMap((event) => {
        if (event.type !== 'hivemind/workstream-completed' && event.type !== 'hivemind/workstream-failed') return []
        if (typeof event.data !== 'object' || event.data === null || Array.isArray(event.data)) return []
        const data = event.data as Record<string, unknown>
        return data['planId'] === plan.planId && typeof data['workstreamId'] === 'string'
          ? [data['workstreamId']]
          : []
      }),
    )
    return plan.workstreams.some(workstream => !terminal.has(workstream.id))
  }

  function replaceCapabilityLease(
    agent: Agent,
    capabilities: ReadonlySet<CapabilityLane>,
    operation: CapabilityLeaseRecorded['operation'],
    discoveredTools?: readonly string[],
  ): CapabilityLeaseRecorded {
    const previous = capabilityStateByAgent.get(agent)
    previous?.lift()
    const availableTools =
      previous?.availableTools ?? new Set(discoveredTools ?? agent.ctx.tools.schemas().map(tool => tool.name))
    // Capture the agent-local baseline once. A pre-existing local utility is
    // not a newly leased capability merely because it was absent from the
    // standing prompt assembly; only names registered later count as dynamic.
    const localBaseTools = previous?.localBaseTools ?? new Set(agent.ctx.tools.schemas().map(tool => tool.name))
    const requested = new Set<string>(CORE_TOOLS)
    // HQ owns durable coordination even when a workstream executes inline.
    // Ordinary employee presets retain their existing progressive boundary.
    if (nativeTeamCoordination) {
      for (const tool of [
        'hivemind_hq_contract', 'hivemind_hq_rest', 'hivemind_employee_panel',
        'hivemind_hq_awakening', 'hivemind_onboarding',
        'team_task_list', 'team_task_get', 'team_task_create', 'team_task_update', 'list_agents',
        'send_message', 'wait_agent', 'interrupt_agent',
      ]) requested.add(tool)
    }
    for (const capability of capabilities) {
      for (const tool of CAPABILITY_TOOLS[capability]) requested.add(tool)
    }
    // A capability lease must not reopen research already closed by durable
    // run state. Orientation tools stay executable as compact idempotent
    // fallbacks for weaker models, but request assembly no longer advertises
    // them. A recorded evidence gap reopens the research tools.
    const suppressed = toolsSuppressedByRunState(agent)
    const hardSuppressed = suppressed
    const visibleTools = new Set(
      [...requested].filter(tool => availableTools.has(tool) && !hardSuppressed.has(tool)),
    )
    const lift = agent.ctx.tools.restrict({ allow: [...visibleTools].filter(tool => !AGENT_LOCAL_TOOLS.has(tool)) })
    capabilityStateByAgent.set(agent, { capabilities: new Set(capabilities), availableTools, localBaseTools, visibleTools, lift })
    const receipt: CapabilityLeaseRecorded = {
      operation,
      capabilities: [...capabilities],
      visibleTools: [...visibleTools].filter(tool => !suppressed.has(tool)).sort(),
    }
    agent.session.append('hivemind/capability-lease', receipt)
    return receipt
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    let assembled = await next()
    const agent = context.agent
    if (agent === undefined) return assembled
    if (progressiveToolDisclosure) {
      // Assembly is the first lifecycle point carrying the complete inherited
      // schema set. Install the native agent-scope restriction here and apply
      // the exact same projection to request one; later assemblies are already
      // filtered by the registry itself.
      let state = capabilityStateByAgent.get(agent)
      if (state === undefined) {
        replaceCapabilityLease(
          agent,
          new Set(),
          'initial',
          assembled.tools.map(tool => tool.name),
        )
        state = capabilityStateByAgent.get(agent)
      }
      if (!state) throw new Error('Capability lease was not initialized')
      const suppressed = toolsSuppressedByRunState(agent)
      const visibleTools = new Set([...state.visibleTools].filter(tool => !suppressed.has(tool)))
      // The standing preset registry owns the ordinary Harness tools, while
      // an agent-local registry owns tools revealed during this session (for
      // example the official Playwright tools registered by browser
      // discovery). Do not use the local registry as the authority for the
      // standing tool projection: on a fresh agent it can contain only a
      // local utility such as `inspect_image`, which used to erase the
      // capability lease's core HIVE tools from the very first request.
      //
      // Conversely, retain local names which were not in the original
      // assembly. They are the progressively revealed native schemas and
      // must remain both executable and visible on the next model step.
      const localDynamicSchemas = agent.ctx.tools.schemas().filter(
        tool => !state.availableTools.has(tool.name) && !state.localBaseTools.has(tool.name),
      )
      const promptDynamicSchemas = assembled.tools.filter(
        tool => tool.name.startsWith('mcp__singulance_browser__browser_') && !state.availableTools.has(tool.name),
      )
      // A direct MCP registration is scope-local. Its exact model contract is
      // persisted by progressive discovery so that a fresh prompt assembly
      // can restore it even when the standing registry intentionally omits
      // scope-local tool providers.
      const dynamicSchemas = [
        ...localDynamicSchemas,
        ...promptDynamicSchemas.filter(
          tool => !localDynamicSchemas.some(candidate => candidate.name === tool.name),
        ),
        ...leasedBrowserToolSchemas(agent).filter(
          tool => !localDynamicSchemas.some(candidate => candidate.name === tool.name)
            && !promptDynamicSchemas.some(candidate => candidate.name === tool.name),
        ),
      ]
      // Keep execution and model-visible schemas in lockstep. Otherwise a
      // weaker model can repeat a remembered tool name after its schema was
      // removed and the stale registry lease will still execute it.
      state.lift()
      // `restrict()` only accepts inherited global names. Scope-local MCP
      // registrations survive that mask automatically, so keep them out of
      // this allow-list while still projecting their schemas below.
      const effectiveLift = agent.ctx.tools.restrict({ allow: [...visibleTools].filter(tool => !AGENT_LOCAL_TOOLS.has(tool)) })
      capabilityStateByAgent.set(agent, { ...state, lift: effectiveLift })
      const activeSections = new Set(
        [...state.capabilities].flatMap(capability => CAPABILITY_SECTIONS[capability] ?? []),
      )
      // HyperAgents is a company-operating preset, not a coding-session
      // tutorial. Keep checkout/Web-shell instructions dormant until workspace
      // work is deliberately leased. Likewise, employee child guidance must
      // not countermand this preset's inline-employee default. The underlying
      // native tools remain registered and can still be selected progressively.
      const hiddenSections = new Set<string>()
      if (!employeeSubagentPlanning) hiddenSections.add('tool:subagent_fork')
      for (const tool of suppressed) hiddenSections.add(`tool:${tool}`)
      const projectedStandingTools = assembled.tools.filter(tool => visibleTools.has(tool.name))
      assembled = {
        ...assembled,
        sections: assembled.sections.filter(
          section =>
            !hiddenSections.has(section.name)
            && (!PROGRESSIVE_SECTION_NAMES.has(section.name) || activeSections.has(section.name)),
        ),
        // `assembled.tools` is the authoritative merged standing registry.
        // Filter it by the durable capability lease plus agent-local dynamic
        // tools, rather than by `agent.ctx.tools.schemas()` alone. This keeps
        // the compact core available on request one and preserves a browser
        // lease across its following request.
        tools: [
          ...projectedStandingTools,
          // `next()` assembles the standing preset registry only. A direct
          // MCP tool is registered into the agent-local scope after discovery,
          // so it is absent from that base array even though it is callable.
          // Append the original schema exactly once; this is the Cordis
          // projection seam, not a provider-specific browser wrapper.
          // A restored schema appears in the full inherited assembly but is
          // deliberately outside the compact standing lease. De-duplicate
          // against the projected tools, not that full pre-projection list,
          // or the first continuation after discovery loses the native tool.
          ...dynamicSchemas.filter(tool => !projectedStandingTools.some(candidate => candidate.name === tool.name)),
        ],
      }
    }
    const systemChars = renderPrompt(assembled).length
    const contextChars = joinContextSections(renderContextSections(assembled)).length
    const tools = assembled.tools.map(tool => ({ name: tool.name, chars: JSON.stringify(tool).length }))
    const toolSchemaChars = tools.reduce((sum, tool) => sum + tool.chars, 0)
    const messages =
      (agent.session as unknown as { deriveMessages?: () => readonly unknown[] }).deriveMessages?.() ?? []
    const historyChars = JSON.stringify(messages).length
    const requestIndex = (assemblyIndexByAgent.get(agent) ?? 0) + 1
    assemblyIndexByAgent.set(agent, requestIndex)
    agent.session.append('hivemind/request-assembly-budget', {
      requestIndex,
      systemChars,
      contextChars,
      toolSchemaChars,
      toolCount: tools.length,
      totalFixedChars: systemChars + contextChars + toolSchemaChars,
      historyChars,
      historyMessageCount: messages.length,
      totalAttributedChars: systemChars + contextChars + toolSchemaChars + historyChars,
      sections: assembled.sections.map(section => ({ name: section.name, chars: section.text.length })),
      tools,
    })
    return assembled
  })
  if (reasoningCaps.length > 0) {
    // This plugin is mounted inside the HyperAgents preset realm. The scoped
    // waterfall therefore adjusts only calls made by agents using that preset;
    // it does not change provider catalogs, saved user selections, or the
    // native Harness loop. An explicit lower effort (notably `off`) wins.
    ctx.on('agent/request', async (_payload, next): Promise<LlmCallConfig> => {
      const resolved = await next()
      const cap = reasoningCaps.find(item => item.provider === resolved.provider && item.model === resolved.model)
      if (cap === undefined) return resolved
      const selectedRank =
        resolved.reasoningEffort === undefined
          ? Number.POSITIVE_INFINITY
          : REASONING_RANK.get(String(resolved.reasoningEffort))
      const capRank = REASONING_RANK.get(cap.effort)
      if (capRank === undefined) return resolved
      if (selectedRank !== undefined && selectedRank <= capRank) return resolved
      return { ...resolved, reasoningEffort: ReasoningEffortId(cap.effort) }
    })
  }
  ctx.tools.register(
    defineTool({
      name: 'hivemind_capabilities',
      description:
        'Progressively reveal installed native Harness capabilities when the task needs them. Use list to see compact lanes, then lease only the smallest relevant lane before using its tools: a known public page or screenshot normally needs browser alone; current public facts need web or research; workspace is only for files, shell, or jobs. Do not lease unrelated lanes “just in case.” Reset after a completed phase when a smaller surface helps. Leasing changes only model-visible schemas for this agent; it does not install, emulate, or replace tools.',
      parameters: {
        operation: { type: 'string', required: true, enum: ['list', 'lease', 'reset'] },
        capabilities: {
          type: 'array',
          items: { type: 'string', enum: Object.keys(CAPABILITY_TOOLS) },
          description: 'One or more lanes to add. Required for lease.',
        },
      },
      output,
      isConcurrencySafe: args => String(args.operation) === 'list',
      async execute(args, execution) {
        const input = record(args as JsonValue, 'arguments')
        const operation = text(input['operation'], 'operation', 20)
        const agent = currentAgent(execution.agent)
        if (operation === 'list') {
          const state = capabilityStateByAgent.get(agent)
          const suppressed = toolsSuppressedByRunState(agent)
          return {
            status: 'ready',
            active: [...(state?.capabilities ?? [])],
            capabilities: Object.entries(CAPABILITY_DESCRIPTIONS).map(([id, description]) => ({ id, description })),
            ...(suppressed.size === 0 ? {} : { suppressed_tools: [...suppressed].sort() }),
            instruction: suppressed.size === 0
              ? 'Lease only the lanes useful for the next work. The next model step receives their original native tool schemas.'
              : 'Research and orientation are satisfied. For a missing first-party passage, lease web and read its exact URL with web_fetch. To reopen research or search, call hivemind_workstream with action evidence_gap, the active workstream_id, and a specific missing-fact summary.',
          }
        }
        if (operation === 'reset') {
          const retainOrchestration = hasUnfinishedPlanWorkstreams(agent)
          return {
            status: 'ready',
            ...replaceCapabilityLease(
              agent,
              retainOrchestration ? new Set<CapabilityLane>(['orchestration']) : new Set(),
              'reset',
            ),
            ...(retainOrchestration
              ? {
                retained_capabilities: ['orchestration'],
                next: 'The active plan still has unfinished workstreams. Continue them with hivemind_workstream.',
              }
              : {}),
          }
        }
        if (operation !== 'lease') throw new TypeError('hivemind-playbooks: unsupported capability operation')
        const requested = stringList(input['capabilities'], 'capabilities') ?? []
        if (requested.length === 0)
          throw new TypeError('hivemind-playbooks: capabilities must contain at least one lane')
        const unknown = requested.filter(value => !Object.hasOwn(CAPABILITY_TOOLS, value))
        if (unknown.length > 0) throw new TypeError(`hivemind-playbooks: unknown capability ${unknown.join(', ')}`)
        const active = new Set(capabilityStateByAgent.get(agent)?.capabilities ?? [])
        const plan = latestPlan(agent)
        const hasInlineEmployees = plan?.workstreams.some(item => item.actor.kind === 'inline_employee') ?? false
        const hasEmployeeChildren = plan?.workstreams.some(item => item.actor.kind === 'employee_subagent') ?? false
        const suppressEmployeeChildren = !nativeTeamCoordination
          && (!employeeSubagentPlanning || (hasInlineEmployees && !hasEmployeeChildren))
        if (suppressEmployeeChildren) active.delete('employees')
        for (const capability of requested) {
          if (capability === 'employees' && suppressEmployeeChildren) continue
          active.add(capability as CapabilityLane)
        }
        const skills = recommendedSkills(active)
        const suppressed = toolsSuppressedByRunState(agent)
        return {
          status: 'ready',
          ...replaceCapabilityLease(agent, active, 'lease'),
          ...(suppressed.size === 0 ? {} : { suppressed_tools: [...suppressed].sort() }),
          ...(suppressEmployeeChildren && requested.includes('employees')
            ? {
              suppressed_capabilities: ['employees'],
              plan_fidelity:
                  'The active plan selected inline_employee workstreams. Use hivemind_workstream; revise the plan before exposing independent child-agent tools.',
            }
            : {}),
          ...(skills.length === 0 ? {} : { recommended_skills: skills }),
          next:
            suppressEmployeeChildren && requested.includes('employees')
              ? 'Continue the selected inline employee workstreams with hivemind_workstream in this parent session.'
              : skills.length === 0
                ? 'Continue the task using the newly visible original Harness tools.'
                : `When their guidance is useful, load these exact progressive skills with hivemind_skills: ${skills.join(', ')}. Continue with the original Harness tools; this is guidance, not a mandatory workflow.`,
        }
      },
      presentCall(args) {
        return {
          card: 'generic',
          title: 'Load Harness capabilities',
          kind: 'read',
          rawInput: String(args.operation ?? ''),
        }
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'hivemind_operating_context',
      description:
        'Prepare a compact, authoritative company operating-context receipt when internal evidence, methods, or employee discovery would materially help. This call retrieves company context, focused internal recall, applicable global doctrine and compatible local method content, and authenticated employee candidates. The next model step reasons over that evidence before optionally recording a plan. Native Harness tools remain freely available; repeat retrieval only for a specific unresolved gap.',
      parameters: {
        objective: {
          type: 'string',
          required: true,
          description: 'The user requested company outcome, in natural language.',
        },
      },
      output,
      isConcurrencySafe: () => false,
      async execute(args, execution) {
        const input = record(args as JsonValue, 'arguments')
        const objective = text(input['objective'], 'objective', maxObjectiveChars)
        const agent = currentAgent(execution.agent)
        const activePlan = latestPlan(agent)
        const existing = activePlan === undefined ? undefined : operatingContextForRun(agent, activePlan.runId)
        if (activePlan !== undefined && existing !== undefined) {
          return {
            status: 'already_ready',
            next: 'Continue the existing operating plan and native session todo from their current state. Do not repeat company orientation, playbook selection, or research already represented by receipts.',
            active_plan: { plan_id: activePlan.planId, revision: activePlan.revision },
            run_id: activePlan.runId,
            requested_objective: objective,
          }
        }
        const query = new Set([...tokens(objective)].filter(token => !RECALL_STOP_WORDS.has(token)))
        const ranked = PLAYBOOKS.map(playbook => ({ playbook, score: score(playbook, query, new Set()) }))
          .filter(candidate => candidate.score > 0)
          .sort((left, right) => right.score - left.score || left.playbook.id.localeCompare(right.playbook.id))
        const rankedLocals = ranked.filter(candidate => candidate.playbook.level === 'local')
        const requiredGlobalIds = new Set(rankedLocals.flatMap(candidate => candidate.playbook.parentGlobalIds ?? []))
        const requiredGlobals = [...requiredGlobalIds].flatMap((id) => {
          const playbook = PLAYBOOKS.find(item => item.level === 'global' && item.id === id)
          return playbook ? [{ playbook, score: score(playbook, query, new Set()) }] : []
        })
        const matchedGlobals = ranked.filter(
          candidate => candidate.playbook.level === 'global' && !requiredGlobalIds.has(candidate.playbook.id),
        )
        const globals = [...requiredGlobals, ...matchedGlobals].slice(0, 3)
        const globalIds = new Set(globals.map(candidate => candidate.playbook.id))
        const compatibleLocals = rankedLocals.filter(
          candidate =>
            candidate.playbook.level === 'local' &&
            (candidate.playbook.parentGlobalIds ?? []).some(parentId => globalIds.has(parentId)),
        )
        // Keep the best local method beside its doctrine even under a compact
        // candidate limit; otherwise global candidates crowd out executable guidance.
        const firstLocal = compatibleLocals[0]
        const firstParent = globals.find(candidate => firstLocal?.playbook.parentGlobalIds?.includes(candidate.playbook.id))
        const playbookCandidates = [
          ...(firstParent ? [firstParent] : []), ...(firstLocal ? [firstLocal] : []), ...globals, ...compatibleLocals,
        ]
          .filter(
            (candidate, index, all) => all.findIndex(item => item.playbook.id === candidate.playbook.id) === index,
          )
          .slice(0, maxSearchResults)
          .map(({ playbook, score: relevance }) => ({
            id: playbook.id,
            version: playbook.version,
            level: playbook.level,
            title: playbook.title,
            description: playbook.description,
            domains: [...playbook.domains],
            ...(playbook.parentGlobalIds === undefined ? {} : { parentGlobalIds: [...playbook.parentGlobalIds] }),
            content: playbook.content,
            ...(playbook.fieldMethod === undefined ? {} : { fieldMethod: playbook.fieldMethod, guidanceTool: 'hivemind_field_step', capabilityLane: 'orchestration' }),
            ...(playbook.generationCapabilities === undefined ? {} : { generationCapabilities: [...playbook.generationCapabilities] }),
            relevance,
          }))
        const [companyContext, internalEvidence, directory] = await Promise.all([
          ctx.hivemindMemory.context(agent, execution.signal),
          ctx.hivemindMemory.recall({ query: focusedRecallQuery(objective), mode: 'auto', limit: 5 }, execution.signal, execution),
          ctx.hivemindMemory.profiles(execution.signal),
        ])
        const profiles = Array.isArray(directory['profiles']) ? directory['profiles'] : []
        const employeeCandidates = profiles.slice(0, maxOperatingEmployees).flatMap((value) => {
          if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
          const profile = value as Record<string, JsonValue>
          if (typeof profile['id'] !== 'string' || typeof profile['name'] !== 'string') return []
          const role = typeof profile['role_archetype'] === 'string' ? profile['role_archetype'] : 'HIVE-MIND employee'
          return [{ id: profile['id'], name: profile['name'], role, capabilities: employeeCapabilities(profile, role) }]
        })
        const guidance = capabilityGuidance(objective)
        const compactInternalEvidence = compactEvidence(
          internalEvidence,
          maxOperatingEvidenceItems,
          maxOperatingEvidenceChars,
        )
        const internalEvidenceCount =
          typeof compactInternalEvidence['count'] === 'number' ? compactInternalEvidence['count'] : 0
        const externalEvidenceLikelyNeeded = guidance.includes('current external evidence may be needed')
        const retrieval = {
          companyContext: 'ready' as const,
          internalRecall: internalEvidenceCount > 0 ? ('ready' as const) : ('empty' as const),
          employeeDirectory: employeeCandidates.length > 0 ? ('ready' as const) : ('empty' as const),
          additionalRecallNeeded: false,
          additionalRecallReason:
            internalEvidenceCount > 0
              ? 'Focused company recall is already included. Recall again only for a specifically named missing fact, person, decision, or file.'
              : 'The focused recall returned no evidence. Recall again only if the task requires a specifically named company fact that the compact company context does not contain.',
          externalEvidenceLikelyNeeded,
        }
        const event: OperatingContextRecorded = {
          runId: randomUUID(),
          objective,
          companyContext: boundedJson(companyContext, maxOperatingCompanyChars) as Record<string, JsonValue>,
          internalEvidence: compactInternalEvidence,
          // Employee identity precedes large playbook bodies in the serialized
          // receipt so provider-side result truncation cannot cut off the exact
          // authenticated id needed for inline execution.
          employeeCandidates,
          playbookCandidates,
          recommendedGlobalPlaybooks: globals.map(candidate => candidate.playbook.id),
          compatibleLocalPlaybooks: compatibleLocals.map(candidate => candidate.playbook.id),
          employeeExecution: {
            defaultActorKind: nativeTeamCoordination ? 'persistent_employee' : 'inline_employee',
            tool: nativeTeamCoordination ? 'hivemind_hq_contract' : 'hivemind_workstream',
            childAgents: nativeTeamCoordination ? 'persistent_room_execution' : employeeSubagentPlanning ? 'optional_escalation' : 'disabled_for_preset',
          },
          capabilityGuidance: guidance,
          likelyNeeds: guidance,
          retrieval,
        }
        agent.session.append('hivemind/operating-context', event)
        const handoff = operatingContextHandoff(event)
        const injectable = agent as Agent & { inject?: (message: ReturnType<typeof createUserMessage>) => void }
        injectable.inject?.(createUserMessage({
          content: [{ type: 'text', text: handoff }],
          source: {
            kind: 'plugin',
            plugin: name,
            form: 'snapshot',
            sections: [{ name: 'hivemind:operating-context-handoff', text: handoff }],
          },
        }))
        const { retrieval: retrievalReceipt, ...operatingEvidence } = event
        return {
          status: 'ready',
          retrieval: retrievalReceipt,
          next: nativeTeamCoordination
            ? 'Runtime coordinates approved work and reviews exact employee receipts. Assign immediate deliverables with hivemind_hq_contract action assign into each authenticated employee persistent room; schedule future assignments with action schedule, which notifies the employee now and targets their room at its saved start. Native Team tasks own dependencies and acceptance status. Do not perform assigned employee research or artifacts inline. Ordinary greetings and direct questions need concise answers without a task or investigation. Existing authority remains unchanged.'
            : employeeSubagentPlanning
              ? 'Reason over the returned global doctrine, compatible local method content, evidence, and authenticated employee candidates. These employees are executable identities: never ask the user to provide their views. For substantial multi-step company work, record one concise adaptive operating plan before expensive research or delegation; include only workstreams and actors that add execution value. Use the returned employeeExecution default for ordinary employee work. Escalate to employee_subagent only when isolation, real concurrent long-running execution, or a distinct model/tool boundary materially helps. For bounded work, answer or execute directly. External research belongs after this orientation unless a live fact is needed to choose the approach. Do not repeat covered HIVE retrieval unless a specific gap emerges, and never invent facts, employees, files, deliverables, or thresholds.'
              : 'Reason over the returned global doctrine, compatible local method content, evidence, and authenticated employee candidates. Employee selections are visible inline work identities: assign them with inline_employee and let this parent runtime complete their todo workstreams through hivemind_workstream. Do not create employee child sessions. For substantial multi-step company work, record one concise adaptive operating plan; bounded work may proceed directly. External research belongs after this orientation unless a live fact is needed to choose the approach. Do not repeat covered HIVE retrieval or invent facts, employees, files, deliverables, or thresholds.',
          ...operatingEvidence,
        }
      },
      presentCall(args) {
        return {
          card: 'generic',
          title: 'Prepare company operating context',
          kind: 'read',
          rawInput: String(args.objective ?? ''),
        }
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'hivemind_playbooks',
      description:
        'Progressively discover and load company operating playbooks, then record the adaptive playbook selection for a substantial HyperAgents run. Search first with the user objective and optional domains; load only useful IDs. record_plan atomically loads its selected playbooks if they were not already loaded, so an ordering error cannot strand a governed run. If no playbook fits, continue with native Harness reasoning instead of inventing a method. Do not call for greetings or simple direct answers, and do not treat a run plan as a completed task.',
      parameters: {
        operation: {
          type: 'string',
          required: true,
          enum: [
            'search',
            'load',
            'record_plan',
            'revise_plan',
            'brief',
            'discover',
            'select',
            'record',
            'plan',
            'revise',
          ],
          description:
            'Use search, load, record_plan, or revise_plan. Discovery aliases are accepted only for resilient provider interoperability.',
        },
        query: { type: 'string', description: 'Complete task objective for search.' },
        level: { type: 'string', enum: ['global', 'local'], description: 'Optional playbook level filter.' },
        domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional relevant disciplines or capabilities.',
        },
        limit: { type: 'integer', description: 'Maximum compact candidates to return.' },
        playbook_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exact playbook IDs to load or record.',
        },
        objective: { type: 'string', description: 'Optional concise task objective for the run receipt.' },
        approach: { type: 'string', description: 'Optional concise execution approach for the run receipt.' },
        reason: {
          type: 'string',
          description:
            'Optional concise reason the selected playbook or playbooks fit this run. One reason is intentionally shared so all model providers can call this reliably.',
        },
        plan_id: { type: 'string', description: 'Exact current plan id, required only when revising a recorded plan.' },
        revision_reason: { type: 'string', description: 'Why the runtime changed its earlier plan.' },
        workstreams: {
          type: 'array',
          description:
            'Optional workstreams chosen by the runtime. Actor selection is recorded, never inferred by this tool.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              objective: { type: 'string' },
              actor_kind: { type: 'string', enum: acceptedActorKinds, description: employeeActorDescription },
              employee_id: { type: 'string' },
              role: { type: 'string' },
              outcome: { type: 'string' },
            },
          },
        },
      },
      output,
      isConcurrencySafe: args =>
        !['record_plan', 'record', 'plan', 'revise_plan', 'revise'].includes(String(args.operation)),
      async execute(args, execution) {
        const input = record(args as JsonValue, 'arguments')
        const operation = normalizeOperation(input['operation'])
        if (operation === 'search') {
          const queryText = input['query'] === undefined ? '' : text(input['query'], 'query', maxObjectiveChars)
          const requestedLevel =
            input['level'] === undefined ? undefined : (text(input['level'], 'level', 20) as PlaybookLevel)
          if (requestedLevel !== undefined && requestedLevel !== 'global' && requestedLevel !== 'local')
            throw new TypeError('hivemind-playbooks: unsupported level')
          const requestedDomains = new Set(
            (stringList(input['domains'], 'domains') ?? []).map(domain => domain.toLowerCase()),
          )
          const requestedLimit = input['limit'] ?? maxSearchResults
          if (
            !Number.isInteger(requestedLimit) ||
            (requestedLimit as number) < 1 ||
            (requestedLimit as number) > maxSearchResults
          )
            throw new TypeError(`hivemind-playbooks: limit must be from 1 to ${maxSearchResults}`)
          const query = tokens(queryText)
          const ranked = PLAYBOOKS.filter(
            playbook => requestedLevel === undefined || playbook.level === requestedLevel,
          )
            .map(playbook => ({ playbook, score: score(playbook, query, requestedDomains) }))
            .filter(candidate => candidate.score > 0)
            .sort((left, right) => right.score - left.score || left.playbook.id.localeCompare(right.playbook.id))
          const limit = requestedLimit as number
          let candidates = ranked.slice(0, limit)
          // Unscoped discovery returns one applicable global doctrine as well as
          // matching local methods. This is progressive context, not a pipeline:
          // the model still decides whether the substantial task needs the methods.
          if (requestedLevel === undefined) {
            const rankedGlobal = ranked.filter(candidate => candidate.playbook.level === 'global')
            candidates = [
              ...rankedGlobal.slice(0, 1),
              ...ranked.filter(candidate => candidate.playbook.level === 'local'),
            ]
              .filter(
                (candidate, index, all) =>
                  all.findIndex(item => item.playbook.id === candidate.playbook.id) === index,
              )
              .slice(0, limit)
          }
          const compact = candidates.map(({ playbook, score: relevance }) => ({
            id: playbook.id,
            version: playbook.version,
            level: playbook.level,
            title: playbook.title,
            description: playbook.description,
            domains: [...playbook.domains],
            ...(playbook.parentGlobalIds === undefined ? {} : { parentGlobalIds: [...playbook.parentGlobalIds] }),
            relevance,
          }))
          return {
            status: 'ready',
            operation: 'search',
            candidates: compact,
            recommended_plan: {
              playbook_ids: compact.map(playbook => playbook.id),
              next_operation: 'load',
              instruction:
                compact.length === 0
                  ? 'No catalog method matched. Continue with native Harness reasoning; do not invent or load a playbook.'
                  : 'Load only the useful global doctrine and compatible local methods; omit irrelevant methods.',
            },
          }
        }
        const ids = stringList(input['playbook_ids'], 'playbook_ids') ?? []
        if (ids.length === 0 || ids.length > maxSelectedPlaybooks)
          throw new TypeError(`hivemind-playbooks: playbook_ids must contain 1 to ${maxSelectedPlaybooks} items`)
        if (new Set(ids).size !== ids.length) throw new TypeError('hivemind-playbooks: playbook_ids must be unique')
        const selected = selectionWithParents(ids, byId)
        if (operation === 'load') {
          const agent = currentAgent(execution.agent)
          const loaded = loadedByAgent.get(agent) ?? new Set<string>()
          for (const playbook of selected) loaded.add(playbook.id)
          loadedByAgent.set(agent, loaded)
          const context = latestOperatingContext(agent)
          agent.session.append('hivemind/playbooks-loaded', {
            ...(context === undefined ? {} : { runId: context.runId }),
            playbooks: selected.map(playbook => ({ id: playbook.id, version: playbook.version })),
          })
          return {
            status: 'ready',
            operation: 'load',
            ...(context === undefined ? {} : { run_id: context.runId }),
            playbooks: selected.map(playbook => ({
              ...playbook,
              domains: [...playbook.domains],
              intents: [...playbook.intents],
              ...(playbook.parentGlobalIds === undefined ? {} : { parentGlobalIds: [...playbook.parentGlobalIds] }),
            })),
            next: 'Use the selected methods only where they improve the task. Record a concise operating plan when an intent receipt would make meaningful execution clearer or more durable.',
          }
        }
        const agent = currentAgent(execution.agent)
        const loaded = loadedByAgent.get(agent) ?? new Set<string>()
        const loadedNow = selected.filter(playbook => !loaded.has(playbook.id))
        // record_plan is a durable boundary, not a trivia test for a model. Load
        // the exact selected methods here when needed so a harmless call-order
        // variation cannot stop a company task and force an unnecessary question.
        for (const playbook of loadedNow) loaded.add(playbook.id)
        loadedByAgent.set(agent, loaded)
        // The plan is an observability receipt, never a task gate. Keep the
        // public call contract flat: several model providers lose arbitrary keys
        // in nested object schemas, which otherwise turns a useful receipt into
        // a repeat-tool loop. Rich callers may supply prose; safe defaults retain
        // the selected version without inventing task facts.
        const objective = optionalText(
          input['objective'],
          'objective',
          'Operating run with the selected playbooks.',
          maxObjectiveChars,
        )
        const approach = optionalText(
          input['approach'],
          'approach',
          'Adapt the selected operating methods to the requested outcome.',
          maxObjectiveChars,
        )
        const reason = optionalText(
          input['reason'],
          'reason',
          'Selected as the applicable operating method for this run.',
          1_000,
        )
        const previous = latestPlan(agent)
        const revising = operation === 'revise_plan'
        const planId = revising ? text(input['plan_id'], 'plan_id', 200) : randomUUID()
        if (revising && (previous === undefined || previous.planId !== planId))
          throw new TypeError('hivemind-playbooks: plan_id is not the current operating plan')
        const revisionReason = revising ? text(input['revision_reason'], 'revision_reason', 1_000) : undefined
        const selectedWorkstreams = resolveEmployeeActors(
          agent,
          workstreams(
            input['workstreams'],
            maxObjectiveChars,
            plannedActorKinds,
            !employeeSubagentPlanning,
          ),
        )
        const event: RunPlanRecorded = {
          runId: latestOperatingContext(agent)?.runId ?? randomUUID(),
          planId,
          revision: revising && previous ? previous.revision + 1 : 1,
          objective,
          approach,
          workstreams: selectedWorkstreams,
          playbooks: selected.map(playbook => ({
            id: playbook.id,
            version: playbook.version,
            reason,
          })),
          ...(revisionReason === undefined ? {} : { revisionReason }),
        }
        const operatingContext = latestOperatingContext(agent)
        if (loadedNow.length > 0 && operatingContext !== undefined)
          agent.session.append('hivemind/playbooks-loaded', {
            runId: operatingContext.runId,
            playbooks: selected.map(playbook => ({ id: playbook.id, version: playbook.version })),
          })
        agent.session.append(revising ? 'hivemind/run-plan-revised' : 'hivemind/run-plan', event)
        agent.session.append('todo/write', { todos: operatingPlanTodos(event) })
        return {
          status: 'recorded',
          operation: revising ? 'revise_plan' : 'record_plan',
          plan: event,
          todo: { status: 'created', items: operatingPlanTodos(event) },
          next: 'Use native Harness tools, skills, jobs, workflows, and employees freely. Their receipts are linked to this operating run automatically; use hivemind_workstream only for named inline employee work or meaningful progress without another native receipt. Keep the native session todo current and finish its remaining items before the final response.',
          ...(loadedNow.length === 0
            ? {}
            : {
              loaded_playbooks: loadedNow.map(playbook => ({
                ...playbook,
                domains: [...playbook.domains],
                intents: [...playbook.intents],
              })),
            }),
        }
      },
      presentCall(args) {
        return {
          card: 'generic',
          title: 'Use HIVE-MIND playbooks',
          kind: 'read',
          rawInput: String(args.operation ?? ''),
        }
      },
    }),
  )

  // Keep plan recording separate from playbook discovery in the model-facing
  // surface. This is the same durable plan contract, not a second planner: the
  // parent model supplies every workstream and actor choice, and the tool only
  // validates and records that decision.
  ctx.tools.register(
    defineTool({
      name: 'hivemind_operating_plan',
      description:
        "Record the model's concise adaptive operating intent when substantial company work benefits from a durable plan. Select only useful global/local playbooks and authenticated employees returned by operating context. Optional workstreams record the model's own actor choices; they do not create a fixed task graph. The resulting receipt progressively reveals only the native execution lanes needed by those choices. Bounded work may skip this tool, and native Harness execution remains unrestricted.",
      parameters: {
        objective: { type: 'string', required: true, description: 'The requested company outcome.' },
        approach: { type: 'string', required: true, description: 'Your concise adaptive execution approach.' },
        playbook_ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Useful global/local playbook IDs from the current operating-context receipt. Omit when none fits.',
        },
        workstreams: {
          type: 'array',
          description:
            'Optional meaningful workstreams selected by the model. Use an authenticated employee id only when operating context returned it.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              objective: { type: 'string' },
              actor_kind: { type: 'string', enum: acceptedActorKinds, description: employeeActorDescription },
              employee_id: { type: 'string' },
              role: { type: 'string' },
              outcome: { type: 'string' },
              approval_required: {
                type: 'boolean',
                description: 'Set only when a real human decision must be granted before this workstream can complete.',
              },
            },
          },
        },
      },
      output,
      isConcurrencySafe: () => false,
      async execute(args, execution) {
        const input = record(args as JsonValue, 'arguments')
        const agent = currentAgent(execution.agent)
        const context = latestOperatingContext(agent)
        const activePlan = latestPlan(agent)
        // Weak and strong models both sometimes call the planning tool again
        // after execution has started. Creating a second plan here severs the
        // apparent relationship between the active plan and its existing
        // receipts, which can trigger an expensive duplicate-research loop.
        // Keep the boundary idempotent until the current plan's todos settle.
        if (
          activePlan !== undefined
          && (context === undefined || activePlan.runId === context.runId)
          && hasUnfinishedPlanTodo(agent)
        ) {
          const todos = latestPlanTodos(agent)
          return {
            status: 'already_active',
            operation: 'continue_plan',
            plan: activePlan,
            todo: { status: 'in_progress', items: todos },
            next: 'Continue the existing operating plan from its durable receipts. Do not create another plan or repeat completed research. Finish or fail its remaining workstreams before final synthesis.',
          }
        }
        const previouslyLoaded = latestLoadedPlaybooks(agent)
        // A conversation may contain multiple company tasks. Inherit loaded
        // methods only from the active operating context, never from an earlier
        // completed run in the same chat.
        const loadedForCurrentRun =
          previouslyLoaded !== undefined && (context === undefined || previouslyLoaded.runId === context.runId)
            ? previouslyLoaded.playbooks
            : []
        const requestedIds =
          stringList(input['playbook_ids'], 'playbook_ids') ?? loadedForCurrentRun.map(playbook => playbook.id)
        if (requestedIds.length > maxSelectedPlaybooks)
          throw new TypeError(`hivemind-playbooks: playbook_ids cannot exceed ${maxSelectedPlaybooks} items`)
        if (new Set(requestedIds).size !== requestedIds.length)
          throw new TypeError('hivemind-playbooks: playbook_ids must be unique')
        if (context !== undefined) {
          const candidates = new Set(
            context.playbookCandidates.flatMap(candidate =>
              typeof candidate['id'] === 'string' ? [candidate['id']] : [],
            ),
          )
          const outsideReceipt = requestedIds.filter(id => !candidates.has(id))
          if (outsideReceipt.length > 0)
            throw new TypeError(
              `hivemind-playbooks: playbook ${outsideReceipt[0]} was not returned by the current operating context`,
            )
        }
        const selected = selectionWithParents(requestedIds, byId)
        const objective = text(input['objective'], 'objective', maxObjectiveChars)
        const approach = text(input['approach'], 'approach', maxObjectiveChars)
        const requestedWorkstreams = workstreams(
          input['workstreams'],
          maxObjectiveChars,
          plannedActorKinds,
          !employeeSubagentPlanning,
        )
        // Once the model elects to record an operating plan, an empty
        // workstream list must not strand its todo outside the coordinator.
        // Treat the chosen approach as one parent-runtime workstream. This is
        // an execution identity and progress anchor, not a generated DAG.
        const selectedWorkstreams = resolveEmployeeActors(agent, requestedWorkstreams.length > 0
          ? requestedWorkstreams
          : [{ id: 'execute_outcome', objective: approach, actor: { kind: 'main' } }])
        const loaded = loadedByAgent.get(agent) ?? new Set<string>()
        const loadedNow = selected.filter(playbook => !loaded.has(playbook.id))
        for (const playbook of loadedNow) loaded.add(playbook.id)
        loadedByAgent.set(agent, loaded)
        const alreadyReceipted =
          previouslyLoaded !== undefined &&
          (context === undefined || previouslyLoaded.runId === context.runId) &&
          selected.length === previouslyLoaded.playbooks.length &&
          selected.every(playbook =>
            previouslyLoaded.playbooks.some(
              receipt => receipt.id === playbook.id && receipt.version === playbook.version,
            ),
          )
        if (selected.length > 0 && !alreadyReceipted)
          agent.session.append('hivemind/playbooks-loaded', {
            ...(context === undefined ? {} : { runId: context.runId }),
            playbooks: selected.map(playbook => ({ id: playbook.id, version: playbook.version })),
          })
        const event: RunPlanRecorded = {
          runId: context?.runId ?? randomUUID(),
          planId: randomUUID(),
          revision: 1,
          objective,
          approach,
          workstreams: selectedWorkstreams,
          playbooks: selected.map(playbook => ({
            id: playbook.id,
            version: playbook.version,
            reason: 'Loaded before this operating plan.',
          })),
        }
        agent.session.append('hivemind/run-plan', event)
        const sessionTodos = operatingPlanTodos(event)
        agent.session.append('todo/write', { todos: sessionTodos })
        const executionCapabilities = new Set(capabilityStateByAgent.get(agent)?.capabilities ?? [])
        if (selected.some(playbook =>
          playbook.id === 'global-research'
          || playbook.domains.includes('research')
          || playbook.parentGlobalIds?.includes('global-research') === true,
        )) executionCapabilities.add('research')
        if (selectedWorkstreams.length > 0) executionCapabilities.add('orchestration')
        if (selectedWorkstreams.some(item => item.actor.kind === 'employee_subagent'))
          executionCapabilities.add('employees')
        const capabilityLease =
          progressiveToolDisclosure && executionCapabilities.size > 0
            ? replaceCapabilityLease(agent, executionCapabilities, 'lease')
            : undefined
        const employeeChildren = selectedWorkstreams.filter(item => item.actor.kind === 'employee_subagent')
        const nextActions: Array<Record<string, unknown>> = selectedWorkstreams.flatMap((item) => {
          if (item.actor.kind === 'employee_subagent' && employeeChildren.length === 1)
            return [
              {
                workstream_id: item.id,
                tool: 'hivemind_delegate_employee',
                employee_id: item.actor.employeeId,
                objective: item.objective,
              },
            ]
          if (item.actor.kind === 'inline_employee')
            return [
              {
                workstream_id: item.id,
                tool: 'hivemind_workstream',
                action: 'start',
                employee_id: item.actor.employeeId,
                objective: item.objective,
                ...(item.approvalRequired === true
                  ? {
                    approval_required: true,
                    completion_gate: 'Call request_approval and require allowed-once before complete.',
                  }
                  : {}),
              },
            ]
          return []
        })
        if (employeeChildren.length > 1)
          nextActions.unshift({
            tool: 'hivemind_employee_panel',
            assignments: employeeChildren.map(item => ({
              workstream_id: item.id,
              employee_id: item.actor.employeeId,
              task: item.objective,
              ...(item.outcome === undefined ? {} : { outcome: item.outcome }),
            })),
          })
        return {
          status: 'recorded',
          operation: 'record_plan',
          plan: event,
          todo: { status: 'created', items: sessionTodos },
          next:
            nextActions.length === 0
              ? 'Execute naturally with native Harness capabilities. Keep the native session todo current and complete it before the final response. Research, child, workflow, browser, artifact, and action receipts attach to this run.'
              : 'Execute the selected employee workstreams with the indicated original Harness tools, update the native session todo as work completes, then synthesize from their terminal receipts. Do not leave todo items in progress when returning the final answer.',
          ...(capabilityLease === undefined ? {} : { capability_lease: capabilityLease }),
          ...(nextActions.length === 0 ? {} : { next_actions: nextActions }),
          ...(loadedNow.length === 0
            ? {}
            : {
              loaded_playbooks: loadedNow.map(playbook => ({
                ...playbook,
                domains: [...playbook.domains],
                intents: [...playbook.intents],
              })),
            }),
        }
      },
      presentCall(args) {
        return {
          card: 'generic',
          title: 'Record HIVE-MIND operating plan',
          kind: 'read',
          rawInput: String(args.objective ?? ''),
        }
      },
    }),
  )
}
