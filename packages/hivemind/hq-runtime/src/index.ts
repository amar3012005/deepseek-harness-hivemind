/** HQ policy extends native Team tasks instead of maintaining a competing board. */
import type { Context } from '@deepseek-ai/cordis'
import { TeamTaskId } from '@deepseek-ai/dsh-experimental-agent-team'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { companyTaskContract, requireArtifactReceipts, taskContracts, verifiedArtifactLinks, type CompanyTaskContract, type TaskArtifactLinks } from './ledger.ts'
export const name = 'hivemind-hq-runtime'
export { HqControl } from './control.ts'
export type { HqModeUpdate, HqModeUpdateResult } from './control.ts'
export type { HqModeState } from './mode.ts'
export const inject = ['tools', 'agentTeams', 'sessions', 'sessionPersistence', 'agents']
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Immutable requirements supplementing a native Team task. */
    'hivemind/hq-task-contract': CompanyTaskContract
    /** Artifact references correlated to a native Team task. */
    'hivemind/hq-task-artifacts': TaskArtifactLinks
  }
}
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.agentTeams.guardTaskUpdates((caller, request) => {
    if (request.action !== 'complete') return
    const root = ctx.agentTeams.membership(caller).root
    // Other companies and non-HQ Teams retain their native policy.
    const events = root.session.snapshotEvents()
    if (!taskContracts(events).some(contract => contract.taskId === request.taskId)) return
    try { requireArtifactReceipts(events, request.taskId) } catch { return 'HQ task completion requires a saved artifact receipt linked to this task.' }
  }))
  ctx.tools.register(defineTool({
    name: 'hivemind_hq_contract',
    description: 'Supplement an existing native Team task with company deadline and acceptance criteria. Native team_task tools own creation, revisions, claims, dependencies, and completion. Artifact links require saved producer receipts. This tool does not dispatch, grant authority, or certify acceptance.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'attach', 'artifacts'] },
      task_id: { type: 'string' }, due_at: { type: 'string', description: 'RFC3339 instant with explicit timezone.' },
      acceptance_criteria: { type: 'array', items: { type: 'string' } },
      artifact_ids: { type: 'array', items: { type: 'string' } },
      producer: { type: 'string', description: 'Exact native Team member name that saved the artifacts; defaults to lead. Only rostered members can supply receipts.' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    isConcurrencySafe: () => false,
    async execute(args, execution) {
      const agent = execution.agent
      if (!agent) throw new Error('hq_active_agent_required')
      const input = args as {
        action: string
        task_id?: string
        due_at?: string
        acceptance_criteria?: string[]
        artifact_ids?: string[]
        producer?: string
      }
      const membership = ctx.agentTeams.membership(agent)
      const root = membership.root
      const events = root.session.snapshotEvents()
      const contracts = taskContracts(events)
      if (input.action === 'list') return { contracts: contracts.map(contract => ({ ...contract, acceptanceCriteria: [...contract.acceptanceCriteria] })), tasks: ctx.agentTeams.listTasks(agent).map(task => ({ task_id: task.id, revision: task.revision, subject: task.subject, status: task.status })) }
      if (membership.role !== 'lead') throw new Error('hq_lead_required')
      if (!input.task_id) throw new Error('hq_task_id_required')
      ctx.agentTeams.getTask(agent, TeamTaskId(input.task_id))
      if (input.action === 'attach') {
        if (contracts.some(item => item.taskId === input.task_id)) throw new Error('hq_contract_exists')
        const contract = companyTaskContract({ taskId: input.task_id, dueAt: input.due_at, acceptanceCriteria: input.acceptance_criteria })
        root.session.append('hivemind/hq-task-contract', contract)
        if (!await ctx.sessions.flush(root.session)) throw new Error('hq_contract_persistence_required')
        return { contract: { ...contract, acceptanceCriteria: [...contract.acceptanceCriteria] } }
      }
      if (input.action !== 'artifacts' || !contracts.some(item => item.taskId === input.task_id)) throw new Error('hq_contract_required')
      const producer = ctx.agentTeams.listMembers(agent).find(member => member.name === (input.producer ?? 'lead'))
      if (!producer) throw new Error('hq_artifact_producer_not_member')
      const liveProducer = ctx.agents.get(producer.id)
      if (liveProducer && !await ctx.sessions.flush(liveProducer.session)) throw new Error('hq_producer_persistence_required')
      const handle = await ctx.sessionPersistence.open(producer.id, 'read', { signal: execution.signal })
      let receipt: TaskArtifactLinks
      try {
        const { events: sourceEvents } = await handle.read(0, undefined, { signal: execution.signal })
        receipt = verifiedArtifactLinks(sourceEvents, input.task_id, input.artifact_ids ?? [], producer.id)
      } finally { await handle.close() }
      root.session.append('hivemind/hq-task-artifacts', receipt)
      if (!await ctx.sessions.flush(root.session)) throw new Error('hq_artifact_link_persistence_required')
      return { receipt: {
        taskId: receipt.taskId, artifactIds: [...receipt.artifactIds],
        producerReceipts: receipt.producerReceipts?.map(item => ({ ...item })) ?? [],
      } }
    },
  }))
}
