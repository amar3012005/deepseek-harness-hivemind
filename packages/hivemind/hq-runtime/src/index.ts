/** HQ policy extends native Team tasks instead of maintaining a competing board. */
import {
  jevReview,
  reviewFingerprint,
  savedArtifactText,
  savedSourceEvidence,
  type HqTaskReview,
} from './review.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { installRest, recoverRest, acknowledgeRestNotes, restBriefing, isHqLead } from './rest.ts'
import { installAwakening, awakeningContext } from './awakening.ts'
import { investigationExpired } from './investigation.ts'
import { wakeBriefing } from './wake-briefing.ts'
import { dispatchEmployee, reconcileEmployeeArtifacts } from './employee-room.ts'
import type {} from './control.ts'
import { calendarItems } from './calendar.ts'
import type {} from '@deepseek-ai/dsh-hivemind-employee-directory'
import type { Context } from '@deepseek-ai/cordis'
import { TeamTaskId } from '@deepseek-ai/dsh-experimental-agent-team'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import {
  companyTaskContract,
  requireArtifactReceipts,
  taskContracts,
  sameArtifactLinks,
  verifiedArtifactLinks,
  type CompanyTaskContract,
  type TaskArtifactLinks,
} from './ledger.ts'
export const name = 'hivemind-hq-runtime'
export { HqControl } from './control.ts'
export type { HqModeUpdate, HqModeUpdateResult } from './control.ts'
export type { HqModeState } from './mode.ts'
export const inject = [
  'tools',
  'agentTeams',
  'agentPresets',
  'sessions',
  'sessionPersistence',
  'agents',
  'schedule',
  'hivemindHq',
  'hivemindEmployeeDirectory',
  'sessionController',
]
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Immutable requirements supplementing a native Team task. */
    'hivemind/hq-task-contract': CompanyTaskContract
    /** Typed model acceptance review tied to task revision, saved artifacts and input digest. */
    'hivemind/hq-task-review': HqTaskReview
    /** Saved producer artifact references correlated to a native Team task. */
    'hivemind/hq-task-artifacts': TaskArtifactLinks
    /** Frozen authorized employee identity and native roster session for one assignment. */
    'hivemind/hq-employee-assignment': {
      taskId: string
      employeeId: string
      memberName: string
      sessionId: string
      personaSha256: string
    }
  }
}
export function apply(ctx: Context): void {
  installRest(ctx)
  installAwakening(ctx)
  const briefed = new WeakMap<object, number>()
  const researchMasked = new WeakSet<object>()
  const investigationMasks = new WeakMap<object, () => void>()
  ctx.effect(() => ctx.on('agent/pre-step', async ({ agent, turn, signal }, next) => {
    // Public-only investigation is a one-turn test scope, not the employee's
    // permanent operating identity. A later turn restores normal capabilities.
    if (investigationExpired(agent.session.ownEvents(), turn) && isHqLead(ctx, agent)) {
      agent.session.append('hivemind/hq-public-investigation', { enabled: false })
      if (!await ctx.sessions.flush(agent.session)) throw new Error('hq_investigation_scope_persistence_required')
      investigationMasks.get(agent)?.()
      investigationMasks.delete(agent)
    }
    const latestHuman = agent.session.snapshotEvents().findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')
    const wake = latestHuman?.type === 'user/message' && /^wake\s+up\s*,?\s*chief\s*!?\s*$/iu.test(latestHuman.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('').trim())
    if (wake && isHqLead(ctx, agent)) {
      const mode = agent.session.snapshotEvents().findLast(event => event.type === 'hivemind/hq-public-investigation')
      if (mode?.type === 'hivemind/hq-public-investigation' && mode.data.enabled) {
        agent.session.append('hivemind/hq-public-investigation', { ...mode.data, enabled: false })
        if (!await ctx.sessions.flush(agent.session)) throw new Error('hq_awakening_persistence_required')
        investigationMasks.get(agent)?.()
        investigationMasks.delete(agent)
      }
    }
    const decision = await next()
    if (decision.kind === 'reject') return decision
    let preset = agent.session.header.agentPreset
    for (const event of agent.session.ownEvents())
      if (event.type === 'agent-preset/selected') preset = event.data.agentPreset
    if (preset !== 'hivemind-hq') return decision
    if (!researchMasked.has(agent)) {
      ctx.effect(() => agent.ctx.tools.restrict({ deny: ['hivemind_research_answer'] }))
      researchMasked.add(agent)
    }
    const investigation = agent.session.snapshotEvents().findLast(
      event => event.type === 'hivemind/hq-public-investigation',
    )
    if (investigation?.type === 'hivemind/hq-public-investigation' && investigation.data.enabled) {
      if (!investigationMasks.has(agent)) {
        const internal = new Set(['hivemind_meta', 'hivemind_recall', 'hyperagents_memory',
          'hivemind_profile_context', 'hivemind_operating_context', 'hivemind_onboarding',
          'hivemind_hyperagent_profiles', 'hivemind_playbooks', 'hivemind_capabilities',
          'hivemind_hq_contract', 'hivemind_hq_awakening', 'hivemind_agent_message'])
        const deny = agent.ctx.tools.schemas(agent).map(tool => tool.name).filter(name => internal.has(name))
        if (deny.length) investigationMasks.set(agent, agent.ctx.tools.restrict({ deny }))
      }
      // Native tools and the user goal drive investigation; existing operational records remain intact.
      return decision
    }
    const member = ctx.agentTeams.tryMembership(agent)
    if (!member || member.role !== 'lead' || member.root !== agent) return decision
    investigationMasks.get(agent)?.()
    investigationMasks.delete(agent)
    await recoverRest(ctx, agent, signal)
    await acknowledgeRestNotes(ctx, agent)
    const awakening = await awakeningContext(ctx, agent, turn, decision.messages)
    if (briefed.get(agent) === turn) return decision
    // The admitted message is durable native context: inject once per turn,
    // and reread on cold restoration rather than adding a copy per tool step.
    const workspace = await ctx.hivemindHq.workspace(agent)
    briefed.set(agent, turn)
    const rest = restBriefing(agent, decision.messages)
    const briefing = createUserMessage({
      source: { kind: 'plugin', plugin: 'hivemind-hq/wake-briefing', form: 'recall', sections: [rest.section] },
      content: [{ type: 'text', text: `${wakeBriefing(workspace, agent.session.snapshotEvents(), agent.id)}\n${awakening ? '' : rest.text}` }],
    })
    if (awakening) return { ...decision, messages: [briefing, ...decision.messages, createUserMessage({
      source: { kind: 'plugin', plugin: 'hivemind-hq/first-awakening', form: 'snapshot', sections: [{ name: 'hq-first-awakening', text: awakening }] },
      content: [{ type: 'text', text: awakening }],
    })] }
    return { ...decision, messages: [briefing, ...decision.messages] }
  }, { prepend: true }))
  ctx.effect(() =>
    ctx.agentTeams.guardTaskUpdates((caller, request) => {
      if (request.action !== 'complete') return
      const root = ctx.agentTeams.membership(caller).root
      // Other companies and non-HQ Teams retain their native policy.
      const events = root.session.snapshotEvents()
      if (!taskContracts(events).some(contract => contract.taskId === request.taskId)) return
      try {
        requireArtifactReceipts(events, request.taskId)
      } catch {
        return 'HQ task completion requires a saved artifact receipt linked to this task.'
      }
      const review = events.findLast(
        event => event.type === 'hivemind/hq-task-review' && event.data.taskId === request.taskId,
      )
      const links = events.findLast(
        event =>
          event.type === 'hivemind/hq-task-artifacts' && event.data.taskId === request.taskId,
      )
      if (
        review?.type !== 'hivemind/hq-task-review' ||
        review.data.status !== 'accepted' ||
        review.data.taskRevision !== request.expectedRevision ||
        links?.type !== 'hivemind/hq-task-artifacts' ||
        JSON.stringify(review.data.artifactIds) !== JSON.stringify(links.data.artifactIds)
      )
        return 'HQ task completion requires an accepted review of the current task revision and linked saved artifacts.'
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'hivemind_hq_contract',
      description:
        'Coordinate existing native Team tasks: list contracts, attach immutable deadline/acceptance criteria, assign an authenticated employee persistent room, schedule contracted pending tasks for verified employees, link saved producer artifacts, or review those saved inputs with Jev. Native Team tools own task lifecycle and dependencies. Completion requires linked receipts and an accepted review of the current revision. This tool never grants authority.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['list', 'attach', 'artifacts', 'assign', 'review', 'schedule'],
        },
        employee_id: {
          type: 'string',
          description:
            'Exact authenticated employee id; assign delivers to the employee persistent room using native task ownership.',
        },
        task_id: { type: 'string' },
        due_at: { type: 'string', description: 'RFC3339 instant with explicit timezone.' },
        starts_at: { type: 'string', description: 'Future RFC3339 start with timezone for schedule.' },
        ends_at: { type: 'string', description: 'RFC3339 end after starts_at for schedule.' },
        acceptance_criteria: { type: 'array', items: { type: 'string' } },
        artifact_ids: { type: 'array', items: { type: 'string' } },
        producer: {
          type: 'string',
          description:
            'Exact native Team member name that saved the artifacts; defaults to lead. Only authenticated native task assignees can supply receipts.',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: {} },
        render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
      },
      isConcurrencySafe: () => false,
      async execute(args, execution) {
        const agent = execution.agent
        if (!agent) throw new Error('hq_active_agent_required')
        const input = args as {
          action: string
          task_id?: string
          employee_id?: string
          starts_at?: string
          ends_at?: string
          due_at?: string
          acceptance_criteria?: string[]
          artifact_ids?: string[]
          producer?: string
        }
        const membership = ctx.agentTeams.membership(agent)
        const root = membership.root
        await reconcileEmployeeArtifacts(ctx, root, execution.signal)
        const events = root.session.snapshotEvents()
        const contracts = taskContracts(events)
        if (input.action === 'list')
          return {
            contracts: contracts.map(contract => ({
              ...contract,
              acceptanceCriteria: [...contract.acceptanceCriteria],
            })),
            tasks: ctx.agentTeams
              .listTasks(agent)
              .map(task => ({
                task_id: task.id,
                revision: task.revision,
                subject: task.subject,
                status: task.status,
              })),
            calendar: calendarItems(events).map(item => ({
              id: item.id,
              revision: item.revision,
              kind: item.kind,
              title: item.title,
              owner: item.owner,
              startsAt: item.startsAt,
              endsAt: item.endsAt,
              resolved: item.resolved,
              taskId: item.taskId ?? null,
            })),
          }
        if (membership.role !== 'lead') throw new Error('hq_lead_required')
        if (!input.task_id) throw new Error('hq_task_id_required')
        const task = ctx.agentTeams.getTask(agent, TeamTaskId(input.task_id))
        if (input.action === 'schedule') {
          if (!contracts.some(value => value.taskId === task.id) || !input.employee_id || !input.starts_at || !input.ends_at)
            throw new Error('hq_schedule_requires_contract_employee_and_times')
          const directory = await ctx.hivemindEmployeeDirectory.profiles(execution.signal)
          if (!directory.profiles.some(profile => profile['id'] === input.employee_id)) throw new Error('hq_employee_not_found')
          const existing = calendarItems(events).find(item => item.taskId === task.id)
          if (!existing && Date.parse(input.starts_at) <= Date.now()) throw new Error('hq_schedule_start_must_be_future')
          const result = await ctx.hivemindHq.plan(root, {
            expectedRevision: existing ? existing.revision - 1 : 0,
            item: existing ?? { id: `initial-${task.id}`, revision: 1, kind: 'assignment', title: task.subject,
              owner: input.employee_id, taskId: task.id, startsAt: input.starts_at, endsAt: input.ends_at, resolved: false },
          })
          if (!result.ok) throw new Error('hq_calendar_conflict')
          const workspace = await ctx.hivemindHq.workspace(root)
          const wake = workspace.wakes.find(item => item.taskId === task.id && item.status === 'active')
          if (!wake) throw new Error('hq_schedule_receipt_unavailable')
          return { status: 'scheduled', task_id: task.id, employee_id: result.value.owner, starts_at: result.value.startsAt,
            ends_at: result.value.endsAt, schedule_id: wake.id, effective_trigger_at: wake.scheduledAt }
        }
        if (input.action === 'review') {
          const contract = contracts.find(value => value.taskId === task.id)
          if (!contract) throw new Error('hq_contract_required')
          requireArtifactReceipts(events, task.id)
          const linksEvent = events.findLast(
            event => event.type === 'hivemind/hq-task-artifacts' && event.data.taskId === task.id,
          )
          if (linksEvent?.type !== 'hivemind/hq-task-artifacts')
            throw new Error('hq_artifact_receipt_required')
          const links = linksEvent.data
          const documents: {
            artifactId: string
            text: string
            sources: ReturnType<typeof savedSourceEvidence>
          }[] = []
          for (const receipt of links.producerReceipts ?? []) {
            const producer = ctx.agentTeams
              .listMembers(root)
              .find(member => member.id === receipt.sessionId)
            if (!producer) throw new Error('hq_artifact_producer_not_member')
            const handle = await ctx.sessionPersistence.open(producer.id, 'read', {
              signal: execution.signal,
            })
            try {
              const source = (await handle.read(0, undefined, { signal: execution.signal })).events
              const text = savedArtifactText(source, receipt.artifactId)
              if (!text) throw new Error('hq_review_saved_document_unavailable')
              documents.push({
                artifactId: receipt.artifactId,
                text,
                sources: savedSourceEvidence(source, text),
              })
            } finally {
              await handle.close()
            }
          }
          if (
            documents.length !== links.artifactIds.length ||
            documents.reduce((total, value) => total + value.text.length, 0) > 48000
          )
            throw new Error('hq_review_document_context_unavailable')
          const state = {
            task: {
              subject: task.subject,
              description: task.description,
              authority: task.writeScopes,
            },
            acceptanceCriteria: contract.acceptanceCriteria,
            savedArtifactLinks: { taskId: links.taskId, producerReceipts: links.producerReceipts },
            documents,
          }
          const inputHash = reviewFingerprint(state)
          const previous = events.findLast(
            event =>
              event.type === 'hivemind/hq-task-review' &&
              event.data.taskId === task.id &&
              event.data.inputHash === inputHash &&
              event.data.taskRevision === task.revision,
          )
          if (previous?.type === 'hivemind/hq-task-review')
            return {
              review: {
                ...previous.data,
                artifactIds: [...previous.data.artifactIds],
                probabilities: [...previous.data.probabilities],
              },
            }
          const decision = await jevReview(state, contract.acceptanceCriteria, execution.signal)
          execution.signal.throwIfAborted()
          if (ctx.agentTeams.getTask(root, task.id).revision !== task.revision)
            throw new Error('hq_review_task_changed')
          const review: HqTaskReview = {
            taskId: task.id,
            taskRevision: task.revision,
            artifactIds: [...links.artifactIds],
            inputHash,
            ...decision,
          }
          root.session.append('hivemind/hq-task-review', review)
          if (!(await ctx.sessions.flush(root.session)))
            throw new Error('hq_review_persistence_required')
          return {
            review: {
              ...review,
              artifactIds: [...review.artifactIds],
              probabilities: [...review.probabilities],
            },
          }
        }
        if (input.action === 'assign') {
          const contract = contracts.find(value => value.taskId === task.id)
          if (!contract || !input.employee_id)
            throw new Error('hq_assignment_requires_contract_and_employee')
          if (task.status === 'completed' || task.status === 'deleted')
            throw new Error('hq_task_terminal')
          if (task.status === 'pending' && !task.ready)
            throw new Error('hq_task_dependencies_unfinished')
          const planned = calendarItems(root.session.snapshotEvents()).find(
            item => item.taskId === task.id,
          )
          const firstAwakening = root.session.snapshotEvents().some(
            event => event.type === 'hivemind/hq-awakening-start',
          ) && !root.session.snapshotEvents().some(
            event => event.type === 'hivemind/hq-awakening-checkpoint'
              && (event.data.stage === 'conversation' || event.data.stage === 'remembered') && !event.data.blocked,
          )
          // Initial discovery plans future work. A dispatch needs its saved
          // calendar first; ordinary subsequent work retains its native flow.
          if (task.status === 'pending' && firstAwakening && !planned)
            throw new Error('hq_first_awakening_schedule_before_assign: use action schedule with task_id, employee_id, starts_at and ends_at; do not assign before its saved start')
          if (task.status === 'pending' && planned && Date.parse(planned.startsAt) > Date.now())
            throw new Error('hq_task_planned_start_not_due')
          return dispatchEmployee(ctx, root, task.id, input.employee_id, execution.signal)
        }
        if (input.action === 'attach') {
          if (task.status === 'completed' || task.status === 'deleted')
            throw new Error('hq_task_terminal')
          const contract = companyTaskContract({
            taskId: input.task_id,
            dueAt: input.due_at,
            acceptanceCriteria: input.acceptance_criteria,
          })
          const existing = contracts.find(item => item.taskId === contract.taskId)
          if (existing && JSON.stringify(existing) !== JSON.stringify(contract))
            throw new Error('hq_contract_exists')
          if (!existing) root.session.append('hivemind/hq-task-contract', contract)
          if (!(await ctx.sessions.flush(root.session)))
            throw new Error('hq_contract_persistence_required')
          // An interrupted attachment can replay this same contract and repair its
          // native calendar wake. Schedule owns deduplication and delivery state.
          const wake = await ctx.schedule.ensure(
            root.id,
            `hq-task-deadline-${contract.taskId}`,
            {
              title: `HQ task deadline: ${task.subject}`.slice(0, 120),
              at: contract.dueAt,
              prompt:
                `Review native Team task ${contract.taskId} and its HQ acceptance contract at its committed deadline. ` +
                'Inspect current task status, employee messages and saved receipts before acting. ' +
                'Do not repeat completed work. If unfinished, continue within approved authority or report the concrete blocker. ' +
                'A deadline wake does not prove completion or grant additional authority.',
            },
            execution.signal,
          )
          return {
            contract: { ...contract, acceptanceCriteria: [...contract.acceptanceCriteria] },
            schedule_id: wake.id,
          }
        }
        if (task.status === 'completed' || task.status === 'deleted')
          throw new Error('hq_task_terminal')
        if (
          input.action !== 'artifacts' ||
          !contracts.some(item => item.taskId === input.task_id)
        )
          throw new Error('hq_contract_required')
        const producer = ctx.agentTeams
          .listMembers(agent)
          .find(member => member.name === (input.producer ?? 'lead'))
        if (!producer) throw new Error('hq_artifact_producer_not_member')
        const liveProducer = ctx.agents.get(producer.id)
        if (liveProducer && !(await ctx.sessions.flush(liveProducer.session)))
          throw new Error('hq_producer_persistence_required')
        const handle = await ctx.sessionPersistence.open(producer.id, 'read', {
          signal: execution.signal,
        })
        let receipt: TaskArtifactLinks
        try {
          const { events: sourceEvents } = await handle.read(0, undefined, {
            signal: execution.signal,
          })
          receipt = verifiedArtifactLinks(
            sourceEvents,
            input.task_id,
            input.artifact_ids ?? [],
            producer.id,
          )
        } finally {
          await handle.close()
        }
        const latest = root.session.snapshotEvents().findLast(event =>
          event.type === 'hivemind/hq-task-artifacts' && event.data.taskId === receipt.taskId)
        if (latest?.type !== 'hivemind/hq-task-artifacts' || !sameArtifactLinks(latest.data, receipt))
          root.session.append('hivemind/hq-task-artifacts', receipt)
        if (!(await ctx.sessions.flush(root.session)))
          throw new Error('hq_artifact_link_persistence_required')
        return {
          receipt: {
            taskId: receipt.taskId,
            artifactIds: [...receipt.artifactIds],
            producerReceipts: receipt.producerReceipts?.map(item => ({ ...item })) ?? [],
          },
        }
      },
    }),
  )
}
