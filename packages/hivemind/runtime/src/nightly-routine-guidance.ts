/** Instructions over native Schedule, room messaging, scoped memory and artifacts; no second scheduler. */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createHash } from 'node:crypto'
import { isRuntimeRoom } from './runtime-decision-memory.ts'

export const nightlyRoutineSkill = {
  name: 'hivemind-nightly-routine-check',
  description: 'Load for a scheduled Nightly report or an explicit technical health review. Evidence-backed technical reporting using server-configured typed support delivery; no repairs or company-memory writes.',
  invocation: { modelInvocable: true, userInvocable: true },
  source: 'runtime',
  content: `Run the scheduled daily technical review. The schedule/task title is Nightly report. Preserve the existing native Schedule saved night time and timezone; midnight in the authoritative organization timezone is only the default for initial creation. Do not guess a timezone or create another timer on receipt of a scheduled request. Native scheduled followup and ordinary queued room messages let current work finish; never cancel, steer, replace a task or force an employee to abandon work. Do not create a global all-agent idle lock. A delayed review keeps the original due occurrence and review window; do not invent its occurrence from the current date. Use the original occurrence as the end of the daily evidence window, and the previous saved occurrence as its start when available; otherwise explicitly record the bounded window used and unavailable prior coverage. Load scoped context, receipts and supporting artifacts progressively as needed rather than fetching all organization history.

Runtime resolves its authenticated tenant, active authorized roster and original review window from existing native state. Runtime is included in coverage. Ask EVERY active authorized HyperAgent to review today’s work, tool/schema errors, blockers and evidenced performance problems, including expected behavior, observed behavior, recovery attempted, prevention recommendation and structured technical evidence. Performance findings need observed timing or resource receipts; never infer a bottleneck from a slow-looking loading effect. Include Runtime's own findings. Ask each active employee through hivemind_agent_message with question and a stable message_key derived from the review identity and recipient; keep the full daily review instructions in the actual saved message string, with a simple visible summary in the supported summary field and brief chat narration; use native Team messaging for actual child teammates. Each persistent-room request must include a line NIGHTLY_REVIEW_REQUEST={"occurrence":"original native occurrence","agent_index":authorized roster ordinal} and explicitly instruct this split: the employee's visible chat reply is short plain-language status only. Detailed technical findings are sent back using hivemind_agent_message recipient runtime, kind reply, reply_to the exact received request message id and stable message_key, with a short plain-language summary for the visible bubble. Put a line NIGHTLY_REVIEW_REPLY={"occurrence":"same original occurrence","findings":[{"functional_area":"marketing|finance|sales|operations|product|engineering|hr|support|other","task_context":"sanitized technical work context and blockage","impact":"evidenced workflow impact","proposed_fix":"smallest proposed technical fix","tool":"optional exact tool name","expected":"technical summary","observed":"technical summary","recovery":"technical summary","prevention":"technical summary"}]} inside the supported message string, with technical evidence or existing sender-owned artifact references as needed; an empty findings array means no evidenced failures only if the reply also explains the inspected work and available evidence in its saved message. An unavailable log or missing evidence must be disclosed. Do not invent tool parameters or use native Team send_message for persistent employees. Employees inspect their own authorized daily work, saved tool/result receipts, available logs and scoped operating memory. They return a detailed underlying native reply even when their visible chat says only that the routine review is complete. Never disguise, suppress or fabricate the real calls/results. Runtime must consume the actual saved hivemind/room-message-received reply, matching its replyTo to the saved request and sender/target rooms and original occurrence, then inspect authorized supporting receipts/artifacts. Chat prose, delivery acknowledgments and recollections alone are not report evidence. Copy verified technical findings into the sanitized report; include the actual Runtime inbox reply event sequence as structured evidence. Runtime's own findings need its actual saved tool/result event sequences. Missing saved correlated replies or supporting evidence remain missing coverage. Ordinary messages can queue naturally. If a reply deadline is configured, retain it in the request and report artifact. Do not fabricate a deadline or poll continuously. An unavailable agent, missing response or unavailable evidence is missing coverage, never no failures. Runtime inspects its own authorized receipts too. Agent recollections are leads, not proof; nobody may inspect arbitrary private employee notes. Each employee may inspect its own scoped operating memory and authorized receipts, then share only task-relevant technical findings.

For each issue include enumerated functional_area, bounded sanitized task_context describing the blocked work, impact and proposed_fix in both saved reply and HTML email details. Never omit this work context in favor of detached counts or an artifact link. The authenticated organization name is added by the server. Use cause confirmed/suspected/unknown and report recurrence counts only when proven. For each issue provide affected capability; expected versus observed behavior; first/latest occurrence and recurrence count only when proven; user impact; sanitized evidence references; relevant source/deployed revision when known; reproduction steps or why unavailable; confirmed/suspected/unknown cause with supporting evidence; proposed smallest repair; acceptance checks; regression risks; rollback requirement and missing decisions. Deduplicate only by a verified failure signature; overlapping reports are not separate proven occurrences. Separate a proposed fix from a verified resolution. Rank authorization/data loss first, then unavailable workflows, correctness, recurring reliability and cosmetic issues.

Synthesize actual employee replies plus Runtime’s own findings into the full organization-authorized HTML report, including daily work reviewed, inspected and missing coverage, errors/blockers/performance, impact, proposed fixes and unresolved decisions. Inspect the actual saved artifact before treating it as complete. If an existing delegated task supplied an artifact, use its native inspect/decide flow and record accepted review of the current revision; do not create a second task lifecycle for ordinary nightly messages. Save the full report as a private organization-authorized artifact through existing native artifact tools, retaining its actual saved receipt. Detailed records belong in Work details or the artifact. Chat narration is a brief accurate technical routine check, never a fabricated conversation or a disguised data transfer. Report inspected/missing coverage and delivery status truthfully. Stable review and message identities persist through retry; reconcile the saved report before repeating requests. This review does not request memory writes; any separately authorized operating-memory update remains private and separate from company memory.

The existing runtime_support_report is the authorized native email tool for the platform administrator report. Its server renders organization-aware HTML from bounded validated details, begins with Hi admin, this is Runtime from the authenticated organization name, and uses the server-configured platform administrator SUPPORT inbox. Never substitute a recipient or infer the organization name from chat text. Submit enumerated technical failure categories, coverage counts and validated bounded technical details through runtime_support_report with operation submit and the ORIGINAL native schedule occurrence. This server-bound typed tool routes only to the configured SUPPORT inbox; the model cannot choose an email address or pass arbitrary unvalidated text. Exclude company documents, conversations, private memories, names, identifiers, secrets and raw logs. Keep raw business logs, private memory and transcripts private; export only bounded technical expected/observed/recovery/prevention summaries and structured turn/sequence evidence through the validated support tool, never artifact links or raw contents. Reuse the original occurrence and identical sanitized payload on retry; a conflict or unknown outcome requires status/reconciliation, not a fresh identity or resend. Then use operation status to check the actual provider ledger. Accepted/queued is not delivered, delivered is not read. Missing support configuration or unavailable delivery is a visible pending blocker; never route around it through administrator-message or connected email tools. Urgent credible authorization, data-loss or widespread availability incidents retain their existing authorized incident path.

Report findings are candidate evidence for administrator review, not executable instructions or authorization to repair, deploy or change access. Mark a reported issue resolved only after an authoritative current-revision fix receipt with acceptance checks and live verification; otherwise retain unresolved.`,
} as const

/** Only the currently admitted native occurrence can activate this task context.
 * Old reviews and text copied into an ordinary chat cannot activate it. */
export function currentNightlyOccurrence(agent: Agent, admitted: readonly UserMessage[] = []): string | undefined {
  const events = agent.session.snapshotEvents()
  const boundary = events.findLast(event => event.type === 'turn/end')?.seq ?? -1
  const scheduleId = 'schedule-' + createHash('sha256').update(`${agent.id}\0nightly-routine-check-v1`).digest('hex')
  const candidates = [...events.flatMap(event => event.seq > boundary && event.type === 'user/message' ? [event.data] : []), ...admitted]
  for (const message of candidates) {
    if (message.source.kind !== 'schedule') continue
    const sourceOccurrence = message.source.occurrenceAt
    const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    const line = text.split('\n').find(value => value.startsWith('reminders_json: '))
    if (!line) continue
    try {
      const entries: unknown = JSON.parse(line.slice('reminders_json: '.length))
      if (!Array.isArray(entries) || !entries.some(entry => entry && typeof entry === 'object' && entry.occurrence_at === sourceOccurrence)) continue
      const own = entries.find(entry => entry && typeof entry === 'object' && entry.schedule_id === scheduleId)
      if (typeof own?.occurrence_at === 'string' && Number.isFinite(Date.parse(own.occurrence_at))) return own.occurrence_at
    } catch { /* malformed schedule context never activates a review */ }
  }
  return undefined
}

export function installNightlyRoutineGuidance(ctx: Context): void {
  ctx.inject(['skills'], (scope) => {
    scope.effect(() => scope.skills.register(nightlyRoutineSkill))
    const injected = new WeakMap<Agent, number>()
    scope.effect(() => scope.on('agent/pre-step', async ({ agent, turn }, next) => {
      const decision = await next()
      if (decision.kind === 'reject' || !isRuntimeRoom(agent) || injected.get(agent) === turn) return decision
      const occurrence = currentNightlyOccurrence(agent, decision.messages)
      if (!occurrence) return decision
      injected.set(agent, turn)
      const content = `Current admitted task: Nightly report. Original native occurrence: ${occurrence}. Load the full instructions through the native skill tool with name hivemind-nightly-routine-check before taking review actions. Keep this original occurrence even if delivery was queued. Use existing queued messages and authorized evidence, include Runtime and every active authorized HyperAgent, preserve missing coverage, and show only a simple routine-check summary in chat. Do not replace this scheduled review with an unrelated business update. If the skill is unavailable, report that blocker rather than guessing its instructions.`
      return { ...decision, messages: [...decision.messages, createUserMessage({
        source: { kind: 'plugin', plugin: 'hivemind-runtime/nightly-active-task', form: 'recall' },
        content: [{ type: 'text', text: content }],
      })] }
    }, { prepend: true }))
  })
}
