/** Company orientation and exact-revision strategy review through native capabilities. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-hivemind-memory'
import type {} from '@deepseek-ai/dsh-user-questions'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { hqContinuity } from './continuity.ts'
import type { LedgerEvent } from './ledger.ts'

/** Evidence references identify successful receipts, not a model assertion of truth. */
export interface HqBaseline {
  readonly revision: number
  readonly observedAt: number
  readonly summary: string
  readonly evidenceSequences: readonly number[]
}
/** Owner review applies to exactly the strategy presented; it grants no tool permission. */
export interface HqStrategyDecision {
  readonly strategyRevision: number
  readonly strategy: string
  readonly status: 'proposed' | 'approved' | 'declined'
  readonly answer?: string
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Versioned company understanding with references to successful native tool receipts. */
    'hivemind/hq-baseline': HqBaseline
    /** Owner's review of an exact immutable strategic proposal. */
    'hivemind/hq-strategy-decision': HqStrategyDecision
  }
}
/** Restore baseline independently of strategy and task execution.
 * @param events - canonical HQ history.
 * @returns latest baseline, or undefined before first orientation.
 */
export function hqBaseline(events: readonly LedgerEvent[]): HqBaseline | undefined {
  let current: HqBaseline | undefined
  for (const event of events) {
    if (event.type !== 'hivemind/hq-baseline') continue
    const value = event.data as HqBaseline
    if (!value || value.revision !== (current?.revision ?? 0) + 1 || !Number.isSafeInteger(value.observedAt)
      || value.observedAt < 0 || typeof value.summary !== 'string' || !value.summary.trim()
      || value.summary.length > 12000 || !Array.isArray(value.evidenceSequences)
      || !value.evidenceSequences.length || value.evidenceSequences.some(seq => !Number.isSafeInteger(seq) || seq < 0))
      throw new Error('hq_invalid_baseline_record')
    current = value
  }
  return current
}

/** Identify the last meaningful strategy change independently of activity acknowledgement.
 * @param events - durable strategy and review history.
 * @returns revision at which the current strategy changed.
 */
export function hqStrategyRevision(events: readonly LedgerEvent[]): number {
  let text = '', revision = 0
  for (const event of events) {
    if (event.type !== 'hivemind/hq-continuity') continue
    const next = event.data as { strategy: string; revision: number }
    if (next.strategy !== text) { text = next.strategy; revision = next.revision }
  }
  return revision
}

/** Mount progressive discovery without copying company catalogs into the system prompt.
 * @param ctx - scoped native company memory, Teams and persistence services.
 */
export function installOrientation(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'hivemind_hq_orientation',
    description: 'Inspect authenticated company context, real employee capabilities, your latest baseline and strategic decision. Save a revised baseline only from successful tool receipts. Discovery is read-only; it does not save company memory or grant authority. Retrieve relevant company documents and screenshots through existing memory/artifact tools before deciding.',
    parameters: {
      action: { type: 'string', required: true, enum: ['inspect', 'load_evidence', 'save_baseline'] },
      artifact_id: { type: 'string', description: 'Exact existing baseline/plan artifact ID returned by inspect; never a URL or guessed identifier.' },
      expected_revision: { type: 'integer', description: 'Exact baseline revision from inspect, zero before the first baseline.' },
      summary: { type: 'string', description: 'Company understanding, verified evidence, inference, gaps and freshness; maximum 12000 characters.' },
      evidence_sequences: { type: 'array', items: { type: 'integer' }, description: 'Sequences of successful tool/result receipts in your HQ session supporting this baseline. Do not invent references.' },
    },
    output: { schema: { type: 'object', properties: {}, additionalProperties: true }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    isConcurrencySafe: () => false,
    async execute(args, execution) {
      if (!execution.agent) throw new Error('hq_active_agent_required')
      const member = ctx.agentTeams.membership(execution.agent)
      if (member.role !== 'lead') throw new Error('hq_lead_required')
      const root = member.root
      // Resolve canonical ownership before retrieving any company context.
      if (await ctx.hivemindHqOwnership.find() !== root.id) throw new Error('hq_canonical_runtime_required')
      const events = root.session.snapshotEvents()
      const baseline = hqBaseline(events)
      if (args.action === 'inspect') {
        const [company, employees, companyEvidence] = await Promise.all([
          ctx.hivemindMemory.context(root, execution.signal),
          ctx.hivemindEmployeeDirectory.profiles(execution.signal),
          ctx.hivemindHqOwnership.companyEvidence(root.id),
        ])
        const strategy = hqContinuity(events)
        const decision = events.findLast(event => event.type === 'hivemind/hq-strategy-decision' && event.data.strategyRevision === hqStrategyRevision(events))
        return { company, employees: { ...employees }, company_evidence: companyEvidence,
          baseline: baseline ? { ...baseline, evidenceSequences: [...baseline.evidenceSequences] } : null,
          baseline_revision: baseline?.revision ?? 0,
          strategy: strategy.strategy, strategy_revision: strategy.revision,
          strategy_decision: decision?.type === 'hivemind/hq-strategy-decision' ? { ...decision.data } : null,
          evidence_receipts: events.filter(event => event.type === 'tool/result' && !event.data.error && !event.data.message.content.some(block => block.type === 'tool-result' && block.isError)).slice(-40).map(event => ({ sequence: event.seq })),
          guidance: 'Reuse relevant evidence. Retrieve available screenshots/documents through company recall and artifact tools; unavailable evidence is a gap. Delegate justified missing assessments through verified employee assignments. No fixed orientation sequence is required on later wakes.' }
      }
      if (args.action === 'load_evidence') {
        if (typeof args.artifact_id !== 'string' || !/^[0-9a-f-]{36}$/iu.test(args.artifact_id)) throw new Error('hq_listed_company_artifact_id_required')
        return ctx.hivemindHqOwnership.companyEvidence(root.id, args.artifact_id)
      }
      if (args.expected_revision !== (baseline?.revision ?? 0)) return { conflict: true,
        baseline: baseline ? { ...baseline, evidenceSequences: [...baseline.evidenceSequences] } : null }
      const summary = args.summary
      const sequences = args.evidence_sequences
      if (typeof summary !== 'string' || !summary.trim() || summary.length > 12000
        || !Array.isArray(sequences) || !sequences.length || sequences.length > 40
        || sequences.some(seq => !Number.isSafeInteger(seq) || !events.some(event => event.seq === seq && event.type === 'tool/result' && !event.data.error && !event.data.message.content.some(block => block.type === 'tool-result' && block.isError))))
        throw new Error('hq_baseline_successful_receipts_required')
      const next: HqBaseline = { revision: (baseline?.revision ?? 0) + 1, observedAt: Date.now(), summary: summary.trim(),
        evidenceSequences: [...new Set(sequences as number[])] }
      root.session.append('hivemind/hq-baseline', next)
      if (!(await ctx.sessions.flush(root.session))) throw new Error('hq_baseline_persistence_required')
      return { saved: true, baseline: { ...next, evidenceSequences: [...next.evidenceSequences] } }
    },
  })))
}

/** Mount owner review; native action approvals remain independently enforced.
 * @param ctx - native user-question answerers and persisted HQ strategy.
 */
export function installStrategyReview(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'hivemind_hq_review_strategy',
    description: 'Present your saved strategy to the owner for native plan review. The decision applies only to this exact revision; it never permits external actions, spending, or company-memory writes by itself. Reuse a recorded decision instead of asking twice.',
    parameters: { expected_revision: { type: 'integer', required: true } },
    output: { schema: { type: 'object', properties: {}, additionalProperties: true }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    isConcurrencySafe: () => false,
    async execute(args, execution) {
      if (!execution.agent) throw new Error('hq_active_agent_required')
      const member = ctx.agentTeams.membership(execution.agent)
      if (member.role !== 'lead') throw new Error('hq_lead_required')
      const root = member.root
      if (await ctx.hivemindHqOwnership.find() !== root.id) throw new Error('hq_canonical_runtime_required')
      const strategy = hqContinuity(root.session.snapshotEvents())
      if (args.expected_revision !== strategy.revision || !strategy.strategy.trim()) throw new Error('hq_current_saved_strategy_required')
      const strategyRevision = hqStrategyRevision(root.session.snapshotEvents())
      const prior = root.session.snapshotEvents().findLast(event => event.type === 'hivemind/hq-strategy-decision'
        && event.data.strategyRevision === strategyRevision && event.data.strategy === strategy.strategy)
      if (prior?.type === 'hivemind/hq-strategy-decision' && prior.data.status !== 'proposed') return { ...prior.data, reused: true }
      const proposal: HqStrategyDecision = { strategyRevision, strategy: strategy.strategy, status: 'proposed' }
      if (!prior) root.session.append('hivemind/hq-strategy-decision', proposal)
      if (!(await ctx.sessions.flush(root.session))) throw new Error('hq_strategy_review_persistence_required')
      const id = `hq-strategy-${strategyRevision}`
      const reply = await ctx.userQuestions.ask({ agent: root, signal: execution.signal,
        questions: [{ id, question: 'Review the proposed company strategy', detail: strategy.strategy,
          options: [{ label: 'Approve strategy' }, { label: 'Revise strategy' }], intent: { kind: 'plan-review', approve: 'Approve strategy' } }] })
      const answer = reply.answers.find(value => value.id === id)
      if (!answer || (!answer.custom && !answer.selected.length)) return { ...proposal, pending: true }
      const current = hqContinuity(root.session.snapshotEvents())
      if (current.strategy !== strategy.strategy || hqStrategyRevision(root.session.snapshotEvents()) !== strategyRevision)
        return { ...proposal, stale: true }
      const decision: HqStrategyDecision = { ...proposal, status: !answer.custom && answer.selected.length === 1 && answer.selected[0] === 'Approve strategy' ? 'approved' : 'declined', answer: answer.custom ?? answer.selected.join(', ') }
      root.session.append('hivemind/hq-strategy-decision', decision)
      if (!(await ctx.sessions.flush(root.session))) throw new Error('hq_strategy_review_persistence_required')
      return { ...decision, authority_granted: false }
    },
  })))
}
