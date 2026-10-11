export { greetingOnly, socialTurnOnly } from './social-turn.ts'
/** HIVE-MIND organization and recent-conversation context projection. */
import type { Context, Plugin } from '@deepseek-ai/cordis'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint'
import { activeTeamWait } from '@deepseek-ai/dsh-experimental-tool-agent-team'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-user-questions/types'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, Message, UserMessage } from '@deepseek-ai/dsh-llm'
import { isAppendSurfaceEvent, isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
/** Prompt-projection budgets and the registered on-demand capability tool. */
export interface ContextConfig {
  historyTurns: number
  historyMaxChars: number
  capabilityToolName: string
  /** Load the bounded authenticated profile brief for the first turn and direct profile questions. */
  profileBrief?: (agent: Agent, signal: AbortSignal, turn: number) => Promise<string | undefined>
  /** Return a compact authoritative instruction that is re-read for every user turn. */
  turnInstruction?: (agent: Agent, turn: number) => string | undefined
}
interface ConversationExchange { turn: number; user: string; assistant: string }
const HISTORY_CONTEXT_SOURCE = 'dsh-hivemind-runtime/history'
const PROFILE_CONTEXT_SOURCE = 'dsh-hivemind-runtime/profile'
const TURN_CONTEXT_SOURCE = 'dsh-hivemind-runtime/turn'
function textOf(message: Message): string { return message.content.filter((block): block is Extract<ContentBlock,{ type:'text' }> => block.type === 'text').map(block => block.text.trim()).filter(Boolean).join('\n') }
function isDirectUserMessage(message: Message): boolean { return (message.source as { readonly kind: string }).kind === 'user' }
const DIRECT_USER_PROFILE = /\b(?:about me|know about me|my profile|who am i|my (?:name|role|locale|language|timezone))\b/u
const DIRECT_ORG_PROFILE = /\b(?:my|our) (?:company|organization|organisation|website)\b|\b(?:company|organization|organisation) profile\b/u
function needsProfileBrief(messages: readonly Message[], turn: number): boolean {
  if (turn === 1) return true
  const request = messages.filter(isDirectUserMessage).map(textOf).join('\n').toLowerCase()
  if (request === '') return false
  return DIRECT_USER_PROFILE.test(request) || DIRECT_ORG_PROFILE.test(request)
}
function profileMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: PROFILE_CONTEXT_SOURCE, form: 'recall' },
  })
}
function turnInstructionMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: TURN_CONTEXT_SOURCE, form: 'recall' },
  })
}
/**
 * Extract completed direct-user/final-assistant exchanges from durable events.
 * @param events - append-only session events.
 * @returns completed exchanges in turn order.
 */
export function completedExchanges(events: readonly SessionEvent[]): ConversationExchange[] { const users = new Map<number,string[]>(), assistants = new Map<number,string>(), completed = new Set<number>(); let open: number|undefined; for (const event of events) { if (event.type === 'turn/start') { open = event.data.turn; continue } if (event.type === 'turn/end') { if (event.data.reason.kind === 'completed') completed.add(event.data.turn); if (open === event.data.turn) open = undefined; continue } if (!isAppendSurfaceEvent(event)) continue; if (event.type === 'user/message' && open !== undefined && event.data.source.kind === 'user') { const value = textOf(event.data); if (value) users.set(open,[...users.get(open)??[],value]) } else if (event.type === 'assistant/message') { const value = textOf(event.data.message); if (value) assistants.set(event.data.turn,value) } } return [...completed].sort((a,b)=>a-b).flatMap((turn)=>{ const user=users.get(turn)?.join('\n'),assistant=assistants.get(turn); return user===undefined||assistant===undefined?[]:[{ turn,user,assistant }] }) }
/**
 * Render a bounded recent-conversation projection without old tool payloads.
 * @param exchanges - completed exchanges in turn order.
 * @param maxTurns - maximum number of newest exchanges to retain.
 * @param maxChars - maximum projection character count.
 * @returns model-facing recent conversation text.
 */
export function recentConversationText(exchanges: readonly ConversationExchange[], maxTurns: number, maxChars: number): string { const heading='## Recent conversation\nOnly completed user requests and final answers are retained; tool calls and tool outputs are omitted. The separate user message after this block is the current request and must be answered.\n'; const selected:string[]=[]; let remaining=maxChars-heading.length; for(const exchange of exchanges.slice(-maxTurns).reverse()){const rendered=`\n### User\n${exchange.user}\n\n### Assistant\n${exchange.assistant}\n`;if(rendered.length<=remaining){selected.unshift(rendered);remaining-=rendered.length;continue}if(selected.length>0||remaining<80)break;const userBudget=Math.max(20,Math.floor(remaining*.35)),assistantBudget=Math.max(20,remaining-userBudget-36);selected.unshift(`\n### User\n${exchange.user.slice(0,userBudget)}\n\n### Assistant\n${exchange.assistant.slice(0,assistantBudget)}\n`);break}return `${heading}${selected.join('')}`.slice(0,maxChars) }
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
/** Keep admitted peer evidence until its correlated response or actual task review. */
function unresolvedPeerMessage(event: SessionEvent | undefined, events: readonly SessionEvent[]): boolean {
  if (event?.type !== 'user/message') return false
  const source = record(event.data.source)
  if (source?.kind === 'agent-message' && source.form === 'relay') return true // Native direct Team messages have no reply-to identity.
  if (source?.kind === 'team-message') return true // Native Team messages lack a reply-to identity; do not guess completion.
  if (source?.kind !== 'hivemind-agent-message' || source.form === 'notice') return false
  const receipt = events.find(item => String(item.type) === 'hivemind/room-message-received'
    && record(item.data)?.id === source.messageId)
  const data = record(receipt?.data)
  if (typeof data?.taskId === 'string' && Array.isArray(data.artifactIds) && data.artifactIds.length > 0) {
    const task = record(events.findLast(item => String(item.type) === 'team/task'
      && record(record(item.data)?.task)?.id === data.taskId)?.data)?.task
    const snapshot = record(task)
    if (typeof snapshot?.revision !== 'number') return true
    const revision = snapshot.status === 'completed' ? snapshot.revision - 1 : snapshot.revision
    return !events.some(item => item.seq > event.seq && String(item.type) === 'hivemind/hq-task-review'
      && record(item.data)?.taskId === data.taskId && record(item.data)?.reviewer === 'runtime'
      && record(item.data)?.status === 'accepted' && record(item.data)?.taskRevision === revision
      && JSON.stringify(record(item.data)?.artifactIds) === JSON.stringify(data.artifactIds))
  }
  return !events.some(item => item.seq > event.seq && String(item.type) === 'hivemind/room-message-queued'
    && record(item.data)?.replyTo === source.messageId && record(item.data)?.kind === 'reply')
}
function projectHistory(ctx: Context, agent: Agent, config: ContextConfig): boolean {
  const session = agent.session
  const events = session.snapshotEvents()
  const exchanges = completedExchanges(events)
  if (exchanges.length === 0) return false
  const lastCompleted = events.findLast(event => event.type === 'turn/end' && event.data.reason.kind === 'completed')
  if (lastCompleted === undefined) return false
  const nodes = [...session.surface.nodes]
  // Surface order is positional, not numeric seq order. Pruning and native
  // compaction append newer replacement events at older history positions.
  // Follow their source provenance instead of filtering holes out of a range.
  const historical = new Map<SessionSeq, boolean>()
  const isHistorical = (seq: SessionSeq): boolean => {
    const cached = historical.get(seq)
    if (cached !== undefined) return cached
    const event = session.eventAt(seq)
    if (event === undefined) return false
    if (seq < lastCompleted.seq) return true
    if (!isReplacementSurfaceEvent(event)) return false
    const sources = (event.sourceEventSeqs ?? []).filter((source) => {
      const original = session.eventAt(source)
      return original !== undefined && (isAppendSurfaceEvent(original) || isReplacementSurfaceEvent(original))
    })
    const result = sources.length > 0 && sources.every(isHistorical)
    historical.set(seq, result)
    return result
  }
  // Keep the native system message outside the replacement interval, and stop
  // at the first current-work node. Never replace a non-contiguous filtered set.
  const pinned = nodes.findLastIndex((seq) => {
    const event = session.eventAt(seq)
    return event?.type === 'system/message'
      || (event?.type === 'user/message' && isCompactCheckpointSource(event.data.source))
  })
  const tail = nodes.slice(pinned + 1)
  const current = tail.findIndex(seq => !isHistorical(seq))
  const historicalTail = current === -1 ? tail : tail.slice(0, current)
  // Reuse the native pending-question projection and Team checkpoint. Keep the
  // original assistant call plus every subsequent result while input is pending.
  const pending = ctx.get('sessionProjections')?.snapshot(session).values.userQuestions?.active ?? []
  const calls = new Set(pending.map(question => question.callId))
  const waiting = activeTeamWait(events)
  if (waiting !== undefined) calls.add(waiting.callId)
  const protectedFrom = historicalTail.findIndex((seq) => {
    const event = session.eventAt(seq)
    return (event?.type === 'assistant/message' && event.data.message.content.some(block =>
      block.type === 'tool-call' && calls.has(block.id)))
      || (event?.type === 'user/message' && waiting?.originalSourceMessageId === event.data.id)
      || unresolvedPeerMessage(event, events)
  })
  const shadowed = protectedFrom === -1 ? historicalTail : historicalTail.slice(0, protectedFrom)
  const start = shadowed[0], end = shadowed.at(-1)
  if (start === undefined || end === undefined) return false
  const text = recentConversationText(exchanges, config.historyTurns, config.historyMaxChars)
  const previous = shadowed.length === 1 ? session.eventAt(start) : undefined
  if (previous?.type === 'user/message' && previous.data.source.kind === 'plugin'
    && previous.data.source.plugin === HISTORY_CONTEXT_SOURCE && textOf(previous.data) === text.trim()) return false
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: HISTORY_CONTEXT_SOURCE, form: 'recall' },
  }), { surfaceOp: { op: 'replace', startSeq: start, endSeq: end }, sourceEventSeqs: shadowed })
  return true
}
function capabilityCatalogRequested(events: readonly SessionEvent[], turn: number, toolName: string): boolean {
  return events.some(event => event.type === 'tool/call'
    && event.data.turn === turn
    && event.data.name === toolName)
}
function isSkillCatalog(message: Message): boolean {
  return (message.source as { readonly kind: string }).kind === 'skill-catalog'
}

/**
 * Project compact history and reveal the native skill catalog only after a model request.
 * @param config - history budgets and the registered capability-request tool name.
 * @returns A Cordis plugin that projects model context without changing the native agent loop.
 */
export function contextPlugin(config: ContextConfig): Plugin.Object<void> {
  return {
    name: 'hivemind-context',
    apply(ctx: Context): void {
      const projected = new WeakMap<Agent, number>()
      ctx.effect(() => ctx.on('agent/pre-step', async ({ agent, turn, signal }, next) => {
        const decision = await next()
        if (decision.kind === 'reject') return decision

        const first = projected.get(agent) !== turn
        if (first) projected.set(agent, turn)
        const changed = first && projectHistory(ctx, agent, config)
        const showCatalog = capabilityCatalogRequested(
          agent.session.snapshotEvents(),
          turn,
          config.capabilityToolName,
        )
        const withoutCatalog = showCatalog
          ? decision.messages
          : decision.messages.filter(message => !isSkillCatalog(message))
        let messages = withoutCatalog
        if (first && config.turnInstruction !== undefined) {
          const instruction = config.turnInstruction(agent, turn)
          if (instruction !== undefined && instruction.trim() !== '') {
            messages = [turnInstructionMessage(instruction), ...messages]
          }
        }
        if (first && config.profileBrief !== undefined && needsProfileBrief(withoutCatalog, turn)) {
          try {
            const brief = await config.profileBrief(agent, signal, turn)
            if (brief !== undefined && brief.trim() !== '') messages = [profileMessage(brief), ...messages]
          } catch {
            // The explicit HIVE meta operation owns typed retrieval failures. A
            // missing optional brief must not prevent the user's turn.
          }
        }
        return changed
          ? { ...decision, messages, startsRequestSeries: true }
          : { ...decision, messages }
      }, { prepend: true }))
    },
  }
}
