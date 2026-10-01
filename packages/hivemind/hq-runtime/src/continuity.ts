/** Strategic continuity supplements native execution; it does not prescribe a task sequence. */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { LedgerEvent } from './ledger.ts'
import type {} from './ownership.ts'

/** Per-session sequence positions avoid losing late commits from another employee. */
export interface HqContinuity {
  readonly revision: number
  readonly strategy: string
  readonly reviewed: Readonly<Record<string, number>>
}
/** References to durable employee outcomes; an ended turn is not a certified completed task. */
export interface HqActivity {
  readonly sessionId: string
  readonly sequence: number
  readonly title: string
  readonly time: number
  readonly outcome: JsonValue
  readonly artifacts: readonly JsonValue[]
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Persisted strategy and reviewed positions; execution remains owned by native tasks. */
    'hivemind/hq-continuity': HqContinuity
    /** Exact activity batch shown to HQ, authorizing only those review positions. */
    'hivemind/hq-activity-batch': { id: string; positions: Record<string, number> }
  }
}
/** Replay the last strategy and reviewed activity from the original HQ session.
 * @param events - native durable session events.
 * @returns current strategy, revision and per-session reviewed positions.
 */
export function hqContinuity(events: readonly LedgerEvent[]): HqContinuity {
  let state: HqContinuity = { revision: 0, strategy: '', reviewed: {} }
  for (const event of events) {
    if (event.type !== 'hivemind/hq-continuity') continue
    const next = event.data as HqContinuity
    if (!next || next.revision !== state.revision + 1 || typeof next.strategy !== 'string'
      || !next.reviewed || typeof next.reviewed !== 'object' || Array.isArray(next.reviewed)
      || Object.entries(next.reviewed).some(([id, seq]) => !id || !Number.isSafeInteger(seq) || seq < 0
        || seq < (state.reviewed[id] ?? 0))
      || Object.entries(state.reviewed).some(([id, seq]) => (next.reviewed[id] ?? -1) < seq))
      throw new Error('hq_invalid_continuity_record')
    state = next
  }
  return state
}
/** Mount one progressive strategy/activity tool on the HQ preset.
 * @param ctx - native Team, persistence and authorized company activity provider.
 */
export function installContinuity(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'hivemind_hq_continuity',
    description: 'Inspect your durable strategy and unreviewed employee outcomes, revise strategy, or acknowledge an inspected activity batch. Outcome references cover authorized employee sessions, including human-directed work. Read relevant artifacts and private operating memory before deciding. Turn termination is not task acceptance. This tool grants no authority.',
    parameters: {
      action: { type: 'string', required: true, enum: ['inspect', 'save_strategy', 'review_activity'] },
      expected_revision: { type: 'integer', description: 'Exact continuity revision returned by inspect.' },
      strategy: { type: 'string', description: 'Objectives, priorities, rationale, commitments, dependencies and reconsideration conditions; max 12000 characters.' },
      batch_id: { type: 'string', description: 'Exact inspected batch id; acknowledge only after reviewing it.' },
    },
    output: { schema: { type: 'object', properties: {}, additionalProperties: true }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    isConcurrencySafe: () => false,
    async execute(args, execution) {
      if (!execution.agent) throw new Error('hq_active_agent_required')
      const member = ctx.agentTeams.membership(execution.agent)
      if (member.role !== 'lead') throw new Error('hq_lead_required')
      const root = member.root
      const events = root.session.snapshotEvents()
      const current = hqContinuity(events)
      if (args.action === 'inspect') {
        const result = await ctx.hivemindHqOwnership.activity(root.id, current.reviewed, 20)
        const positions: Record<string, number> = {}
        for (const item of result.items) positions[item.sessionId] = Math.max(positions[item.sessionId] ?? 0, item.sequence)
        const id = `activity-${root.session.snapshotEvents().length}`
        root.session.append('hivemind/hq-activity-batch', { id, positions })
        if (!(await ctx.sessions.flush(root.session))) throw new Error('hq_continuity_persistence_required')
        return {
          revision: current.revision, strategy: current.strategy, reviewed: { ...current.reviewed }, batch_id: id,
          activity: result.items.map(item => ({ ...item, artifacts: [...item.artifacts] })), has_more: result.hasMore,
        }
      }
      if (args.expected_revision !== current.revision) return { conflict: true, current: { ...current, reviewed: { ...current.reviewed } } }
      let next: HqContinuity
      if (args.action === 'save_strategy') {
        if (typeof args.strategy !== 'string' || !args.strategy.trim() || args.strategy.length > 12000)
          throw new Error('hq_strategy_required_max_12000_chars')
        next = { ...current, revision: current.revision + 1, strategy: args.strategy.trim() }
      } else {
        const batch = events.findLast(event => event.type === 'hivemind/hq-activity-batch' && event.data.id === args.batch_id)
        if (batch?.type !== 'hivemind/hq-activity-batch') throw new Error('hq_inspected_activity_batch_required')
        const reviewed = { ...current.reviewed }
        for (const [id, seq] of Object.entries(batch.data.positions)) reviewed[id] = Math.max(reviewed[id] ?? 0, seq)
        next = { ...current, revision: current.revision + 1, reviewed }
      }
      root.session.append('hivemind/hq-continuity', next)
      if (!(await ctx.sessions.flush(root.session))) throw new Error('hq_continuity_persistence_required')
      return { saved: true, ...next, reviewed: { ...next.reviewed } }
    },
  })))
}
