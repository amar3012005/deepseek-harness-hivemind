/** One native stopping-boundary repair; prose is never a blocker or completion receipt. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { TeamTaskId } from '@deepseek-ai/dsh-experimental-agent-team'
import { admittedEmployeeWork } from './employee-work-origin.ts'
import { allowsEmployeeWork, authenticatedRoot, rooms } from './employee-room.ts'

const plugin = 'hivemind-hq/employee-report-repair'
const marker = 'HQ_EMPLOYEE_REPORT_REPAIR='

function repaired(agent: Agent, key: string): boolean {
  const matches = (message: UserMessage) => message.source.kind === 'plugin' && message.source.plugin === plugin
    && message.content.some(block => block.type === 'text' && block.text.startsWith(marker + key + '\n'))
  return agent.session.ownEvents().some(event => (event.type === 'user/message' && matches(event.data))
    || (event.type === 'agent/inbox/spliced' && event.data.inserted.some(matches)))
}

/** Only successful native evidence in the current assigned turn counts as a report. */
export function employeeReportReceipt(agent: Agent, turn: number, taskId: string): boolean {
  const events = agent.session.ownEvents()
  const start = events.findLast(event => event.type === 'turn/start' && event.data.turn === turn)
  if (!start) return false
  const current = events.filter(event => event.seq > start.seq)
  if (current.some(event => event.type === 'hivemind/artifact-created' || event.type === 'hivemind/generation-created')) return true
  if (current.some(event => event.type === 'hivemind/connected-receipt' && event.data.tool === 'workflow_checkpoint'
    && event.data.receipt !== null && typeof event.data.receipt === 'object'
    && !Array.isArray(event.data.receipt) && event.data.receipt['status'] === 'checkpoint_saved'
    && typeof event.data.receipt['checkpoint'] === 'string' && (() => {
    try { return JSON.parse(event.data.receipt['checkpoint']).task_id === taskId } catch { return false }
  })())) return true
  return current.some((event) => {
    if (event.type !== 'tool/call' || event.data.name !== 'hivemind_agent_message') return false
    let args: unknown = event.data.arguments
    try { if (typeof args === 'string') args = JSON.parse(args) } catch { return false }
    if (!args || typeof args !== 'object' || Reflect.get(args, 'task_id') !== taskId
      || Reflect.get(args, 'recipient') !== 'runtime' || !['update', 'question'].includes(Reflect.get(args, 'kind'))) return false
    return current.some(result => result.type === 'tool/result' && result.data.message.content.some(block =>
      block.type === 'tool-result' && block.toolCallId === event.data.callId && !block.isError))
  })
}

/** Reuses native steer/inbox persistence and keyed room delivery; never creates a new work loop. */
export function installEmployeeReportRepair(ctx: Context): void {
  ctx.effect(() => ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    signal.throwIfAborted()
    const origin = admittedEmployeeWork(agent)
    if (!origin || origin.turn !== turn || employeeReportReceipt(agent, turn, origin.taskId)) return
    // Fresh registry, assignment, task ownership and mode checks own authority.
    let allowed: boolean
    try { allowed = await allowsEmployeeWork(ctx, agent, origin, signal) } catch {
      signal.throwIfAborted()
      return // revoked/reassigned/missing authority cannot steer or report
    }
    if (!allowed) return
    const root = await authenticatedRoot(ctx, origin.rootId, signal)
    const task = ctx.agentTeams.getTask(root, TeamTaskId(origin.taskId))
    if (['completed', 'deleted'].includes(task.status)) return
    const key = `${origin.rootId}:${origin.taskId}:${turn}`
    if (!repaired(agent, key)) {
      agent.steer(createUserMessage({ source: { kind: 'plugin', plugin }, content: [{ type: 'text',
        text: marker + key + '\nYour assigned work has no successful saved output, blocker, or explicit task report receipt in this turn. This is ONE bounded host correction, not new human authority. If genuinely required human input is missing, use the existing hivemind_employee_blocker with a stable key and exact question; do not guess input or infer permission. Otherwise save the actual authorized deliverable and report its exact receipt to Runtime, or send an explicit incomplete task report. Do not substitute a draft for a required final outcome, claim completion, ask the human here, or execute outside existing authority. If you cannot produce the required receipt, leave the task open and state the limitation. No further automatic correction will be issued.' }] }))
      if (!await ctx.sessions.flush(agent.session)) throw new Error('hq_employee_report_repair_persistence_required')
      return
    }
    // The model omitted the native report twice. Tell Runtime exactly that,
    // without promoting prose into human_input, approval, or task completion.
    await rooms(ctx).deliverAgentMessage(agent, { key: `employee-report-incomplete:${key}`, target: 'runtime',
      kind: 'update', taskId: origin.taskId,
      text: `Assigned task ${origin.taskId} remains incomplete: employee ${agent.id} stopped without a successful saved output, blocker checkpoint, or explicit task report after one bounded correction. No human-input or permission grant was inferred. Inspect the existing receipts and keep this task open; do not treat the ordinary prose response as final completion.` }, signal)
  }))
}
