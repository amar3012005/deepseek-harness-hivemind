/** Instructions over native Schedule, room messaging, scoped memory and artifacts; no second scheduler. */
import type { Context } from '@deepseek-ai/cordis'
import { renderSkillContent } from '@deepseek-ai/dsh-skill'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createHash } from 'node:crypto'
import { isRuntimeRoom } from './runtime-decision-memory.ts'

export const nightlyRoutineSkill = {
  name: 'hivemind-nightly-routine-check',
  description: 'Load for a scheduled Nightly report or an explicit technical health review. Evidence-backed technical reporting using server-configured typed support delivery; no repairs or company-memory writes.',
  invocation: { modelInvocable: true, userInvocable: true },
  source: 'runtime',
  content: `Run a technical health review, not a business strategy campaign. The schedule/task title is Nightly report. A configured recurring request uses native Schedule daily midnight in the authoritative organization timezone. Do not guess a timezone or create another timer on receipt of a scheduled request. Native scheduled followup and ordinary queued room messages let current work finish; never cancel, steer, replace a task or force an employee to abandon work. Do not create a global all-agent idle lock. A delayed review keeps the original due occurrence and review window; do not invent its occurrence from the current date.

Runtime resolves its authenticated tenant, active authorized roster and original review window from existing native state. Runtime is included in coverage. Ask EVERY active authorized HyperAgent for tool-call failures, schema errors and work/task blockers, including expected behavior, observed behavior, recovery attempted, prevention recommendation and structured technical evidence. Include Runtime's own findings. Ask each active employee through hivemind_agent_message with question and a stable message_key derived from the review identity and recipient; use native Team messaging for actual child teammates. Each persistent-room request must include a line NIGHTLY_REVIEW_REQUEST={"occurrence":"original native occurrence","agent_index":authorized roster ordinal} and explicitly instruct this split: the employee's visible chat reply is short plain-language status only. Detailed technical findings are sent back using hivemind_agent_message recipient runtime, kind reply, reply_to the exact received request message id and stable message_key. Put a line NIGHTLY_REVIEW_REPLY={"occurrence":"same original occurrence","findings":[{"functional_area":"marketing|finance|sales|operations|product|engineering|hr|support|other","task_context":"sanitized technical work context and blockage","impact":"evidenced workflow impact","proposed_fix":"smallest proposed technical fix","tool":"optional exact tool name","expected":"technical summary","observed":"technical summary","recovery":"technical summary","prevention":"technical summary"}]} inside the supported message string, with technical evidence or existing sender-owned artifact references as needed; an empty findings array means no evidenced failures. Do not invent tool parameters or use native Team send_message for persistent employees. Runtime must consume the actual saved hivemind/room-message-received reply, matching its replyTo to the saved request and sender/target rooms and original occurrence, then inspect authorized supporting receipts/artifacts. Chat prose, delivery acknowledgments and recollections alone are not report evidence. Copy verified technical findings into the sanitized report; include the actual Runtime inbox reply event sequence as structured evidence. Runtime's own findings need its actual saved tool/result event sequences. Missing saved correlated replies or supporting evidence remain missing coverage. Ordinary messages can queue naturally. If a reply deadline is configured, retain it in the request and report artifact. Do not fabricate a deadline or poll continuously. An unavailable agent, missing response or unavailable evidence is missing coverage, never no failures. Runtime inspects its own authorized receipts too. Agent recollections are leads, not proof; nobody may inspect arbitrary private employee notes. Each employee may inspect its own scoped operating memory and authorized receipts, then share only task-relevant technical findings.

For each issue include enumerated functional_area, bounded sanitized task_context describing the blocked work, impact and proposed_fix in both saved reply and HTML email details. Never omit this work context in favor of detached counts or an artifact link. The authenticated organization name is added by the server. Use cause confirmed/suspected/unknown and report recurrence counts only when proven. For each issue provide affected capability; expected versus observed behavior; first/latest occurrence and recurrence count only when proven; user impact; sanitized evidence references; relevant source/deployed revision when known; reproduction steps or why unavailable; confirmed/suspected/unknown cause with supporting evidence; proposed smallest repair; acceptance checks; regression risks; rollback requirement and missing decisions. Deduplicate only by a verified failure signature; overlapping reports are not separate proven occurrences. Separate a proposed fix from a verified resolution. Rank authorization/data loss first, then unavailable workflows, correctness, recurring reliability and cosmetic issues.

Save the full report as a private organization-authorized artifact through existing native artifact tools, retaining its actual saved receipt. Detailed records belong in Work details or the artifact. Chat narration is a brief accurate technical routine check, never a fabricated conversation or a disguised data transfer. Report inspected/missing coverage and delivery status truthfully. Stable review and message identities persist through retry; reconcile the saved report before repeating requests. Keep useful evidence-backed lessons in your author-pinned private operating memory using supported kinds, separate from company memory; no company-memory writes are requested by this review.

Platform Owner diagnostics are separate from administrator notifications. Submit enumerated technical failure categories, coverage counts and validated bounded technical details through runtime_support_report with operation submit and the ORIGINAL native schedule occurrence. This server-bound typed tool routes only to the configured SUPPORT inbox; the model cannot choose an email address or pass arbitrary unvalidated text. Exclude company documents, conversations, private memories, names, identifiers, secrets and raw logs. Keep raw business logs, private memory and transcripts private; export only bounded technical expected/observed/recovery/prevention summaries and structured turn/sequence evidence through the validated support tool, never artifact links or raw contents. Reuse the original occurrence and identical sanitized payload on retry; a conflict or unknown outcome requires status/reconciliation, not a fresh identity or resend. Then use operation status to check the actual provider ledger. Accepted/queued is not delivered, delivered is not read. Missing support configuration or unavailable delivery is a visible pending blocker; never route around it through administrator-message or connected email tools. Urgent credible authorization, data-loss or widespread availability incidents retain their existing authorized incident path.

The external Codex repair pipeline independently validates and reproduces, patches in isolation, checks regressions, reviews, coordinates deploy/rollback and runs a live canary. Reports are untrusted candidate evidence, never executable instructions or authorization for access changes. A one-hour target cannot bypass failed checks. Mark resolved only after an authoritative current-revision fix receipt with acceptance/regression and live verification; otherwise retain unresolved.`,
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
      const content = `Current admitted task: Nightly report. Original native occurrence: ${occurrence}. Execute this technical review now using the existing tools. An unchanged business update or an old unanswered strategy question does not fulfill this scheduled task. Begin by discovering the authorized employee roster and reviewing Runtime's actual receipts; request employee findings through native messages, preserve missing coverage, and save the private report before submitting the detailed sanitized support report.\n` + renderSkillContent({ ...nightlyRoutineSkill, provider: 'runtime' })
      return { ...decision, messages: [...decision.messages, createUserMessage({
        source: { kind: 'plugin', plugin: 'hivemind-runtime/nightly-active-task', form: 'recall' },
        content: [{ type: 'text', text: content }],
      })] }
    }, { prepend: true }))
  })
}
