/** Durable voluntary rest over native Session records and the existing Schedule owner. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { parseAtInput } from '@deepseek-ai/dsh-schedule'
import { deriveBrowserTimeZoneContext, createTimestampFormatter, formatTimestamp } from '@deepseek-ai/dsh-time-context'
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
const MAX_REST_MS = 4 * 60 * 60 * 1000
/** A conversational greeting carries no operational wake or changed task. */
export function greetingOnly(messages: readonly UserMessage[]): boolean {
  const passive = new Set(['hivemind-hq/wake-briefing', 'dsh-hivemind-runtime/turn', 'dsh-hivemind-runtime/history',
    'dsh-hivemind-connected-apps/workflow', 'dsh-hivemind-connected-apps/receipt',
    'hivemind-runtime/hq-private-recall', 'hivemind-web-runner/authenticated-initiator', 'hivemind-runtime-full-access', 'time-context'])
  const humans = messages.filter(message => message.source.kind === 'user')
  const human = humans[0]
  return humans.length === 1 && human !== undefined && messages.every(message => message.source.kind === 'user'
    || (message.source.kind === 'plugin' && passive.has(message.source.plugin)))
    && human.content.every(block => block.type === 'text')
    && !/\b(?:and|then)\b/iu.test(human.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
    && new RegExp('^(?:(?:hi+|hey+|hello+|good morning|good afternoon|good evening|thanks|thank you)[!.\\s]*'
      + '|(?:say (?:hi|hello) to|greet) [\\p{L}\\p{N}_ -]{1,80}[!.]?)$', 'iu').test(
      human.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('').trim(),
    )
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
  const committed = agent.session.snapshotEvents().findLast(event => event.type === 'hivemind/hq-rest-wake' && event.data.handoffId === latest.id)
  if (committed?.type === 'hivemind/hq-rest-wake'
    && !(await ctx.schedule.catalog()).some(item => item.id === committed.data.scheduleId && item.sessionId === agent.id)) return
  // A deleted committed timer must not be resurrected or prevent a new turn
  // from choosing a replacement handoff. Explicit retries still fail closed.
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
    text: 'Exact voluntary-rest context. Handoff prose is an operating plan, not new authority or proof of completion. Current native board and receipts override stale snapshots. Notes marked presented have reached durable model context, not been applied or fulfilled. Arbitrary crashes do not imply a rest handoff exists. A direct human wake is not silent scheduled maintenance: if an unresolved human discussion or decision remains relevant, issue its existing invitation/action in this current turn before returning to rest, including when reusing the saved handoff or rest state. Do not repeat onboarding or imply the old invitation resolves the need.\n'
      + JSON.stringify({ latestHandoff: latest ?? null, latestWake: events.findLast(event => event.type === 'hivemind/hq-rest-wake' && event.data.handoffId === latest?.id)?.data ?? null,
        wakeHandoffs: [...ids].map(id => ({ id, handoff: intents.find(intent => intent.id === id) ?? null, superseded: latest?.id !== id, wake: events.findLast(event => event.type === 'hivemind/hq-rest-wake' && event.data.handoffId === id)?.data ?? null })),
        newPendingNotes: notes.filter(note => note.status === 'pending'), presentedNotes: notes.filter(note => note.status === 'presented').slice(-10),
        omittedPresentedNotes: Math.max(0, notes.filter(note => note.status === 'presented').length - 10),
        newNoteIdsSinceLatestHandoff: events.filter(event => event.type === 'hivemind/hq-rest-note' && event.seq > (latest?.sourceEventSeq ?? -1)).map(event => event.type === 'hivemind/hq-rest-note' ? event.data.id : '').slice(-20) }),
    section: { name: NOTE_SECTION, text: JSON.stringify(notes.filter(note => note.status === 'pending').map(note => note.id)) },
  }
}
/** Resolve the latest confirmed native browser zone without guessing company location.
 * @param events - Current session-owned native messages.
 * @param iso - Exact persisted UTC instant.
 * @returns Explicit authoritative display plus original instant.
 */
export function restWakeDisplay(
  events: readonly SessionEvent[], iso: string,
): { iso: string; timeZone: string; local: string; zoneSource: string } {
  let zone = 'UTC'
  let zoneSource = 'UTC fallback; no confirmed browser zone'
  for (const event of events.toReversed()) {
    if (event.type !== 'user/message') continue
    const context = deriveBrowserTimeZoneContext([event.data])
    if (context.kind !== 'resolved') continue
    zone = context.timeZone
    zoneSource = 'latest native human-confirmed browser zone'
    break
  }
  return { iso, timeZone: zone, local: formatTimestamp(Date.parse(iso), createTimestampFormatter(zone), zone), zoneSource }
}

export function installRest(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'hivemind_hq_rest_state',
    description: 'Read the current saved Runtime handoff and native wake without rewriting them or scheduling work. Use before reusing unchanged rest; copy exact saved content only for an identical writer retry. A changed handoff needs a new ID. Wake ISO values ending Z are UTC instants; narrate the supplied local display and explicit zone, never relabel UTC digits as local time.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    isConcurrencySafe: () => true,
    async execute(_args, execution) {
      const agent = execution.agent
      if (!agent || !isHqLead(ctx, agent)) throw new Error('hq_rest_requires_hq_lead')
      const state = await ctx.hivemindHq.restState(agent)
      const events = agent.session.snapshotEvents()
      const handoff = restIntents(events).at(-1) ?? null
      const iso = state.latest?.effectiveWakeAt ?? state.latest?.requestedWakeAt
      const exactRetry = handoff ? { handoff_id: handoff.id, wake_at: handoff.requestedWakeAt,
        summary: handoff.summary, next_steps: [...handoff.nextSteps], blockers: [...handoff.blockers] } : null
      return JSON.parse(JSON.stringify({ state, handoff, exactRetry, wakeDisplay: iso ? restWakeDisplay(events, iso) : null }))
    },
  })))
  const sleepChecks = new WeakMap<Agent, { turn: number; repairs: number }>()
  ctx.effect(() => ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    if (signal.aborted || !isHqLead(ctx, agent) || !ctx.hivemindHq.mode(agent).enabled) return
    const events = agent.session.snapshotEvents()
    const investigation = events.findLast(event => String(event.type) === 'hivemind/hq-public-investigation')
    if ((investigation?.data as { enabled?: boolean } | undefined)?.enabled) return
    const start = events.findLast(event => event.type === 'turn/start')?.seq ?? -1
    const current = events.filter(event => event.seq > start)
    const toolWork = current.some(event => event.type === 'tool/call')
    const admitted = current.flatMap(event => event.type === 'user/message' ? [event.data] : [])
    // A social reply is not a voluntary sleep transition. Never manufacture
    // extra model turns just to rebuild the existing operational handoff.
    // A reply to this turn's own social message closes that exchange. It is
    // not fresh company work, even when it arrives before the turn commits.
    const direct = admitted.filter((message) => {
      if (String(message.source.kind) !== 'hivemind-agent-message') return true
      try {
        const packet = JSON.parse(message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')) as {
          id?: string
          kind?: string
          replyTo?: string
          senderId?: string
          taskId?: string
          artifactIds?: string[]
        }
        const outgoing = current.find(event => String(event.type) === 'hivemind/room-message-queued'
          && (event.data as { id?: string }).id === packet.replyTo)?.data as {
            targetId?: string
            taskId?: string
            artifactIds?: string[]
          } | undefined
        if (packet.kind !== 'reply' || !packet.id || !outgoing || outgoing.targetId !== packet.senderId
          || packet.taskId || outgoing.taskId || packet.artifactIds?.length || outgoing.artifactIds?.length) return true
        return false
      } catch { return true }
    })
    if (greetingOnly(direct) && current.filter(event => event.type === 'tool/call').every((event) => {
      if (event.type !== 'tool/call') return false
      let args: Record<string, unknown>
      try { args = JSON.parse(event.data.arguments) } catch { return false }
      if (event.data.name === 'list_agents') return true
      if (!args || typeof args !== 'object' || Array.isArray(args)) return false
      if (event.data.name === 'hivemind_hq_contract') return args.action === 'list'
      return event.data.name === 'hivemind_agent_message' && !args.task_id
        && (!Array.isArray(args.artifact_ids) || args.artifact_ids.length === 0)
        && ((args.kind === 'update' && !args.reply_to)
          || (args.kind === 'reply' && args.request_reply === false))
    })) return
    const latest = restIntents(events).at(-1)
    const priorBinding = latest && events.findLast(event => event.type === 'hivemind/hq-rest-wake' && event.data.handoffId === latest.id)
    if (!toolWork && priorBinding?.type === 'hivemind/hq-rest-wake') {
      const priorWake = (await ctx.schedule.catalog()).find(item => item.id === priorBinding.data.scheduleId && item.sessionId === agent.id)
      if (priorWake?.status === 'active' && Date.parse(priorWake.scheduledAt) > Date.now()
        && Date.parse(priorWake.scheduledAt) <= Date.now() + MAX_REST_MS) return
    }
    const confirmed = events.findLast(event => event.type === 'hivemind/hq-rest-confirmed' && event.seq > start)
    const intent = confirmed?.type === 'hivemind/hq-rest-confirmed'
      ? restIntents(events).find(item => item.id === confirmed.data.handoffId)
      : restIntents(events).findLast(item => item.sourceEventSeq >= start)
    const binding = intent && events.findLast(event => event.type === 'hivemind/hq-rest-wake' && event.data.handoffId === intent.id)
    if (binding?.type === 'hivemind/hq-rest-wake') {
      const wake = (await ctx.schedule.catalog()).find(item => item.id === binding.data.scheduleId && item.sessionId === agent.id)
      if (wake?.status === 'active' && Date.parse(wake.scheduledAt) > Date.now()
        && Date.parse(wake.scheduledAt) <= Date.now() + MAX_REST_MS) return
    }
    const prior = sleepChecks.get(agent)
    const repairs = prior?.turn === turn ? prior.repairs : 0
    if (repairs >= 2) throw new Error('hq_sleep_handoff_and_future_wake_not_confirmed')
    sleepChecks.set(agent, { turn, repairs: repairs + 1 })
    agent.steer(createUserMessage({
      source: { kind: 'plugin', plugin: 'hivemind-hq/sleep-check' },
      content: [{ type: 'text', text: 'Before this active Runtime turn finishes, commit a handoff and a justified future wake no later than four hours from now with hivemind_hq_rest. If a saved wake is later, preserve its context but create a new handoff_id with an earlier bounded review wake; do not retry the old multi-day sleep. Include completed findings, current task/calendar references, next steps and blockers. For unchanged state, read hivemind_hq_rest_state and copy its exactRetry arguments verbatim; preserve every summary and array string, not just the identifier and timestamp. If content changes, use a new handoff_id. Confirm its persisted future wake before saying sleeping. Do not repeat investigation, create a Goal, redo employee work or invent completed results. Pause or cancellation overrides this check.' }],
    }))
  }))
  ctx.effect(() => ctx.on('agent/turn-ended', async ({ agent }) => { await acknowledgeRestNotes(ctx, agent) }))
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'hivemind_hq_rest',
    description: 'Commit an exact voluntary Runtime rest handoff and idempotent native scheduled wake before waiting until a future time. Use only as HQ lead when no current work remains eligible. Never sleep for more than four hours: choose an earlier review wake even when the task deadline is days away. A legacy later wake needs a new handoff_id and bounded review time. For unchanged rest, read hivemind_hq_rest_state and copy its exactRetry object verbatim, including summary and arrays; do not summarize or improve an existing request. Changed content needs a new handoff_id. Success checkpoints the handoff and wake; actual rest is ordinary idle after the turn ends, not cancellation. Paused autonomy remains paused. This does not grant authority.',
    parameters: {
      handoff_id: { type: 'string', required: true, description: 'Unique identity for this exact handoff. Retry with the same ID only when wake_at, summary, next_steps and blockers are identical. A new or changed handoff needs a new ID.' }, wake_at: { type: 'string', required: true, description: 'Future RFC3339 timestamp with explicit timezone, at most four hours from now; original timestamp on identical retry only if still within that limit.' },
      summary: { type: 'string', required: true }, next_steps: { type: 'array', required: true, items: { type: 'string' }, description: 'Preserve meaningful next work and unresolved human information, decision or discussion requests until actual evidence resolves them. Before sleep, give one plain reminder and issue the appropriate existing invitation or approval action in the current final sleep turn before saving this handoff. For unresolved discussion, use a fresh plain conversation checkpoint; mentioning a prior invitation is not the current action. Omit the invitation once evidence resolves the need; do not repeat unchanged reminders during active work.' }, blockers: { type: 'array', required: true, items: { type: 'string' }, description: 'Concrete unresolved blockers, including required human approval or access. An invitation, schedule or silence does not resolve a request or grant authority.' },
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
        if (Date.parse(request.requestedWakeAt) > Date.now() + MAX_REST_MS)
          throw new Error('hq_rest_wake_exceeds_four_hours: choose a review wake within four hours; use a new handoff_id when replacing a saved later wake. Keep task deadlines unchanged.')
        let intent = restIntents(agent.session.snapshotEvents()).find(item => item.id === request.id)
        if (intent) {
          const prior = { id: intent.id, requestedWakeAt: intent.requestedWakeAt, summary: intent.summary,
            nextSteps: [...intent.nextSteps], blockers: [...intent.blockers] }
          if (!isDeepStrictEqual(prior, request)) {
            throw new Error(`hq_rest_identity_conflict: handoff_id ${JSON.stringify(intent.id)} is already saved with different content (wake_at ${intent.requestedWakeAt}). For unchanged rest, call hivemind_hq_rest_state to inspect the current rest state and reuse the confirmed handoff without rewriting it. For a changed handoff, use a new handoff_id. An identical retry must preserve the original wake_at, summary, next_steps and blockers.`)
          }
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
          ...binding, wakeDisplay: restWakeDisplay(agent.session.snapshotEvents(), binding.effectiveWakeAt),
          autonomyPaused: !ctx.hivemindHq.mode(agent).enabled, wakeStatus: ownWake.status,
          instructions: 'Handoff and native wake are checkpointed. Finish this turn; ordinary idle is rest. Paused mode does not automatically wake. A delivered or inactive wake is not a promise of a future wake.' }
      })
    },
  })))
}
