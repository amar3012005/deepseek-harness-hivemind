/** Company strategy methods loaded only for strategic work through native skills. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'

/** Shared strategic judgment for Runtime agendas and employee contributions. */
export const companyStrategySkill = {
  name: 'hivemind-company-strategy',
  description: 'Load for company priorities, growth strategy, campaigns or a substantive strategic recommendation. Connect evidence to objectives, audience, hypotheses and success measures. Not for simple questions, routine execution or unchanged pending work.',
  invocation: { modelInvocable: true, userInvocable: false },
  source: 'runtime',
  content: `Keep your Runtime or employee identity. An authorized agenda is enough to begin useful work; do not wait for magic wording or invent a new objective. Use sufficient current company context, relevant private learning and the existing task or operating plan. Identify material evidence gaps and retrieve only what affects the decision. Distinguish approved goals, historical information and provisional assumptions.

Build a concise strategic brief where relevant: the company objective, audience and need, evidence supporting the opportunity, proposed hypothesis, success measure, constraints and responsibilities. Explain why the proposed work could help the objective; a polished content calendar is not a strategy and activity is not a business outcome. Use existing global or local playbooks for the actual domain. Retrieve approved Brand DNA for company-facing work; disclose material unknowns rather than present inferred branding as approved. Ask the relevant specialist first when their knowledge can resolve a gap, then ask the user for a required decision or missing authority.

Runtime owns coordination. Choose justified work, including no new assignment when appropriate. Pass a short strategic rationale and exact relevant strategy, brand, evidence and method references in the existing task description to the chosen persistent employee room. Read current workload and avoid duplicate tasks. Use native Teams and Schedule; future work is scheduled directly, not dispatched early. Keep acceptance criteria observable and within the approved scope. Do not add another operating plan for the same delegated deliverable.

An employee owns the assigned contribution. Read the Chief's objective, criteria and references, then load only relevant methods. Fill material evidence gaps within authority or report them to Runtime. Do not repeat company-wide planning or expand the assignment into an unauthorized campaign. A direct user question deserves a direct useful answer; substantial strategic work deserves an evidence-grounded recommendation.

Prefer a bounded experiment with a meaningful review point over speculative bulk work. Compare actual results with the hypothesis and success measure, save verified reusable private learning and adapt the next recommendation. Do not promise growth or treat generated assets as published work. Inspect finished artifacts with the production guidance; Runtime decides acceptance using runtime-submission-review when work is submitted. Send concise natural results with the saved artifact and important gaps, not a README packet.

Narrate meaningful findings and choices plainly in normal chat. Act on an actionable blocker before a deadline when an authorized route exists; otherwise save the gap and wait for a meaningful answer or event. External actions, spending, publishing and company-memory writes retain existing approval requirements.`,
} as const

/** Register the shared strategy method in the existing scoped native registry.
 * @param ctx - Cordis scope containing the skill registry.
 */
export function installCompanyStrategyGuidance(ctx: Context): void {
  ctx.inject(['skills'], (scope) => {
    scope.effect(() => scope.skills.register(companyStrategySkill))
  })
}
