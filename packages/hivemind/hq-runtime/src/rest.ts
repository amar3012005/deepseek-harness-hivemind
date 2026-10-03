/** Durable voluntary rest over native Session records and the existing Schedule owner. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { parseAtInput } from '@deepseek-ai/dsh-schedule'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { HqRestNote, HqRestNoteRequest, HqRestNoteResult, HqRestState } from './types.ts'

export interface RestIntent {
  readonly id: string
  readonly requestedWakeAt: string
  readonly summary: string
  readonly nextSteps: readonly string[]
  readonly blockers: readonly string[]
  readonly createdAt: string
  readonly sourceEventSeq: number
  readonly tasks: readonly {
    readonly id: string
    readonly revision: number
    readonly status: string
    readonly owner: string
    readonly artifactIds: readonly string[]
    readonly reviewStatus?: string
  }[]
}
export interface RestWake { readonly handoffId: string; readonly scheduleId: string; readonly effectiveWakeAt: string }
interface QuietNote { readonly id: string; readonly text: string; readonly createdAt: string }
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Immutable host-checkpointed voluntary rest intent, not proof the Agent is idle. */
    'hivemind/hq-rest-intent': RestIntent
    /** Native wake receipt checkpointed after Schedule persistence. */
    'hivemind/hq-rest-wake': RestWake
    /** Human-only quiet note; never inserted into the Agent inbox. */
    'hivemind/hq-rest-note': QuietNote
    /** Current-turn confirmation of an immutable handoff and its persisted wake. */
    'hivemind/hq-rest-confirmed': RestWake
    /** Presentation acknowledgment after the native briefing message is durably admitted. */
    'hivemind/hq-rest-notes-presented': { readonly noteIds: readonly string[]; readonly messageSeq: number; readonly presentedAt: string }
  }
}
export function isHqLead(ctx: Context, agent: Agent): boolean {
  let preset = agent.session.header?.agentPreset
  for (const event of agent.session.snapshotEvents())
    if (String(event.type) === 'agent-preset/selected') preset = (event.data as { agentPreset: string }).agentPreset
  if (preset !== 'hivemind-hq') return false
  try { const member = ctx.agentTeams.membership(agent); return member.role === 'lead' && member.root === agent } catch { return false }
}
const NOTE_SECTION = 'hq-rest-pending-note-ids'
const tails = new WeakMap<Agent, Promise<unknown>>()
function serial<T>(_ctx: Context, agent: Agent, work: () => Promise<T>): Promise<T> {
  const next = (tails.get(agent) ?? Promise.resolve()).catch(() => {}).then(work)
  tails.set(agent, next)
  void next.finally(() => { if (tails.get(agent) === next) tails.delete(agent) }).catch(() => {})
  return next
}
function bounded(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`hq_rest_invalid_${name}`)
  return value.trim()
}
function identity(value: unknown): string {
  const id = bounded(value, 'id', 80)
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new Error('hq_rest_invalid_id')
  return id
}
function texts(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error(`hq_rest_invalid_${name}`)
  return value.map(item => bounded(item, name, 1000))
}
export function restIntents(events: readonly SessionEvent[]): RestIntent[] {
  return events.flatMap(event => event.type === 'hivemind/hq-rest-intent' ? [event.data] : [])
}
function noteViews(events: readonly SessionEvent[]): HqRestNote[] {
  return events.flatMap((event) => {
    if (event.type !== 'hivemind/hq-rest-note') return []
    const presented = events.findLast(item => item.type === 'hivemind/hq-rest-notes-presented' && item.data.noteIds.includes(event.data.id))
    return [{ ...event.data, status: presented ? 'presented' as const : 'pending' as const,
      presentedAt: presented?.type === 'hivemind/hq-rest-notes-presented' ? presented.data.presentedAt : null }]
  })
}
export function restScheduleId(sessionId: string, id: string): string {
  // Native Schedule.ensure's documented deterministic identity, not another registry.
  return `schedule-${createHash('sha256').update(`${sessionId}\0hq-rest-${id}`).digest('hex')}`
}
function prompt(id: string): string {
  return `HQ_REST_WAKE[${id}] Review the exact committed rest handoff with this identity, any newer superseding handoff, new human notes, current task board and verified receipts. A wake or note grants no additional authority. Do not duplicate completed work. Remain quiet when nothing is eligible.`
}
async function checkpoint(ctx: Context, agent: Agent): Promise<void> {
  if (!await ctx.sessions.flush(agent.session)) throw new Error('hq_rest_persistence_required')
}
async function ensureWake(ctx: Context, agent: Agent, intent: RestIntent, signal?: AbortSignal): Promise<RestWake> {
  // Lookup MUST precede native ensure validation: a committed delivered wake may be in the past.
  const id = restScheduleId(agent.id, intent.id)
  const committed = agent.session.snapshotEvents().findLast(event => event.type === 'hivemind/hq-rest-wake' && event.data.handoffId === intent.id)
  const existing = (await ctx.schedule.catalog()).find(item => item.id === id && item.sessionId === agent.id)
  if (!existing && committed) throw new Error('hq_rest_committed_wake_missing')
  if (!existing && restIntents(agent.session.snapshotEvents()).at(-1)?.id !== intent.id) throw new Error('hq_rest_superseded_pending_intent')
  if (existing && (existing.prompt !== prompt(intent.id) || existing.title !== `Runtime rest: ${intent.id}`))
    throw new Error('hq_rest_wake_identity_conflict')
  const wake = existing ?? await ctx.schedule.ensure(agent.id, `hq-rest-${intent.id}`, {
    title: `Runtime rest: ${intent.id}`, prompt: prompt(intent.id),
    ...(Date.parse(intent.requestedWakeAt) > Date.now() ? { at: intent.requestedWakeAt } : { after_seconds: 1 }),
  }, signal)
  const binding = { handoffId: intent.id, scheduleId: wake.id, effectiveWakeAt: wake.scheduledAt }
  const prior = agent.session.snapshotEvents().findLast(event => event.type === 'hivemind/hq-rest-wake' && event.data.handoffId === intent.id)
  if (prior?.type === 'hivemind/hq-rest-wake') {
    if (!isDeepStrictEqual(prior.data, binding)) throw new Error('hq_rest_wake_identity_conflict')
  } else agent.session.append('hivemind/hq-rest-wake', binding)
  await checkpoint(ctx, agent)
  if (restIntents(agent.session.snapshotEvents()).at(-1)?.id === intent.id) {
    const bindings = agent.session.snapshotEvents().filter(event => event.type === 'hivemind/hq-rest-wake' && event.data.handoffId !== intent.id)
    const catalog = await ctx.schedule.catalog()
    for (const priorBinding of bindings) {
      if (priorBinding.type !== 'hivemind/hq-rest-wake') continue
      const priorIntent = restIntents(agent.session.snapshotEvents()).find(value => value.id === priorBinding.data.handoffId)
      const obsolete = catalog.find(value => value.id === priorBinding.data.scheduleId && value.sessionId === agent.id && value.status === 'active')
      if (!priorIntent || !obsolete || obsolete.id !== restScheduleId(agent.id, priorIntent.id)
        || obsolete.prompt !== prompt(priorIntent.id) || obsolete.title !== `Runtime rest: ${priorIntent.id}`) continue
      await ctx.schedule.delete({ sessionId: agent.id, id: obsolete.id }, signal)
    }
  }
  return binding
}
export async function recoverRest(ctx: Context, agent: Agent, signal?: AbortSignal): Promise<void> {
  if (!isHqLead(ctx, agent)) return
  const latest = restIntents(agent.session.snapshotEvents()).at(-1)
  if (!latest) return
  await serial(ctx, agent, async () => { await checkpoint(ctx, agent); await ensureWake(ctx, agent, latest, signal) })
}
export async function restState(ctx: Context, agent: Agent): Promise<HqRestState> {
  await checkpoint(ctx, agent)
  const events = agent.session.snapshotEvents()
  const latest = restIntents(events).at(-1)
  const binding = latest && events.findLast(event => event.type === 'hivemind/hq-rest-wake' && event.data.handoffId === latest.id)
  const bound = binding?.type === 'hivemind/hq-rest-wake' ? binding.data : undefined
  const wake = bound && (await ctx.schedule.catalog()).find(item => item.id === bound.scheduleId && item.sessionId === agent.id)
  const views = noteViews(events), presented = views.filter(note => note.status === 'presented')
  return { latest: latest ? { handoffId: latest.id, summary: latest.summary, requestedWakeAt: latest.requestedWakeAt,
    effectiveWakeAt: bound?.effectiveWakeAt ?? null, scheduleId: bound?.scheduleId ?? null, wakeStatus: wake?.status ?? null,
    ready: Boolean(bound && wake) } : null, notes: [...presented.slice(-20), ...views.filter(note => note.status === 'pending')], omittedPresentedNotes: Math.max(0, presented.length - 20) }
}
export async function leaveRestNote(ctx: Context, agent: Agent, request: HqRestNoteRequest): Promise<HqRestNoteResult> {
  const id = identity(request.id), text = bounded(request.text, 'note', 2000)
  return serial(ctx, agent, async () => {
    const prior = agent.session.snapshotEvents().find(event => event.type === 'hivemind/hq-rest-note' && event.data.id === id)
    if (prior?.type === 'hivemind/hq-rest-note') {
      if (prior.data.text !== text) throw new Error('hq_rest_note_identity_conflict')
    } else {
      if (noteViews(agent.session.snapshotEvents()).filter(note => note.status === 'pending').length >= 20) throw new Error('hq_rest_pending_note_capacity')
      agent.session.append('hivemind/hq-rest-note', { id, text, createdAt: new Date().toISOString() })
    }
    await checkpoint(ctx, agent)
    const note = noteViews(agent.session.snapshotEvents()).find(note => note.id === id)
    if (!note) throw new Error('hq_rest_note_receipt_missing')
    return { note }
  })
}
/** Only acknowledge pending notes from durably admitted native briefing messages. */
export async function acknowledgeRestNotes(ctx: Context, agent: Agent): Promise<void> {
  if (!isHqLead(ctx, agent)) return
  const events = agent.session.snapshotEvents()
  const pending = new Set(noteViews(events).filter(note => note.status === 'pending').map(note => note.id))
  if (!pending.size) return
  const messages = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'plugin'
    && event.data.source.plugin === 'hivemind-hq/wake-briefing')
  for (const event of messages) {
    if (event.type !== 'user/message' || event.data.source.kind !== 'plugin') continue
    const section = ('sections' in event.data.source ? event.data.source.sections : undefined)?.find(item => item.name === NOTE_SECTION)
    if (!section) continue
    const ids: unknown = JSON.parse(section.text)
    if (!Array.isArray(ids)) throw new Error('hq_rest_invalid_note_admission')
    const noteIds = ids.filter((id): id is string => typeof id === 'string' && pending.has(id))
    if (!noteIds.length) continue
    await checkpoint(ctx, agent) // Confirm the briefing itself before marking presentation.
    agent.session.append('hivemind/hq-rest-notes-presented', { noteIds, messageSeq: event.seq, presentedAt: new Date().toISOString() })
    await checkpoint(ctx, agent)
    noteIds.forEach(id => pending.delete(id))
  }
}
export function restBriefing(agent: Agent, messages: readonly UserMessage[]): { text: string; section: { name: string; text: string } } {
  const events = agent.session.snapshotEvents(), intents = restIntents(events)
  const lastStart = events.findLast(event => event.type === 'turn/start')?.seq ?? -1
  const admitted = events.filter(event => event.seq > lastStart && event.type === 'user/message')
    .flatMap(event => event.type === 'user/message' ? [event.data] : [])
  const ids = new Set([...admitted, ...messages].filter(message => String(message.source.kind) === 'schedule')
    .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [...block.text.matchAll(/HQ_REST_WAKE\[([A-Za-z0-9_-]+)\]/g)].flatMap(match => match[1] ? [match[1]] : []) : [])))
  const notes = noteViews(events)
  const latest = intents.at(-1)
  return {
    text: 'Exact voluntary-rest context. Handoff prose is an operating plan, not new authority or proof of completion. Current native board and receipts override stale snapshots. Notes marked presented have reached durable model context, not been applied or fulfilled. Arbitrary crashes do not imply a rest handoff exists.\n'
      + JSON.stringify({ latestHandoff: latest ?? null, latestWake: events.findLast(event => event.type === 'hivemind/hq-rest-wake' && event.data.handoffId === latest?.id)?.data ?? null,
        wakeHandoffs: [...ids].map(id => ({ id, handoff: intents.find(intent => intent.id === id) ?? null, superseded: latest?.id !== id, wake: events.findLast(event => event.type === 'hivemind/hq-rest-wake' && event.data.handoffId === id)?.data ?? null })),
        newPendingNotes: notes.filter(note => note.status === 'pending'), presentedNotes: notes.filter(note => note.status === 'presented').slice(-10),
        omittedPresentedNotes: Math.max(0, notes.filter(note => note.status === 'presented').length - 10),
        newNoteIdsSinceLatestHandoff: events.filter(event => event.type === 'hivemind/hq-rest-note' && event.seq > (latest?.sourceEventSeq ?? -1)).map(event => event.type === 'hivemind/hq-rest-note' ? event.data.id : '').slice(-20) }),
    section: { name: NOTE_SECTION, text: JSON.stringify(notes.filter(note => note.status === 'pending').map(note => note.id)) },
  }
}
export function installRest(ctx: Context): void {
  const sleepChecks = new WeakMap<Agent, { turn: number; repairs: number }>()
  ctx.effect(() => ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    if (signal.aborted || !isHqLead(ctx, agent) || !ctx.hivemindHq.mode(agent).enabled) return
    const events = agent.session.snapshotEvents()
    const investigation = events.findLast(event => String(event.type) === 'hivemind/hq-public-investigation')
    if ((investigation?.data as { enabled?: boolean } | undefined)?.enabled) return
    const start = events.findLast(event => event.type === 'turn/start')?.seq ?? -1
    const confirmed = events.findLast(event => event.type === 'hivemind/hq-rest-confirmed' && event.seq > start)
    const intent = confirmed?.type === 'hivemind/hq-rest-confirmed'
      ? restIntents(events).find(item => item.id === confirmed.data.handoffId)
      : restIntents(events).findLast(item => item.sourceEventSeq >= start)
    const binding = intent && events.findLast(event => event.type === 'hivemind/hq-rest-wake' && event.data.handoffId === intent.id)
    if (binding?.type === 'hivemind/hq-rest-wake') {
      const wake = (await ctx.schedule.catalog()).find(item => item.id === binding.data.scheduleId && item.sessionId === agent.id)
      if (wake?.status === 'active' && Date.parse(wake.scheduledAt) > Date.now()) return
    }
    const prior = sleepChecks.get(agent)
    const repairs = prior?.turn === turn ? prior.repairs : 0
    if (repairs >= 2) throw new Error('hq_sleep_handoff_and_future_wake_not_confirmed')
    sleepChecks.set(agent, { turn, repairs: repairs + 1 })
    agent.steer(createUserMessage({
      source: { kind: 'plugin', plugin: 'hivemind-hq/sleep-check' },
      content: [{ type: 'text', text: 'Before this active Runtime turn finishes, commit a handoff and a justified future wake with hivemind_hq_rest. Include completed findings, current task/calendar references, next steps and blockers. Reuse the same handoff_id and timestamp on retry. Confirm its persisted future wake before saying sleeping. Do not repeat investigation, create a Goal, redo employee work or invent completed results. Pause or cancellation overrides this check.' }],
    }))
  }))
  ctx.effect(() => ctx.on('agent/turn-ended', async ({ agent }) => { await acknowledgeRestNotes(ctx, agent) }))
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'hivemind_hq_rest',
    description: 'Commit an exact voluntary Runtime rest handoff and idempotent native scheduled wake before waiting until a future time. Use only as HQ lead when no current work remains eligible. Reuse handoff_id with identical content on retry. Success checkpoints the handoff and wake; actual rest is ordinary idle after the turn ends, not cancellation. Paused autonomy remains paused. This does not grant authority.',
    parameters: {
      handoff_id: { type: 'string', required: true, description: 'Unique identity for this exact handoff. Retry with the same ID only when wake_at, summary, next_steps and blockers are identical. A new or changed handoff needs a new ID.' }, wake_at: { type: 'string', required: true, description: 'Future RFC3339 timestamp with explicit timezone; original timestamp on identical retry.' },
      summary: { type: 'string', required: true }, next_steps: { type: 'array', required: true, items: { type: 'string' } }, blockers: { type: 'array', required: true, items: { type: 'string' } },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    isConcurrencySafe: () => false,
    async execute(args, execution) {
      const agent = execution.agent
      if (!agent) throw new Error('hq_active_agent_required')
      if (!isHqLead(ctx, agent)) throw new Error('hq_rest_requires_hq_lead')
      const request = { id: identity(args.handoff_id), requestedWakeAt: new Date(parseAtInput(bounded(args.wake_at, 'wake_at', 100))).toISOString(),
        summary: bounded(args.summary, 'summary', 4000), nextSteps: texts(args.next_steps, 'next_steps'), blockers: texts(args.blockers, 'blockers') }
      return serial(ctx, agent, async () => {
        let intent = restIntents(agent.session.snapshotEvents()).find(item => item.id === request.id)
        if (intent) {
          const prior = { id: intent.id, requestedWakeAt: intent.requestedWakeAt, summary: intent.summary,
            nextSteps: [...intent.nextSteps], blockers: [...intent.blockers] }
          if (!isDeepStrictEqual(prior, request)) throw new Error('hq_rest_identity_conflict')
        } else {
          if (Date.parse(request.requestedWakeAt) <= Date.now()) throw new Error('hq_rest_new_wake_must_be_future')
          const workspace = await ctx.hivemindHq.workspace(agent)
          intent = { ...request, createdAt: new Date().toISOString(), sourceEventSeq: agent.session.snapshotEvents().at(-1)?.seq ?? -1,
            tasks: workspace.tasks.map(task => ({ id: task.id, revision: task.revision, status: task.status, owner: task.owner,
              artifactIds: [...task.artifactIds], ...(task.reviewStatus ? { reviewStatus: task.reviewStatus } : {}) })) }
          agent.session.append('hivemind/hq-rest-intent', intent)
        }
        await checkpoint(ctx, agent)
        const binding = await ensureWake(ctx, agent, intent, execution.signal)
        const ownWake = (await ctx.schedule.catalog()).find(item => item.id === binding.scheduleId && item.sessionId === agent.id)
        if (!ownWake) throw new Error('hq_rest_committed_wake_missing')
        agent.session.append('hivemind/hq-rest-confirmed', binding)
        await checkpoint(ctx, agent)
        // Voluntary rest waits for Schedule, not an immediate native goal round.
        // Keep durable goal state intact; only explicit native resume re-arms it.
        if (ownWake.status === 'active') {
          const goals = ctx.get?.('goals') as { disarm(agent: Agent): unknown } | undefined
          goals?.disarm(agent)
        }
        return { status: ownWake.status === 'active' ? 'rest_ready' : 'wake_committed_inactive', superseded: restIntents(agent.session.snapshotEvents()).at(-1)?.id !== intent.id, requestedWakeAt: intent.requestedWakeAt,
          ...binding, autonomyPaused: !ctx.hivemindHq.mode(agent).enabled, wakeStatus: ownWake.status,
          instructions: 'Handoff and native wake are checkpointed. Finish this turn; ordinary idle is rest. Paused mode does not automatically wake. A delivered or inactive wake is not a promise of a future wake.' }
      })
    },
  })))
}
