/** Evidence-backed completion learning, loaded through the native skill registry. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'

export const completionLearningSkill = {
  name: 'hivemind-completion-learning',
  description: 'Load when a completed company contribution or meaningful correction may contain reusable learning. Consider evidence and limitations; skip routine updates, duplicate task records and unsupported generalizations.',
  invocation: { modelInvocable: true, userInvocable: false },
  source: 'runtime',
  content: `Keep your existing employee or Runtime identity. Completion does not require a new learning or a playbook rewrite. Consider whether this result establishes a useful reusable method, decision or correction that is not already saved. Recall relevant scoped private learning before duplicating or correcting it.

When useful, save a concise typed private learning through hyperagents_memory under your own identity. Connect it to the task and exact available evidence or artifact receipts. Explain what worked, the conditions in which it applies, and limitations or unresolved assumptions. Distinguish observed outcomes from hypotheses and do not claim growth, publication or external success without evidence. Do not duplicate automatic task_status records. Report a save only after its receipt confirms it.

Separate method learning from a one-off result, provider outage, permission gap or platform defect. A failed tool may justify reporting a blocker or targeted platform correction, not weakening a company method or approval boundary. Send Runtime a short useful result, saved artifact and any material limitation; do not send a README packet or report every casual reply.

If repeated evidence suggests improving a local company playbook, propose the smallest change with its current playbook ID/version, rationale, supporting tasks/receipts, conditions, limitations and a way to compare a later task. Preserve the previous version and leave global doctrine unchanged. A private proposal is not an approved company revision. The current hivemind_playbooks revise_plan changes a task's operating plan, not playbook content; do not use it as a revision writer. Use only an actually exposed tenant-scoped proposal/version tool when available, otherwise tell Runtime that this capability is missing. Company playbook or company-memory writes retain existing human approval.

On a later comparable authorized task, load the current approved playbook through its actual provider and recall relevant private learning. Compare the result with the earlier evidence, accounting for changed conditions. Record useful new evidence or a limitation rather than automatically rewriting the method. No new task, repeated work, scheduled poll or mandatory learning is needed just to validate a proposal.`,
} as const

export function installCompletionLearningGuidance(ctx: Context): void {
  ctx.inject(['skills'], (scope) => {
    scope.effect(() => scope.skills.register(completionLearningSkill))
  })
}
