/** Evidence-backed completion learning, loaded through the native skill registry. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'

export const completionLearningSkill = {
  name: 'hivemind-completion-learning',
  description: 'Load when a completed company contribution or meaningful correction may contain reusable learning. Consider evidence and limitations; skip routine updates, duplicate task records and unsupported generalizations.',
  invocation: { modelInvocable: true, userInvocable: false },
  source: 'runtime',
  content: `Keep your existing employee or Runtime identity. Completion does not require a new learning or a playbook rewrite. Consider whether this result establishes a useful reusable method, decision or correction that is not already saved. Important user-provided context, confirmed decisions and useful outcomes can deserve a concise decision_note or handoff even when no reusable method emerged. Attribute user reports rather than treating them as verified company facts; preserve corrections, evidence status and remaining uncertainty. Private operating-memory writes do not require company publication approval; shared company-brain writes retain their existing policy. Automatic response history is not a substitute for a useful decision or handoff, but do not duplicate it or save giant transcripts. Recall relevant scoped private learning before duplicating or correcting it. Memory-dependent questions about prior discussions or decisions also need relevant private recall even without a new task. Reconcile older notes with the latest human corrections and confirmed same-chat receipts; retain superseded context as history rather than current direction. Distinguish publicly evidenced identity or role from unconfirmed commercial authority, access or outcomes. Do not ask for reconfirmation of an explicit direction already given.

When useful, save a concise typed private learning through hyperagents_memory under your own identity. Connect it to the task and exact available evidence or artifact receipts. Copy source and receipt identifiers unchanged rather than reconstructing them. Use the current hyperagents_memory action schema for private learning and corrections; do not invent an operation or switch to company-memory tools. Omit room_id unless an exact originating room UUID was returned by a receipt; native session context is attached automatically and session- identifiers are not room UUIDs. Explain what worked, the conditions in which it applies, and limitations or unresolved assumptions. Distinguish observed outcomes from hypotheses and do not claim growth, publication or external success without evidence. Do not duplicate automatic task_status records. Report a save only after its receipt confirms it.

Separate method learning from a one-off result, provider outage, permission gap or platform defect. A failed tool may justify reporting a blocker or targeted platform correction, not weakening a company method or approval boundary. Send Runtime a short useful result, saved artifact and any material limitation; do not send a README packet or report every casual reply.

If repeated evidence suggests improving a local company playbook, propose the smallest change with its current playbook ID/version, rationale, supporting tasks/receipts, conditions, limitations and a way to compare a later task. Preserve the previous version and leave global doctrine unchanged. A private proposal is not an approved company revision. The current hivemind_playbooks revise_plan changes a task's operating plan, not playbook content; do not use it as a revision writer. When the tenant-scoped provider is available, use hivemind_playbooks operation propose_revision with a company- prefixed method ID, the latest approved prior_version (0 for a new method), exact method_body, rationale and evidence_refs. Give the administrator its returned approval_url to inspect and approve the exact version. A native question, private-memory save or full-access session is not publication approval. Search/load retrieve the latest approved company version; pending proposals remain unpublished. If the provider is unavailable, report that specific gap. Company playbook or company-memory writes retain existing human approval.

On a later comparable authorized task, load the current approved playbook through its actual provider and recall relevant private learning. Compare the result with the earlier evidence, accounting for changed conditions. Record useful new evidence or a limitation rather than automatically rewriting the method. No new task, repeated work, scheduled poll or mandatory learning is needed just to validate a proposal.`,
} as const

export function installCompletionLearningGuidance(ctx: Context): void {
  ctx.inject(['skills'], (scope) => {
    scope.effect(() => scope.skills.register(completionLearningSkill))
  })
}
