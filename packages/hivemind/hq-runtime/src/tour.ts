/** First-entry presentation checkpoints over the existing authenticated Runtime room. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-hivemind-execution-scope'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { HqTourCheckpoint, HqTourState, HqTourUpdate, HqTourUpdateResult, HqTourWakeResult } from './types.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Authenticated user/company onboarding progress; presentation only, never a wake instruction. */
    'hivemind/hq-tour': HqTourCheckpoint
  }
}
const tails = new WeakMap<Agent, Promise<unknown>>()
function serial<T>(agent: Agent, action: () => Promise<T>): Promise<T> {
  const result = (tails.get(agent) ?? Promise.resolve()).catch(() => {}).then(action)
  tails.set(agent, result)
  void result.finally(() => { if (tails.get(agent) === result) tails.delete(agent) }).catch(() => {})
  return result
}
function owner(ctx: Context): string {
  const principal = ctx.hivemindExecutionScope.require()
  return createHash('sha256').update(JSON.stringify([principal.orgId, principal.userId])).digest('hex')
}
/** Stable native prompt identity shared by every viewer of this exact Runtime room.
 * @param agent - Exact authorized Runtime root.
 * @returns Native prompt identity retained across retries.
 */
export function tourWakeRequestId(agent: Agent): SessionRequestId {
  return `runtime-first-wake-${createHash('sha256').update(String(agent.id)).digest('hex')}` as SessionRequestId
}
/** Project official native awakening independently from presentation and admission.
 * @param ctx - Authenticated request services.
 * @param agent - Exact authorized Runtime root.
 * @returns User-scoped progress and native awakening receipt state.
 */
export function tourState(ctx: Context, agent: Agent): HqTourState {
  const userKey = owner(ctx)
  const events = agent.session.snapshotEvents()
  const progress = events.findLast(event => event.type === 'hivemind/hq-tour' && event.data.userKey === userKey && event.data.version === 1)
  const start = events.find(event => event.type === 'hivemind/hq-awakening-start')
  const started = start !== undefined
  const checkpoints = events.flatMap(event => event.type === 'hivemind/hq-awakening-checkpoint' && start && event.seq > start.seq ? [event.data] : [])
  // Matches awakeningContext's terminal receipt; a plain invitation outside first awakening does not qualify.
  const awakened = started && checkpoints.some(item => !item.blocked && ['conversation', 'remembered'].includes(item.stage))
  const requestId = tourWakeRequestId(agent)
  const accepted = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => message.source.kind === 'user' && 'rpcId' in message.source && message.source.rpcId === requestId)
    || events.some(event => event.type === 'user/message' && event.data.source.kind === 'user' && 'rpcId' in event.data.source && event.data.source.rpcId === requestId)
  const latest = checkpoints.at(-1)
  const running = agent.status === 'running'
  const awakening = awakened ? 'awakened' : started ? (latest?.blocked ? 'blocked' : 'exploring') : accepted ? 'accepted' : 'sleeping'
  return {
    version: 1, step: progress?.type === 'hivemind/hq-tour' ? progress.data.step : 0,
    presentation: progress?.type === 'hivemind/hq-tour' ? progress.data.presentation : 'active',
    revision: progress?.type === 'hivemind/hq-tour' ? progress.data.revision : 0,
    awakening, running, canResume: !awakened && (started || accepted) && !running
      && agent.inbox.nextTurn.length === 0 && agent.inbox.nextStep.length === 0
      && events.some(event => event.type === 'turn/end'),
    wakeRequestId: accepted ? requestId : null,
  }
}
/** Persist one presentation checkpoint without touching the composer or inbox.
 * @param ctx - Authenticated request services.
 * @param agent - Exact authorized Runtime root.
 * @param request - Observed revision and intended presentation.
 * @returns Confirmed saved progress or the concurrent checkpoint.
 */
export function checkpointTour(ctx: Context, agent: Agent, request: HqTourUpdate): Promise<HqTourUpdateResult> {
  const userKey = owner(ctx)
  if (!Number.isSafeInteger(request.step) || request.step < 0 || request.step > 4
    || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0
    || !['active', 'dismissed', 'completed'].includes(request.presentation)) throw new Error('hq_invalid_tour_checkpoint')
  return serial(agent, async () => {
    const current = tourState(ctx, agent)
    // Retry a lost persistence acknowledgement without making a second checkpoint.
    if (current.revision === request.expectedRevision + 1 && current.step === request.step
      && current.presentation === request.presentation) {
      if (!await ctx.sessions.flush(agent.session)) throw new Error('hq_tour_checkpoint_not_persisted')
      return { ok: true, value: current }
    }
    if (current.revision !== request.expectedRevision) return { ok: false, current }
    // Completion is never regressed by a stale tab or a later presentation reopen.
    const presentation = current.presentation === 'completed' ? 'completed' : request.presentation
    if (current.step === request.step && current.presentation === presentation) {
      if (!await ctx.sessions.flush(agent.session)) throw new Error('hq_tour_checkpoint_not_persisted')
      return { ok: true, value: current }
    }
    agent.session.append('hivemind/hq-tour', { version: 1, userKey, step: request.step, presentation,
      revision: current.revision + 1, updatedAt: new Date().toISOString() })
    if (!await ctx.sessions.flush(agent.session)) throw new Error('hq_tour_checkpoint_not_persisted')
    return { ok: true, value: tourState(ctx, agent) }
  })
}
/** Explicit recovery admits a continuation after an unfinished native turn.
 * @param ctx - Authenticated native prompt and persistence services.
 * @param agent - Exact authorized Runtime root.
 * @returns Admission or reconciliation receipt, without claiming official awakening.
 */
export function resumeFromTour(ctx: Context, agent: Agent): Promise<HqTourWakeResult> {
  owner(ctx)
  return serial(agent, async () => {
    const state = tourState(ctx, agent)
    const ended = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    if (!state.canResume || !ended) return { state, requestId: state.wakeRequestId, dispatched: false }
    const requestId = `runtime-awakening-resume-${createHash('sha256').update(`${agent.id}:${ended.seq}`).digest('hex')}` as SessionRequestId
    await ctx.sessionController.prompt({ requestId, sessionId: agent.id, mode: 'queue', content: [{ type: 'text',
      text: 'Continue my unfinished first Runtime awakening in this same room. Reuse the saved investigation checkpoints and successful receipts. Explain any unresolved blocker and ask for my decision when needed. Do not repeat completed steps, duplicate assignments, or widen permissions.' }] }, new AbortController().signal)
    if (!await ctx.sessions.flush(agent.session)) throw new Error('hq_tour_resume_receipt_not_persisted')
    return { state: tourState(ctx, agent), requestId, dispatched: true }
  })
}

/** Explicit human wake uses native prompt admission with one durable retry identity.
 * @param ctx - Authenticated native prompt and persistence services.
 * @param agent - Exact authorized Runtime root.
 * @returns Admission or reconciliation receipt, without claiming official awakening.
 */
export function wakeFromTour(ctx: Context, agent: Agent): Promise<HqTourWakeResult> {
  owner(ctx) // Require the authenticated principal even when only reconciling a prior receipt.
  return serial(agent, async () => {
    const current = tourState(ctx, agent)
    if (current.awakening !== 'sleeping') {
      if (!await ctx.sessions.flush(agent.session)) throw new Error('hq_tour_wake_receipt_not_persisted')
      return { state: tourState(ctx, agent), requestId: current.wakeRequestId, dispatched: false }
    }
    if (current.running) throw new Error('hq_tour_runtime_busy')
    const requestId = tourWakeRequestId(agent)
    await ctx.sessionController.prompt({ requestId, sessionId: agent.id, mode: 'queue',
      content: [{ type: 'text', text: 'Wakeup ! chief' }] }, new AbortController().signal)
    // Native followup writes agent/inbox/spliced before returning. Flush that native record,
    // rather than claiming that a sent message is proof the investigation succeeded.
    if (!await ctx.sessions.flush(agent.session)) throw new Error('hq_tour_wake_receipt_not_persisted')
    return { state: tourState(ctx, agent), requestId, dispatched: true }
  })
}
