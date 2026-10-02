/** First awakening is a resumable investigation in the native room, not a second agent loop. */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
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
const trigger = /^wake\s+up\s*,?\s*chief\s*!?\s*$/iu
export async function awakeningContext(ctx: Context, agent: Agent, turn: number, messages: readonly UserMessage[]): Promise<string> {
  if (!isHqLead(ctx, agent)) return ''
  let started = agent.session.snapshotEvents().some(event => event.type === 'hivemind/hq-awakening-start')
  const humanMessages = [...messages, ...agent.session.snapshotEvents().flatMap(event => event.type === 'user/message' ? [event.data] : [])]
  if (!started && humanMessages.some(message => message.source.kind === 'user' && trigger.test(message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('').trim()))) {
    agent.session.append('hivemind/hq-awakening-start', { version: 1, turn, startedAt: new Date().toISOString() })
    if (!await ctx.sessions.flush(agent.session)) throw new Error('hq_awakening_persistence_required')
    started = true
  }
  if (!started) return ''
  const checkpoints = agent.session.snapshotEvents().flatMap(event => event.type === 'hivemind/hq-awakening-checkpoint' ? [event.data] : [])
  if (checkpoints.some(item => item.stage === 'remembered' && !item.blocked)) return ''
  return 'FIRST AWAKENING INVESTIGATION. This is the current human-requested first awakening, separate from ordinary wake review. Completed verification handoffs and their one-time acknowledgements are historical results, not the current task. Do not repeat a continuity-test phrase or stop on an empty board. Start company discovery now; retain real human business direction such as the German-market focus. Resume the saved investigation; do not repeat inspected sources. Be curious, decisive and evidence-led, without claiming consciousness or exposing hidden reasoning. Give short plain-language findings as evidence arrives.\n'
    + '1 company: call hivemind_meta operation context for full onboarding, then hivemind_operating_context for ICP, market, company situation and relevant methods. Establish who Runtime serves and what is known versus inferred.\n'
    + '2 evidence: call hivemind_onboarding operation catalog, then inspect each returned source_id separately, including homepage-screenshot when available. Read each available page and inspect each image individually with native tools. Never claim visual inspection from an image URL alone. Preserve capture dates. Call hivemind_hq_awakening after each inspected item to display a horizontal evidence card. Report unavailable retained media explicitly; use current public evidence only for a specific gap.\n'
    + '3 team: use hivemind_hq_awakening stage team to load the authenticated employee profiles, then read their personas, roles and tools and explain how their responsibilities fit this company. No delegation merely to introduce them.\n'
    + '4 memory: consider the host private recall and relevant HyperAgent memories, existing tasks and completed receipts. Distinguish completed work from suggestions.\n'
    + '5 strategy: reason from the evidence using useful global doctrine and compatible company local playbooks, then call hivemind_operating_plan to record the adaptive operating plan. Propose 3–5 useful bounded tasks (maximum 6; fewer if justified), with named verified employees, suggested times, dependencies, deliverables, success criteria and evidence-based reasons. These are proposals, not dispatched or scheduled work. Present them for acceptance; only accepted tasks enter native Team contracts and Schedule. No invented outreach authority or company-memory writes.\n'
    + '6 conversation: offer the existing live voice control in this Runtime room to discuss the current company and next agenda. Do not claim a call started or ended without a receipt. Text discussion is valid if preferred. Keep this stage pending until the human has actually supplied or confirmed direction.\n'
    + '7 remembered: save verified findings and agreed direction using hyperagents_memory with Runtime\'s persistent owner, never another employee; save inferred opportunities as hypotheses. Record remembered only with a successful private-memory save receipt. Then continue accepted native company work and use the normal rest/handoff flow.\n'
    + 'hivemind_hq_awakening records presentation checkpoints, not proof of company outcomes. Its receipt references must point to existing successful native tool results. Checkpoint incomplete stages with blocked=true and the exact gap. Do not turn a technical outage into an invented finding.\nSaved investigation: ' + JSON.stringify(checkpoints.slice(-40))
}
function safeImage(value: unknown): string | undefined {
  // Only the existing authenticated same-origin artifact surface; never arbitrary remote pixels or credential URLs.
  return typeof value === 'string' && /^\/(?:api|assets)\/[A-Za-z0-9_./%-]+$/.test(value) ? value : undefined
}
export function installAwakening(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'hivemind_hq_awakening',
    description: 'Checkpoint the first Runtime investigation and show inspected evidence or authenticated team cards. Native tools perform retrieval and actions. Evidence references must occur in successful tool receipts in this room. Calling team loads real employee profiles. A checkpoint never schedules, delegates, grants authority or proves task completion.',
    parameters: {
      stage: { type: 'string', required: true, enum: [...awakeningStages] },
      summary: { type: 'string', required: true, description: 'Short evidence-backed finding or concrete gap, not hidden reasoning.' },
      evidence_refs: { type: 'array', required: true, items: { type: 'string' }, description: 'Exact source URLs, artifact IDs or receipt identifiers returned by native tools. Use an empty list only for team discovery or a blocked stage.' },
      blocked: { type: 'boolean', required: true },
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
      if (!events.some(event => event.type === 'hivemind/hq-awakening-start')) throw new Error('hq_awakening_not_started')
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
      if (!args.blocked && stage !== 'team' && receipts.length === 0) throw new Error('hq_awakening_receipt_required')
      const checkpoint: AwakeningCheckpoint = { stage, summary, receiptSeqs: [...new Set(matched.map(event => event.seq))],
        blocked: args.blocked,
        turn: events.findLast(event => event.type === 'turn/start')?.data.turn ?? 0, recordedAt: new Date().toISOString(), cards }
      const prior = events.findLast(event => event.type === 'hivemind/hq-awakening-checkpoint' && event.data.stage === stage)
      if (prior?.type !== 'hivemind/hq-awakening-checkpoint' || JSON.stringify({ ...prior.data, recordedAt: '' }) !== JSON.stringify({ ...checkpoint, recordedAt: '' })) agent.session.append('hivemind/hq-awakening-checkpoint', checkpoint)
      if (!await ctx.sessions.flush(agent.session)) throw new Error('hq_awakening_persistence_required')
      return JSON.parse(JSON.stringify({ status: args.blocked ? 'needs_attention' : 'checkpoint_saved', checkpoint, ...(profiles ? { profiles } : {}) })) as Record<string, JsonValue>
    },
  })))
}
