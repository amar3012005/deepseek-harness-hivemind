/** First awakening is a resumable investigation in the native room, not a second agent loop. */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-skill'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isHqLead } from './rest.ts'

export const awakeningStages = ['company', 'evidence', 'team', 'memory', 'strategy', 'conversation', 'remembered'] as const
export type AwakeningStage = typeof awakeningStages[number]
export interface AwakeningCheckpoint {
  readonly stage: AwakeningStage
  readonly turn: number
  readonly summary: string
  readonly receiptSeqs: readonly number[]
  readonly blocked: boolean
  readonly recordedAt: string
  readonly cards: readonly {
    title: string
    detail: string
    image?: string
    reference?: string
    employeeId?: string
    role?: string
    avatarUrl?: string
  }[]
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Records the human-triggered first awakening and its initial turn and timestamp for restart continuity. */
    'hivemind/hq-awakening-start': { readonly version: 1; readonly turn: number; readonly startedAt: string }
    /** Saves an investigation stage, inspected evidence references and presentation cards without dispatching work. */
    'hivemind/hq-awakening-checkpoint': AwakeningCheckpoint
  }
}
const trigger = /^(?:wake\s+up|wakeup)\s*[!,]?\s*chief(?=$|[\s!.,:;—-])/iu
export async function awakeningContext(ctx: Context, agent: Agent, turn: number, messages: readonly UserMessage[]): Promise<string> {
  if (!isHqLead(ctx, agent)) return ''
  let started = agent.session.snapshotEvents().some(event => event.type === 'hivemind/hq-awakening-start')
  const humanMessages = [...messages, ...agent.session.snapshotEvents().flatMap(event => event.type === 'user/message' ? [event.data] : [])]
  if (!started && humanMessages.some(message => message.source.kind === 'user' && trigger.test(message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('').trim()))) {
    agent.session.append('hivemind/hq-awakening-start', { version: 1, turn, startedAt: new Date().toISOString() })
    if (!await ctx.sessions.flush(agent.session)) throw new Error('hq_awakening_persistence_required')
    // Only the explicit leading human wake command activates the existing autonomy
    // switch. Model checkpoints and later scheduled wakes cannot enable it.
    const mode = ctx.hivemindHq.mode(agent)
    if (!mode.enabled) {
      const enabled = await ctx.hivemindHq.setMode(agent, { enabled: true, expectedRevision: mode.revision })
      if (!enabled.ok) throw new Error('hq_awakening_mode_conflict')
    }
    started = true
  }
  if (!started) return ''
  const events = agent.session.snapshotEvents()
  const start = events.findLast(event => event.type === 'hivemind/hq-awakening-start')
  const boundary = events.findLast(event => event.type === 'turn/start')?.seq ?? -1
  const currentHuman = [...events.flatMap(event => event.seq > boundary && event.type === 'user/message' ? [event.data] : []), ...messages]
    .filter(message => message.source.kind === 'user')
  const request = currentHuman.at(-1)?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('').trim()
  // An unfinished orientation is saved work, not a competing objective for an
  // unrelated current human request. Native answer/result wakes can still resume it.
  if (start?.type === 'hivemind/hq-awakening-start' && start.data.turn !== turn
    && request !== undefined && !trigger.test(request)
    && !/^\s*(?:please\s+)?(?:continue|resume|finish|complete|orient)\b.{0,80}\b(?:awakening|orientation|onboarding)\b/iu.test(request)) return ''
  const checkpoints = events.flatMap(event => event.type === 'hivemind/hq-awakening-checkpoint' ? [event.data] : [])
  const stages = ['company', 'evidence', 'team', 'strategy', 'conversation'] as const
  // An invitation is not completion of orientation. Recover the latest stage
  // state, including a later blocked correction to previously accepted findings.
  const next = stages.find((stage) => {
    const latest = checkpoints.findLast(item => item.stage === stage)
    return !latest || latest.blocked
  })
  if (!next) return ''
  const findings = awakeningStages.flatMap((stage) => {
    const event = events.findLast(event => event.type === 'hivemind/hq-awakening-checkpoint' && event.data.stage === stage)
    return event?.type === 'hivemind/hq-awakening-checkpoint'
      ? [{ stage, blocked: event.data.blocked, summary: (event.data.summary ?? '').slice(0, 240), sequence: event.seq }] : []
  })
  return `First awakening is active. You remain Runtime, the AI Chief of Staff. Load runtime-company-awakening through the native skill loader for its five flexible outcomes; detailed guidance belongs in the loaded skill, not the human chat bubble. Current unfinished checkpoint: ${next}. Reuse saved findings and receipts, choose only justified work, and do not create an ongoing goal for scheduled waiting. Normal permissions, Pause and sleep rules remain in force.
Saved latest findings (read the original sequence with hyperagents_history when needed): ${JSON.stringify(findings)}`

}
/** Load the current complete method through the agent-scoped native registry.
 * This request projection is not a new journal or competing skill catalog.
 */
export async function awakeningMethod(ctx: Context, agent: Agent, messages: readonly UserMessage[],
  signal: AbortSignal): Promise<UserMessage[]> {
  const skills = ctx.get('skills')
  if (!skills) throw new Error('hq_awakening_skill_unavailable')
  const method = await skills.get('runtime-company-awakening', { scope: agent, cwd: agent.session.header.cwd, signal })
  if (!method?.invocation.modelInvocable || !method.content.trim()) throw new Error('hq_awakening_skill_unavailable')
  const text = `<skill_content name="${method.name}">\n${method.content}\n</skill_content>`
  // pre-step decisions contain newly claimed input, not existing model history.
  // Read the native surface so reuse survives later steps and cold restoration.
  const visible = new Set(agent.session.surface.nodes)
  const owned = agent.session.snapshotEvents().filter(event => visible.has(event.seq)
    && event.type === 'user/message' && event.data.source.kind === 'plugin'
    && event.data.source.plugin === 'hivemind-hq/awakening-method')
  const matches = (message: UserMessage) => message.source.kind === 'plugin'
    && message.source.plugin === 'hivemind-hq/awakening-method'
    && message.content.some(block => block.type === 'text' && block.text === text)
  if (owned.length === 1 && owned[0]?.type === 'user/message' && matches(owned[0].data)) return []
  if (owned.length) {
    // Only our method projection is replaced. Raw versions and every unrelated
    // message, task and approval remain untouched in the append-only journal.
    owned.forEach((event, index) => {
      const message = createUserMessage({ source: { kind: 'plugin',
        plugin: index === 0 ? 'hivemind-hq/awakening-method' : 'hivemind-hq/awakening-method-superseded', form: 'recall' },
      content: [{ type: 'text', text: index === 0 ? text : 'Duplicate awakening method superseded; use the current method.' }] })
      agent.session.append('user/message', message, {
        surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq }, sourceEventSeqs: [event.seq],
      })
    })
    return []
  }
  if (messages.some(matches)) return []
  return [createUserMessage({ source: { kind: 'plugin', plugin: 'hivemind-hq/awakening-method', form: 'recall' },
    content: [{ type: 'text', text }] })]

}
function safeImage(value: unknown): string | undefined {
  // Only the existing authenticated same-origin artifact surface; never arbitrary remote pixels or credential URLs.
  return typeof value === 'string' && /^\/(?:api|assets)\/[A-Za-z0-9_./%-]+$/.test(value) ? value : undefined
}
export function installAwakening(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'hivemind_hq_awakening',
    description: 'Checkpoint the first Runtime investigation and show inspected evidence or authenticated team cards. Native tools perform retrieval and actions. Collect successful context/source tool results before checkpointing findings. Copy exact references from those returned results into evidence_refs; skill loading, a wake command, plans and intentions are not company evidence. Evidence references must occur in successful non-awakening tool receipts in this room. After completed onboarding, later wakes resume ordinary work; do not call non-conversation awakening checkpoints again. Calling team loads real employee profiles. A plain conversation invitation is also available outside first awakening. A conversation checkpoint records an invitation, not a placed call or action proof. A checkpoint never schedules, delegates, grants authority or proves task completion.',
    parameters: {
      stage: { type: 'string', required: true, enum: [...awakeningStages] },
      summary: { type: 'string', required: true, description: 'Short evidence-backed finding or concrete gap, not hidden reasoning.' },
      evidence_refs: { type: 'array', required: true, items: { type: 'string' }, description: 'Exact source URLs, artifact IDs or receipt identifiers copied unchanged from successful non-awakening tool results in this Runtime room; employee messages, IDs from another room or earlier awakening checkpoints are not substitutes. After a rejected reference, inspect the actual successful result and correct the reference rather than repeating the same call. Use an empty list only for team discovery, a blocked stage, or a conversation invitation without artifact/image references.' },
      blocked: { type: 'boolean', description: 'Set true only when this stage has a concrete unresolved gap; defaults to false.' },
      title: { type: 'string', description: 'Optional inspected artifact or page title.' },
      image: { type: 'string', description: 'Optional exact authenticated same-origin image path already returned by a successful receipt.' },
      reference: { type: 'string', description: 'Optional exact artifact identifier or source URL from the referenced receipt.' },
    },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    isConcurrencySafe: () => false,
    async execute(args, execution) {
      const agent = execution.agent
      if (!agent || !isHqLead(ctx, agent)) throw new Error('hq_awakening_requires_runtime')
      const events = agent.session.snapshotEvents()
      if (!(args.stage === 'conversation' && !args.reference && !args.image) && !events.some(event => event.type === 'hivemind/hq-awakening-start')) throw new Error('hq_awakening_not_started')
      const stage = args.stage
      if (!awakeningStages.includes(stage)) throw new Error('hq_awakening_invalid_stage')
      const summary = args.summary.trim()
      if (!summary || summary.length > 2400 || args.evidence_refs.length > 20) throw new Error('hq_awakening_invalid_checkpoint')
      const calls = events.flatMap(event => event.type === 'assistant/message' ? event.data.message.content.flatMap(block => block.type === 'tool-call' ? [block] : []) : [])
      const successful = events.filter(event => event.type === 'tool/result' && event.data.message.content.some(block => block.type === 'tool-result' && !block.isError))
      const matched = args.evidence_refs.map((reference) => {
        if (!reference.trim() || reference.length > 1000) throw new Error('hq_awakening_invalid_reference')
        const event = successful.findLast(item => item.type === 'tool/result' && item.data.message.content.some(block => block.type === 'tool-result' && !block.isError && calls.some(call => call.id === block.toolCallId && call.name !== 'hivemind_hq_awakening')) && JSON.stringify(item.data).includes(reference))
        if (!event) throw new Error('hq_awakening_successful_receipt_required')
        return event
      })
      const receipts = matched.map(event => JSON.stringify(event.data))
      if (stage === 'remembered' && !args.blocked) {
        const saved = matched.some(event => event.type === 'tool/result' && event.data.message.content.some(block => block.type === 'tool-result' && !block.isError && calls.some((call) => {
          if (call.id !== block.toolCallId || call.name !== 'hyperagents_memory') return false
          try { return JSON.parse(call.arguments).action === 'save' } catch { return false }
        })))
        if (!saved) throw new Error('hq_awakening_private_memory_save_required')
      }
      const cards: AwakeningCheckpoint['cards'][number][] = []
      let profiles: JsonValue | undefined
      if (stage === 'team') {
        const directory = await ctx.hivemindEmployeeDirectory.profiles(execution.signal)
        profiles = directory.profiles as JsonValue
        for (const employee of directory.profiles) cards.push({
          title: String(employee['name']), detail: String(employee['persona'] ?? employee['role_archetype'] ?? 'Employee').slice(0, 2400), employeeId: String(employee['id']), role: String(employee['role_archetype'] ?? 'communicator'), ...(typeof employee['avatar_url'] === 'string' ? { avatarUrl: employee['avatar_url'] } : {}),
        })
      } else if (args.title) {
        const reference = args.reference?.trim()
        if (reference && !receipts.some(receipt => receipt.includes(reference))) throw new Error('hq_awakening_reference_not_in_receipt')
        const image = safeImage(args.image)
        if (args.image && (!image || !receipts.some(receipt => receipt.includes(image)))) throw new Error('hq_awakening_image_not_in_receipt')
        cards.push({ title: args.title.slice(0, 180), detail: summary,
          ...(reference ? { reference } : {}), ...(image ? { image } : {}) })
      }
      if (!args.blocked && stage !== 'team' && !(stage === 'conversation' && !args.reference && !args.image) && receipts.length === 0) throw new Error('hq_awakening_receipt_required')
      const checkpoint: AwakeningCheckpoint = { stage, summary, receiptSeqs: [...new Set(matched.map(event => event.seq))],
        blocked: args.blocked === true,
        turn: events.findLast(event => event.type === 'turn/start')?.data.turn ?? 0, recordedAt: new Date().toISOString(), cards }
      const prior = events.findLast(event => event.type === 'hivemind/hq-awakening-checkpoint' && event.data.stage === stage)
      if (prior?.type !== 'hivemind/hq-awakening-checkpoint' || JSON.stringify({ ...prior.data, recordedAt: '' }) !== JSON.stringify({ ...checkpoint, recordedAt: '' })) agent.session.append('hivemind/hq-awakening-checkpoint', checkpoint)
      if (!await ctx.sessions.flush(agent.session)) throw new Error('hq_awakening_persistence_required')
      return JSON.parse(JSON.stringify({ status: args.blocked ? 'needs_attention' : 'checkpoint_saved', checkpoint, ...(profiles ? { profiles } : {}) })) as Record<string, JsonValue>
    },
  })))
}
